import type { SupabaseClient } from '@supabase/supabase-js'
import { isAiConfigured } from '@/lib/ai-verify'
import { getSettingStrict, setSetting } from '@/lib/app-settings'
import { isAutomationPaused } from '@/lib/automation-kill-switch'
import { claimDailyOnce, deleteEdits, editsLoggable, insertEdits } from '@/lib/content-edits'
import { EST_COST_USD_PER_CALL, modelCallFor, serializeField, type ContentEdit, type LogicalField, type ModelCall, type RepairFields } from '@/lib/content-repair'
import { GUIDE_LIMITS, buildGuideItem, finalizeEdits, guideFrom, guideFields } from '@/lib/content-repair-adapters'
import { composeGuide, groundingText, guideBlockers, parseArticle, type ComposedGuide, type GateContext } from '@/lib/guide-composer'
import { guideOffenders, repairGuideFields, type GuideRepairCfg } from '@/lib/guide-repairs'
import { NAMED_PROPERTY_KINDS, buildBrief, getGuidePublishMode, isGuessedPropertyNote } from '@/lib/guide-run'
import { composedGuideFromRow } from '@/lib/heal-drafts'
import { appendHealLog, healLoop, openBudget, type HealBudget, type HealTarget } from '@/lib/heal-loop'
import { pingIndexNow } from '@/lib/indexnow'
import { ENRICH_REASON_PREFIX, guideKinds, guidePath, isSafePageNote, type GuideCandidate, type GuideKind } from '@/lib/guides'

// Safe-page enrichment. When the heal cannot make a guide pass, its last rung publishes a "safe page": a short page built only from
// stored facts, flagged with the safe-page note (so it is noindex and left out of the sitemap, llms.txt and the related feeds). This
// file upgrades such a page to a full, indexable one, with no new cron: the daily heal step (lib/content-heal-run.ts) calls it, and so
// does `scripts/heal-guides-now.ts --enrich`.
//
// What one run does (at most one safe page a day, only when the day's heal call budget has room):
//   1. pick a safe page that has had fewer than ENRICH_MAX_ATTEMPTS tries and was last tried at least ENRICH_MIN_GAP_DAYS ago;
//   2. write the page again from its normal brief (the standard writer), then run the full heal ladder on it with NO safe-page rung and
//      NO whole-section deletion, and with the independent QA judge always required;
//   3. accept the result only if the gate and the judge passed AND it is clearly fuller than the safe page (ENRICH_MIN_WORD_RATIO times
//      the words, at least ENRICH_MIN_SECTIONS sections);
//   4. then, and only then, replace the text through content_edits (so Undo works), clear the safe-page note (indexing resumes) and
//      tell IndexNow. Any failure leaves the safe page exactly as it was: never worse than before.
// A guide named from a trip title is never touched, and neither is a named-property page whose name is not in stored package data.

export const ENRICH_MAX_ATTEMPTS = 3
export const ENRICH_MIN_GAP_DAYS = 2
export const ENRICH_PER_DAY = 1
export const ENRICH_MIN_WORD_RATIO = 1.3
export const ENRICH_MIN_SECTIONS = 8
/** The heal calls left that a run needs before it starts: the writer's 2 calls plus room for the heal rounds and the judge. */
export const ENRICH_MIN_BUDGET = 10
export const ENRICH_WRITER_CALLS = 2
/** Time a run needs before the caller's deadline: the writer (up to about 140 s) plus a first heal round. */
export const ENRICH_MIN_MS = 240_000
export const ENRICH_ATTEMPTS_KEY = 'safe_enrich_attempts'
const DAY_MS = 86_400_000
const PER_ITEM_MS = 180_000
const READ_LIMIT = 500

type Row = Record<string, unknown>
const str = (v: unknown) => (typeof v === 'string' ? v : '')

export interface EnrichAttempt {
  /** Tries made so far (counted when a try starts, so a crash still uses one up). */
  n: number
  /** When the last try started (ISO). */
  at: string
  /** What happened last, in plain words. */
  last: string
  /** Why the page was passed over without a try (no AI spent), when it was. */
  skip?: string
}
export type EnrichAttempts = Record<string, EnrichAttempt>

export const enrichKey = (kind: string, slug: string) => `${kind}:${slug}`

// ---------------------------------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------------------------------

/** Why a safe page may not be tried now, or null when it may. `force` (the admin script) lifts the spacing between tries only. Pure. */
export function enrichBlockReason(row: Row, attempt: EnrichAttempt | undefined, now: Date, opts: { force?: boolean } = {}): string | null {
  if (row.source !== 'ai' || row.status !== 'published') return 'not a live page the AI wrote'
  const notes = str(row.quality_notes)
  if (isGuessedPropertyNote(notes)) return 'its name was taken from a trip title, so it is never touched'
  if (!isSafePageNote(notes)) return 'not a safe page'
  const n = attempt?.n ?? 0
  if (n >= ENRICH_MAX_ATTEMPTS) return `used all ${ENRICH_MAX_ATTEMPTS} upgrade attempts`
  if (!opts.force && attempt?.at) {
    const at = Date.parse(attempt.at)
    if (Number.isFinite(at) && now.getTime() - at < ENRICH_MIN_GAP_DAYS * DAY_MS) return `tried ${attempt.at.slice(0, 10)}, next try not before ${new Date(at + ENRICH_MIN_GAP_DAYS * DAY_MS).toISOString().slice(0, 10)}`
  }
  return null
}

/** The safe pages that may be tried, fewest tries first, then oldest first. Pure. */
export function orderEnrichable(rows: Row[], attempts: EnrichAttempts, now: Date, opts: { force?: boolean } = {}): Row[] {
  return rows
    .filter((r) => enrichBlockReason(r, attempts[enrichKey(str(r.kind), str(r.slug))], now, opts) === null)
    .sort((a, b) => (attempts[enrichKey(str(a.kind), str(a.slug))]?.n ?? 0) - (attempts[enrichKey(str(b.kind), str(b.slug))]?.n ?? 0) || Date.parse(str(a.created_at)) - Date.parse(str(b.created_at)))
}

/** True when the stored facts name at least one real package for the subject (the grounding text has a "Packages on our site" block). */
export function hasStoredPackageData(grounding: string): boolean {
  return /^Packages on our site that involve it/m.test(grounding)
}

/** A named property (hotel, resort, ship, river cruise, yacht) is touched only when its name is in stored package data. Pure. */
export function nameIsStored(kind: string, grounding: string): boolean {
  return !(NAMED_PROPERTY_KINDS as readonly string[]).includes(kind) || hasStoredPackageData(grounding)
}

const wordsOf = (summary: string, body: string) => `${summary} ${body}`.trim().split(/\s+/).filter(Boolean).length
export const sectionCountOf = (body: string) => body.split(/^(?=##\s)/m).filter((c) => /^##\s/.test(c)).length

/** Null when `next` is clearly fuller than `old` (words and sections), else the plain reason it is not. Pure. */
export function enrichmentShortfall(old: { summary: string; body: string }, next: { summary: string; body: string }): string | null {
  const before = wordsOf(old.summary, old.body)
  const after = wordsOf(next.summary, next.body)
  const need = Math.ceil(before * ENRICH_MIN_WORD_RATIO)
  if (after < need) return `not fuller than the safe page (${after} words, needs at least ${need}; the safe page has ${before})`
  const sections = sectionCountOf(next.body)
  if (sections < ENRICH_MIN_SECTIONS) return `too few sections (${sections}, needs at least ${ENRICH_MIN_SECTIONS})`
  return null
}

// ---------------------------------------------------------------------------------------------------
// The attempts store (one small app_settings JSON). Fails closed: an unreadable or corrupt store means no try.
// ---------------------------------------------------------------------------------------------------

export async function readEnrichAttempts(admin: SupabaseClient): Promise<{ attempts: EnrichAttempts; error?: string }> {
  try {
    const { value, error } = await getSettingStrict(admin, ENRICH_ATTEMPTS_KEY)
    if (error) return { attempts: {}, error }
    if (!value || !value.trim()) return { attempts: {} }
    const parsed = JSON.parse(value) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { attempts: {}, error: 'the enrichment attempts record is not readable' }
    const out: EnrichAttempts = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      const e = v as Partial<EnrichAttempt> | null
      if (!e || typeof e !== 'object') continue
      out[k] = { n: Number.isInteger(e.n) && (e.n as number) >= 0 ? (e.n as number) : ENRICH_MAX_ATTEMPTS, at: str(e.at), last: str(e.last), ...(e.skip ? { skip: str(e.skip) } : {}) }
    }
    return { attempts: out }
  } catch (e) {
    return { attempts: {}, error: `the enrichment attempts record is not readable (${e instanceof Error ? e.message : 'unknown error'})` }
  }
}

async function writeEnrichAttempts(admin: SupabaseClient, attempts: EnrichAttempts): Promise<string | null> {
  try {
    const { error } = await setSetting(admin, ENRICH_ATTEMPTS_KEY, JSON.stringify(attempts))
    return error ?? null
  } catch (e) {
    return e instanceof Error ? e.message : 'unknown error'
  }
}

/** Changes one entry in the store (read, change, write). Returns an error text, or null. */
async function updateAttempt(admin: SupabaseClient, key: string, change: (old: EnrichAttempt | undefined) => EnrichAttempt | null): Promise<string | null> {
  const read = await readEnrichAttempts(admin)
  if (read.error) return read.error
  const next = change(read.attempts[key])
  if (next) read.attempts[key] = next
  else delete read.attempts[key]
  return writeEnrichAttempts(admin, read.attempts)
}

// ---------------------------------------------------------------------------------------------------
// The brief
// ---------------------------------------------------------------------------------------------------

export interface EnrichBrief {
  ctx: GateContext
  links: { path: string; label: string }[]
  /** The standard writer, on this brief. */
  compose: () => Promise<{ guide: ComposedGuide } | { error: string }>
}

export type EnrichBriefLoader = (row: Row, admin: SupabaseClient) => Promise<EnrichBrief | null>

/** Production: the guide's normal brief (buildBrief, the same facts the writer uses) and the standard writer (composeGuide). */
export const defaultEnrichBrief: EnrichBriefLoader = async (row, admin) => {
  const cand: GuideCandidate = { kind: str(row.kind) as GuideKind, name: str(row.name), slug: str(row.slug), parent_slug: str(row.parent_slug) || null, origin: 'seed' }
  const built = await buildBrief(admin, cand)
  const brief = built.brief
  return {
    ctx: { grounding: groundingText(brief), allowedPaths: built.allowedPaths, names: [...(brief.parentName ? [brief.parentName] : []), ...brief.links.map((l) => l.label)] },
    links: brief.links,
    compose: () => composeGuide(brief),
  }
}

// ---------------------------------------------------------------------------------------------------
// One run
// ---------------------------------------------------------------------------------------------------

export interface EnrichOpts {
  now?: Date
  /** Tests inject the model; production uses the heal loop's own. */
  model?: ModelCall
  /** Tests (and the admin script) inject a budget; the default opens today's persistent one. */
  budget?: HealBudget
  deadlineMs?: number
  loadBrief?: EnrichBriefLoader
  /** The admin script: lifts the once-a-day marker and the gap between tries (the 3-try cap still holds). */
  force?: boolean
  /** Only this guide ('kind/slug'). */
  only?: string
  /** Look and report; no AI call, no write. */
  dry?: boolean
}

export type EnrichAction = 'enriched' | 'failed' | 'deferred' | 'skipped'

export interface EnrichResult {
  action: EnrichAction
  path: string | null
  /** Tries started (0 or 1). */
  tried: number
  enriched: number
  calls: number
  problems: string[]
  note: string
  ladder: string[]
}

const result = (action: EnrichAction, note: string, extra: Partial<EnrichResult> = {}): EnrichResult => ({ action, path: null, tried: 0, enriched: 0, calls: 0, problems: [], note, ladder: [], ...extra })

const TEXT_FIELDS: LogicalField[] = ['body', 'meta_title', 'meta_description', 'og_title', 'og_description', 'faq', 'key_takeaways']

/** Runs the enrichment for at most one safe page. Never throws. */
export async function runSafeEnrichment(admin: SupabaseClient, opts: EnrichOpts = {}): Promise<EnrichResult> {
  const now = opts.now ?? new Date()
  try {
    if ((await getGuidePublishMode(admin)) !== 'publish') return result('skipped', 'safe pages not upgraded (guides are not in publish mode)')
    if (await isAutomationPaused(admin)) return result('skipped', 'safe pages not upgraded (automation is paused)')
    if (!opts.dry && !opts.loadBrief && !opts.model && !isAiConfigured()) return result('skipped', 'safe pages not upgraded (AI writing is not configured)')
    if (!(await editsLoggable(admin))) return result('skipped', 'safe pages not upgraded: apply migration 0033', { problems: ['safe pages not upgraded: apply migration 0033'] })

    const { data, error } = await admin.from('guides').select('*').eq('status', 'published').eq('source', 'ai').like('quality_notes', 'safe-page:%').order('created_at', { ascending: true }).limit(READ_LIMIT)
    if (error) return result('skipped', 'safe pages not upgraded', { problems: [`could not read the guides (${error.message})`] })
    let rows = ((data ?? []) as Row[]).filter((r) => isSafePageNote(str(r.quality_notes)))
    if (opts.only) rows = rows.filter((r) => `${str(r.kind)}/${str(r.slug)}` === opts.only)
    if (!rows.length) return result('skipped', opts.only ? `${opts.only} is not a live safe page` : 'no safe pages waiting')

    const read = await readEnrichAttempts(admin)
    if (read.error) return result('skipped', 'safe pages not upgraded', { problems: [`${read.error}, so nothing was tried`] })
    const picks = orderEnrichable(rows, read.attempts, now, { force: opts.force })
    if (!picks.length) return result('skipped', 'no safe page is due for an upgrade try (spacing or the 3-try cap)')
    if (opts.dry) return result('skipped', `dry run: ${picks.length} safe page(s) could be tried, first ${guidePath(str(picks[0].kind) as GuideKind, str(picks[0].slug))}`)

    // The deadline and the budget are checked before anything is claimed or recorded, so a day with no room costs no try.
    if (opts.deadlineMs !== undefined && opts.deadlineMs - Date.now() < ENRICH_MIN_MS) return result('deferred', 'safe page upgrade waits for the next run (not enough time left today)')
    const budget = opts.budget ?? (await openBudget(admin, now))
    if (!budget.readable) return result('deferred', `safe page upgrade waits (${budget.reason ?? 'the heal counters could not be read'})`)
    if (budget.remaining() < ENRICH_MIN_BUDGET) return result('deferred', `safe page upgrade waits for tomorrow (only ${budget.remaining()} heal calls left today, it needs ${ENRICH_MIN_BUDGET})`)

    const loadBrief = opts.loadBrief ?? defaultEnrichBrief
    const problems: string[] = []
    for (const row of picks.slice(0, 20)) {
      const key = enrichKey(str(row.kind), str(row.slug))
      const path = guidePath(str(row.kind) as GuideKind, str(row.slug))
      let brief: EnrichBrief | null = null
      try {
        brief = await loadBrief(row, admin)
      } catch (e) {
        problems.push(`${path}: could not rebuild its facts (${e instanceof Error ? e.message : 'unknown error'})`)
      }
      if (!brief) continue
      // A named property whose name is not in stored package data may not be a real business: it is passed over (no AI spent, no try used).
      if (!nameIsStored(str(row.kind), brief.ctx.grounding)) {
        await updateAttempt(admin, key, (old) => ({ n: old?.n ?? 0, at: old?.at ?? '', last: old?.last ?? '', skip: 'its name is not in stored package data, so it is left as it is' })).catch(() => undefined)
        continue
      }
      // The once-a-day marker, taken only now that a real try will start.
      if (!opts.force && !(await claimDailyOnce(admin, 'safe-enrich', now))) return result('skipped', 'already tried a safe page today', { problems })
      return await enrichOne(admin, row, brief, budget, now, opts, problems)
    }
    return result('skipped', 'no safe page could be upgraded (its facts could not be rebuilt, or its name is not in stored package data)', { problems })
  } catch (e) {
    const why = e instanceof Error ? e.message : 'unknown error'
    return result('failed', `safe page upgrade failed: ${why}`, { problems: [`safe page upgrade failed: ${why}`] })
  }
}

async function enrichOne(admin: SupabaseClient, row: Row, brief: EnrichBrief, budget: HealBudget, now: Date, opts: EnrichOpts, problems: string[]): Promise<EnrichResult> {
  const kind = str(row.kind) as GuideKind
  const slug = str(row.slug)
  const key = enrichKey(kind, slug)
  const path = guidePath(kind, slug)
  const base = { path, problems }
  const stamp = now.toISOString()
  let calls = 0

  // The try is recorded BEFORE any AI spend, so a crash or a timeout still uses it up (the spend stays bounded).
  let prior: EnrichAttempt | undefined
  const recorded = await updateAttempt(admin, key, (old) => {
    prior = old
    return { n: (old?.n ?? 0) + 1, at: stamp, last: 'started' }
  })
  if (recorded) return result('failed', 'safe page upgrade not started', { ...base, problems: [...problems, `${path}: could not record the try (${recorded}), so nothing was tried`] })
  const finish = async (action: EnrichAction, why: string, extra: Partial<EnrichResult> = {}): Promise<EnrichResult> => {
    // Keep the count the start of this try made; only the plain-words result changes.
    await updateAttempt(admin, key, (old) => (old ? { ...old, last: why.slice(0, 280) } : { n: 1, at: stamp, last: why.slice(0, 280) })).catch(() => undefined)
    return result(action, `${path}: ${why}`, { ...base, tried: 1, calls, ...extra })
  }

  if (!(await budget.take(ENRICH_WRITER_CALLS))) {
    // Nothing was spent, so this does not use up one of the guide's tries.
    await updateAttempt(admin, key, () => prior ?? null).catch(() => undefined)
    return result('deferred', `${path}: today's heal limit ran out before the page could be written, so it waits`, { ...base })
  }
  calls += ENRICH_WRITER_CALLS
  const composed = await brief.compose()
  if ('error' in composed) return finish('failed', `the writer could not write it again (${composed.error})`)
  const fresh = composed.guide
  if (fresh.name !== str(row.name)) fresh.name = str(row.name)

  // The full heal ladder, but with no safe-page rung (none is given) and no deleteFallback (so no whole-section deletion). The independent
  // judge is always required. healLoop itself writes nothing: the edits are made below, against the SAFE PAGE text, so Undo restores it.
  const cfg: GuideRepairCfg = { kind, name: fresh.name, grounding: brief.ctx.grounding, names: brief.ctx.names ?? [], links: brief.links, limits: GUIDE_LIMITS }
  const built = buildGuideItem(fresh, brief.ctx, { path, links: brief.links })
  const target: HealTarget = {
    type: 'guide',
    key: `guide:${kind}:${slug}`,
    path,
    item: { ...built, detect: (f: RepairFields, blockers: string[]) => guideOffenders(f, cfg, blockers) },
    brief: brief.ctx.grounding,
    repair: (f, blockers, tracker) => repairGuideFields(f, cfg, blockers, tracker),
  }
  const outcome = await healLoop(target, { model: opts.model ?? modelCallFor('heal-loop'), budget, deadlineMs: Math.min(Date.now() + PER_ITEM_MS, opts.deadlineMs ?? Number.MAX_SAFE_INTEGER), requireJudge: true })
  calls += outcome.calls
  await appendHealLog(admin, { at: stamp, type: 'guide', path, status: outcome.status, rounds: outcome.rounds, calls: outcome.calls, ladder: outcome.ladder, reason: `safe page upgrade: ${outcome.status === 'healed' || outcome.status === 'already_clean' ? outcome.note : outcome.reasons[0] ?? outcome.note}` }).catch(() => undefined)

  if (outcome.status === 'deferred') return finish('deferred', `the upgrade could not finish today (${outcome.reasons[0] ?? outcome.note})`)
  if (outcome.status === 'rejected_by_heal') return finish('failed', `the new text did not pass the checks and the QA review (${outcome.reasons[0] ?? outcome.note}); the safe page stays`)
  if (outcome.ladder.includes('safe-page')) return finish('failed', 'the heal ended in a safe page again; the safe page stays')

  const fields = outcome.fields
  const next = guideFrom(fresh, fields)
  // Belt and braces: the final text must be clean for the gate, split into sections, and clearly fuller than what is live.
  const finalBlockers = guideBlockers(next, brief.ctx)
  if (finalBlockers.length) return finish('failed', `the final text still failed the checks (${finalBlockers[0]}); the safe page stays`)
  const parsed = parseArticle(`${next.summary}\n\n${next.body}`)
  if (!parsed) return finish('failed', 'the new text did not split into sections; the safe page stays')
  const short = enrichmentShortfall({ summary: str(row.summary), body: str(row.body) }, { summary: next.summary, body: next.body })
  if (short) return finish('failed', `${short}; the safe page stays`)

  // ---- replace the text: log first (against the safe page text), then apply, guarded against a change made meanwhile ----
  const before = guideFields(composedGuideFromRow(row))
  const after: RepairFields = { ...guideFields(next) }
  const changed = TEXT_FIELDS.filter((f) => serializeField('guide', before, f) !== serializeField('guide', after, f))
  const per = changed.length ? Math.round(((calls * EST_COST_USD_PER_CALL) / changed.length) * 10000) / 10000 : 0
  const edits: ContentEdit[] = changed.map((field) => ({
    content_type: 'guide',
    content_id: str(row.id),
    path,
    field,
    reason: `${ENRICH_REASON_PREFIX} replaced the safe page with a full page written from the stored brief (passed the checks and the independent QA review)`,
    before: serializeField('guide', before, field),
    after: serializeField('guide', after, field),
    method: 'generate',
    published_after: true,
    cost_usd: per,
  }))
  const logged = await insertEdits(admin, edits)
  if (logged.error) return finish('failed', `the audit log could not be written (${logged.error}); the safe page stays`)
  let update = admin
    .from('guides')
    .update({
      summary: next.summary,
      body: next.body,
      sections: parsed.sections,
      faq: next.faq,
      key_takeaways: next.key_takeaways,
      meta_title: next.meta_title || null,
      meta_description: next.meta_description || null,
      og_title: next.og_title || null,
      og_description: next.og_description || null,
      quality_notes: null,
      updated_at: stamp,
    })
    .eq('id', str(row.id))
    .eq('status', 'published')
    .like('quality_notes', 'safe-page:%')
  update = row.updated_at ? update.eq('updated_at', row.updated_at as string) : update.is('updated_at', null)
  const { data: saved, error: saveError } = await update.select('id')
  if (saveError || !saved?.length) {
    await deleteEdits(admin, logged.ids).catch(() => undefined)
    return finish('failed', saveError ? `could not save the new text (${saveError.message}); the safe page stays` : 'the page was changed by someone else meanwhile, so the safe page was left alone')
  }
  await finalizeEdits(admin, logged.ids, { id: str(row.id), path, published: true })
  // Done: the page is a full page now, so its record is dropped (a later safe page of the same guide would start fresh).
  await updateAttempt(admin, key, () => null).catch(() => undefined)
  await pingIndexNow([path, guideKinds[kind].urlPrefix, '/sitemap.xml']).catch(() => undefined)
  return result('enriched', `${path}: upgraded from a safe page to a full page (${wordsOf(next.summary, next.body)} words, ${sectionCountOf(next.body)} sections); indexing resumes`, { ...base, tried: 1, enriched: 1, calls, ladder: outcome.ladder })
}

// ---------------------------------------------------------------------------------------------------
// What the admin sees
// ---------------------------------------------------------------------------------------------------

export interface SafePageLine {
  kind: string
  slug: string
  name: string
  path: string
  attempts: number
  maxAttempts: number
  lastAt: string | null
  last: string
  skip: string | null
  state: 'ready' | 'waiting' | 'used-up' | 'left-alone'
  /** Plain words for the line on the Guide Pages screen. */
  text: string
}

/** One safe page as one line. Pure. */
export function describeSafePage(row: Row, attempt: EnrichAttempt | undefined, now: Date): SafePageLine {
  const kind = str(row.kind)
  const slug = str(row.slug)
  const n = attempt?.n ?? 0
  const block = enrichBlockReason(row, attempt, now)
  const state: SafePageLine['state'] = block === null ? 'ready' : /all \d+ upgrade attempts/.test(block) ? 'used-up' : /next try not before/.test(block) ? 'waiting' : 'left-alone'
  const skip = attempt?.skip ?? null
  const text = state === 'used-up' ? `${n} of ${ENRICH_MAX_ATTEMPTS} tries used, stays a safe page` : state === 'waiting' ? `${n} of ${ENRICH_MAX_ATTEMPTS} tries used; ${block}` : state === 'left-alone' ? `left alone: ${block}` : skip && n === 0 ? `not tried: ${skip}` : `${n} of ${ENRICH_MAX_ATTEMPTS} tries used, due for its next try`
  return { kind, slug, name: str(row.name), path: guidePath(kind as GuideKind, slug), attempts: n, maxAttempts: ENRICH_MAX_ATTEMPTS, lastAt: attempt?.at || null, last: attempt?.last ?? '', skip, state, text }
}

/** Every live safe page with its enrichment attempts. Read only. */
export async function listSafePages(admin: SupabaseClient, now: Date = new Date()): Promise<{ pages: SafePageLine[]; error?: string }> {
  try {
    const { data, error } = await admin.from('guides').select('id, kind, slug, name, status, source, quality_notes, created_at').eq('status', 'published').like('quality_notes', 'safe-page:%').order('created_at', { ascending: true }).limit(READ_LIMIT)
    if (error) return { pages: [], error: error.message }
    const read = await readEnrichAttempts(admin)
    const pages = ((data ?? []) as Row[]).filter((r) => isSafePageNote(str(r.quality_notes))).map((r) => describeSafePage(r, read.attempts[enrichKey(str(r.kind), str(r.slug))], now))
    return { pages, ...(read.error ? { error: read.error } : {}) }
  } catch (e) {
    return { pages: [], error: e instanceof Error ? e.message : 'unknown error' }
  }
}
