import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { getSetting } from '@/lib/app-settings'
import { listPostsAdmin, createPost } from '@/lib/posts'
import { dueApprovedTopics, pickOneTopic, setTopicStatus, type TopicIdea } from '@/lib/blog-topics'
import { composeFullPost, autoPublishBlockers } from '@/lib/blog-composer'
import { findDuplicate } from '@/lib/content-dedupe'

// Ported from Nomad Escape Plan's modules/marketing/autoblog-run.ts (Factory Phase 2:
// blog/autoblog), adapted to this project's posts table (lib/posts.ts) and app_settings helper
// (lib/app-settings.ts). Dropped: the Autopilot "posts per week" dial and weekday scheduling
// (Nomad's own admin feature, not part of this port) - a scheduled run here still self-limits to
// one post per day, just without a configurable weekly cadence. That cadence dial is a genuine
// follow-up if Joel wants finer control than "at most one a day", not something to invent here.
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

/** One post per call, at most. `scheduled: true` (the cron) also caps at one post per calendar
 * day; `scheduled: false` (the admin "run now" button) bypasses that daily cap. */
export async function runAutoblog(opts: { scheduled: boolean }): Promise<AutoblogResult> {
  const mode = await getAutoblogMode()
  if (mode === 'off') return { ran: false, mode, note: 'autoblog is off' }

  const admin = getSupabaseAdmin()
  const existingPosts = await listPostsAdmin()

  if (opts.scheduled) {
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

  if (findDuplicate(composed.title, existingPosts)) {
    composed.slug = `${composed.slug}-${Date.now().toString(36)}`
  }

  const blockers = mode === 'publish' ? autoPublishBlockers(composed) : []
  const publishing = mode === 'publish' && blockers.length === 0

  const post = await createPost({
    title: composed.title,
    slug: composed.slug,
    body: composed.body,
    tags: composed.tags,
    status: publishing ? 'published' : 'draft',
    publish_date: publishing ? new Date().toISOString().slice(0, 10) : null,
    meta_title: composed.seo_title,
    meta_description: composed.seo_description,
  })

  if (queueRowId) await setTopicStatus(admin, queueRowId, 'used', { used_slug: post.slug })

  return {
    ran: true,
    mode,
    note: blockers.length ? `wrote a draft - quality gate held it back: ${blockers.join('; ')}` : 'ok',
    postId: post.id,
    postSlug: post.slug,
    published: publishing,
  }
}
