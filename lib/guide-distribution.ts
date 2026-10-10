import type { SupabaseClient } from '@supabase/supabase-js'
import { getDistributionMode } from '@/lib/distribution'
import { isAutomationPaused } from '@/lib/automation-kill-switch'
import { guideDistributionPath, guideDistributionSlug } from '@/lib/guide-post-source'
import type { GuideKind } from '@/lib/guides'

// Social posts for published guides (growth loop WP7). A published guide is enrolled into the same
// post_distribution ledger as a blog post (content_type 'post', slug `guide-<kind>-<slug>`, `path` set), and
// the same posting pass sends it: same captions, hook rotation, UTM tags and send code. This file only decides
// WHETHER to enrol. It never sends anything. At most ONE guide is enrolled per UTC day across all kinds.

/** The most guides enrolled for social posting per UTC day, across every kind. */
export const GUIDE_ENROLMENTS_PER_DAY = 1

/** Kinds that name a real business. Their social posts are enrolled as `held` whatever distribution_mode is. */
export const HELD_GUIDE_KINDS: readonly GuideKind[] = ['hotels', 'resorts', 'ships', 'river-cruises', 'yachts']

/** 00:00 UTC of the day `now` falls in, as an ISO string. */
export function utcDayStart(now: Date = new Date()): string {
  return `${now.toISOString().slice(0, 10)}T00:00:00.000Z`
}

/** Guide rows enrolled since `sinceIso` (slug starts with 'guide-' AND path is set, so a blog post whose own
 * slug begins "guide-" is never counted), or null when the count could not be read. Callers MUST treat null as
 * "do not enrol" (fail closed). Also null before migration 0030 is applied (no path column yet). */
export async function guideEnrolmentsSince(admin: SupabaseClient, sinceIso: string): Promise<number | null> {
  try {
    const { count, error } = await admin
      .from('post_distribution')
      .select('slug', { count: 'exact', head: true })
      .like('slug', 'guide-%')
      .not('path', 'is', null)
      .gte('created_at', sinceIso)
    return error ? null : (count ?? 0)
  } catch {
    return null
  }
}

/** The networks each guide's social post really reached, keyed by ledger slug (`guide-<kind>-<slug>`), read from
 * post_distribution.sent_platforms. A guide that was never posted has no entry. Never throws: an unreadable
 * ledger (or migration 0030 not applied yet) is an empty map, which the admin shows as "not posted". */
export async function guideSocialNetworks(admin: SupabaseClient): Promise<Record<string, string[]>> {
  try {
    const { data, error } = await admin.from('post_distribution').select('slug, sent_platforms').like('slug', 'guide-%').not('path', 'is', null)
    if (error) return {}
    const out: Record<string, string[]> = {}
    for (const r of (data ?? []) as { slug: string; sent_platforms: string[] | null }[]) {
      if (r.sent_platforms && r.sent_platforms.length > 0) out[r.slug] = r.sent_platforms
    }
    return out
  } catch {
    return {}
  }
}

export interface GuideToEnrol {
  kind: GuideKind
  slug: string
  name: string
  status: string
  /** Gate or review notes. A guide with notes was held back by the quality gate and is never promoted. */
  quality_notes?: string | null
}

/** Enrols a just-published guide for social posting, once. A no-op (and never an error) when: the guide is not
 * published, distribution mode is off, automation is paused, the guide is already enrolled, today's guide
 * enrolment is already used, or the daily count cannot be read. `prepare` mode enrols into `held` (an admin
 * approves it), `auto` into `queued`, exactly as enrollIfDue does for posts. Never throws: a ledger failure
 * must never block publishing the guide. Returns what happened, for logs and tests. */
export async function enrollGuideIfDue(admin: SupabaseClient, guide: GuideToEnrol): Promise<'enrolled' | 'skipped'> {
  try {
    if (guide.status !== 'published') return 'skipped'
    // A guide the quality gate held back (an admin force-published it) is not promoted on social.
    if (guide.quality_notes && guide.quality_notes.trim()) return 'skipped'
    const mode = await getDistributionMode(admin)
    if (mode === 'off') return 'skipped'
    if (await isAutomationPaused(admin)) return 'skipped'

    const slug = guideDistributionSlug(guide.kind, guide.slug)
    const { data: existing, error: existingError } = await admin.from('post_distribution').select('slug').eq('content_type', 'post').eq('slug', slug).maybeSingle()
    if (existingError || existing) return 'skipped'

    const since = utcDayStart()
    const before = await guideEnrolmentsSince(admin, since)
    if (before === null || before >= GUIDE_ENROLMENTS_PER_DAY) return 'skipped'

    const { error } = await admin.from('post_distribution').insert({
      content_type: 'post',
      slug,
      title: guide.name,
      path: guideDistributionPath(guide.kind, guide.slug),
      // Named properties always wait for Joel to release them from the Distribution screen, in any mode.
      stage: mode === 'prepare' || HELD_GUIDE_KINDS.includes(guide.kind) ? 'held' : 'queued',
    })
    if (error) return 'skipped'

    // Two guides published in the same instant could both pass the check above. Count again: if the day is now
    // over its limit, take this row back out (it has not been sent, only enrolled) so the limit holds.
    const after = await guideEnrolmentsSince(admin, since)
    if (after === null || after > GUIDE_ENROLMENTS_PER_DAY) {
      await admin.from('post_distribution').delete().eq('content_type', 'post').eq('slug', slug).neq('stage', 'done')
      return 'skipped'
    }
    return 'enrolled'
  } catch (err) {
    console.error('[guide-distribution] enrol failed:', err instanceof Error ? err.message : err)
    return 'skipped'
  }
}
