import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { getSetting, setSetting } from '@/lib/app-settings'
import { getGuideCaps, readCapUsage, getGuidePublishMode, loadBackfillProgress } from '@/lib/guide-run'
import { readBackfillState } from '@/lib/guide-backfill'
import { GUIDE_CATCHUP_KEY } from '@/lib/guide-distribution'
import { healLoopCard } from '@/lib/heal-loop'
import { readGuideSpend } from '@/lib/guide-spend'
import { getAutoblogMaxPerDay } from '@/lib/autoblog-cadence'
import { ENRICH_MAX_ATTEMPTS, listSafePages } from '@/lib/safe-enrich'
import { readOrphanAudit } from '@/lib/guide-orphans'
import { countGuidesNeedingPhoto } from '@/lib/guide-photo-run'
import { TRIP_SOCIAL_KEY, TRIP_ENROLMENTS_PER_WEEK, TRIP_HOLD_HOURS } from '@/lib/trip-social'
import { PROMOTION_GAP_DAYS } from '@/lib/promotion'
import { pastTripsNeedingRecap } from '@/lib/past-trip'
import { checkPublishedPostsForDrift } from '@/lib/content-drift'
import { isExactTrue, parseToggleRequest } from '@/lib/posts-menu-2'
import { listTopicQueue } from '@/lib/blog-topics'
import { getAutoblogMode } from '@/lib/autoblog-run'
import { getAutoblogPostsPerWeek, currentWeekday } from '@/lib/autoblog-cadence'
import { describeAutoblogPlan, parseLastRun } from '@/lib/autoblog-summary'
import { isAutomationPaused } from '@/lib/automation-kill-switch'
import { cronRunKey } from '@/lib/cron-heartbeat'
import { getDistributionMode, getTailoredCaptionsEnabled } from '@/lib/distribution'
import { getNewsMode, getNewsPerDay } from '@/lib/news-settings'
import { derivePostType } from '@/lib/blog-admin-filters'
import { pickPostImage } from '@/lib/social-cover'
import { SITE_URL } from '@/lib/site'

export const dynamic = 'force-dynamic'

// Read-only summary for the Automation card at the top of each Posts page (GET). Nothing is written by GET.
// `type` is blog, news, guides or trips. POST flips one of the two small on/off switches (guide catch-up, trip social posts).
export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const type = new URL(request.url).searchParams.get('type')
    if (type !== 'blog' && type !== 'news' && type !== 'guides' && type !== 'trips') return NextResponse.json({ error: 'type must be blog, news, guides or trips' }, { status: 400 })
    const admin = getSupabaseAdmin()
    if (type === 'guides') return NextResponse.json(await guidesFacts(admin))
    if (type === 'trips') return NextResponse.json(await tripsFacts(admin))

    const [distributionMode, tailoredCaptions, paused] = await Promise.all([
      getDistributionMode(admin).catch(() => 'off' as const),
      getTailoredCaptionsEnabled(admin).catch(() => false),
      isAutomationPaused(admin).catch(() => false),
    ])

    // The newest published post of this kind, to say whether a composed Instagram cover can be made for it.
    const { data: recent } = await admin
      .from('posts')
      .select('slug, title, tags, related_package_id, cover_image_url')
      .eq('status', 'published')
      .order('publish_date', { ascending: false, nullsFirst: false })
      .limit(60)
    const newest = ((recent ?? []) as { slug: string; title: string; tags: string[] | null; related_package_id: string | null; cover_image_url: string | null }[])
      .find((p) => (type === 'news' ? derivePostType({ slug: p.slug, tags: p.tags ?? [], related_package_id: p.related_package_id }) === 'news' : derivePostType({ slug: p.slug, tags: p.tags ?? [], related_package_id: p.related_package_id }) !== 'news'))
    const picked = newest ? pickPostImage({ base: SITE_URL, kind: type, slug: newest.slug, title: newest.title, coverUrl: newest.cover_image_url }) : null
    const cover = { composedAvailable: !!picked?.composed, sampleUrl: picked?.composed ? picked.url : null, sampleSlug: newest?.slug ?? null }
    const common = { type, distributionMode, tailoredCaptions, paused, cover }

    if (type === 'blog') {
      const [topics, mode, postsPerWeek, maxPerDay, lastAutoblog, lastAutopilot] = await Promise.all([
        listTopicQueue(admin).catch(() => []),
        getAutoblogMode(),
        getAutoblogPostsPerWeek(admin),
        getAutoblogMaxPerDay(admin),
        getSetting(admin, cronRunKey('autoblog')).catch(() => null),
        getSetting(admin, cronRunKey('autopilot')).catch(() => null),
      ])
      const approved = topics.filter((t) => t.status === 'approved').length
      const ab = parseLastRun(lastAutoblog)
      const ap = parseLastRun(lastAutopilot)
      const lastRun = ab && ap ? (Date.parse(ap.at) > Date.parse(ab.at) ? ap : ab) : ab ?? ap
      const plan = describeAutoblogPlan({ mode, paused, postsPerWeek, todayWeekday: currentWeekday(), approvedTopics: approved })
      return NextResponse.json({ ...common, mode, postsPerWeek, maxPerDay, approvedTopics: approved, plan, lastRun })
    }

    const [mode, perDay] = await Promise.all([getNewsMode(admin), getNewsPerDay(admin)])
    return NextResponse.json({ ...common, mode, perDay })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}

type Admin = ReturnType<typeof getSupabaseAdmin>

// Guides: every number here is read from what the pipeline already stores. A read that fails shows as null, never as a made-up zero.
async function guidesFacts(admin: Admin) {
<<<<<<< HEAD
  const [publishMode, caps, usage, heal, catchup, safe, orphanAudit, backfillState, backfillActive, distributionMode, paused, spend] = await Promise.all([
=======
  const [publishMode, caps, usage, heal, catchup, safe, orphanAudit, backfillState, backfillActive, distributionMode, paused, photoCount] = await Promise.all([
>>>>>>> loop-guide-photos
    getGuidePublishMode(admin).catch(() => null),
    getGuideCaps(admin).catch(() => null),
    readCapUsage(admin).catch(() => null),
    healLoopCard(admin).catch(() => null),
    getSetting(admin, GUIDE_CATCHUP_KEY).catch(() => null),
    listSafePages(admin).catch(() => null),
    readOrphanAudit(admin).catch(() => null),
    readBackfillState(admin).catch(() => null),
    loadBackfillProgress(admin).catch(() => null),
    getDistributionMode(admin).catch(() => 'off' as const),
    isAutomationPaused(admin).catch(() => false),
<<<<<<< HEAD
    readGuideSpend(admin).catch(() => null),
=======
    countGuidesNeedingPhoto(admin).catch(() => null),
>>>>>>> loop-guide-photos
  ])
  const backfill =!backfillState
    ? { state: 'none' as const, written: 0, waiting: 0 }
    : backfillState.cancelled_at
      ? { state: 'cancelled' as const, written: 0, waiting: 0 }
      : backfillActive && backfillActive.progress.waiting > 0
        ? { state: 'running' as const, written: backfillActive.progress.written, waiting: backfillActive.progress.waiting }
        : { state: 'done' as const, written: backfillActive?.progress.written ?? 0, waiting: 0 }
  const safePages = safe?.pages ?? null
  return {
    type: 'guides' as const,
    distributionMode,
    paused,
    publishMode,
    caps,
    usage,
    heal: heal ? { cap: heal.cap, used: heal.used, readable: heal.readable, waiting: heal.waiting, healedToday: heal.healedToday } : null,
    catchup: { enabled: isExactTrue(catchup), key: GUIDE_CATCHUP_KEY },
    backfill,
    safePages: safePages
      ? { count: safePages.length, attemptsUsed: safePages.reduce((n, p) => n + p.attempts, 0), maxAttempts: ENRICH_MAX_ATTEMPTS, usedUp: safePages.filter((p) => p.state === 'used-up').length, ready: safePages.filter((p) => p.state === 'ready').length }
      : null,
    spend,
    orphans: orphanAudit ? { count: orphanAudit.orphans.length, checked: orphanAudit.checked, at: orphanAudit.at } : null,
    // Published guides whose hero is a duplicate, missing, tiny or a wrong subject (the daily heal fixes up to 3 a day). Null = could not be read.
    photosNeeded: photoCount,
  }
}

// Trips: the posting rules are fixed in code (lib/trip-social.ts, lib/promotion.ts); this only reports them and the live counts.
async function tripsFacts(admin: Admin) {
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString()
  const [enabledRaw, distributionMode, paused, held, thisWeek, needRecap, drift] = await Promise.all([
    getSetting(admin, TRIP_SOCIAL_KEY).catch(() => null),
    getDistributionMode(admin).catch(() => 'off' as const),
    isAutomationPaused(admin).catch(() => false),
    admin.from('post_distribution').select('slug', { count: 'exact', head: true }).like('slug', 'package-%').not('path', 'is', null).eq('stage', 'held').then((r) => (r.error ? null : r.count ?? 0), () => null),
    admin.from('post_distribution').select('slug', { count: 'exact', head: true }).like('slug', 'package-%').not('path', 'is', null).gte('created_at', weekAgo).then((r) => (r.error ? null : r.count ?? 0), () => null),
    pastTripsNeedingRecap(admin).then((r) => r.length, () => null),
    checkPublishedPostsForDrift().then((r) => r.length, () => null),
  ])
  return {
    type: 'trips' as const,
    distributionMode,
    paused,
    tripSocial: { enabled: isExactTrue(enabledRaw), key: TRIP_SOCIAL_KEY },
    caps: { perTripDays: PROMOTION_GAP_DAYS, perWeek: TRIP_ENROLMENTS_PER_WEEK, holdHours: TRIP_HOLD_HOURS, text: `1 post per trip per ${PROMOTION_GAP_DAYS} days, ${TRIP_ENROLMENTS_PER_WEEK} per week, ${TRIP_HOLD_HOURS}h hold` },
    heldNow: held,
    enrolledThisWeek: thisWeek,
    pastTripsNeedingRecap: needRecap,
    drift: { findings: drift },
  }
}

// POST { setting: 'guide_catchup_posts' | 'trip_social_posts', enabled: true | false }
// Flips one switch. The value must be a real boolean and the setting must be on the short list; it is stored as exactly 'true' or 'false'.
export async function POST(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const parsed = parseToggleRequest(await request.json().catch(() => ({})))
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })
    const { error } = await setSetting(getSupabaseAdmin(), parsed.key, parsed.value)
    if (error) return NextResponse.json({ error }, { status: 500 })
    return NextResponse.json({ ok: true, setting: parsed.key, enabled: parsed.value === 'true' })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}
