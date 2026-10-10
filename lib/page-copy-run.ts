import type { SupabaseClient } from '@supabase/supabase-js'
import { getSetting, setSetting } from '@/lib/app-settings'
import { isAiConfigured } from '@/lib/ai-verify'
import { pingIndexNow } from '@/lib/indexnow'
import { getComparePage } from '@/lib/compare-destinations'
import { getBestTimeToVisitPage } from '@/lib/best-time-to-visit'
import { getPublishedGuide } from '@/lib/guides'
import type { DbPackage } from '@/lib/packages'
import { composePageCopy, copyGroundingText, copyPublishDecision, monthRange, pageCopyBlockers, MAX_BRIEF_PACKAGES_PER_DESTINATION, type CopyBriefDestination, type PageCopyBrief } from '@/lib/page-copy-composer'
import { clearCopyFailure, readCopyFailures, readCopyFailuresChecked, recentCopyFailureCount, recordCopyFailure, MAX_COPY_ATTEMPTS, COPY_BREAKER_FAILURES, COPY_BREAKER_HOURS } from '@/lib/page-copy-failures'
import {
  getPageCopyAdmin,
  listPageCopyCandidates,
  pageCopyCreatedSince,
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
  opts: { source: 'pipeline' | 'admin'; beforeSave?: () => Promise<string | null> },
): Promise<WritePageCopyResult> {
  if (!isAiConfigured()) return { ok: false, note: 'AI writing is not configured (ANTHROPIC_API_KEY is not set)' }
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
    const copy = composed.copy

    blockers = pageCopyBlockers(copy, { grounding: copyGroundingText(brief), destinations: brief.destinations.map((d) => d.name), names: brief.links.map((l) => l.label), allowedPaths })
    const decision = copyPublishDecision(blockers)
    publishing = decision.publish

    const stop = opts.beforeSave ? await opts.beforeSave() : null
    // A pass dropped because a cap was reached while composing is not a failure: it must not feed the breaker.
    if (stop) return { ok: false, note: stop }

    saved = await savePageCopy(admin, {
      path: cand.path,
      page_type: cand.type,
      intro: copy.intro,
      faq: copy.faq,
      key_takeaways: copy.key_takeaways,
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
    await recordCopyFailure(admin, cand.path, reason).catch(() => undefined)
    return { ok: false, failed: true, note: `could not write "${cand.label}": ${reason}` }
  } finally {
    await releaseLock(admin)
  }

  // The copy is saved. Nothing below may turn that into a "could not write".
  try {
    await clearCopyFailure(admin, cand.path)
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
export async function runPageCopyStep(admin: SupabaseClient): Promise<{ ok: boolean; note: string }> {
  const { perDay, perWeek } = await getPageCopyCaps(admin)
  if (perDay === 0 || perWeek === 0) return { ok: true, note: 'page copy is switched off (a cap is 0)' }
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
    // Composing takes a while: look at the caps again right before saving, so two runs cannot both write.
    beforeSave: async () => {
      const again = await readCopyCapUsage(admin)
      if (again.today === null || again.week === null || again.today >= perDay || again.week >= perWeek) return 'a page was written while this one was being composed, so this one was dropped'
      return null
    },
  })
  return { ok: !result.failed, note: result.note }
}
