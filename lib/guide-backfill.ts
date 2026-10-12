import type { SupabaseClient } from '@supabase/supabase-js'
import { getSetting, setSetting } from '@/lib/app-settings'
import { inferScope, parseScope, type GuideScope } from '@/lib/guide-scope'
import type { GuideCandidate, GuideKind } from '@/lib/guides'

// One-time guide backfill (growth loop WP16, part 1). Joel wants a page for every destination, hotel, resort, ship,
// cruise line, river cruise and yacht that the published trips name. The pipeline's guides step already writes
// pages under a daily cap of one; this file adds the plan, the cost estimate and the one-time batch allowance:
//
//   1. DRY RUN (no AI call, no write): planBackfill() lists the pages and estimateBackfill() prices them.
//   2. START (admin, once): stores the list and a batch cap that Joel chose after seeing the estimate.
//   3. The existing pipeline guides step then writes the listed pages first, and may exceed the daily cap only
//      until `batch_cap` of them are written. After that the normal daily cap resumes for what is left and for the
//      long tail (suppliers, countries, ports).
//
// Nothing here writes a page, calls the model or publishes anything. Every page still goes through the same fact
// gate, source rule and publish decision as any other guide (lib/guide-run.ts). Kept free of runtime imports of
// lib/guides.ts so lib/guides.ts can import it without a loop.

export const GUIDE_BACKFILL_KEY = 'guide_backfill'
/** The most pages one backfill may ever allow, whatever is typed. */
export const BACKFILL_HARD_MAX = 40
/** The batch cap offered when none is chosen. */
export const BACKFILL_DEFAULT_BATCH = 10
/** While a batch is running the daily cap grows by this many (so at most 1 + 4 = 5 a day with the defaults). */
export const BACKFILL_EXTRA_PER_DAY = 4
/** A guide takes two model calls (the article, then the FAQ and meta text). */
export const CALLS_PER_GUIDE_MIN = 2
/** Plus up to two self-repair calls (lib/content-repair.ts REPAIR_CALLS_PER_ITEM). */
export const CALLS_PER_GUIDE_MAX = 4
/** Mirrors EST_COST_USD_PER_CALL in lib/content-repair.ts, the site's one per-call estimate. An estimate, not a bill. */
export const EST_USD_PER_CALL = 0.05

/** After the destinations, the order in which the named properties are written. */
export const BACKFILL_KIND_ORDER: readonly GuideKind[] = ['destinations', 'cruise-lines', 'ships', 'resorts', 'hotels', 'river-cruises', 'yachts']
const KIND_ORDER = BACKFILL_KIND_ORDER
const KINDS = new Set<string>(KIND_ORDER as readonly string[])
/** Kinds that name a real business. A backfilled page of one of these publishes only when the repaired gate is clean. */
export const REVIEW_KINDS: readonly GuideKind[] = ['hotels', 'resorts', 'ships', 'cruise-lines', 'river-cruises', 'yachts']

export interface BackfillEntry {
  kind: GuideKind
  slug: string
  name: string
  parent_slug: string | null
  scope: GuideScope | null
  origin: 'destination' | 'package'
}

export interface BackfillState {
  /** ISO time the admin started it. Only pages created after this count against the batch. */
  started_at: string
  /** How many pages may be written above the normal daily cap. Chosen after the estimate was shown. */
  batch_cap: number
  entries: BackfillEntry[]
  /** Set when the admin stops it: the entries stay listed but stop getting the extra allowance. */
  cancelled_at: string | null
}

/** The stored state, or null when nothing is stored or it is not well formed. A bad value can never break the guides step. */
export function parseBackfillState(raw: string | null | undefined): BackfillState | null {
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const p = parsed as Record<string, unknown>
  if (typeof p.started_at !== 'string' || Number.isNaN(Date.parse(p.started_at))) return null
  const cap = Number(p.batch_cap)
  if (!Number.isInteger(cap) || cap < 0 || cap > BACKFILL_HARD_MAX) return null
  if (!Array.isArray(p.entries)) return null
  const entries: BackfillEntry[] = []
  for (const e of p.entries as Record<string, unknown>[]) {
    if (!e || typeof e !== 'object') continue
    if (typeof e.kind !== 'string' || !KINDS.has(e.kind) || typeof e.slug !== 'string' || !e.slug || typeof e.name !== 'string' || !e.name) continue
    entries.push({
      kind: e.kind as GuideKind,
      slug: e.slug,
      name: e.name,
      parent_slug: typeof e.parent_slug === 'string' && e.parent_slug ? e.parent_slug : null,
      scope: parseScope(e.scope),
      origin: e.origin === 'package' ? 'package' : 'destination',
    })
  }
  return { started_at: p.started_at, batch_cap: cap, entries, cancelled_at: typeof p.cancelled_at === 'string' ? p.cancelled_at : null }
}

// ---------------------------------------------------------------------------------------------------
// The plan (pure)
// ---------------------------------------------------------------------------------------------------

// Words that mean the "name" is the title of a trip, not of a property. "Singles Getaway Resort" is not a resort.
const TRIP_WORDS = /\b(singles?|group|getaway|getaways|party|trip|tour|tours|escape|adventure|vacation|holiday|weekend|retreat|experience|package|special|deal|girls|boys|couples|friends|reunion|birthday|bachelorette|wedding|honeymoon|fun|sale|early bird)\b/i
// The kind words themselves do not make a name distinctive.
const KIND_WORDS = new Set(['resort', 'resorts', 'hotel', 'hotels', 'inn', 'lodge', 'ship', 'cruise', 'cruises', 'river', 'yacht', 'yachts', 'line', 'the', 'and', 'of', 'ms', 'mv', 'spa', 'beach', 'club', 'all', 'inclusive'])

/** True when a name taken from a package title looks like the title of a trip rather than a property. */
export function looksLikeTripTitle(name: string): boolean {
  if (TRIP_WORDS.test(name)) return true
  const distinctive = name.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && !KIND_WORDS.has(w))
  return distinctive.length === 0
}

export interface SkippedCandidate {
  kind: GuideKind
  name: string
  reason: string
}

export interface BackfillPlan {
  entries: BackfillEntry[]
  skipped: SkippedCandidate[]
  byKind: { kind: GuideKind; count: number }[]
  /** How many pages name a business (hotel, resort, ship, cruise line, river cruise, yacht). These wait in the review queue unless the gate is clean. */
  namedCount: number
}

/** Which of the candidate pages the backfill would queue. Only real data counts: a destination a published trip goes
 * to, or a property name taken from a published package name. Curated seed names are the long tail and are not part
 * of the backfill. A name that already failed `maxAttempts` times, or that looks like a trip title, is left out and
 * listed under `skipped` with the reason. Pure. */
export function planBackfill(candidates: GuideCandidate[], failures: Record<string, { n: number }>, maxAttempts = 2): BackfillPlan {
  const entries: BackfillEntry[] = []
  const skipped: SkippedCandidate[] = []
  const seen = new Set<string>()
  for (const c of candidates) {
    if (c.origin === 'seed') continue
    if (!KINDS.has(c.kind) || !c.slug) continue
    const key = `${c.kind}:${c.slug}`
    if (seen.has(key)) continue
    seen.add(key)
    if ((failures[key]?.n ?? 0) >= maxAttempts) {
      skipped.push({ kind: c.kind, name: c.name, reason: `failed ${failures[key].n} times before (dismiss it on Needs attention to retry)` })
      continue
    }
    if (c.origin === 'package' && looksLikeTripTitle(c.name)) {
      skipped.push({ kind: c.kind, name: c.name, reason: 'looks like the title of a trip, not the name of a property' })
      continue
    }
    entries.push({ kind: c.kind, slug: c.slug, name: c.name, parent_slug: c.parent_slug, scope: c.scope ?? inferScope(c.kind, c.name), origin: c.origin })
  }
  entries.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.name.localeCompare(b.name))
  const byKind = KIND_ORDER.map((kind) => ({ kind, count: entries.filter((e) => e.kind === kind).length })).filter((k) => k.count > 0)
  const namedCount = entries.filter((e) => REVIEW_KINDS.includes(e.kind)).length
  return { entries, skipped, byKind, namedCount }
}

export interface BackfillEstimate {
  guides: number
  callsMin: number
  callsMax: number
  usdMin: number
  usdMax: number
}

/** What writing `guides` pages could cost: two model calls each, up to four with self-repair, at the site's per-call
 * estimate. Always shown as a range and always labelled an estimate. No AI call is made to produce it. Pure. */
export function estimateBackfill(guides: number): BackfillEstimate {
  const n = Math.max(0, Math.floor(guides))
  const round = (x: number) => Math.round(x * 100) / 100
  return {
    guides: n,
    callsMin: n * CALLS_PER_GUIDE_MIN,
    callsMax: n * CALLS_PER_GUIDE_MAX,
    usdMin: round(n * CALLS_PER_GUIDE_MIN * EST_USD_PER_CALL),
    usdMax: round(n * CALLS_PER_GUIDE_MAX * EST_USD_PER_CALL),
  }
}

/** The batch cap to store: what was asked for, a whole number from 1 to the smaller of the hard maximum and the
 * number of planned pages. Nothing asked for gives the default. Zero planned pages gives 0. Never uncapped. */
export function clampBatchCap(requested: unknown, planned: number): number {
  if (!Number.isFinite(planned) || planned <= 0) return 0
  const ceiling = Math.min(BACKFILL_HARD_MAX, Math.floor(planned))
  const asked = Number(requested)
  if (requested === undefined || requested === null || requested === '' || !Number.isFinite(asked)) return Math.min(BACKFILL_DEFAULT_BATCH, ceiling)
  return Math.max(1, Math.min(ceiling, Math.floor(asked)))
}

export interface BackfillProgress {
  /** Listed pages written since the backfill started (any status). */
  written: number
  /** Listed pages that do not exist yet. */
  waiting: number
  /** How many more pages may still use the extra daily allowance. */
  remainingBatch: number
  /** True while the extra allowance applies. */
  bursting: boolean
}

/** How far the backfill has got. `existing` is every guide row (kind, slug, created_at). Pure. */
export function backfillProgress(
  state: BackfillState | null,
  existing: { kind: string; slug: string; created_at: string }[],
  failures: Record<string, { n: number }> = {},
  maxAttempts = 2,
): BackfillProgress {
  if (!state) return { written: 0, waiting: 0, remainingBatch: 0, bursting: false }
  // `waiting` counts only pages that can still be written: a listed page that already failed `maxAttempts` times is
  // skipped by the pipeline, so it must not keep the allowance alive.
  const listed = new Set(state.entries.filter((e) => (failures[`${e.kind}:${e.slug}`]?.n ?? 0) < maxAttempts).map((e) => `${e.kind}:${e.slug}`))
  const have = new Set(existing.map((g) => `${g.kind}:${g.slug}`))
  const started = Date.parse(state.started_at)
  const written = existing.filter((g) => listed.has(`${g.kind}:${g.slug}`) && Date.parse(g.created_at) >= started).length
  const waiting = [...listed].filter((k) => !have.has(k)).length
  const remainingBatch = state.cancelled_at ? 0 : Math.max(0, Math.min(state.batch_cap - written, waiting))
  return { written, waiting, remainingBatch, bursting: remainingBatch > 0 }
}

/** The daily and weekly caps the guides step should use right now. Normal caps, plus the one-time allowance while
 * a batch is running (`remainingBatch` > 0). The allowance is bounded by the batch cap, which was chosen after the
 * estimate was shown, so the total above the normal caps can never pass it. Pure. */
export function effectiveGuideCaps(base: { perDay: number; perWeek: number }, progress: Pick<BackfillProgress, 'remainingBatch'>, batchCap: number): { perDay: number; perWeek: number } {
  if (progress.remainingBatch <= 0) return base
  // A switched-off step (a cap of 0) stays off: the allowance never turns guides back on.
  if (base.perDay === 0 || base.perWeek === 0) return base
  return { perDay: base.perDay + BACKFILL_EXTRA_PER_DAY, perWeek: base.perWeek + Math.max(0, batchCap) }
}

// ---------------------------------------------------------------------------------------------------
// Storage (app_settings, service role)
// ---------------------------------------------------------------------------------------------------

export async function readBackfillState(admin: SupabaseClient): Promise<BackfillState | null> {
  try {
    return parseBackfillState(await getSetting(admin, GUIDE_BACKFILL_KEY))
  } catch {
    return null
  }
}

/** Stores the state. (The API route refuses to start a second backfill while an earlier one still has pages waiting.) */
export async function saveBackfillState(admin: SupabaseClient, state: BackfillState): Promise<{ error?: string }> {
  return setSetting(admin, GUIDE_BACKFILL_KEY, JSON.stringify(state))
}
