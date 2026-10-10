import type { SupabaseClient } from '@supabase/supabase-js'
import { getSetting, getSettingStrict, setSetting } from '@/lib/app-settings'
import { isAiConfigured } from '@/lib/ai-verify'
import { pingIndexNow } from '@/lib/indexnow'
import { getComparePage } from '@/lib/compare-destinations'
import { getBestTimeToVisitPage } from '@/lib/best-time-to-visit'
import { getPublishedGuide } from '@/lib/guides'
import { deleteEdits } from '@/lib/content-edits'
import { finalizeEdits, repairComposedCopy } from '@/lib/content-repair-adapters'
import type { DbPackage } from '@/lib/packages'
import { composePageCopy, copyGroundingText, copyPublishDecision, linkedPackageSlugs, monthRange, pageCopyBlockers, MAX_BRIEF_PACKAGES_PER_DESTINATION, type CopyBriefDestination, type PageCopyBrief, type PageCopyPublishMode } from '@/lib/page-copy-composer'
import { STALE_COPY_KEY, clearCopyFailure, readCopyFailures, readCopyFailuresChecked, recentCopyFailureCount, recordCopyFailure, MAX_COPY_ATTEMPTS, COPY_BREAKER_FAILURES, COPY_BREAKER_HOURS } from '@/lib/page-copy-failures'
import {
  getPageCopyAdmin,
  listPageCopyCandidates,
  pageCopyCreatedSince,
  staleLinkedSlugs,
  pickNextCopyCandidate,
  savePageCopy,
  type PageCopy,
  type PageCopyCandidate,
  type PageCopyType,
} from '@/lib/page-copy'

// Writing compare and best-time page copy: the caps, the lock, the brief (real data only), the rotation and the
// one pipeline step. The AI and the quality gate are in lib/page-copy-composer.ts; the data in lib/page-copy.ts.

export const PAGE_COPY_PER_DAY_KEY = 'page_copy_per_day'
export const PAGE_COPY_PER_WEEK_KEY = 'page_copy_per_week'
export const DEFAULT_PAGE_COPY_PER_DAY = 1
export const DEFAULT_PAGE_COPY_PER_WEEK = 7
const MAX_PER_DAY = 5
const MAX_PER_WEEK = 21
const RUN_LOCK_KEY = 'page_copy_run_lock'
// A lock older than this is treated as a crashed run, so one stuck lock cannot stop page copy forever.
const RUN_LOCK_STALE_MS = 10 * 60 * 1000

function whole(raw: string | null, fallback: number, max: number): number {
  const n = Number(raw)
  return raw !== null && raw.trim() !== '' && Number.isInteger(n) && n >= 0 && n <= max ? n : fallback
}

export async function getPageCopyCaps(admin: SupabaseClient): Promise<{ perDay: number; perWeek: number }> {
  const [day, week] = await Promise.all([getSetting(admin, PAGE_COPY_PER_DAY_KEY), getSetting(admin, PAGE_COPY_PER_WEEK_KEY)])
  return { perDay: whole(day, DEFAULT_PAGE_COPY_PER_DAY, MAX_PER_DAY), perWeek: whole(week, DEFAULT_PAGE_COPY_PER_WEEK, MAX_PER_WEEK) }
}

export async function setPageCopyCaps(admin: SupabaseClient, perDay: number, perWeek: number): Promise<{ error?: string }> {
  if (!Number.isInteger(perDay) || perDay < 0 || perDay > MAX_PER_DAY) return { error: `pages per day must be a whole number from 0 to ${MAX_PER_DAY}` }
  if (!Number.isInteger(perWeek) || perWeek < 0 || perWeek > MAX_PER_WEEK) return { error: `pages per week must be a whole number from 0 to ${MAX_PER_WEEK}` }
  const a = await setSetting(admin, PAGE_COPY_PER_DAY_KEY, String(perDay))
  if (a.error) return a
  return setSetting(admin, PAGE_COPY_PER_WEEK_KEY, String(perWeek))
}

/** Best-effort lock so the admin button and the pipeline cannot both spend AI credits on page copy at once. */
async function acquireLock(admin: SupabaseClient): Promise<boolean> {
  const existing = await getSetting(admin, RUN_LOCK_KEY)
  if (existing) {
    const since = Date.parse(existing)
    if (!Number.isNaN(since) && Date.now() - since < RUN_LOCK_STALE_MS) return false
  }
  const { error } = await setSetting(admin, RUN_LOCK_KEY, new Date().toISOString())
  return !error
}

async function releaseLock(admin: SupabaseClient): Promise<void> {
  await setSetting(admin, RUN_LOCK_KEY, '')
}

export interface CopyCapUsage {
  today: number | null
  week: number | null
}

/** Rows created since 00:00 UTC today and in the last 7 days, counted straight from the table. A null means
 * "could not read", and every caller treats that as "do not write" (fail closed). */
export async function readCopyCapUsage(admin: SupabaseClient): Promise<CopyCapUsage> {
  const startOfDay = `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString()
  const [today, week] = await Promise.all([pageCopyCreatedSince(admin, startOfDay), pageCopyCreatedSince(admin, weekAgo)])
  return { today, week }
}

// ---------------------------------------------------------------------------------------------------
// The brief: everything the writer may know, all of it real
// ---------------------------------------------------------------------------------------------------

export interface BuiltCopyBrief {
  brief: PageCopyBrief
  /** Paths the intro may link to, for the quality gate. */
  allowedPaths: Set<string>
}

async function destinationBrief(admin: SupabaseClient, name: string, slug: string, packages: DbPackage[]): Promise<CopyBriefDestination> {
  const { data } = await admin.from('destination_blurbs').select('blurb').eq('slug', slug).maybeSingle()
  const guide = await getPublishedGuide('destinations', slug)
  return {
    name,
    slug,
    blurb: (data as { blurb: string } | null)?.blurb ?? null,
    guideSummary: guide?.summary ?? null,
    packages: packages.slice(0, MAX_BRIEF_PACKAGES_PER_DESTINATION).map((p) => ({
      name: p.name,
      slug: p.slug,
      destination: p.destination,
      category: p.category,
      short_description: p.short_description,
      months: monthRange(p.available_from, p.available_to),
    })),
  }
}

/** The brief for one candidate page, built from the same data the page itself lists. Null when the page no
 * longer exists (its destination lost its last published package). */
export async function buildCopyBrief(admin: SupabaseClient, cand: Pick<PageCopyCandidate, 'path' | 'type'>): Promise<BuiltCopyBrief | null> {
  let brief: PageCopyBrief
  if (cand.type === 'compare') {
    const page = await getComparePage(cand.path.replace(/^\/compare\//, ''))
    if (!page) return null
    brief = {
      type: 'compare',
      title: `${page.a.destination} vs ${page.b.destination}`,
      destinations: [await destinationBrief(admin, page.a.destination, page.a.slug, page.a.packages), await destinationBrief(admin, page.b.destination, page.b.slug, page.b.packages)],
      links: [],
    }
  } else {
    const slug = cand.path.replace(/^\/best-time-to-visit\//, '')
    const page = await getBestTimeToVisitPage(slug)
    if (!page) return null
    brief = { type: 'best-time', title: `Best time to visit ${page.destination}`, destinations: [await destinationBrief(admin, page.destination, slug, page.packages)], links: [] }
  }
  for (const d of brief.destinations) {
    for (const p of d.packages) brief.links.push({ path: `/packages/${p.slug}`, label: `the "${p.name}" trip` })
    brief.links.push({ path: `/destinations/${d.slug}`, label: `our ${d.name} page` })
  }
  return { brief, allowedPaths: new Set(brief.links.map((l) => l.path)) }
}

// ---------------------------------------------------------------------------------------------------
// Publish mode: what happens to copy that passed the quality gate
// ---------------------------------------------------------------------------------------------------

export const PAGE_COPY_PUBLISH_MODE_KEY = 'page_copy_publish_mode'

/** `app_settings.page_copy_publish_mode`: 'draft' (the default, also when unset or unreadable) saves every page as
 * a draft for review; 'publish' lets copy that passed the gate go live. Strict equality, same as guides. */
export async function getPageCopyPublishMode(admin: SupabaseClient): Promise<PageCopyPublishMode> {
  const { value, error } = await getSettingStrict(admin, PAGE_COPY_PUBLISH_MODE_KEY)
  return !error && value === 'publish' ? 'publish' : 'draft'
}

export async function setPageCopyPublishMode(admin: SupabaseClient, mode: string): Promise<{ error?: string }> {
  if (mode !== 'draft' && mode !== 'publish') return { error: 'mode must be "draft" or "publish"' }
  return setSetting(admin, PAGE_COPY_PUBLISH_MODE_KEY, mode)
}

// ---------------------------------------------------------------------------------------------------
// Published copy that links to a trip the page no longer lists (checked about once a day)
// ---------------------------------------------------------------------------------------------------

const STALE_CHECK_EVERY_MS = 24 * 3_600_000

/** Paths of published copy whose intro links to a trip that is no longer on the page. The page itself already hides
 * such copy at render time; this list is what Needs attention shows so someone rewrites it. */
export interface StaleState {
  /** When the last check ran (set even when it failed, so it runs once a day). */
  at?: string
  /** Paths found stale. */
  paths: string[]
  /** When each path was last checked (ISO), so the oldest-checked rows go first. */
  checked: Record<string, string>
}

/** At most this many rows are checked per run (each check fetches the page's trips). */
export const STALE_CHECK_MAX_ROWS = 40

export function parseStaleState(raw: string | null): StaleState {
  try {
    const p = (JSON.parse(raw ?? 'null') ?? {}) as Partial<StaleState>
    return { at: typeof p.at === 'string' ? p.at : undefined, paths: Array.isArray(p.paths) ? p.paths.filter((x): x is string => typeof x === 'string') : [], checked: p.checked && typeof p.checked === 'object' ? p.checked : {} }
  } catch {
    return { paths: [], checked: {} }
  }
}

/** The rows to check this run: oldest-checked first (never checked first of all), at most STALE_CHECK_MAX_ROWS. Pure. */
export function pickRowsToCheck<T extends { path: string }>(rows: T[], checked: Record<string, string>, max = STALE_CHECK_MAX_ROWS): T[] {
  return [...rows].sort((a, b) => (checked[a.path] ?? '').localeCompare(checked[b.path] ?? '') || a.path.localeCompare(b.path)).slice(0, max)
}

/** Checks up to STALE_CHECK_MAX_ROWS published rows and returns the new state (previous findings for rows not
 * checked this time are kept). */
export async function findStaleCopyPaths(admin: SupabaseClient, previous: StaleState = { paths: [], checked: {} }): Promise<StaleState> {
  const { data, error } = await admin.from('page_copy').select('path, page_type, linked_slugs').eq('status', 'published')
  if (error) throw new Error(`could not read page copy: ${error.message}`)
  const now = new Date().toISOString()
  const rows = pickRowsToCheck((data ?? []) as { path: string; page_type: PageCopyType; linked_slugs: string[] | null }[], previous.checked)
  const stale: string[] = []
  const checked = { ...previous.checked }
  for (const row of rows) {
    checked[row.path] = now
    if (!row.linked_slugs?.length) continue
    let current: string[] | null = null
    if (row.page_type === 'compare') {
      const page = await getComparePage(row.path.replace(/^\/compare\//, ''))
      if (page) current = [...page.a.packages, ...page.b.packages].map((p) => p.slug)
    } else {
      const page = await getBestTimeToVisitPage(row.path.replace(/^\/best-time-to-visit\//, ''))
      if (page) current = page.packages.map((p) => p.slug)
    }
    if (current && staleLinkedSlugs(row.linked_slugs, current).length) stale.push(row.path)
  }
  const checkedNow = new Set(rows.map((r) => r.path))
  const kept = previous.paths.filter((p) => !checkedNow.has(p))
  return { at: now, paths: [...new Set([...kept, ...stale])], checked }
}

/** Runs findStaleCopyPaths at most once a day and remembers the answer for lib/issues.ts. Never throws. */
async function refreshStaleCopyIfDue(admin: SupabaseClient): Promise<void> {
  try {
    const previous = parseStaleState(await getSetting(admin, STALE_COPY_KEY))
    const at = Date.parse(previous.at ?? '')
    if (!Number.isNaN(at) && Date.now() - at < STALE_CHECK_EVERY_MS) return
    try {
      await setSetting(admin, STALE_COPY_KEY, JSON.stringify(await findStaleCopyPaths(admin, previous)))
    } catch {
      // Stamp the attempt anyway so a failing check retries tomorrow, not on every 15-minute pass.
      await setSetting(admin, STALE_COPY_KEY, JSON.stringify({ ...previous, at: new Date().toISOString() }))
    }
  } catch {
    // an unreadable setting just tries again on the next pass
  }
}

// ---------------------------------------------------------------------------------------------------
// Writing one page
// ---------------------------------------------------------------------------------------------------

export interface WritePageCopyResult {
  ok: boolean
  /** True only for a real failure (the AI or the save failed). A busy lock, a duplicate or a dropped run is not a failure. */
  failed?: boolean
  note: string
  copy?: PageCopy
  published?: boolean
  blockers?: string[]
}

/** Writes and saves ONE page's copy. Whether it goes live is copyPublishDecision(): clean means published, any
 * blocker means a draft with the reasons in quality_notes. `beforeSave` runs right before the row is written (the
 * pipeline re-checks its caps there, because composing takes a while). A path that already failed
 * MAX_COPY_ATTEMPTS times is refused here too, so the admin button cannot keep spending on it. Takes the run
 * lock itself. A failure is remembered for Needs attention. */
export async function writePageCopy(
  admin: SupabaseClient,
  cand: Pick<PageCopyCandidate, 'path' | 'type' | 'label'>,
  opts: { source: 'pipeline' | 'admin'; beforeSave?: () => Promise<string | null>; deadlineMs?: number },
): Promise<WritePageCopyResult> {
  if (!isAiConfigured()) return { ok: false, note: 'AI writing is not configured (ANTHROPIC_API_KEY is not set)' }
  // The routes that run this are killed at 300 seconds. The self-repair only starts a model call with enough time left.
  const deadlineMs = opts.deadlineMs ?? Date.now() + 270_000
  let repairLogIds: string[] = []
  const earlier = (await readCopyFailures(admin))[cand.path]
  if (earlier && earlier.n >= MAX_COPY_ATTEMPTS) return { ok: false, note: `"${cand.label}" failed ${earlier.n} times, so it is skipped. Click Dismiss on the Needs attention item to try it again.` }
  // The breaker applies to the admin button too: after repeated failures, stop spending until someone looks.
  const recent = await recentCopyFailureCount(admin)
  if (recent === null) return { ok: false, note: 'could not check recent page copy failures, so nothing was written' }
  if (recent >= COPY_BREAKER_FAILURES) return { ok: false, note: `paused after ${recent} failures in ${COPY_BREAKER_HOURS}h. Click Dismiss on the Needs attention item on the Autopilot page to resume.` }
  if (!(await acquireLock(admin))) return { ok: false, note: 'another page is being written right now' }

  let saved!: PageCopy
  let publishing!: boolean
  let blockers!: string[]
  try {
    if (await getPageCopyAdmin(admin, cand.path)) return { ok: false, note: `copy for "${cand.label}" already exists (delete it first to write it again)` }

    const built = await buildCopyBrief(admin, cand)
    if (!built) return { ok: false, note: `"${cand.label}" is no longer a page (its trips are gone)` }
    const { brief, allowedPaths } = built
    const composed = await composePageCopy(brief)
    if ('error' in composed) {
      const n = await recordCopyFailure(admin, cand.path, composed.error)
      return { ok: false, failed: true, note: `could not write "${cand.label}" (${composed.error}); attempt ${n} of ${MAX_COPY_ATTEMPTS}` }
    }
    let copy = composed.copy

    const gateCtx = { grounding: copyGroundingText(brief), destinations: brief.destinations.map((d) => d.name), names: brief.links.map((l) => l.label), allowedPaths }
    blockers = pageCopyBlockers(copy, gateCtx)
    // Self-healing (WP10): reword or remove the phrases behind a REPAIRABLE blocker (a weather word, a verdict, a
    // number that is not in the trips), then judge again. A HARD blocker is never touched. Every change is logged
    // before it is used; nothing here can add a fact.
    if (blockers.length) {
      const fixed = await repairComposedCopy(admin, copy, gateCtx, { path: cand.path, links: brief.links, deadlineMs })
      copy = fixed.value
      blockers = fixed.blockers
      repairLogIds = fixed.logIds
    }
    const decision = copyPublishDecision(blockers, await getPageCopyPublishMode(admin))
    publishing = decision.publish

    const stop = opts.beforeSave ? await opts.beforeSave() : null
    // A pass dropped because a cap was reached while composing is not a failure: it must not feed the breaker.
    if (stop) {
      await deleteEdits(admin, repairLogIds)
      return { ok: false, note: stop }
    }

    saved = await savePageCopy(admin, {
      path: cand.path,
      page_type: cand.type,
      intro: copy.intro,
      faq: copy.faq,
      key_takeaways: copy.key_takeaways,
      linked_slugs: linkedPackageSlugs(copy.intro),
      meta_title: copy.meta_title,
      meta_description: copy.meta_description,
      og_title: copy.og_title,
      og_description: copy.og_description,
      primary_keyword: copy.primary_keyword,
      status: publishing ? 'published' : 'draft',
      source: 'ai',
      quality_notes: decision.note,
    })
  } catch (e) {
    const reason = e instanceof Error ? e.message : 'unknown error'
    // The copy was never saved, so its audit rows would point at nothing.
    await deleteEdits(admin, repairLogIds).catch(() => undefined)
    await recordCopyFailure(admin, cand.path, reason).catch(() => undefined)
    return { ok: false, failed: true, note: `could not write "${cand.label}": ${reason}` }
  } finally {
    await releaseLock(admin)
  }

  // The copy is saved. Nothing below may turn that into a "could not write".
  try {
    await clearCopyFailure(admin, cand.path)
    await finalizeEdits(admin, repairLogIds, { id: saved.id, path: cand.path, published: publishing })
    if (publishing) await pingIndexNow([cand.path, '/sitemap.xml'])
  } catch {
    // housekeeping only
  }
  return {
    ok: true,
    copy: saved,
    published: publishing,
    blockers,
    note: publishing ? `wrote and published the copy for "${cand.label}"` : `wrote "${cand.label}" as a draft (${saved.quality_notes ?? 'held for review'})`,
  }
}

// ---------------------------------------------------------------------------------------------------
// Rotation and the pipeline step
// ---------------------------------------------------------------------------------------------------

/** The next candidate (see pickNextCopyCandidate for the order), reading the failure list and the newest row per
 * page type. Null when nothing is left. */
export async function pickNextPageCopy(admin: SupabaseClient, candidates: PageCopyCandidate[]): Promise<{ cand: PageCopyCandidate | null; error?: string }> {
  const { failures, error } = await readCopyFailuresChecked(admin)
  if (error) return { cand: null, error: 'could not read the page copy failure list, so nothing was written' }
  const counts: Record<string, number> = {}
  for (const f of Object.values(failures)) counts[f.path] = f.n

  const { data, error: rowsError } = await admin.from('page_copy').select('page_type, created_at').order('created_at', { ascending: false })
  if (rowsError) return { cand: null, error: `could not read page copy (${rowsError.message}), so nothing was written` }
  const newest: Partial<Record<PageCopyType, string>> = {}
  for (const row of (data ?? []) as { page_type: PageCopyType; created_at: string }[]) if (!newest[row.page_type]) newest[row.page_type] = row.created_at

  return { cand: pickNextCopyCandidate(candidates, newest, counts, MAX_COPY_ATTEMPTS) }
}

/** The pipeline's copy step: at most `page_copy_per_day` and `page_copy_per_week` (counted from the page_copy
 * table, failing closed), one page per call, and none at all while the failure breaker is tripped. The caller has
 * already checked that Autopilot is on and not paused. */
export async function runPageCopyStep(admin: SupabaseClient, opts: { deadlineMs?: number } = {}): Promise<{ ok: boolean; note: string }> {
  const { perDay, perWeek } = await getPageCopyCaps(admin)
  if (perDay === 0 || perWeek === 0) return { ok: true, note: 'page copy is switched off (a cap is 0)' }
  // Not while switched off. It makes no AI call, so it runs even when AI is not configured.
  await refreshStaleCopyIfDue(admin)
  if (!isAiConfigured()) return { ok: true, note: 'AI writing is not configured, so no page copy' }

  // The breaker comes before any AI call. If the log cannot be read, stay closed.
  const recentFailures = await recentCopyFailureCount(admin)
  if (recentFailures === null) return { ok: false, note: 'could not check recent page copy failures, so nothing was written' }
  if (recentFailures >= COPY_BREAKER_FAILURES) return { ok: false, note: `paused after ${recentFailures} failures in ${COPY_BREAKER_HOURS}h (click Dismiss on the Needs attention item to resume)` }

  const usage = await readCopyCapUsage(admin)
  // Fail closed AND visible: if the count cannot be read (for example the page_copy table does not exist yet),
  // nothing is written and the step shows as failed so it appears under Needs attention.
  if (usage.today === null || usage.week === null) return { ok: false, note: 'could not check how many pages were written (is the page_copy table set up?), so nothing was written' }
  if (usage.today >= perDay) return { ok: true, note: `daily cap reached (${usage.today} of ${perDay} today)` }
  if (usage.week >= perWeek) return { ok: true, note: `weekly cap reached (${usage.week} of ${perWeek} this week)` }

  const { cand, error } = await pickNextPageCopy(admin, await listPageCopyCandidates(admin))
  if (error) return { ok: false, note: error }
  if (!cand) return { ok: true, note: 'no pages left to write (all written, or skipped after repeated failures)' }

  const result = await writePageCopy(admin, cand, {
    source: 'pipeline',
    deadlineMs: opts.deadlineMs,
    // Composing takes a while: look at the caps again right before saving, so two runs cannot both write.
    beforeSave: async () => {
      const again = await readCopyCapUsage(admin)
      if (again.today === null || again.week === null || again.today >= perDay || again.week >= perWeek) return 'a page was written while this one was being composed, so this one was dropped'
      return null
    },
  })
  return { ok: !result.failed, note: result.note }
}
