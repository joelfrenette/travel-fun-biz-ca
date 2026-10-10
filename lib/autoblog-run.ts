import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { getSetting, setSetting } from '@/lib/app-settings'
import { listPostsAdmin, createPost } from '@/lib/posts'
import { dueApprovedTopics, pickKeywordTopic, markKeywordSkipped, pickOneTopic, setTopicStatus, findGroundingPackage, groundAngleInPackage, type TopicIdea } from '@/lib/blog-topics'
import { composeFullPost, autoPublishBlockers, type AllowedLink } from '@/lib/blog-composer'
import { pickStyle, CTA_STYLES, appendStyledCta } from '@/lib/content-styles'
import { tagVariant } from '@/lib/content-variants'
import { listSitePages } from '@/lib/site-pages'
import { getBestTimeToVisitSlugs } from '@/lib/best-time-to-visit'
import { generateSlug } from '@/lib/utils'
import { findDuplicate } from '@/lib/content-dedupe'
import { enrollIfDue } from '@/lib/distribution'
import { getAutoblogPostsPerWeek, isPublishDayDue, currentWeekday } from '@/lib/autoblog-cadence'
import { isAutomationPaused } from '@/lib/automation-kill-switch'
import { attachAutoblogCoverImage } from '@/lib/blog-image'
import { pingIndexNow } from '@/lib/indexnow'
import { SITE_ID } from '@/lib/site'
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

/** The pages the composer may link to from the body, each confirmed to exist right now: the matched
 * package, its destination page (only when a published package gives it one), and its
 * best-time-to-visit page (only when that page really exists). No package means no links, so the
 * writer cannot reach for a page that is not there. Never throws. */
async function buildAllowedLinks(admin: ReturnType<typeof getSupabaseAdmin>, pkg: PackageGrounding | null): Promise<AllowedLink[]> {
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
}

const RUN_LOCK_KEY = 'autoblog_run_lock'
// Generous vs. the composer's own ~290s worst case - a lock older than this is treated as
// abandoned (a crashed run) rather than still in progress, so a stuck lock can't wedge autoblog
// forever.
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
async function postsWrittenToday(admin: ReturnType<typeof getSupabaseAdmin>): Promise<number | null> {
  const start = `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`
  const { count, error } = await admin.from('posts').select('id', { count: 'exact', head: true }).gte('created_at', start)
  return error ? null : (count ?? 0)
}

/** One post per call, at most. `scheduled: true` (the cron) also caps at one post per calendar
 * day; `scheduled: false` (the admin "run now" button) bypasses that daily cap. */
export async function runAutoblog(opts: { scheduled: boolean }): Promise<AutoblogResult> {
  const mode = await getAutoblogMode()
  if (mode === 'off') return { ran: false, mode, note: 'autoblog is off' }

  const admin = getSupabaseAdmin()
  // The master kill switch overrides autoblog_mode without touching it - flip the switch back
  // off and whatever mode was set (draft/publish) resumes exactly as it was.
  if (await isAutomationPaused(admin)) return { ran: false, mode, note: 'automation is paused (kill switch)' }

  if (!(await acquireRunLock(admin))) {
    return { ran: false, mode, note: 'another autoblog run is already in progress' }
  }
  try {
    return await runAutoblogLocked(admin, mode, opts)
  } finally {
    await releaseRunLock(admin)
  }
}

async function runAutoblogLocked(admin: ReturnType<typeof getSupabaseAdmin>, mode: AutoblogMode, opts: { scheduled: boolean }): Promise<AutoblogResult> {
  const existingPosts = await listPostsAdmin()

  if (opts.scheduled) {
    const postsPerWeek = await getAutoblogPostsPerWeek(admin)
    if (!isPublishDayDue(postsPerWeek, currentWeekday())) {
      return { ran: false, mode, note: `not a publish day at ${postsPerWeek}/week` }
    }
    // A direct count, not the list above: this is the guard that stops a runaway, so it fails closed
    // (a read error means "do not write") and never depends on a list that could be stale.
    const wroteToday = await postsWrittenToday(admin)
    if (wroteToday === null) return { ran: false, mode, note: 'could not check whether a post was already written today, so nothing was written' }
    if (wroteToday > 0) return { ran: false, mode, note: 'already wrote a post today' }
  }

  if (opts.scheduled && (Number((await getSetting(admin, `autoblog_dupe_skips:${new Date().toISOString().slice(0, 10)}`)) ?? 0) || 0) >= 4) {
    return { ran: false, mode, note: 'every topic today was about a package already covered in the last 30 days; trying again tomorrow (add more trips or approve fresh topics to widen it)' }
  }

  let topic: TopicIdea | null = null
  let queueRowId: string | null = null
  for (const row of await dueApprovedTopics(admin)) {
    if (findDuplicate(row.angle, existingPosts)) {
      await setTopicStatus(admin, row.id, 'used', {})
      continue
    }
    topic = { angle: row.angle, keyword: row.keyword, why: row.why, source: row.source }
    queueRowId = row.id
    break
  }
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
    const since = new Date(Date.now() - 30 * 86_400_000).toISOString()
    const { count, error } = await admin.from('posts').select('id', { count: 'exact', head: true }).gte('created_at', since).ilike('body', `%/packages/${groundingPackage.slug}%`)
    if (error) return { ran: false, mode, note: 'could not check whether this package was already covered, so nothing was written' }
    if (count && count > 0) {
      if (queueRowId) await setTopicStatus(admin, queueRowId, 'used', {})
      if (keywordLed) await markKeywordSkipped(admin, topic.keyword, 'its package already has a recent post')
      await setSetting(admin, skipKey, String(skips + 1))
      return { ran: false, mode, note: `skipped - a post about "${groundingPackage.name}" was already written in the last 30 days (${skips + 1} of 4 repeats allowed today)` }
    }
  }

  const groundedAngle = groundAngleInPackage(topic.angle, groundingPackage)

  // Rotate the writing style off the last ten posts (existingPosts is newest first) and work out which
  // internal pages the post may link to.
  const style = pickStyle(existingPosts.slice(0, 10).map((p) => p.content_style))
  const ctaStyle = CTA_STYLES[existingPosts.length % CTA_STYLES.length]
  const allowedLinks = await buildAllowedLinks(admin, groundingPackage)

  const composed = await composeFullPost(groundedAngle, topic.keyword, { style, allowedLinks })
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
    if (again === null || again > 0) return { ran: false, mode, note: 'a post was written while this one was being composed, so this one was dropped' }
  }

  const blockers = mode === 'publish' ? autoPublishBlockers(composed, new Date(), { allowedPaths: allowedLinks.map((l) => l.path), groundingText: `${groundedAngle} ${topic.keyword}` }) : []
  const publishing = mode === 'publish' && blockers.length === 0
  // Use the composed post's own tags (derived from its actual keywords) rather than the
  // pre-composition topic.keyword - the composer's 'idea' step can land on an article that
  // diverges from the seed angle/keyword, so searching the cover image on the stale seed keyword
  // can return a photo (and Pexels alt text) unrelated to what was actually written.
  const imageSearchTerm = composed.tags[0] || composed.title
  const image = await attachAutoblogCoverImage(admin, imageSearchTerm, composed.slug)

  const post = await createPost({
    title: composed.title,
    slug: composed.slug,
    body: appendStyledCta(composed.body, ctaStyle.id, groundingPackage),
    tags: composed.tags,
    cover_image_url: image?.cover_image_url ?? null,
    alt_text: image?.alt_text ?? null,
    status: publishing ? 'published' : 'draft',
    publish_date: publishing ? new Date().toISOString().slice(0, 10) : null,
    meta_title: composed.seo_title,
    meta_description: composed.seo_description,
    content_style: composed.content_style || style.id,
    faq: composed.faq,
    key_takeaways: composed.key_takeaways,
    og_title: composed.og_title,
    og_description: composed.og_description,
    primary_keyword: composed.primary_keyword,
    secondary_keywords: composed.secondary_keywords,
  })
  // Record the choices so a later step can compare styles against real clicks, visits and leads.
  await tagVariant(admin, post.slug, { content_style: style.id, cta_style: ctaStyle.id })

  if (queueRowId) await setTopicStatus(admin, queueRowId, 'used', { used_slug: post.slug })
  // Close the loop: the keyword this post was written for now points at it, so it is not picked again and
  // the Keyword Research and Search Rankings pages show which page serves which keyword.
  if (keywordLed) {
    await admin.from('keyword_research').update({ target_path: `/blog/${post.slug}`, updated_at: new Date().toISOString() }).eq('keyword', topic.keyword).eq('country', SITE_ID).is('target_path', null)
  }
  if (publishing) {
    await enrollIfDue(admin, post.slug, post.title)
    // Tell Bing a new public blog page appeared. Never blocks or fails the post above.
    await pingIndexNow([`/blog/${post.slug}`, '/blog', '/'])
  }

  return {
    ran: true,
    mode,
    note: blockers.length ? `wrote a draft - quality gate held it back: ${blockers.join('; ')}` : 'ok',
    postId: post.id,
    postSlug: post.slug,
    published: publishing,
  }
}
