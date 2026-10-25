import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { getSetting, setSetting } from '@/lib/app-settings'
import { listPostsAdmin, createPost, type Post } from '@/lib/posts'
import { isDryRunSwitchOn } from '@/lib/dry-run'
import { listPublishedGuideLinks, guidePath, isGuideKind, type GuideKind } from '@/lib/guides'
import { dueApprovedTopics, packageWall, keywordSetOf, pickKeywordTopic, markKeywordSkipped, pickOneTopic, setTopicStatus, findGroundingPackage, groundAngleInPackage, checkTopicConflict, rankByGsc, readGscQueries, type TopicIdea } from '@/lib/blog-topics'
import { composeFullPost, gateWithRepair, type AllowedLink } from '@/lib/blog-composer'
import { loadQuestionHints } from '@/lib/question-hints'
import { coverAltIssue, withSiteLinks } from '@/lib/blog-quality'
import { coverAlt } from '@/lib/image-quality'
import { deleteEdits } from '@/lib/content-edits'
import { rejectedPostSlugs } from '@/lib/blog-reheal'
import { finalizeEdits, repairComposedPost } from '@/lib/content-repair-adapters'
import { healComposedPost, healNoteOf } from '@/lib/heal-targets'
import { rejectLimitReached, type HealOutcome } from '@/lib/heal-loop'
import { pickStyle, pickCtaStyle, CTA_STYLES, CONTENT_STYLES, styleById, appendStyledCta, type ContentStyle } from '@/lib/content-styles'
import { scoresFor, chooseWeighted } from '@/lib/content-performance'

// Growth loop WP3 closes the loop here: once a writing style has 3 or more posts old enough to have
// Google data, the writer leans toward the best-earning style 70% of the time and keeps exploring the
// rest of the time. With no scores yet (new site, Search Console off, migration not run) it is the
// plain rotation from WP1. `recent` is newest first. Never throws: any problem falls back to rotation.
async function pickStyleWithScores(admin: ReturnType<typeof getSupabaseAdmin>, recent: (string | null | undefined)[]): Promise<ContentStyle> {
  try {
    const scores = await scoresFor(admin, 'content_style')
    if (scores.length) {
      const known = recent.filter((s): s is string => typeof s === 'string' && s.length > 0)
      const chosen = styleById(chooseWeighted(scores, known, CONTENT_STYLES.map((s) => s.id)))
      if (chosen) return chosen
    }
  } catch {
    // scores are a bonus, never a blocker
  }
  return pickStyle(recent)
}
import { tagVariant } from '@/lib/content-variants'
import { saveCoverHeadline } from '@/lib/cover-headline-store'
import { listSitePages } from '@/lib/site-pages'
import { getBestTimeToVisitSlugs } from '@/lib/best-time-to-visit'
import { generateSlug } from '@/lib/utils'
import { findDuplicate } from '@/lib/content-dedupe'
import { loadMeaningContext, meaningRejection } from '@/lib/topic-meaning-run'
import { enrollIfDue } from '@/lib/distribution'
import { getAutoblogPostsPerWeek, getAutoblogMaxPerDay, mayWriteAnotherToday, isPublishDayDue, currentWeekday } from '@/lib/autoblog-cadence'
import { checkCadence, postCadenceKey, postLimits, recordPublish } from '@/lib/publish-cadence'
import { isAutomationPaused } from '@/lib/automation-kill-switch'
import { attachAutoblogCoverImage } from '@/lib/blog-image'
import { pingIndexNow } from '@/lib/indexnow'
import { SITE_ID } from '@/lib/site'
import { isNewsSlug } from '@/lib/news-post'
import type { PackageGrounding } from '@/lib/blog-topics'

// Found 2026-10-03: lib/blog-composer.ts's body prompt explicitly tells the AI "do not include a
// call-to-action link (the site adds its own)" - but nothing ever did. Every autoblog post ended
// with no link back to a package, a destination, or the contact form at all: a real funnel leak
// (a visitor who reads the post has nowhere to go next). Grounded the same way the rest of
// autoblog's composition already is - a real matched package's slug when one exists, a generic
// link to the trip listing otherwise. Never invents a destination or package the post isn't
// actually about.
// Growth loop WP1: the closing call to action is now style-aware (lib/content-styles.ts ctaFor, five
// variants, all still grounded: the real package page, the contact section or the home page only).

/** Next CTA style: rotates off the cta_style tagged on the last ten posts (content_variants). If that
 * cannot be read, falls back to a plain count-based rotation. Never throws. */
async function pickRecentCtaStyle(admin: ReturnType<typeof getSupabaseAdmin>, recentSlugs: string[], fallbackIndex: number) {
  try {
    const { data, error } = await admin.from('content_variants').select('slug, variant_tags').in('slug', recentSlugs)
    if (error) throw new Error(error.message)
    const bySlug = new Map((data ?? []).map((r: { slug: string; variant_tags: { cta_style?: string } | null }) => [r.slug, r.variant_tags?.cta_style]))
    return pickCtaStyle(recentSlugs.map((s) => bySlug.get(s)))
  } catch {
    return CTA_STYLES[fallbackIndex % CTA_STYLES.length]
  }
}

/** The most internal links one blog post may be offered. */
export const MAX_POST_LINKS = 5
const MAX_GUIDE_LINKS = 3
const MAX_POST_LINKS_RELATED = 2

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** Case-insensitive whole-word test: "Viking" matches "a Viking cruise" but not "Vikings". Empty needle never matches. */
function hasWholeWord(haystack: string, needle: string): boolean {
  const n = needle.trim()
  if (!n) return false
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(n)}($|[^\\p{L}\\p{N}])`, 'iu').test(haystack)
}

export interface LinkTopic {
  angle: string
  keyword: string
  keywords?: string[]
  tags?: string[]
}
export interface LinkGuide {
  kind: GuideKind
  slug: string
  name: string
  /** The name of the destination this guide sits under (its parent), when known. A guide whose destination
   * also appears in the topic is picked before one whose destination does not. */
  destination?: string | null
}
/** A guide name shorter than this is never matched by name (too easy to hit by accident). 4 keeps real
 * places such as Rome, Bali and Fiji linkable. */
export const MIN_GUIDE_NAME_LENGTH = 4
/** Names too generic to mean one place or line, even when long enough. A guide with exactly such a name is skipped. */
const GENERIC_GUIDE_NAMES = new Set(['cruise', 'cruises', 'travel', 'tours', 'tour', 'trips', 'trip', 'river', 'ocean', 'island', 'islands', 'beach', 'beaches', 'hotel', 'hotels', 'resort', 'resorts', 'world', 'europe tours', 'guide', 'guides', 'vacation', 'vacations', 'holiday', 'holidays', 'ship', 'ships', 'port', 'ports', 'luxury', 'family', 'adventure'])

/** Pure: may this guide be matched by its name at all? */
export function guideNameMatchable(name: string | null | undefined): boolean {
  const n = (name ?? '').trim()
  return n.length >= MIN_GUIDE_NAME_LENGTH && !GENERIC_GUIDE_NAMES.has(n.toLowerCase())
}

export interface LinkPost {
  slug: string
  title: string
  tags?: string[] | null
  status: string
  publish_date?: string | null
}

/** Pure: up to 3 published guides whose name appears (whole word, any case) in the topic's angle, keywords or
 * tags, then up to 2 recent published posts that share a tag with the topic (a post tag that is a topic tag,
 * or appears as a whole word in the topic text). Posts are taken in the order given (newest first). The post
 * being written (`selfSlug`) is never linked. No match returns []. Never exceeds MAX_POST_LINKS. */
export function pickGuideAndPostLinks(topic: LinkTopic, guides: LinkGuide[], posts: LinkPost[], selfSlug?: string, now: number = Date.now()): AllowedLink[] {
  const topicTags = (topic.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean)
  const text = [topic.angle, topic.keyword, ...(topic.keywords ?? []), ...topicTags].filter(Boolean).join(' | ')
  const out: AllowedLink[] = []
  const seen = new Set<string>()
  // Only guides whose full name (long enough, not a generic word) appears as a whole word. Those whose
  // destination also appears in the text come first; otherwise the given order is kept (stable sort).
  const matched = (guides ?? [])
    .filter((g) => !!g && guideNameMatchable(g.name) && isGuideKind(g.kind) && !!g.slug && hasWholeWord(text, g.name))
    .map((g, i) => ({ g, i, near: !!g.destination && guideNameMatchable(g.destination) && hasWholeWord(text, g.destination) ? 0 : 1 }))
    .sort((a, b) => a.near - b.near || a.i - b.i)
    .map((m) => m.g)
  for (const g of matched) {
    if (out.length >= MAX_GUIDE_LINKS) break
    const path = guidePath(g.kind, g.slug)
    if (seen.has(path)) continue
    seen.add(path)
    out.push({ path, label: `our ${g.name.replace(/[[\]]/g, '')} guide` })
  }
  let postCount = 0
  for (const p of posts) {
    if (postCount >= MAX_POST_LINKS_RELATED) break
    if (!p?.slug || p.slug === selfSlug || p.status !== 'published') continue
    if (p.publish_date) {
      const ms = Date.parse(p.publish_date)
      if (!Number.isNaN(ms) && ms > now) continue
    }
    const shares = (p.tags ?? []).some((t) => {
      const tag = (t ?? '').trim()
      return !!tag && (topicTags.includes(tag.toLowerCase()) || hasWholeWord(text, tag))
    })
    if (!shares) continue
    const path = `/blog/${p.slug}`
    if (seen.has(path)) continue
    seen.add(path)
    postCount++
    out.push({ path, label: `our post "${p.title.replace(/[[\]]/g, '')}"` })
  }
  return out
}

/** Pure: the existing links first, then the guide and post links, no repeated path, never more than MAX_POST_LINKS. */
export function mergeAllowedLinks(base: AllowedLink[], extra: AllowedLink[]): AllowedLink[] {
  const seen = new Set<string>()
  const out: AllowedLink[] = []
  for (const l of [...base, ...extra]) {
    if (seen.has(l.path)) continue
    seen.add(l.path)
    out.push(l)
    if (out.length >= MAX_POST_LINKS) break
  }
  return out
}

/** Published guides, each carrying the name of its parent destination guide (when it has one). Throws like the reader it wraps. */
async function readGuidesWithDestination(): Promise<LinkGuide[]> {
  const all = await listPublishedGuideLinks()
  const byDest = new Map(all.filter((g) => g.kind === 'destinations').map((g) => [g.slug, g.name]))
  return all.map((g) => ({ kind: g.kind, slug: g.slug, name: g.name, destination: g.parent_slug ? (byDest.get(g.parent_slug) ?? null) : null }))
}

/** Adds the guide and post links to `base`. Any read error (or a throw from the readers) returns `base` unchanged. */
export async function withGuideAndPostLinks(
  base: AllowedLink[],
  topic: LinkTopic,
  readGuides: () => Promise<LinkGuide[]>,
  readPosts: () => Promise<LinkPost[]>,
  selfSlug?: string,
): Promise<AllowedLink[]> {
  try {
    const [guides, posts] = await Promise.all([readGuides(), readPosts()])
    return mergeAllowedLinks(base, pickGuideAndPostLinks(topic, guides, posts, selfSlug))
  } catch (err) {
    console.error('[autoblog] could not add guide and post links:', err instanceof Error ? err.message : err)
    return base
  }
}

/** The pages the composer may link to from the body, each confirmed to exist right now: the matched
 * package, its destination page (only when a published package gives it one), its best-time-to-visit
 * page (only when that page really exists), then up to 3 published guides named in the topic and up to 2
 * recent published posts sharing a tag (at most 5 in all). With no package and no match there are no
 * links, so the writer cannot reach for a page that is not there. Never throws. */
async function buildAllowedLinks(admin: ReturnType<typeof getSupabaseAdmin>, pkg: PackageGrounding | null, topic: TopicIdea, posts: Post[]): Promise<AllowedLink[]> {
  const base = await buildPackageLinks(admin, pkg)
  return withSiteLinks(await withGuideAndPostLinks(base, topic, readGuidesWithDestination, async () => posts))
}


async function buildPackageLinks(admin: ReturnType<typeof getSupabaseAdmin>, pkg: PackageGrounding | null): Promise<AllowedLink[]> {
  if (!pkg?.slug) return []
  const links: AllowedLink[] = [{ path: `/packages/${pkg.slug}`, label: `the ${pkg.name.replace(/[[\]]/g, '')} trip page` }]
  const destSlug = pkg.destination ? generateSlug(pkg.destination) : ''
  if (!destSlug) return links
  try {
    const pages = await listSitePages(admin)
    if (pages.some((p) => p.type === 'destination' && p.path === `/destinations/${destSlug}`)) {
      links.push({ path: `/destinations/${destSlug}`, label: `our ${pkg.destination} destination page` })
    }
  } catch (err) {
    console.error('[autoblog] could not list destination pages:', err instanceof Error ? err.message : err)
  }
  try {
    const bestTime = await getBestTimeToVisitSlugs()
    if (bestTime.some((b) => b.slug === destSlug)) {
      links.push({ path: `/best-time-to-visit/${destSlug}`, label: `the best time to visit ${pkg.destination} page` })
    }
  } catch (err) {
    console.error('[autoblog] could not list best-time pages:', err instanceof Error ? err.message : err)
  }
  return links
}

// Ported from Nomad Escape Plan's modules/marketing/autoblog-run.ts (Factory Phase 2:
// blog/autoblog), adapted to this project's posts table (lib/posts.ts) and app_settings helper
// (lib/app-settings.ts). The Autopilot "posts per week" dial (Nomad's own admin feature) was
// deferred out of that first port and ships now, in lib/autoblog-cadence.ts.
export type AutoblogMode = 'off' | 'draft' | 'publish'
export const AUTOBLOG_MODE_KEY = 'autoblog_mode'

/** `app_settings.autoblog_mode`: off (default), draft (write but never publish), publish (write
 * and auto-publish when the quality gate passes). Off until an admin explicitly changes it -
 * this ships dormant. */
export async function getAutoblogMode(): Promise<AutoblogMode> {
  const raw = await getSetting(getSupabaseAdmin(), AUTOBLOG_MODE_KEY)
  return raw === 'draft' || raw === 'publish' ? raw : 'off'
}

export interface AutoblogResult {
  ran: boolean
  mode: AutoblogMode
  note: string
  postId?: string
  postSlug?: string
  published?: boolean
  /** True when the run could not do its job (not just "nothing to do today"): the pipeline step then shows as failed. */
  failed?: boolean
}

const RUN_LOCK_KEY = 'autoblog_run_lock'
// The routes that run this are killed at 300s (maxDuration) and composing is told to finish within
// 240s (deadlineMs below), so a lock older than 10 minutes is certainly abandoned (a crashed run)
// rather than in progress. That way a stuck lock can't wedge autoblog forever.
const RUN_LOCK_STALE_MS = 10 * 60 * 1000

/** Best-effort lock so the admin "run now" button and the daily cron can't both create a post in
 * the same narrow window. Not a real distributed lock (no compare-and-swap), just enough to close
 * the realistic race of two near-simultaneous triggers - acceptable since a double-post here is a
 * content-quality annoyance, not a data-integrity issue. */
async function acquireRunLock(admin: ReturnType<typeof getSupabaseAdmin>): Promise<boolean> {
  const existing = await getSetting(admin, RUN_LOCK_KEY)
  if (existing) {
    const since = Date.parse(existing)
    if (!Number.isNaN(since) && Date.now() - since < RUN_LOCK_STALE_MS) return false
  }
  await setSetting(admin, RUN_LOCK_KEY, new Date().toISOString())
  return true
}

async function releaseRunLock(admin: ReturnType<typeof getSupabaseAdmin>): Promise<void> {
  await setSetting(admin, RUN_LOCK_KEY, '')
}

const COMPOSE_FAILURE_KEY = 'autoblog_compose_failures'
// After this many consecutive compose failures, a due approved-queue row is moved to 'rejected'
// instead of being retried forever - without this, a topic whose angle/keyword reliably breaks
// the composer sits first in dueApprovedTopics's oldest-first ordering on every run and starves
// every other approved row behind it.
const MAX_COMPOSE_ATTEMPTS = 3

async function readComposeFailures(admin: ReturnType<typeof getSupabaseAdmin>): Promise<Record<string, number>> {
  const raw = await getSetting(admin, COMPOSE_FAILURE_KEY)
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** Bumps and returns the failure count for `rowId`. */
async function recordComposeFailure(admin: ReturnType<typeof getSupabaseAdmin>, rowId: string): Promise<number> {
  const failures = await readComposeFailures(admin)
  failures[rowId] = (failures[rowId] ?? 0) + 1
  await setSetting(admin, COMPOSE_FAILURE_KEY, JSON.stringify(failures))
  return failures[rowId]
}

/** Clears any failure count for `rowId` once it composes successfully. */
async function clearComposeFailure(admin: ReturnType<typeof getSupabaseAdmin>, rowId: string): Promise<void> {
  const failures = await readComposeFailures(admin)
  if (!(rowId in failures)) return
  delete failures[rowId]
  await setSetting(admin, COMPOSE_FAILURE_KEY, JSON.stringify(failures))
}

/** How many posts were created since 00:00 UTC today, or null when the count could not be read. */
export async function postsWrittenToday(admin: ReturnType<typeof getSupabaseAdmin>): Promise<number | null> {
  const start = `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`
  const { data, error } = await admin.from('posts').select('slug').gte('created_at', start).limit(100)
  if (error) return null
  // A draft the daily re-check retired (rejected) no longer uses up the day's post. Travel news posts (slug "news-...", WP20)
  // have their own daily number and never use up the day's blog post.
  const retired = await rejectedPostSlugs(admin)
  return (data ?? []).filter((p: { slug: string }) => !retired.has(p.slug) && !isNewsSlug(p.slug)).length
}

/** One post per call, at most. `scheduled: true` (the cron) also caps at one post per calendar
 * day; `scheduled: false` (the admin "run now" button) bypasses that daily cap. */
export async function runAutoblog(opts: { scheduled: boolean; deadlineMs?: number }): Promise<AutoblogResult> {
  const mode = await getAutoblogMode()
  if (mode === 'off') return { ran: false, mode, note: 'autoblog is off' }

  const admin = getSupabaseAdmin()
  // The master kill switch overrides autoblog_mode without touching it - flip the switch back
  // off and whatever mode was set (draft/publish) resumes exactly as it was.
  if (await isAutomationPaused(admin)) return { ran: false, mode, note: 'automation is paused (kill switch)' }
  // Dry run (lib/dry-run.ts): the pipeline never gets here while it is on, but the manual entry points (the blog page's run button and the
  // unscheduled autoblog cron route) do, so they are stopped here too.
  if (await isDryRunSwitchOn(admin)) return { ran: false, mode, note: 'dry run is on, so nothing was written' }

  if (!(await acquireRunLock(admin))) {
    return { ran: false, mode, note: 'another autoblog run is already in progress' }
  }
  try {
    return await runAutoblogLocked(admin, mode, opts)
  } finally {
    await releaseRunLock(admin)
  }
}

async function runAutoblogLocked(admin: ReturnType<typeof getSupabaseAdmin>, mode: AutoblogMode, opts: { scheduled: boolean; deadlineMs?: number }): Promise<AutoblogResult> {
  const existingPosts = await listPostsAdmin()
  // True when today's first post is already written and this run may add an extra one from the approved queue only.
  let extraOnly = false
  let wroteBefore = 0

  if (opts.scheduled) {
    const postsPerWeek = await getAutoblogPostsPerWeek(admin)
    if (!isPublishDayDue(postsPerWeek, currentWeekday())) {
      return { ran: false, mode, note: `not a publish day at ${postsPerWeek}/week` }
    }
    // A direct count, not the list above: this is the guard that stops a runaway, so it fails closed
    // (a read error means "do not write") and never depends on a list that could be stale.
    const wroteToday = await postsWrittenToday(admin)
    if (wroteToday === null) return { ran: false, mode, note: 'could not check whether a post was already written today, so nothing was written' }
    // The first post of the day follows the old rule. A second or third (autoblog_max_per_day, default 1, at most 3) is written only when a
    // due approved topic is waiting, and only from that queue (see below).
    const maxPerDay = await getAutoblogMaxPerDay(admin)
    if (wroteToday > 0) {
      const approvedWaiting = maxPerDay > 1 ? await dueApprovedTopics(admin).then((r) => r.length > 0, () => false) : false
      if (!mayWriteAnotherToday(wroteToday, maxPerDay, approvedWaiting)) return { ran: false, mode, note: 'already wrote a post today' }
      extraOnly = true
      wroteBefore = wroteToday
    }
    // The shared publishing limiter: at least 90 minutes since the last automatic post went live (deferred to a later pass, never dropped).
    if (mode === 'publish') {
      const slot = await checkCadence(admin, 'post', postLimits())
      if (!slot.allowed) return { ran: false, mode, note: `post publishing deferred: ${slot.note}`, ...(slot.reason === 'unreadable' ? { failed: true } : {}) }
    }
  }

  if (opts.scheduled && (Number((await getSetting(admin, `autoblog_dupe_skips:${new Date().toISOString().slice(0, 10)}`)) ?? 0) || 0) >= 4) {
    return { ran: false, mode, note: 'every topic today was about a package already covered in the last 30 days; trying again tomorrow (add more trips or approve fresh topics to widen it)' }
  }

  // Growth loop WP19: when the self-heal rejected MAX_REJECTS_PER_DAY drafts today, new writing waits for tomorrow
  // (it keeps the AI spend bounded). An unreadable list stops writing too (fail closed).
  if (mode === 'publish') {
    const limit = await rejectLimitReached(admin)
    // A reached limit is a plain note; one that could not be read is also a failed step so it shows up in Needs attention.
    if (limit.reached) return { ran: false, mode, note: limit.note, ...(limit.unreadable ? { failed: true } : {}) }
  }

  let topic: TopicIdea | null = null
  let queueRowId: string | null = null
  // loop-blog-quality: of the approved topics that are due, the ones Search Console already supports go first (striking distance,
  // positions 8 to 20). A read problem leaves the old oldest-first order.
  const dueRows = rankByGsc(await dueApprovedTopics(admin), await readGscQueries(admin))
  // Same-meaning layer (lib/topic-meaning-run.ts): an approved topic that says the same thing as an existing post is marked rejected as
  // "duplicate of <slug>" (logged with an Undo) and the loop moves on to the next due topic. null = layer off or unreadable.
  const meaningCtx = dueRows.length ? await loadMeaningContext(admin) : null
  for (const row of dueRows) {
    if (findDuplicate(row.angle, existingPosts)) {
      await setTopicStatus(admin, row.id, 'used', {})
      continue
    }
    if (await meaningRejection(admin, { keyword: row.keyword, angle: row.angle, why: row.why, title: row.title_idea }, meaningCtx, { queueRowId: row.id, wasApproved: true, where: 'approved queue pick' })) continue
    topic = { angle: row.angle, keyword: row.keyword, why: row.why, source: row.source, keywords: keywordSetOf(row), package_slug: row.package_slug ?? null }
    queueRowId = row.id
    break
  }
  // An extra post of the day (autoblog_max_per_day above 1) comes ONLY from the approved queue: never the AI-freeform or keyword fallback.
  if (extraOnly && !topic) return { ran: false, mode, note: 'already wrote a post today (an extra post is only written from an approved topic, and none is usable now)' }
  // Order of choice: a topic you approved, then the best researched keyword nothing targets yet (keyword
  // first), then an AI-suggested topic as the last resort.
  if (!topic) topic = await pickKeywordTopic(admin, existingPosts).catch(() => null)
  if (!topic) topic = await pickOneTopic(admin, existingPosts.map((p) => p.title))
  if (!topic) return { ran: false, mode, note: 'no topic available' }
  const keywordLed = topic.source === 'keyword research'

  // Ground the angle in the real travel_packages row (if the topic actually matches one) before
  // composing - without this, composeFullPost's AI steps only ever see the free-text angle/keyword
  // and can invent an itinerary, stop list, or dates that contradict the real product.
  const groundingPackage = await findGroundingPackage(admin, topic)
  // One post per package per 30 days (published or draft). The site once wrote six near-identical posts
  // about one Rhine trip in a day; a stale read let them through, and this is the second wall. Fails
  // closed: if the check cannot be read, nothing is written. The skip counter stops a day of repeats
  // from spending an AI topic call every 15 minutes.
  if (groundingPackage?.slug) {
    const skipKey = `autoblog_dupe_skips:${new Date().toISOString().slice(0, 10)}`
    const skips = Number((await getSetting(admin, skipKey)) ?? 0) || 0
    // An idea made by Promote this package (WP15) is allowed one post per package per 7 days; every other topic keeps 30.
    const promoted = !!topic.package_slug && !!queueRowId
    const wall = packageWall(promoted)
    const since = new Date(Date.now() - wall.days * 86_400_000).toISOString()
    const { data: coverRows, error } = await admin.from('posts').select('slug').gte('created_at', since).ilike('body', `%/packages/${groundingPackage.slug}%`).limit(100)
    if (error) return { ran: false, mode, note: 'could not check whether this package was already covered, so nothing was written' }
    // A draft the daily re-check retired (rejected) does not count as coverage, so the trip can have a new post.
    const retired = await rejectedPostSlugs(admin)
    const count = (coverRows ?? []).filter((p: { slug: string }) => !retired.has(p.slug)).length
    if (count && count > 0 && wall.reschedule && queueRowId) {
      // A promoted idea is never thrown away by the wall: it is moved a week on and stays approved. It does not count
      // towards the day's repeat limit either.
      await setTopicStatus(admin, queueRowId, 'approved', { scheduled_for: wall.rescheduleTo })
      return { ran: false, mode, note: `a post about "${groundingPackage.name}" was written in the last ${wall.days} days, so the promoted idea was moved to ${wall.rescheduleTo}` }
    }
    if (count && count > 0) {
      if (queueRowId) await setTopicStatus(admin, queueRowId, 'used', {})
      if (keywordLed) await markKeywordSkipped(admin, topic.keyword, 'its package already has a recent post')
      await setSetting(admin, skipKey, String(skips + 1))
      return { ran: false, mode, note: `skipped - a post about "${groundingPackage.name}" was already written in the last 30 days (${skips + 1} of 4 repeats allowed today)` }
    }
  }

  // loop-blog-quality (lib/blog-topics.ts topicConflict): the keyword is compared with EVERY post's keywords, and the trip, solo and
  // destination spacing rules are applied. 'duplicate' drops the topic; 'defer' keeps an approved row and moves it to the date the
  // rule frees up. Fails open if the posts cannot be read (the checks above still apply).
  {
    const skipKey = `autoblog_dupe_skips:${new Date().toISOString().slice(0, 10)}`
    const conflict = await checkTopicConflict(
      admin,
      { angle: topic.angle, keyword: topic.keyword, keywords: topic.keywords, packageSlug: groundingPackage?.slug ?? topic.package_slug ?? null, destinationSlug: groundingPackage?.destination ? generateSlug(groundingPackage.destination) : null },
      { retired: await rejectedPostSlugs(admin) },
    )
    if (conflict) {
      const skips = Number((await getSetting(admin, skipKey)) ?? 0) || 0
      if (conflict.kind === 'duplicate') {
        if (queueRowId) await setTopicStatus(admin, queueRowId, 'used', {})
        if (keywordLed) await markKeywordSkipped(admin, topic.keyword, conflict.reason)
      } else {
        if (queueRowId && conflict.until) await setTopicStatus(admin, queueRowId, 'approved', { scheduled_for: conflict.until })
        if (keywordLed) await markKeywordSkipped(admin, topic.keyword, conflict.reason)
      }
      await setSetting(admin, skipKey, String(skips + 1))
      return { ran: false, mode, note: `skipped - ${conflict.reason}${conflict.kind === 'defer' && conflict.until ? ` (waits until ${conflict.until})` : ''} (${skips + 1} of 4 repeats allowed today)` }
    }
  }

  const groundedAngle = groundAngleInPackage(topic.angle, groundingPackage)

  // Rotate the writing style off the last ten posts (existingPosts is newest first) and work out which
  // internal pages the post may link to.
  const style = await pickStyleWithScores(admin, existingPosts.slice(0, 10).map((p) => p.content_style))
  const ctaStyle = await pickRecentCtaStyle(admin, existingPosts.slice(0, 10).map((p) => p.slug), existingPosts.length)
  const allowedLinks = await buildAllowedLinks(admin, groundingPackage, topic, existingPosts)

  // The routes that call this are killed at 300s. Compose and repair are told to wrap up by 240s from
  // now: the optional steps (FAQ/takeaways, the repair call) are skipped when too little time is left.
  const runStart = Date.now()
  // The route is killed at 300s. The pipeline passes its own hard stop (its start plus 280s); everything below ends before it.
  const hardStop = Math.min(runStart + 285_000, opts.deadlineMs ?? runStart + 280_000)
  const deadlineMs = Math.min(runStart + 240_000, hardStop - 30_000)
  const healDeadline = Math.min(runStart + 270_000, hardStop)
  // The post is written for the topic's whole keyword set (primary first), not just one phrase.
  const seedKeywords = topic.keywords?.length ? topic.keywords : [topic.keyword]
  // Real searcher questions for the FAQ step (hub WP5): stored Search Console searches and question headings in our own posts. [] when none.
  const questions = await loadQuestionHints(admin, seedKeywords)
  const composed = await composeFullPost(groundedAngle, seedKeywords, { style, allowedLinks, deadlineMs, ...(questions.length ? { questions } : {}) })
  if (!composed) {
    if (queueRowId) {
      const attempts = await recordComposeFailure(admin, queueRowId)
      if (attempts >= MAX_COMPOSE_ATTEMPTS) {
        await setTopicStatus(admin, queueRowId, 'rejected', {})
        return { ran: false, mode, note: `composer failed ${attempts} times for this topic - moved it to rejected so it stops blocking the approved queue` }
      }
    }
    return { ran: false, mode, note: 'composer failed or AI unconfigured' }
  }
  if (queueRowId) await clearComposeFailure(admin, queueRowId)

  // Pre-compose dedupe only checked the topic's angle, but the AI's 'idea'/'title' steps are free
  // to land on a title that duplicates an existing post by content even when the angle didn't.
  // Renaming the slug alone still wrote a second, functionally-duplicate post - skip creation
  // instead and let the next scheduled/admin-triggered run pick a different topic.
  if (findDuplicate(composed.title, existingPosts)) {
    if (queueRowId) await setTopicStatus(admin, queueRowId, 'used', {})
    if (keywordLed) await markKeywordSkipped(admin, topic.keyword, 'the post written for it duplicated an existing one')
    return { ran: false, mode, note: `skipped - duplicate of an existing post: "${composed.title}"` }
  }

  // The compose step takes a while; check once more, right before saving, that no other run got there first.
  if (opts.scheduled) {
    const again = await postsWrittenToday(admin)
    if (again === null || again > (extraOnly ? wroteBefore : 0)) return { ran: false, mode, note: 'a post was written while this one was being composed, so this one was dropped' }
  }

  // The gate, with the shared self-repair (WP10, lib/content-repair.ts): plain-code fixers, then at most ONE model
  // call (the same limit and deadline as before) that rewords or removes the sentences behind a number, link or
  // missing-FAQ blocker, then a deterministic delete. A HARD blocker (an experience claim, a price, an outside
  // link) is never touched. Every change is logged for the Content edits list before it is used. Still blocked
  // after that means a saved draft.
  let final = composed
  let blockers: string[] = []
  let repairLogIds: string[] = []
  let heal: HealOutcome | null = null
  if (mode === 'publish') {
    // The blog quality gate (lib/blog-quality.ts) checks links and the contact link on the SAVED body, which has the closing call to
    // action appended, and checks a year in the title against the trip's travel dates.
    const gateCtx = {
      allowedPaths: allowedLinks.map((l) => l.path),
      groundingText: `${groundedAngle} ${topic.keyword}`,
      deadlineMs,
      storedBody: (body: string) => appendStyledCta(body, ctaStyle.id, groundingPackage),
      tripDates: groundingPackage ? { from: groundingPackage.available_from, to: groundingPackage.available_to } : null,
      // WP4: the search title and description of the other live posts, so a new post cannot repeat one of them.
      otherMeta: existingPosts.filter((p) => p.status === 'published').map((p) => ({ slug: p.slug, title: p.meta_title, description: p.meta_description })),
    }
    const gated = await repairComposedPost(
      admin,
      composed,
      new Date(),
      gateCtx,
      // The saved body has the closing call to action appended; the audit log must hold what is saved.
      { storedBody: (body) => appendStyledCta(body, ctaStyle.id, groundingPackage) },
    )
    final = gated.value
    blockers = gated.blockers
    repairLogIds = gated.logIds
    // Until migration 0033 is applied there is no audit log, and once the day's 6 repair slots are used there is no
    // room for another shared repair: either way the older one-call repair (numbers and links only) keeps working,
    // so a post is never worse off than before WP10.
    if (blockers.length && /migration 0033|cap of \d+ repaired pages|repair slot/.test(gated.note)) {
      const legacy = await gateWithRepair(composed, new Date(), gateCtx)
      final = legacy.post
      blockers = legacy.blockers
    }
    // Growth loop WP19: a post that is still blocked is not left for a person. The heal loop (lib/heal-loop.ts) has a
    // suggester and an independent QA judge try up to three rounds, then removes the offending sentences, rewrites the
    // offending section, and as a last step writes the whole post again with the failures as constraints. It publishes
    // ONLY text that passes the gate AND the judge. Otherwise the draft is marked rejected_by_heal, which frees the day's
    // slot and the trip's 30-day wall, and the next run moves on to the next topic.
    if (blockers.length) {
      const healed = await healComposedPost(admin, final, new Date(), gateCtx, {
        storedBody: (body) => appendStyledCta(body, ctaStyle.id, groundingPackage),
        // The routes that run this are killed at 300s: stay clear of that.
        deadlineMs: healDeadline,
        regenerate: (reasons) =>
          composeFullPost(`${groundedAngle}

A first draft of this post was refused by the quality checks for these reasons, so avoid them: ${reasons.join('; ')}`, seedKeywords, { style, allowedLinks, deadlineMs: healDeadline }),
      })
      heal = healed.outcome
      if (healed.outcome.status === 'healed') {
        final = healed.value
        blockers = []
        repairLogIds = [...repairLogIds, ...healed.logIds]
      }
    }
  }
  const rejectedByHeal = heal?.status === 'rejected_by_heal'
  const publishing = mode === 'publish' && blockers.length === 0
  // Use the composed post's own tags (derived from its actual keywords) rather than the
  // pre-composition topic.keyword - the composer's 'idea' step can land on an article that
  // diverges from the seed angle/keyword, so searching the cover image on the stale seed keyword
  // can return a photo (and Pexels alt text) unrelated to what was actually written.
  const imageSearchTerm = composed.tags[0] || composed.title
  let post: Awaited<ReturnType<typeof createPost>>
  try {
    // A draft the heal rejected gets no photo: it is not going anywhere. The photo is filed under the FINAL slug (the heal can
    // rewrite the title, and the slug follows it). It is inside this try so that any failure also takes back the audit rows.
    const image = rejectedByHeal ? null : await attachAutoblogCoverImage(admin, imageSearchTerm, final.slug, { destination: groundingPackage?.destination ?? null, title: final.title, cardFallback: true })
    // WP4 cover alt gate: the photo is attached after the text gate, so the alt check lives here. A cover with no useful alt text gets one
    // built by code from the title and place (the same function the site crawl uses); it is a fix, never a reason to hold the post.
    const coverAltText = image && coverAltIssue({ url: image.cover_image_url, alt: image.alt_text })
      ? coverAlt({ title: final.title, destination: groundingPackage?.destination ?? null, keyword: final.primary_keyword })
      : image?.alt_text ?? null
    post = await createPost({
      title: final.title,
      slug: final.slug,
      body: appendStyledCta(final.body, ctaStyle.id, groundingPackage),
      tags: final.tags,
      cover_image_url: image?.cover_image_url ?? null,
      alt_text: coverAltText,
      status: publishing ? 'published' : 'draft',
      publish_date: publishing ? new Date().toISOString().slice(0, 10) : null,
      meta_title: final.seo_title,
      meta_description: final.seo_description,
      content_style: final.content_style || style.id,
      faq: final.faq,
      key_takeaways: final.key_takeaways,
      og_title: final.og_title,
      og_description: final.og_description,
      primary_keyword: final.primary_keyword,
      secondary_keywords: final.secondary_keywords,
    })
  } catch (err) {
    // The post was never saved, so its audit rows would point at nothing.
    await deleteEdits(admin, repairLogIds).catch(() => undefined)
    throw err
  }
  await finalizeEdits(admin, repairLogIds, { id: post.id, path: `/blog/${post.slug}`, published: publishing })
  // The cover headline the title step wrote (hooks in content). Kept in app_settings, no migration; a failed save just means the cover keeps its old headline.
  if (!rejectedByHeal) await saveCoverHeadline(admin, post.slug, final.cover_headline ?? (final.title === composed.title ? composed.cover_headline : undefined))
  // Record the choices so a later step can compare styles against real clicks, visits and leads. A held
  // draft also records why, which the morning brief reads.
  await tagVariant(admin, post.slug, {
    content_style: style.id,
    cta_style: ctaStyle.id,
    ...(blockers.length ? { held_reasons: [...blockers, ...(heal && heal.status !== 'healed' ? [healNoteOf(heal)] : [])].join('; ') } : {}),
    // rejected_by_heal: the same marker the blog re-check uses, so the draft no longer counts towards today's post or the trip's wall.
    ...(rejectedByHeal ? { reheal_state: 'rejected', reheal_last: new Date().toISOString() } : {}),
  })

  if (queueRowId) await setTopicStatus(admin, queueRowId, 'used', { used_slug: post.slug })
  // Close the loop: the keyword this post was written for now points at it, so it is not picked again and
  // the Keyword Research and Search Rankings pages show which page serves which keyword.
  // The whole keyword set the post was written for points at it (an approved engine idea counts too), so
  // the Keyword Research page moves those phrases from "shoot for" to "has a page" and then to "ranking".
  if (rejectedByHeal && keywordLed) await markKeywordSkipped(admin, topic.keyword, 'the draft written for it was rejected by the self-heal')
  if (!rejectedByHeal && (keywordLed || (queueRowId && seedKeywords.length > 1))) {
    await admin.from('keyword_research').update({ target_path: `/blog/${post.slug}`, updated_at: new Date().toISOString() }).in('keyword', seedKeywords).eq('country', SITE_ID).is('target_path', null)
  }
  if (publishing) {
    // The go-live time for the shared publishing limiter (lib/publish-cadence.ts).
    await recordPublish(admin, 'post', postCadenceKey(post.slug))
    await enrollIfDue(admin, post.slug, post.title)
    // Tell Bing a new public blog page appeared. Never blocks or fails the post above.
    await pingIndexNow([`/blog/${post.slug}`, '/blog', '/'])
  }

  return {
    ran: true,
    mode,
    note: (rejectedByHeal && heal ? `wrote a draft, then ${healNoteOf(heal)} (the day's slot is free; the next run picks another topic)` : blockers.length ? `wrote a draft - quality gate held it back: ${blockers.join('; ')}${heal ? ` (${healNoteOf(heal)})` : ''}` : heal?.status === 'healed' ? `ok (healed in ${heal.rounds} round${heal.rounds === 1 ? '' : 's'})` : 'ok') + (post.seoColumnsMissing ? ' | saved without FAQ/takeaways: run migration 0027' : ''),
    postId: post.id,
    postSlug: post.slug,
    published: publishing,
  }
}
