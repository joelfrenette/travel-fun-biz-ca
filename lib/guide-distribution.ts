import type { SupabaseClient } from '@supabase/supabase-js'
import { getDistributionMode } from '@/lib/distribution'
import { isAutomationPaused } from '@/lib/automation-kill-switch'
import { guideDistributionPath, guideDistributionSlug } from '@/lib/guide-post-source'
import type { GuideKind } from '@/lib/guides'
import { autoHoldNote, readReleaseHours } from '@/lib/guide-release'
import { getSetting } from '@/lib/app-settings'

// Social posts for published guides (growth loop WP7). A published guide is enrolled into the same
// post_distribution ledger as a blog post (content_type 'post', slug `guide-<kind>-<slug>`, `path` set), and
// the same posting pass sends it: same captions, hook rotation, UTM tags and send code. This file only decides
// WHETHER to enrol. It never sends anything. At most ONE guide is enrolled per UTC day across all kinds.

/** The most guides enrolled for social posting per UTC day, across every kind. */
export const GUIDE_ENROLMENTS_PER_DAY = 1

/** Kinds that name a real business. Their social posts are enrolled as `held` whatever distribution_mode is, and (in auto
 * mode) released by themselves after guide_social_release_hours when the caption passes (lib/guide-release.ts). */
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

    // Named properties are enrolled as held. In auto mode they carry an "Auto-hold" note and are released by the posting
    // pass after guide_social_release_hours (default 24) if their caption passes the checks (lib/guide-release.ts);
    // with the wait set to 0 (or unreadable) they wait for an approval, as they always did. In prepare mode every row
    // waits for an approval, so no note is added.
    const named = HELD_GUIDE_KINDS.includes(guide.kind)
    const hours = named && mode === 'auto' ? await readReleaseHours(admin) : 0
    const autoHold = named && mode === 'auto' && typeof hours === 'number' && hours > 0
    const { error } = await admin.from('post_distribution').insert({
      content_type: 'post',
      slug,
      title: guide.name,
      path: guideDistributionPath(guide.kind, guide.slug),
      stage: mode === 'prepare' || named ? 'held' : 'queued',
      ...(autoHold ? { last_error: autoHoldNote(hours as number) } : {}),
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

// ---- Catch-up enrolment (growth loop) ----
// A guide is enrolled for social posting at publish time (lib/guide-run.ts). Guides published before that existed,
// or when the daily cap was already used, never got a post. This catch-up runs inside the existing posting pass
// (lib/distribution.ts runDistribution), no new cron: while today's single guide enrolment is unused, it hands the
// oldest never-posted published guide (destinations first) to enrollGuideIfDue(), which keeps every rule: the cap,
// held for named businesses, the kill switch, distribution mode, and the caption checks at send time.

export interface CatchUpGuide extends GuideToEnrol {
  created_at?: string | null
}

/** The guide to catch up on, or null. Pure. Candidates are published guides with empty quality_notes and no
 * ledger row (`ledgerSlugs` holds ledger slugs, `guide-<kind>-<slug>`). Destinations come before every other kind;
 * within a group the oldest created_at wins (ties by slug, so the pick is stable). `enrolledToday` is the number
 * of guides already enrolled this UTC day; at or over GUIDE_ENROLMENTS_PER_DAY, or unreadable (null), returns null. */
export function pickCatchUpGuide(guides: readonly CatchUpGuide[], ledgerSlugs: ReadonlySet<string> | readonly string[], enrolledToday: number | null = 0): CatchUpGuide | null {
  if (enrolledToday === null || enrolledToday >= GUIDE_ENROLMENTS_PER_DAY) return null
  const ledger = ledgerSlugs instanceof Set ? ledgerSlugs : new Set(ledgerSlugs)
  const eligible = guides.filter((g) => g.status === 'published' && !(g.quality_notes && g.quality_notes.trim()) && !ledger.has(guideDistributionSlug(g.kind, g.slug)))
  if (eligible.length === 0) return null
  const time = (g: CatchUpGuide) => {
    const t = g.created_at ? Date.parse(g.created_at) : NaN
    return Number.isNaN(t) ? Number.MAX_SAFE_INTEGER : t
  }
  const sorted = [...eligible].sort((a, b) => {
    const da = a.kind === 'destinations' ? 0 : 1
    const db = b.kind === 'destinations' ? 0 : 1
    if (da !== db) return da - db
    if (time(a) !== time(b)) return time(a) - time(b)
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0
  })
  return sorted[0]
}

/** One catch-up try, called from the posting pass. Does nothing when today's enrolment is used or unreadable, when
 * no guide qualifies, or when a read fails. Never throws. Returns a short note for the run log, or '' for nothing. */
export const GUIDE_CATCHUP_KEY = 'guide_catchup_posts'

export async function runGuideCatchUp(admin: SupabaseClient): Promise<string> {
  try {
    // Off unless the setting is exactly 'true': old guides post as a bare photo until the titled covers are proven.
    if ((await getSetting(admin, GUIDE_CATCHUP_KEY)) !== 'true') return ''
    const used = await guideEnrolmentsSince(admin, utcDayStart())
    if (used === null || used >= GUIDE_ENROLMENTS_PER_DAY) return ''
    const { data: ledger, error: ledgerError } = await admin.from('post_distribution').select('slug').like('slug', 'guide-%').not('path', 'is', null)
    if (ledgerError) return ''
    const { data: rows, error: guidesError } = await admin.from('guides').select('kind, slug, name, status, quality_notes, created_at').eq('status', 'published')
    if (guidesError) return ''
    const pick = pickCatchUpGuide((rows ?? []) as CatchUpGuide[], new Set(((ledger ?? []) as { slug: string }[]).map((r) => r.slug)), used)
    if (!pick) return ''
    const result = await enrollGuideIfDue(admin, pick)
    return result === 'enrolled' ? `guide catch-up enrolled ${guideDistributionSlug(pick.kind, pick.slug)}` : ''
  } catch (err) {
    console.error('[guide-distribution] catch-up failed:', err instanceof Error ? err.message : err)
    return ''
  }
}
