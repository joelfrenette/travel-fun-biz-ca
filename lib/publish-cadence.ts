import type { SupabaseClient } from '@supabase/supabase-js'
import { getSettingStrict, setSetting } from '@/lib/app-settings'
import { blockIfDry } from '@/lib/dry-run'

// One shared rolling-window limiter for every AUTOMATIC publisher (the guide writer, the heal that publishes a held guide, the
// blog writer, the blog re-check). A young domain that suddenly gains a dozen pages in one day crawls slowly and looks templated,
// so the same three rules apply to all of them:
//   per day    at most N publishes in the last 24 hours (rolling, not "since midnight")
//   per week   at most N publishes in the last 7 days
//   gap        at least MIN_GAP_MINUTES between two automatic publishes of the same type
// A publish that the limiter blocks is DEFERRED: the item stays where it is (a draft, a candidate, an approved topic) and the next
// tick asks again. Nothing is failed, dropped or marked rejected. A publish that cannot be counted (the log cannot be read) is
// deferred too (fail closed).
//
// What counts: only a page going live for the first time (draft -> published, or a new page written as published). Healing a page that
// is ALREADY live never counts, and the admin's own manual publish is never blocked (it just is not asked).
//
// Where the history comes from: a small ledger in app_settings (key publish_cadence_log) that each automatic publisher writes at the
// moment it publishes, plus, for guides, the guides table itself (live AI-written guides created in the window), so a burst that
// happened before this limiter existed is seen at once.

export type CadenceType = 'guide' | 'post'

export const MIN_GAP_MINUTES = 90
export const CADENCE_LOG_KEY = 'publish_cadence_log'
const DAY_MS = 86_400_000
const WEEK_MS = 7 * DAY_MS
const LOG_KEEP_MS = 8 * DAY_MS
const LOG_MAX = 300

export interface CadenceLimits {
  /** Max publishes in the last 24 hours. null = no daily cap from this limiter. */
  perDay: number | null
  /** Max publishes in the last 7 days. null = no weekly cap from this limiter. */
  perWeek: number | null
  /** Minimum time between two publishes, in minutes. 0 turns the stagger off. */
  minGapMinutes: number
}

export interface PublishEvent {
  /** What was published, for example `guide:destinations:aruba`. Used to count one page once. */
  key: string
  /** When it went live (ms since the epoch). */
  at: number
}

export type CadenceDecision =
  | { allowed: true }
  | { allowed: false; reason: 'day' | 'week' | 'gap' | 'unreadable'; /** ISO time the next publish may go out; null when unknown. */ retryAfter: string | null; note: string }

/** The guide limits: the existing guides_per_day and guides_per_week numbers, plus the stagger. */
export function guideLimits(caps: { perDay: number; perWeek: number }): CadenceLimits {
  return { perDay: caps.perDay, perWeek: caps.perWeek, minGapMinutes: MIN_GAP_MINUTES }
}

/** The blog limits: the stagger only. The blog's own "posts per day" rule (autoblog_max_per_day, per calendar day) stays where it is. */
export function postLimits(): CadenceLimits {
  return { perDay: null, perWeek: null, minGapMinutes: MIN_GAP_MINUTES }
}

/** One event per page: when the same page appears twice (a ledger row and a table row), the latest time wins. Pure. */
export function dedupeEvents(events: readonly PublishEvent[]): PublishEvent[] {
  const latest = new Map<string, number>()
  for (const e of events) {
    if (!Number.isFinite(e.at)) continue
    const have = latest.get(e.key)
    if (have === undefined || e.at > have) latest.set(e.key, e.at)
  }
  return [...latest.entries()].map(([key, at]) => ({ key, at }))
}

/** When would the (count - limit + 1)th oldest event in the window fall out of it? That is the first moment one more fits. Pure. */
function windowFreesAt(times: number[], limit: number, windowMs: number): number {
  const sorted = [...times].sort((a, b) => a - b)
  return sorted[sorted.length - limit] + windowMs
}

/** The decision for ONE more publish right now. Pure: no clock, no database. A limit of 0 means "none allowed" (the guide caps use 0 for
 * "switched off"). */
export function evaluateCadence(events: readonly PublishEvent[], limits: CadenceLimits, now: number): CadenceDecision {
  const times = dedupeEvents(events).map((e) => e.at).filter((t) => t <= now + 60_000)
  const inDay = times.filter((t) => now - t < DAY_MS)
  const inWeek = times.filter((t) => now - t < WEEK_MS)
  const waits: { reason: 'day' | 'week' | 'gap'; at: number; note: string }[] = []

  if (limits.perDay !== null && inDay.length >= limits.perDay) {
    waits.push({ reason: 'day', at: limits.perDay === 0 ? Number.POSITIVE_INFINITY : windowFreesAt(inDay, limits.perDay, DAY_MS), note: `${inDay.length} published in the last 24 hours (limit ${limits.perDay})` })
  }
  if (limits.perWeek !== null && inWeek.length >= limits.perWeek) {
    waits.push({ reason: 'week', at: limits.perWeek === 0 ? Number.POSITIVE_INFINITY : windowFreesAt(inWeek, limits.perWeek, WEEK_MS), note: `${inWeek.length} published in the last 7 days (limit ${limits.perWeek})` })
  }
  if (limits.minGapMinutes > 0 && times.length > 0) {
    const gapMs = limits.minGapMinutes * 60_000
    const last = Math.max(...times)
    if (now - last < gapMs) waits.push({ reason: 'gap', at: last + gapMs, note: `the last one went live ${Math.max(0, Math.round((now - last) / 60_000))} minutes ago (at least ${limits.minGapMinutes} apart)` })
  }
  if (waits.length === 0) return { allowed: true }

  // The page can go out only when EVERY rule is satisfied, so the retry time is the latest of them; the reason named is that rule.
  const binding = waits.reduce((a, b) => (b.at > a.at ? b : a))
  const retryAfter = Number.isFinite(binding.at) ? new Date(binding.at).toISOString() : null
  return { allowed: false, reason: binding.reason, retryAfter, note: `publishing waits (${waits.map((w) => w.note).join('; ')}); it is deferred, not dropped${retryAfter ? `, next slot ${retryAfter}` : ''}` }
}

// ---------------------------------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------------------------------

interface LedgerRow {
  t: CadenceType
  k: string
  at: string
}

/** The ledger rows of one type from the stored JSON. Anything malformed is dropped. Pure. */
export function parseLedger(raw: string | null | undefined, type: CadenceType): PublishEvent[] {
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const out: PublishEvent[] = []
  for (const r of parsed as Partial<LedgerRow>[]) {
    if (!r || r.t !== type || typeof r.k !== 'string' || typeof r.at !== 'string') continue
    const at = Date.parse(r.at)
    if (Number.isFinite(at)) out.push({ key: r.k, at })
  }
  return out
}

/** Every recent publish of `type` we know of, or null when it could not be read (callers defer). Never throws. */
export async function readPublishEvents(admin: SupabaseClient, type: CadenceType, now: number = Date.now()): Promise<PublishEvent[] | null> {
  try {
    const ledger = await getSettingStrict(admin, CADENCE_LOG_KEY)
    if (ledger.error) return null
    const events = parseLedger(ledger.value, type)
    if (type === 'guide') {
      const since = new Date(now - WEEK_MS).toISOString()
      const { data, error } = await admin.from('guides').select('kind, slug, created_at').eq('status', 'published').eq('source', 'ai').gte('created_at', since)
      if (error) return null
      for (const g of (data ?? []) as { kind: string; slug: string; created_at: string }[]) {
        const at = Date.parse(g.created_at)
        if (Number.isFinite(at)) events.push({ key: guideCadenceKey(g.kind, g.slug), at })
      }
    }
    return dedupeEvents(events)
  } catch {
    return null
  }
}

export const guideCadenceKey = (kind: string, slug: string) => `guide:${kind}:${slug}`
export const postCadenceKey = (slug: string) => `post:${slug}`

/** May one more automatic publish of `type` go out right now? Fails closed: an unreadable history is "wait". Never throws. */
export async function checkCadence(admin: SupabaseClient, type: CadenceType, limits: CadenceLimits, now: Date = new Date()): Promise<CadenceDecision> {
  const events = await readPublishEvents(admin, type, now.getTime())
  if (events === null) return { allowed: false, reason: 'unreadable', retryAfter: null, note: 'could not read the publishing history, so nothing was published (it is deferred, not dropped)' }
  return evaluateCadence(events, limits, now.getTime())
}

/** Writes down that `key` went live now. Call it right after the publish. Best effort: a failure is returned, not thrown, because the
 * page is already live (the guides table still shows a written guide, so the window is not blind for guides). */
export async function recordPublish(admin: SupabaseClient, type: CadenceType, key: string, now: Date = new Date()): Promise<{ error?: string }> {
  // Dry run (lib/dry-run.ts): nothing went live, so the publish counter does not move.
  if (blockIfDry('counter', `publish counter ${type}:${key}`)) return {}
  try {
    const cur = await getSettingStrict(admin, CADENCE_LOG_KEY)
    if (cur.error) return { error: cur.error }
    let rows: LedgerRow[] = []
    try {
      const parsed = JSON.parse(cur.value || '[]')
      if (Array.isArray(parsed)) rows = parsed.filter((r): r is LedgerRow => !!r && typeof r.k === 'string' && typeof r.at === 'string' && (r.t === 'guide' || r.t === 'post'))
    } catch {
      rows = []
    }
    const keep = now.getTime() - LOG_KEEP_MS
    rows = rows.filter((r) => Date.parse(r.at) >= keep)
    rows.push({ t: type, k: key, at: now.toISOString() })
    const res = await setSetting(admin, CADENCE_LOG_KEY, JSON.stringify(rows.slice(-LOG_MAX)))
    return res.error ? { error: res.error } : {}
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'unknown error' }
  }
}

/** For the admin cards: the next free slot as plain words, or null when one is free now / unknown. Pure. */
export function describeDecision(d: CadenceDecision): string {
  return d.allowed ? 'a publish slot is free now' : d.note
}
