import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { getSetting, setSetting } from '@/lib/app-settings'
import { listPostsAdmin, createPost } from '@/lib/posts'
import { dueApprovedTopics, pickOneTopic, setTopicStatus, type TopicIdea } from '@/lib/blog-topics'
import { composeFullPost, autoPublishBlockers } from '@/lib/blog-composer'
import { findDuplicate } from '@/lib/content-dedupe'
import { enrollIfDue } from '@/lib/distribution'
import { getAutoblogPostsPerWeek, isPublishDayDue, currentWeekday } from '@/lib/autoblog-cadence'
import { isAutomationPaused } from '@/lib/automation-kill-switch'
import { attachAutoblogCoverImage } from '@/lib/blog-image'
import { pingIndexNow } from '@/lib/indexnow'

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
    const today = new Date().toISOString().slice(0, 10)
    if (existingPosts.some((p) => p.created_at?.slice(0, 10) === today)) {
      return { ran: false, mode, note: 'already wrote a post today' }
    }
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
  if (!topic) topic = await pickOneTopic(admin, existingPosts.map((p) => p.title))
  if (!topic) return { ran: false, mode, note: 'no topic available' }

  const composed = await composeFullPost(topic.angle, topic.keyword)
  if (!composed) return { ran: false, mode, note: 'composer failed or AI unconfigured' }

  // Pre-compose dedupe only checked the topic's angle, but the AI's 'idea'/'title' steps are free
  // to land on a title that duplicates an existing post by content even when the angle didn't.
  // Renaming the slug alone still wrote a second, functionally-duplicate post - skip creation
  // instead and let the next scheduled/admin-triggered run pick a different topic.
  if (findDuplicate(composed.title, existingPosts)) {
    if (queueRowId) await setTopicStatus(admin, queueRowId, 'used', {})
    return { ran: false, mode, note: `skipped - duplicate of an existing post: "${composed.title}"` }
  }

  const blockers = mode === 'publish' ? autoPublishBlockers(composed) : []
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
    body: composed.body,
    tags: composed.tags,
    cover_image_url: image?.cover_image_url ?? null,
    alt_text: image?.alt_text ?? null,
    status: publishing ? 'published' : 'draft',
    publish_date: publishing ? new Date().toISOString().slice(0, 10) : null,
    meta_title: composed.seo_title,
    meta_description: composed.seo_description,
  })

  if (queueRowId) await setTopicStatus(admin, queueRowId, 'used', { used_slug: post.slug })
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
