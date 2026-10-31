import type { SupabaseClient } from '@supabase/supabase-js'
import { isAiConfigured } from '@/lib/ai-verify'
import { getSettingStrict, setSetting } from '@/lib/app-settings'
import { columnsFor, deleteEdits, editsLoggable, insertEdits, recordRepairSpend, repairDay, revertEdit, storedValue } from '@/lib/content-edits'
import {
  cloneFields,
  generateExtras,
  makeDetectCtx,
  modelCallFor,
  plainForPrompt,
  serializeField,
  EST_COST_USD_PER_CALL,
  MIN_MS_PER_CALL,
  type ContentEdit,
  type ContentType,
  type GenKey,
  type ModelCall,
  type RepairFields,
  type RepairLimits,
} from '@/lib/content-repair'
import { readLatestPerformance, type PerfRow } from '@/lib/ctr-loop'
import { guideKinds, GUIDE_KINDS, type GuideKind } from '@/lib/guides'
import { openBudget, type HealBudget } from '@/lib/heal-loop'
import { additionKey, enqueueAdditions, proposeVerdict, readQueue, readRejectStamp, type AdditionChange } from '@/lib/live-additions-review'
import { isNewsSlug } from '@/lib/news-post'
import { cleanAnchor, insertContextLink } from '@/lib/seo-links'
import { internalLinkPathsOf } from '@/lib/seo-score'

// The near page 1 refresh loop (sibling of lib/ctr-loop.ts). It runs INSIDE the daily heal-content step
// (lib/content-heal-run.ts): no new cron, and every model call is taken from the heal loop's own daily call budget
// (lib/heal-loop.ts openBudget), so it can never spend past the limit you set.
//
//  SWITCH   app_settings.refresh_loop_mode: "off" or "on". It is OFF unless the value is exactly "on" (unset, unreadable or
//           anything else means off). While off the loop reads nothing and writes nothing.
//  (a) FIND   published blog posts and guides whose average Google position is from REFRESH_MIN_POSITION to REFRESH_MAX_POSITION
//             with at least REFRESH_IMPRESSION_FLOOR impressions: just off page 1. content_performance holds the daily Search
//             Console snapshot; every value is a trailing 28-day total as of that day, so ONE day's row is read and days are
//             never added together. A snapshot older than REFRESH_MAX_SNAPSHOT_AGE_DAYS is refused.
//  (b) TRY    for at most REFRESH_PAGES_PER_DAY pages a day, and never the same page twice within REFRESH_COOLDOWN_DAYS:
//             1. up to REFRESH_MAX_LINKS internal links to real published pages about the same destination that the page does
//                not already link to (plain code, the same helpers as the SEO link engines; no model, nothing invented);
//             2. a missing FAQ or key takeaways list is written only by the heal's own generator (generateExtras, which runs the
//                no-fabrication filters) and is HELD for a person in the live additions review, exactly like the daily heal;
//             3. the visible updated date (updated_at) moves only when a link was really added.
//             Every live change is logged to content_edits BEFORE it is applied (so Undo works on the Content edits page).
//  (c) JUDGE  after REFRESH_EVAL_AFTER_DAYS the page position and clicks are compared with the baseline, and the links are
//             undone by themselves ONLY if the position got clearly worse (REFRESH_REVERT_POSITION_DROP places or more with
//             enough impressions). Otherwise the change stays.
//
// News posts (slug news-...) and trip pages are never touched. Nothing here publishes a page or rewrites a sentence.

// ---------------------------------------------------------------------------------------------------
// Tunables (all documented; none are secrets)
// ---------------------------------------------------------------------------------------------------

/** The settings key of the on/off switch. */
export const REFRESH_MODE_KEY = 'refresh_loop_mode'
/** Pages ranked better than this are already on page 1 (positions 1 to 7 are left alone). */
export const REFRESH_MIN_POSITION = 8
/** Pages ranked worse than this on average are too far down for a few links to matter. */
export const REFRESH_MAX_POSITION = 20
/** A page needs at least this many impressions (28 days) before its position means anything. */
export const REFRESH_IMPRESSION_FLOOR = 100
/** At most this many pages get a refresh a day. */
export const REFRESH_PAGES_PER_DAY = 2
/** At most this many internal links are added to one page. */
export const REFRESH_MAX_LINKS = 2
/** A page that was refreshed (or whose extras were turned down) is not touched again for this long. */
export const REFRESH_COOLDOWN_DAYS = 30
/** A page with nothing to add (no new link target, nothing missing) is looked at again after this long. */
export const REFRESH_RETRY_NOCHANGE_DAYS = 7
/** Compare this long after the change: 28 days of data plus Search Console's 2 day delay. */
export const REFRESH_EVAL_AFTER_DAYS = 30
/** Give up and keep the change if no usable numbers exist this long after it. */
export const REFRESH_GIVE_UP_DAYS = 60
/** Undo only when the average position got worse by this many places or more. */
export const REFRESH_REVERT_POSITION_DROP = 3
/** After the test the page needs at least this many impressions, otherwise the result is "too little data" and the change stays. */
export const REFRESH_MIN_AFTER_IMPRESSIONS = REFRESH_IMPRESSION_FLOOR / 2
/** The newest Search Console snapshot must be at most this old. */
export const REFRESH_MAX_SNAPSHOT_AGE_DAYS = 4

const EXPERIMENT_PREFIX = 'refresh_exp:'
const TRIED_PREFIX = 'refresh_tried:'
const SLOT_PREFIX = 'refresh_loop_slot'
/** The click-rate loop keeps its running tests under this prefix; a page in one of them is left alone so the two tests never mix. */
const CTR_EXPERIMENT_PREFIX = 'ctr_exp:'
const CALL_TIMEOUT_MS = 45_000
const DAY_MS = 86_400_000

// ---------------------------------------------------------------------------------------------------
// The switch
// ---------------------------------------------------------------------------------------------------

export type RefreshMode = 'off' | 'on'

/** "on" (any case, spaces ignored) is on; everything else, including unset, is off. Pure. */
export function parseRefreshMode(raw: string | null | undefined): RefreshMode {
  return (raw ?? '').trim().toLowerCase() === 'on' ? 'on' : 'off'
}

/** The switch, read fail-closed: a value that cannot be read means off. */
export async function getRefreshMode(admin: SupabaseClient): Promise<RefreshMode> {
  try {
    const r = await getSettingStrict(admin, REFRESH_MODE_KEY)
    return r.error ? 'off' : parseRefreshMode(r.value)
  } catch {
    return 'off'
  }
}

export async function setRefreshMode(admin: SupabaseClient, mode: RefreshMode): Promise<{ error?: string }> {
  if (mode !== 'off' && mode !== 'on') return { error: 'the mode must be off or on' }
  return setSetting(admin, REFRESH_MODE_KEY, mode)
}

// ---------------------------------------------------------------------------------------------------
// (a) Finding the pages just off page 1
// ---------------------------------------------------------------------------------------------------

export interface NearPageOne {
  path: string
  clicks: number
  impressions: number
  position: number
}

/** Pages with enough impressions whose average position is from REFRESH_MIN_POSITION to REFRESH_MAX_POSITION, most impressions first
 * (the most to gain). A missing number means "not recorded", never zero: that page is skipped. One entry per path. Pure. */
export function findNearPageOne(rows: PerfRow[], opts: { minPosition?: number; maxPosition?: number; floor?: number } = {}): NearPageOne[] {
  const minPos = opts.minPosition ?? REFRESH_MIN_POSITION
  const maxPos = opts.maxPosition ?? REFRESH_MAX_POSITION
  const floor = opts.floor ?? REFRESH_IMPRESSION_FLOOR
  const seen = new Set<string>()
  const out: NearPageOne[] = []
  for (const r of rows) {
    if (r.clicks === null || r.impressions === null || r.position === null || r.clicks === undefined || r.impressions === undefined || r.position === undefined) continue
    const clicks = Number(r.clicks)
    const impressions = Number(r.impressions)
    const position = Number(r.position)
    if (!r.path || seen.has(r.path) || !Number.isFinite(clicks) || !Number.isFinite(impressions) || !Number.isFinite(position)) continue
    if (impressions < floor || position < minPos || position > maxPos) continue
    seen.add(r.path)
    out.push({ path: r.path, clicks, impressions, position })
  }
  return out.sort((a, b) => b.impressions - a.impressions || a.position - b.position || a.path.localeCompare(b.path))
}

/** True for a path this loop may ever edit: a blog post (not a travel news post) or a guide page. A trip page, an index page, the
 * home page or anything else is never. Pure. */
export function isRefreshablePath(path: string): boolean {
  const clean = path.split(/[?#]/)[0].replace(/\/+$/, '')
  const blog = /^\/blog\/([^/]+)$/.exec(clean)?.[1]
  if (blog) return !isNewsSlug(blog)
  return GUIDE_KINDS.some((k) => {
    const prefix = `${guideKinds[k].urlPrefix}/`
    return clean.startsWith(prefix) && clean.length > prefix.length && !clean.slice(prefix.length).includes('/')
  })
}

// ---------------------------------------------------------------------------------------------------
// (b) The links
// ---------------------------------------------------------------------------------------------------

export interface RefreshTarget {
  path: string
  title: string
  dest: string | null
  rank: number
}

/** The real pages this page may link to: they share a destination with it, exist on the site now, are not the page itself and are not
 * already linked from it. Best first (the heal's own order: destination page, then guide, best time, trip), at most `max`. Pure. */
export function chooseLinkTargets(input: { selfPath: string; text: string; destSlugs: string[]; existing: ReadonlySet<string>; targets: readonly RefreshTarget[]; max?: number }): RefreshTarget[] {
  const have = new Set(internalLinkPathsOf(input.text))
  have.add(input.selfPath.replace(/\/+$/, ''))
  const out: RefreshTarget[] = []
  const used = new Set<string>()
  const ordered = [...input.targets].sort((a, b) => a.rank - b.rank || a.path.localeCompare(b.path))
  for (const t of ordered) {
    if (out.length >= (input.max ?? REFRESH_MAX_LINKS)) break
    const path = t.path.replace(/\/+$/, '')
    if (t.dest === null || !input.destSlugs.includes(t.dest) || !input.existing.has(path) || have.has(path) || used.has(path)) continue
    if (!t.title.trim() || cleanAnchor(t.title).length < 2) continue
    used.add(path)
    out.push({ ...t, path })
  }
  return out
}

/** Adds one link per chosen target with the SEO link engines' own helper (inside an existing sentence where the page already names the
 * target, otherwise one "Related reading" line). A link that cannot be placed safely is skipped. Returns the new text and the paths
 * that really made it in. Pure. */
export function addRefreshLinks(text: string, chosen: readonly RefreshTarget[], max = REFRESH_MAX_LINKS): { text: string; added: string[] } {
  let next = text
  const added: string[] = []
  for (const t of chosen) {
    if (added.length >= max) break
    const made = insertContextLink(next, t.title, t.path)
    if (!made || !internalLinkPathsOf(made.body).includes(t.path.replace(/\/+$/, ''))) continue
    next = made.body
    added.push(t.path)
  }
  return { text: next, added }
}

/** Which of FAQ and key takeaways a page has nothing in at all. Only empty lists are filled; a list a person started is left alone. Pure. */
export function missingExtraKeys(fields: Pick<RepairFields, 'faq' | 'key_takeaways'>): GenKey[] {
  const out: GenKey[] = []
  if (fields.faq.length === 0) out.push('faq')
  if (fields.key_takeaways.length === 0) out.push('key_takeaways')
  return out
}

// ---------------------------------------------------------------------------------------------------
// The page behind a path
// ---------------------------------------------------------------------------------------------------

type Row = Record<string, unknown>
const str = (v: unknown) => (typeof v === 'string' ? v : '')

export interface RefreshPage {
  type: Extract<ContentType, 'post' | 'guide'>
  path: string
  row: Row
}

/** The live post or guide behind a site path. Null for a news post, a trip page, a page that is not published or a table that cannot be read. */
export async function resolveRefreshPage(admin: SupabaseClient, path: string): Promise<RefreshPage | null> {
  if (!isRefreshablePath(path)) return null
  const clean = path.split(/[?#]/)[0].replace(/\/+$/, '')
  try {
    const blog = /^\/blog\/([^/]+)$/.exec(clean)?.[1]
    if (blog) {
      const { data } = await admin.from('posts').select('*').eq('slug', blog).eq('status', 'published').maybeSingle()
      return data ? { type: 'post', path: clean, row: data as Row } : null
    }
    const kind = GUIDE_KINDS.find((k) => clean.startsWith(`${guideKinds[k].urlPrefix}/`)) as GuideKind | undefined
    if (!kind) return null
    const slug = clean.slice(guideKinds[kind].urlPrefix.length + 1)
    const { data } = await admin.from('guides').select('*').eq('kind', kind).eq('slug', slug).eq('status', 'published').maybeSingle()
    return data ? { type: 'guide', path: clean, row: data as Row } : null
  } catch {
    return null
  }
}

/** What the loop needs to know about a page. The heal builds it from its own item builders, so the destination and the fields are the heal's. */
export interface RefreshPageItem {
  type: ContentType
  path: string
  label: string
  fields: RepairFields
  keyword: string | null
  limits: RepairLimits
  destSlugs: string[]
  names: string[]
}

/** The site's pages, passed in by the heal (which has already built them) so this file reads no extra page list. */
export interface RefreshIndex {
  existing: ReadonlySet<string>
  targets: readonly RefreshTarget[]
  itemFor(type: ContentType, row: Row): RefreshPageItem | null
}

// ---------------------------------------------------------------------------------------------------
// The experiment record (one app_settings row per test)
// ---------------------------------------------------------------------------------------------------

export type RefreshStatus = 'running' | 'kept' | 'reverted' | 'inconclusive' | 'undone_by_person' | 'revert_blocked'

export interface RefreshExperiment {
  path: string
  type: RefreshPage['type']
  contentId: string
  startedAt: string
  addedLinks: string[]
  baselinePosition: number
  baselineClicks: number
  baselineImpressions: number
  editIds: string[]
  status: RefreshStatus
  evaluatedAt?: string
  afterPosition?: number
  afterClicks?: number
  afterImpressions?: number
  note?: string
}

export const refreshExperimentKey = (path: string, startedAt: string) => `${EXPERIMENT_PREFIX}${startedAt.slice(0, 10)}:${path}`

export function parseRefreshExperiment(raw: string | null | undefined): RefreshExperiment | null {
  try {
    const e = JSON.parse(raw ?? 'null') as Partial<RefreshExperiment> | null
    if (!e || typeof e.path !== 'string' || typeof e.startedAt !== 'string' || !Number.isFinite(Date.parse(e.startedAt)) || !Array.isArray(e.editIds) || typeof e.status !== 'string') return null
    return e as RefreshExperiment
  } catch {
    return null
  }
}

/** The first day (YYYY-MM-DD) whose 28-day snapshot is entirely after the change. Pure. */
export function refreshEvalDayOf(startedAt: string): string {
  return new Date(Date.parse(startedAt) + REFRESH_EVAL_AFTER_DAYS * DAY_MS).toISOString().slice(0, 10)
}

export type RefreshDecision = 'revert' | 'keep' | 'inconclusive'

/** Compares the average position before and after. Reverts ONLY when the position got worse by REFRESH_REVERT_POSITION_DROP places or
 * more and the page still has enough impressions to trust the number; every other result keeps the change and says why. Pure. */
export function decideRefresh(
  baseline: { position: number; clicks: number; impressions: number },
  after: { position: number | null; clicks: number | null; impressions: number | null },
): { decision: RefreshDecision; reason: string } {
  const imp = Number(after.impressions)
  if (after.impressions === null || !Number.isFinite(imp) || imp < REFRESH_MIN_AFTER_IMPRESSIONS) return { decision: 'inconclusive', reason: 'too few impressions after the change to judge' }
  const pos = Number(after.position)
  if (after.position === null || !Number.isFinite(pos)) return { decision: 'inconclusive', reason: 'no average position after the change' }
  const moved = pos - baseline.position
  const clicksNote = after.clicks === null || !Number.isFinite(Number(after.clicks)) ? '' : `; clicks went from ${baseline.clicks} to ${Number(after.clicks)}`
  if (moved >= REFRESH_REVERT_POSITION_DROP) return { decision: 'revert', reason: `position got worse, from ${baseline.position.toFixed(1)} to ${pos.toFixed(1)}${clicksNote}` }
  return { decision: 'keep', reason: `position went from ${baseline.position.toFixed(1)} to ${pos.toFixed(1)}${clicksNote}` }
}

/** True while a page is still resting after an earlier attempt or test. Pure. */
export function isRefreshResting(t: { at: string; outcome: string } | undefined, now: number): boolean {
  if (!t) return false
  const age = now - Date.parse(t.at)
  if (!Number.isFinite(age)) return false
  return age < (t.outcome === 'nochange' ? REFRESH_RETRY_NOCHANGE_DAYS : REFRESH_COOLDOWN_DAYS) * DAY_MS
}

// ---------------------------------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------------------------------

export interface RefreshLoopResult {
  calls: number
  changedPaths: string[]
  problems: string[]
  note: string
  started: number
  /** Pages whose missing FAQ or takeaways were written and held for a person to approve. */
  queued: number
  checked: number
  reverted: number
  active: boolean
}

export interface RefreshLoopOpts {
  index: RefreshIndex
  deadlineMs?: number
  now?: Date
  /** Replaces the model (checks use a stub; nothing here may reach a paid API from a check). */
  model?: ModelCall
  budget?: HealBudget
}

interface TriedRow {
  at: string
  outcome: string
}

async function readTried(admin: SupabaseClient): Promise<Map<string, TriedRow> | string> {
  const { data, error } = await admin.from('app_settings').select('key, value').like('key', `${TRIED_PREFIX}%`)
  if (error) return error.message
  const out = new Map<string, TriedRow>()
  for (const r of (data ?? []) as { key: string; value: string }[]) {
    try {
      const v = JSON.parse(r.value) as TriedRow
      if (typeof v.at === 'string') out.set(r.key.slice(TRIED_PREFIX.length), v)
    } catch {
      // an unreadable marker is ignored: the page may be tried again, still capped by the daily slots
    }
  }
  return out
}

async function markTried(admin: SupabaseClient, path: string, outcome: 'touched' | 'rejected' | 'nochange' | 'finished', now: Date): Promise<void> {
  await setSetting(admin, `${TRIED_PREFIX}${path}`, JSON.stringify({ at: now.toISOString(), outcome })).catch(() => undefined)
}

/** Claims one of today's REFRESH_PAGES_PER_DAY slots (an atomic unique-key insert, like the heal's repair slots). False when taken or unreadable. */
async function claimSlot(admin: SupabaseClient, path: string, day: string): Promise<{ ok: boolean; problem?: string }> {
  const prefix = `${SLOT_PREFIX}:${day}:`
  const { data, error } = await admin.from('app_settings').select('key').like('key', `${prefix}%`)
  if (error) return { ok: false, problem: `could not read today's refresh slots (${error.message})` }
  const taken = new Set(((data ?? []) as { key: string }[]).map((r) => r.key))
  for (let n = 1; n <= REFRESH_PAGES_PER_DAY; n++) {
    if (taken.has(`${prefix}${n}`)) continue
    const { error: insertError } = await admin.from('app_settings').insert({ key: `${prefix}${n}`, value: path })
    if (!insertError) return { ok: true }
    if ((insertError as { code?: string }).code !== '23505') return { ok: false, problem: `could not claim a refresh slot (${insertError.message})` }
  }
  return { ok: false }
}

async function slotsLeftToday(admin: SupabaseClient, day: string): Promise<number | null> {
  const { data, error } = await admin.from('app_settings').select('key').like('key', `${SLOT_PREFIX}:${day}:%`)
  return error ? null : Math.max(0, REFRESH_PAGES_PER_DAY - (data ?? []).length)
}

async function readExperiments(admin: SupabaseClient): Promise<{ key: string; exp: RefreshExperiment }[] | string> {
  const { data, error } = await admin.from('app_settings').select('key, value').like('key', `${EXPERIMENT_PREFIX}%`)
  if (error) return error.message
  const out: { key: string; exp: RefreshExperiment }[] = []
  for (const r of (data ?? []) as { key: string; value: string }[]) {
    const exp = parseRefreshExperiment(r.value)
    if (exp) out.push({ key: r.key, exp })
  }
  return out
}

/** Paths with a running click-rate title test. Unreadable means "none known", and the 30 day rest still applies to everything else. */
async function ctrBusyPaths(admin: SupabaseClient): Promise<Set<string>> {
  const out = new Set<string>()
  try {
    const { data } = await admin.from('app_settings').select('key, value').like('key', `${CTR_EXPERIMENT_PREFIX}%`)
    for (const r of (data ?? []) as { value: string }[]) {
      try {
        const v = JSON.parse(r.value) as { path?: unknown; status?: unknown }
        if (typeof v.path === 'string' && v.status === 'running') out.add(v.path)
      } catch {
        // skip an unreadable record
      }
    }
  } catch {
    // nothing known
  }
  return out
}

/** Checks every running test: undone by a person, due for its comparison, or still waiting. Free (no model). */
async function evaluateExperiments(admin: SupabaseClient, now: Date, out: RefreshLoopResult): Promise<void> {
  const all = await readExperiments(admin)
  if (typeof all === 'string') {
    out.problems.push(`refresh test: could not read the running tests (${all})`)
    return
  }
  const running = all.filter((x) => x.exp.status === 'running')
  if (running.length === 0) return
  const ids = running.flatMap((x) => x.exp.editIds)
  const reverted = new Map<string, boolean>()
  if (ids.length) {
    const { data, error } = await admin.from('content_edits').select('id, reverted_at').in('id', ids)
    if (error) {
      out.problems.push(`refresh test: could not read the change log (${error.message})`)
      return
    }
    for (const r of (data ?? []) as { id: string; reverted_at: string | null }[]) reverted.set(r.id, !!r.reverted_at)
  }
  const save = async (key: string, exp: RefreshExperiment) => {
    const saved = await setSetting(admin, key, JSON.stringify(exp))
    if (saved.error) out.problems.push(`refresh test: could not save the result for ${exp.path} (${saved.error})`)
  }
  for (const { key, exp } of running) {
    const live = exp.editIds.filter((id) => reverted.get(id) === false)
    if (live.length === 0) {
      // A person pressed Undo on the Content edits page, or the edit rows are gone: the test is over and the page stays as they left it.
      await save(key, { ...exp, status: 'undone_by_person', evaluatedAt: now.toISOString(), note: 'undone by a person before the comparison' })
      await markTried(admin, exp.path, 'finished', now)
      out.checked++
      continue
    }
    const dueDay = refreshEvalDayOf(exp.startedAt)
    if (now.toISOString().slice(0, 10) < dueDay) continue
    const ageDays = (now.getTime() - Date.parse(exp.startedAt)) / DAY_MS
    const perf = await admin.from('content_performance').select('day, clicks, impressions, position').eq('path', exp.path).gte('day', dueDay).order('day', { ascending: false }).limit(1)
    if (perf.error) {
      out.problems.push(`refresh test: could not read the numbers for ${exp.path} (${perf.error.message})`)
      continue
    }
    const row = perf.data?.[0] as { day: string; clicks: number | null; impressions: number | null; position: number | null } | undefined
    if (!row) {
      if (ageDays > REFRESH_GIVE_UP_DAYS) {
        await save(key, { ...exp, status: 'inconclusive', evaluatedAt: now.toISOString(), note: 'no Search Console numbers for this page after the change; the change stays' })
        await markTried(admin, exp.path, 'finished', now)
        out.checked++
      }
      continue
    }
    const num = (v: number | null) => (v === null ? null : Number(v))
    const verdict = decideRefresh({ position: exp.baselinePosition, clicks: exp.baselineClicks, impressions: exp.baselineImpressions }, { position: num(row.position), clicks: num(row.clicks), impressions: num(row.impressions) })
    const after = { afterPosition: Number(row.position), afterClicks: Number(row.clicks), afterImpressions: Number(row.impressions), evaluatedAt: now.toISOString() }
    out.checked++
    if (verdict.decision !== 'revert') {
      await save(key, { ...exp, ...after, status: verdict.decision === 'keep' ? 'kept' : 'inconclusive', note: verdict.reason })
      await markTried(admin, exp.path, 'finished', now)
      continue
    }
    // The position got clearly worse: put the old body back with the same Undo the Content edits page uses. No force: a body changed
    // since by someone else is left alone, and the test says so.
    let blocked = ''
    for (const id of live) {
      const r = await revertEdit(admin, id, { skipSiblingUnpublish: true })
      if (!r.ok) blocked = r.needsForce ? 'the page was changed again after the test started, so it was left as it is' : (r.error ?? 'the change could not be undone')
    }
    if (blocked) {
      await save(key, { ...exp, ...after, status: 'revert_blocked', note: `${verdict.reason}; ${blocked}` })
      if (!/changed again/.test(blocked)) out.problems.push(`refresh test: ${exp.path} should be undone but ${blocked}`)
    } else {
      await save(key, { ...exp, ...after, status: 'reverted', note: verdict.reason })
      out.reverted++
    }
    await markTried(admin, exp.path, 'finished', now)
  }
}

/** The whole loop for one daily heal run. Never throws; every problem is returned as plain text for Needs attention. */
export async function runRefreshLoop(admin: SupabaseClient, opts: RefreshLoopOpts): Promise<RefreshLoopResult> {
  const now = opts.now ?? new Date()
  const out: RefreshLoopResult = { calls: 0, changedPaths: [], problems: [], note: '', started: 0, queued: 0, checked: 0, reverted: 0, active: false }
  const lines: string[] = []
  try {
    // The switch comes first. Off (or unreadable) means nothing is read and nothing is written.
    if ((await getRefreshMode(admin)) !== 'on') return out
    if (!(await editsLoggable(admin))) return { ...out, note: 'refresh test: waiting for the change log (migration 0033)' }

    // (c) finish the tests that are due. Free.
    await evaluateExperiments(admin, now, out)
    if (out.checked) lines.push(`checked ${out.checked} earlier refresh${out.checked === 1 ? '' : 'es'}${out.reverted ? ` (${out.reverted} undone because the position got worse)` : ''}`)

    // (a, b) start new refreshes. Needs today's slots and a fresh snapshot.
    const day = repairDay(now)
    const left = await slotsLeftToday(admin, day)
    if (left === null) {
      out.problems.push('refresh test: could not read how many pages were refreshed today, so none was')
      return finish(out, lines)
    }
    if (left === 0) return finish(out, lines)

    const perf = await readLatestPerformance(admin, now, REFRESH_MAX_SNAPSHOT_AGE_DAYS)
    if ('skip' in perf) {
      if (perf.problem) out.problems.push(`refresh test: ${perf.problem}`)
      return finish(out, lines)
    }
    const candidates = findNearPageOne(perf.rows).filter((c) => isRefreshablePath(c.path))
    if (candidates.length === 0) return finish(out, lines)

    const tried = await readTried(admin)
    if (typeof tried === 'string') {
      out.problems.push(`refresh test: could not read which pages were refreshed before (${tried}), so none was`)
      return finish(out, lines)
    }
    const exps = await readExperiments(admin)
    if (typeof exps === 'string') {
      out.problems.push(`refresh test: could not read the running tests (${exps}), so none was started`)
      return finish(out, lines)
    }
    const busy = new Set(exps.filter((x) => x.exp.status === 'running').map((x) => x.exp.path))
    for (const p of await ctrBusyPaths(admin)) busy.add(p)

    const model = opts.model ?? (isAiConfigured() ? modelCallFor('refresh-loop') : null)
    let budget: HealBudget | null = opts.budget ?? null
    let additions = await readQueue(admin)
    // An object, not a plain variable: the closure below sets it, and TypeScript would otherwise narrow it to null.
    const st = { stop: null as 'budget' | 'time' | null }
    const callVia = (b: HealBudget): ModelCall => async (prompt, maxTokens) => {
      if (!model) return null
      if (opts.deadlineMs !== undefined && opts.deadlineMs - Date.now() < MIN_MS_PER_CALL) {
        st.stop = 'time'
        return null
      }
      if (!(await b.take(1))) {
        st.stop = 'budget'
        return null
      }
      out.calls++
      const timeout = opts.deadlineMs === undefined ? CALL_TIMEOUT_MS : Math.max(5_000, Math.min(CALL_TIMEOUT_MS, opts.deadlineMs - Date.now() - 3_000))
      try {
        return await model(prompt, maxTokens, timeout)
      } catch {
        return null
      }
    }

    const notes: string[] = []
    let pagesDone = 0
    for (const c of candidates) {
      if (pagesDone >= left || st.stop === 'time') break
      if (busy.has(c.path) || isRefreshResting(tried.get(c.path), now.getTime())) continue
      const page = await resolveRefreshPage(admin, c.path)
      if (!page) continue
      const item = opts.index.itemFor(page.type, page.row)
      if (!item) continue

      // The plan, before anything is claimed or paid for.
      const text = storedValue(page.type, page.row, 'links')
      const plan = addRefreshLinks(text, chooseLinkTargets({ selfPath: page.path, text, destSlugs: item.destSlugs, existing: opts.index.existing, targets: opts.index.targets }))
      const keys = model ? missingExtraKeys(item.fields) : []
      const addKey = additionKey(page.type, String(page.row.id))
      let wantExtras = keys.length > 0 && proposeVerdict(additions, addKey, await readRejectStamp(admin, addKey)).ok
      let budgetShort = false
      if (wantExtras && !budget) budget = await openBudget(admin, now)
      if (wantExtras && (!budget || !budget.readable || budget.remaining() < 1)) {
        wantExtras = false
        budgetShort = true
      }
      if (plan.added.length === 0 && !wantExtras) {
        // Nothing to do. Only a page held back by an empty or unreadable heal budget is not marked: it is looked at again once there is room.
        if (!budgetShort) await markTried(admin, c.path, 'nochange', now)
        continue
      }

      const slot = await claimSlot(admin, c.path, day)
      if (!slot.ok) {
        if (slot.problem) out.problems.push(`refresh test: ${slot.problem}`)
        break
      }
      const callsBefore = out.calls
      pagesDone++

      // Missing FAQ or takeaways: the heal's own generator and filters, then HELD for a person (never applied here).
      const extraChanges: AdditionChange[] = []
      if (wantExtras && budget) {
        const bodyCtx = makeDetectCtx(item.type, plainForPrompt(item.fields), [...item.names, item.keyword ?? ''])
        const { got } = await generateExtras(callVia(budget), item.fields, keys, { ...item.limits, faqMin: Math.min(3, item.limits.faqMin) }, item.keyword, bodyCtx)
        const next = cloneFields(item.fields)
        if (got.faq) next.faq = got.faq
        if (got.key_takeaways) next.key_takeaways = got.key_takeaways
        for (const field of keys) {
          const before = serializeField(item.type, item.fields, field)
          const after = serializeField(item.type, next, field)
          if (before !== after) extraChanges.push({ field, before, after })
        }
      }

      // The links: read the page again so a body changed meanwhile is never overwritten, plan on the FRESH text, log, then apply.
      let linksApplied = 0
      const fresh = await resolveRefreshPage(admin, c.path)
      if (!fresh) {
        notes.push(`${c.path}: no longer a published page, left alone`)
      } else if (plan.added.length > 0) {
        const before = storedValue(fresh.type, fresh.row, 'links')
        const redo = addRefreshLinks(before, chooseLinkTargets({ selfPath: fresh.path, text: before, destSlugs: item.destSlugs, existing: opts.index.existing, targets: opts.index.targets }))
        const columns = redo.added.length ? (columnsFor(fresh.type, 'body', redo.text) as Row | null) : null
        if (!columns) {
          notes.push(`${c.path}: no safe place for a link now, left alone`)
        } else {
          const usedCalls = out.calls - callsBefore
          const edit: ContentEdit = {
            content_type: fresh.type,
            content_id: String(fresh.row.id),
            path: fresh.path,
            field: 'links',
            reason: `Near page 1 refresh: added ${redo.added.length} link${redo.added.length === 1 ? '' : 's'} to real pages about the same destination (${redo.added.join(', ')}). The page ranked around position ${c.position.toFixed(1)} on Google. It is checked after ${REFRESH_EVAL_AFTER_DAYS} days and undone by itself if its position gets ${REFRESH_REVERT_POSITION_DROP} or more places worse.`.slice(0, 480),
            before,
            after: redo.text,
            method: 'links',
            published_after: false,
            cost_usd: Math.round(usedCalls * EST_COST_USD_PER_CALL * 10000) / 10000,
          }
          const logged = await insertEdits(admin, [edit])
          if (logged.error || logged.ids.length === 0) {
            out.problems.push(`refresh test: the change log could not be written (${logged.error ?? 'no id'}), nothing was changed on ${fresh.path}`)
          } else {
            // The visible Updated date (updated_at) moves here, and only here: it is not touched when no link was added.
            let q = admin.from(fresh.type === 'post' ? 'posts' : 'guides').update({ ...columns, updated_at: now.toISOString() }).eq('status', 'published').eq('id', String(fresh.row.id))
            if (typeof fresh.row.updated_at === 'string') q = q.eq('updated_at', fresh.row.updated_at)
            const { data: written, error: updateError } = await q.select('id')
            if (updateError || !written || (written as unknown[]).length === 0) {
              await deleteEdits(admin, logged.ids)
              if (updateError) out.problems.push(`refresh test: could not update ${fresh.path} (${updateError.message})`)
              else notes.push(`${c.path}: changed while it was being checked, left alone`)
            } else {
              const exp: RefreshExperiment = {
                path: fresh.path,
                type: fresh.type,
                contentId: String(fresh.row.id),
                startedAt: now.toISOString(),
                addedLinks: redo.added,
                baselinePosition: c.position,
                baselineClicks: c.clicks,
                baselineImpressions: c.impressions,
                editIds: logged.ids,
                status: 'running',
              }
              const saved = await setSetting(admin, refreshExperimentKey(fresh.path, exp.startedAt), JSON.stringify(exp))
              if (saved.error) {
                // The change is live and logged (Undo works) but would never be compared: take it back so nothing runs unwatched.
                for (const id of logged.ids) await revertEdit(admin, id, { force: true, skipSiblingUnpublish: true })
                out.problems.push(`refresh test: could not save the test for ${fresh.path} (${saved.error}), so the change was undone`)
              } else {
                linksApplied = redo.added.length
                busy.add(fresh.path)
                out.started++
                out.changedPaths.push(fresh.path)
              }
            }
          }
        }
      }

      // The held FAQ or takeaways are queued last, once the live page is in the state their "before" text describes.
      let queuedNow = false
      if (extraChanges.length > 0) {
        const q = await enqueueAdditions(admin, { type: page.type, id: String(page.row.id), path: page.path, title: item.label || page.path, changes: extraChanges })
        if (q.queued) {
          queuedNow = true
          out.queued++
          additions = await readQueue(admin)
        } else notes.push(`${c.path}: could not hold the FAQ or takeaways for review (${q.reason})`)
      }
      await markTried(admin, c.path, linksApplied > 0 || queuedNow ? 'touched' : 'rejected', now)
    }
    // The day's estimated spend (a display number) counts every call made, kept or turned down.
    if (out.calls) await recordRepairSpend(admin, out.calls)
    if (out.started) lines.push(`refreshed ${out.started} page${out.started === 1 ? '' : 's'} with new internal links (${out.changedPaths.join(', ')})`)
    if (out.queued) lines.push(`${out.queued} missing FAQ or takeaways list${out.queued === 1 ? '' : 's'} held for review`)
    if (notes.length) lines.push(notes.join('; '))
    if (st.stop === 'budget') lines.push("stopped at today's heal limit")
    return finish(out, lines)
  } catch (e) {
    out.problems.push(`refresh test: ${e instanceof Error ? e.message : 'failed'}`)
    return finish(out, lines)
  }
}

function finish(out: RefreshLoopResult, lines: string[]): RefreshLoopResult {
  const note = lines.length ? `refresh test: ${lines.join('; ')}` : ''
  return { ...out, note, active: lines.length > 0 }
}
