import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { getSetting } from '@/lib/app-settings'
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

// Read-only summary for the Automation card at the top of each Posts page. Nothing is written here.
// `type` is blog or news today; the Guides and Trips pages add their own branch in phase 2.
export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const type = new URL(request.url).searchParams.get('type')
    if (type !== 'blog' && type !== 'news') return NextResponse.json({ error: 'type must be blog or news' }, { status: 400 })
    const admin = getSupabaseAdmin()

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
      const [topics, mode, postsPerWeek, lastAutoblog, lastAutopilot] = await Promise.all([
        listTopicQueue(admin).catch(() => []),
        getAutoblogMode(),
        getAutoblogPostsPerWeek(admin),
        getSetting(admin, cronRunKey('autoblog')).catch(() => null),
        getSetting(admin, cronRunKey('autopilot')).catch(() => null),
      ])
      const approved = topics.filter((t) => t.status === 'approved').length
      const ab = parseLastRun(lastAutoblog)
      const ap = parseLastRun(lastAutopilot)
      const lastRun = ab && ap ? (Date.parse(ap.at) > Date.parse(ab.at) ? ap : ab) : ab ?? ap
      const plan = describeAutoblogPlan({ mode, paused, postsPerWeek, todayWeekday: currentWeekday(), approvedTopics: approved })
      return NextResponse.json({ ...common, mode, postsPerWeek, approvedTopics: approved, plan, lastRun })
    }

    const [mode, perDay] = await Promise.all([getNewsMode(admin), getNewsPerDay(admin)])
    return NextResponse.json({ ...common, mode, perDay })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}
