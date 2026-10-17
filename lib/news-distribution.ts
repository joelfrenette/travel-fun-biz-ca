import type { SupabaseClient } from '@supabase/supabase-js'
import { getDistributionMode } from '@/lib/distribution'
import { isAutomationPaused } from '@/lib/automation-kill-switch'
import { isNewsSlug } from '@/lib/news-post'

// Social posts for travel news (growth loop WP20). A published news post is enrolled into the SAME post_distribution ledger
// as every blog post (content_type 'post', slug = the post slug, which starts "news-"), and the same posting pass in
// lib/distribution.ts sends it: the same captions (the hook is the post's first key takeaway, which is the brief's first
// sentence), the same per-network limits, hook rotation, UTM tags (utm_campaign is the slug, so it starts "news-") and the
// same send code. This file only decides WHETHER to enrol. It never sends anything and is not a send path.

/** The most social posts enrolled per UTC day across everything: blog posts, guides and news together. */
export const SOCIAL_ENROLMENTS_PER_DAY_CEILING = 6

export const utcDayStart = (now: Date = new Date()): string => `${now.toISOString().slice(0, 10)}T00:00:00.000Z`

/** Ledger rows created since `sinceIso` whose slug starts "news-", or null when the count could not be read (callers must
 * treat null as "do not enrol": fail closed). */
export async function newsEnrolmentsSince(admin: SupabaseClient, sinceIso: string): Promise<number | null> {
  try {
    const { count, error } = await admin.from('post_distribution').select('slug', { count: 'exact', head: true }).like('slug', 'news-%').gte('created_at', sinceIso)
    return error ? null : (count ?? 0)
  } catch {
    return null
  }
}

/** Every ledger row created since `sinceIso`, or null when unreadable. This is the cap news SHARES with blog posts and guides. */
export async function allEnrolmentsSince(admin: SupabaseClient, sinceIso: string): Promise<number | null> {
  try {
    const { count, error } = await admin.from('post_distribution').select('slug', { count: 'exact', head: true }).gte('created_at', sinceIso)
    return error ? null : (count ?? 0)
  } catch {
    return null
  }
}

export interface NewsToEnrol {
  slug: string
  title: string
  status: string
}

/** Enrols a just-published news post for social posting, ONCE. A no-op (never an error) when the post is not a published
 * news post, distribution is off, automation is paused, the post is already in the ledger, today's news count is already
 * `perDay`, today's total across all kinds is already at the ceiling, or either count cannot be read. `prepare` mode
 * enrols into `held` (a person approves it), `auto` into `queued`, exactly as enrollIfDue does for blog posts. */
export async function enrollNewsIfDue(admin: SupabaseClient, post: NewsToEnrol, perDay: number): Promise<'enrolled' | 'skipped' | 'ceiling'> {
  try {
    if (post.status !== 'published' || !isNewsSlug(post.slug)) return 'skipped'
    const mode = await getDistributionMode(admin)
    if (mode === 'off') return 'skipped'
    if (await isAutomationPaused(admin)) return 'skipped'

    const { data: existing, error: existingError } = await admin.from('post_distribution').select('slug').eq('content_type', 'post').eq('slug', post.slug).maybeSingle()
    if (existingError || existing) return 'skipped'

    const since = utcDayStart()
    const newsBefore = await newsEnrolmentsSince(admin, since)
    const allBefore = await allEnrolmentsSince(admin, since)
    if (newsBefore === null || allBefore === null || newsBefore >= perDay) return 'skipped'
    // The ceiling is shared with blog posts and guides and is one-sided (news cannot reserve room in it), so when it is the
    // reason news is skipped the caller says so in the step note.
    if (allBefore >= SOCIAL_ENROLMENTS_PER_DAY_CEILING) return 'ceiling'

    const { error } = await admin.from('post_distribution').insert({ content_type: 'post', slug: post.slug, title: post.title, stage: mode === 'prepare' ? 'held' : 'queued' })
    if (error) return 'skipped'

    // Two runs at the same instant could both pass the check above. Count again: if either limit is now exceeded, take this
    // row back out (it has not been sent, only enrolled) so the limits hold.
    const newsAfter = await newsEnrolmentsSince(admin, since)
    const allAfter = await allEnrolmentsSince(admin, since)
    if (newsAfter === null || allAfter === null || newsAfter > perDay || allAfter > SOCIAL_ENROLMENTS_PER_DAY_CEILING) {
      await admin.from('post_distribution').delete().eq('content_type', 'post').eq('slug', post.slug).neq('stage', 'done')
      return allAfter !== null && allAfter > SOCIAL_ENROLMENTS_PER_DAY_CEILING ? 'ceiling' : 'skipped'
    }
    return 'enrolled'
  } catch (err) {
    console.error('[news-distribution] enrol failed:', err instanceof Error ? err.message : err)
    return 'skipped'
  }
}
