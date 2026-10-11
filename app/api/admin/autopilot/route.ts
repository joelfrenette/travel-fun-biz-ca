import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { isAutopilotOn, setAutopilot, autopilotReadiness, getVideosPerWeek, setVideosPerWeek } from '@/lib/autopilot'
import { runPipeline, readLastPipelineRun } from '@/lib/pipeline'
import { collectIssues, resolveIssue, type IssueAction } from '@/lib/issues'
import { runDebriefIfDue } from '@/lib/debrief'
import { sendThrottledAlert } from '@/lib/alerts'
import { alertHtml } from '@/lib/brief-html'
import { plainAction, HARD_WAITING_ISSUE_ID } from '@/lib/plain-steps'
import { getKeywordBudget, setKeywordBudget, readKeywordRefreshInfo } from '@/lib/keyword-refresh'
import { isKeywordDataConfigured } from '@/lib/keywords'
import { shotstackEnv } from '@/lib/shotstack'
import { getDistributionMode } from '@/lib/distribution'
import { readCronRuns } from '@/lib/cron-heartbeat'
import { judgeCron } from '@/lib/cron-health'

export const maxDuration = 300

export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const admin = getSupabaseAdmin()
    const [on, readiness, videosPerWeek, runs, pipeline, distributionMode, lastRun, keywordBudget, keywordInfo, issues] = await Promise.all([
      isAutopilotOn(admin),
      autopilotReadiness(admin),
      getVideosPerWeek(admin),
      readCronRuns(admin),
      admin.from('content_pipeline').select('*').order('created_at', { ascending: false }).limit(15),
      getDistributionMode(admin),
      readLastPipelineRun(admin),
      getKeywordBudget(admin),
      readKeywordRefreshInfo(admin),
      collectIssues(admin),
    ])
    const slugs = (pipeline.data ?? []).map((r: { slug: string }) => r.slug)
    const { data: posts } = slugs.length ? await admin.from('posts').select('slug, title, status').in('slug', slugs) : { data: [] }
    const titles = new Map((posts ?? []).map((p: { slug: string; title: string }) => [p.slug, p.title]))
    const statusOf = new Map((posts ?? []).map((p: { slug: string; status: string }) => [p.slug, p.status]))
    // The content map: for each blog post, where its social posts really went and how many leads it earned
    // (test leads never counted). One blog post becomes several social posts: the post itself, a carousel and a video.
    const { data: dist } = slugs.length ? await admin.from('post_distribution').select('slug, sent_platforms').eq('content_type', 'post').in('slug', slugs) : { data: [] }
    const postNetworks = new Map((dist ?? []).map((d: { slug: string; sent_platforms: string[] | null }) => [d.slug, d.sent_platforms ?? []]))
    const { data: leadRows } = slugs.length ? await admin.from('leads').select('utm_campaign').eq('is_test', false).in('utm_campaign', slugs) : { data: [] }
    const leadCount = new Map<string, number>()
    for (const l of (leadRows ?? []) as { utm_campaign: string }[]) leadCount.set(l.utm_campaign, (leadCount.get(l.utm_campaign) ?? 0) + 1)
    return NextResponse.json({
      on,
      readiness,
      videosPerWeek,
      shotstackEnv: shotstackEnv(),
      distributionMode,
      lastRun,
      issues,
      keyword: { budget: keywordBudget, configured: isKeywordDataConfigured(), lastRunAt: keywordInfo.lastRunAt, log: keywordInfo.log },
      cron: judgeCron('autopilot', runs.autopilot),
      rows: (pipeline.data ?? []).map((r: Record<string, unknown>) => ({
        ...r,
        title: titles.get(r.slug as string) ?? r.slug,
        post_status: statusOf.get(r.slug as string) ?? 'missing',
        post_networks: postNetworks.get(r.slug as string) ?? [],
        leads: leadCount.get(r.slug as string) ?? 0,
      })),
    })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const body = await request.json().catch(() => ({}))
    const admin = getSupabaseAdmin()
    if (typeof body.on === 'boolean') {
      const { error } = await setAutopilot(admin, body.on)
      if (error) return NextResponse.json({ error }, { status: 400 })
      return NextResponse.json({ on: body.on })
    }
    if (typeof body.videosPerWeek === 'number') {
      const { error } = await setVideosPerWeek(admin, body.videosPerWeek)
      if (error) return NextResponse.json({ error }, { status: 400 })
      return NextResponse.json({ videosPerWeek: body.videosPerWeek })
    }
    if (typeof body.keywordBudget === 'number') {
      const { error } = await setKeywordBudget(admin, body.keywordBudget)
      if (error) return NextResponse.json({ error }, { status: 400 })
      return NextResponse.json({ keywordBudget: body.keywordBudget })
    }
    if (body.action === 'issue' && typeof body.kind === 'string') {
      const error = await resolveIssue(admin, body.kind as IssueAction, typeof body.slug === 'string' ? body.slug : undefined)
      if (error) return NextResponse.json({ error }, { status: 400 })
      return NextResponse.json({ ok: true })
    }
    if (body.action === 'debrief') {
      // Emails the daily brief now (does not use up the 7 am send).
      const sent = await runDebriefIfDue(admin, { force: true })
      return NextResponse.json({ note: sent?.note ?? 'nothing to send' }, { status: sent?.ok === false ? 502 : 200 })
    }
    if (body.action === 'test-alert') {
      // Emails one "needs attention" alert right now in the same look as the daily brief, built from whatever is
      // open (or the first two setup items when nothing is), so the admin can see what a real alert looks like.
      // Ignores the 6-hour throttle and does not move it. Nothing else changes.
      const all = await collectIssues(admin)
      const open = all.filter((i) => i.area !== 'setup' && i.id !== HARD_WAITING_ISSUE_ID)
      const actions = (open.length ? open : all.slice(0, 2)).map(plainAction)
      if (!actions.length) return NextResponse.json({ note: 'nothing is open right now, so there is nothing to show in a test alert' })
      const dateLabel = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Toronto', weekday: 'long', month: 'long', day: 'numeric' })
      const result = await sendThrottledAlert(
        admin,
        `TEST: Autopilot: ${actions.length} thing${actions.length === 1 ? '' : 's'} need${actions.length === 1 ? 's' : ''} attention`,
        [...actions.flatMap((a) => [`* ${a.title}`, `  ${a.why}`, ...a.steps.map((s, k) => `  ${k + 1}) ${s}`), `  ${a.urlLabel}: ${a.url}`, '']), 'See everything: https://www.travelfunbiz.ca/admin/autopilot'],
        alertHtml(actions, dateLabel),
        { ignoreThrottle: true },
      )
      const notes: Record<string, string> = { sent: 'Test alert emailed', 'not-configured': 'Email is not set up: RESEND_API_KEY or ADMIN_EMAIL is missing in Vercel', failed: 'Resend refused the email (see Needs attention for the reason)', throttled: 'Throttled' }
      return NextResponse.json({ note: notes[result] ?? result }, { status: result === 'sent' ? 200 : 502 })
    }
    if (body.action === 'run') {
      const run = await runPipeline(admin, { force: true })
      return NextResponse.json({ note: run.steps.map((x) => `${x.step}: ${x.note}`).join(' | ') })
    }
    return NextResponse.json({ error: 'Nothing to do - pass on, videosPerWeek, or {action: "run"}.' }, { status: 400 })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}
