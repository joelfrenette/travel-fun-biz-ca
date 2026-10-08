import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { isAutopilotOn, setAutopilot, autopilotReadiness, getVideosPerWeek, setVideosPerWeek } from '@/lib/autopilot'
import { runPipeline, readLastPipelineRun } from '@/lib/pipeline'
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
    const [on, readiness, videosPerWeek, runs, pipeline, distributionMode, lastRun, keywordBudget, keywordInfo] = await Promise.all([
      isAutopilotOn(admin),
      autopilotReadiness(admin),
      getVideosPerWeek(admin),
      readCronRuns(admin),
      admin.from('content_pipeline').select('*').order('created_at', { ascending: false }).limit(15),
      getDistributionMode(admin),
      readLastPipelineRun(admin),
      getKeywordBudget(admin),
      readKeywordRefreshInfo(admin),
    ])
    const slugs = (pipeline.data ?? []).map((r: { slug: string }) => r.slug)
    const { data: posts } = slugs.length ? await admin.from('posts').select('slug, title').in('slug', slugs) : { data: [] }
    const titles = new Map((posts ?? []).map((p: { slug: string; title: string }) => [p.slug, p.title]))
    return NextResponse.json({
      on,
      readiness,
      videosPerWeek,
      shotstackEnv: shotstackEnv(),
      distributionMode,
      lastRun,
      keyword: { budget: keywordBudget, configured: isKeywordDataConfigured(), lastRunAt: keywordInfo.lastRunAt, log: keywordInfo.log },
      cron: judgeCron('autopilot', runs.autopilot),
      rows: (pipeline.data ?? []).map((r: Record<string, unknown>) => ({ ...r, title: titles.get(r.slug as string) ?? r.slug })),
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
    if (body.action === 'run') {
      const run = await runPipeline(admin, { force: true })
      return NextResponse.json({ note: run.steps.map((x) => `${x.step}: ${x.note}`).join(' | ') })
    }
    return NextResponse.json({ error: 'Nothing to do - pass on, videosPerWeek, or {action: "run"}.' }, { status: 400 })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}
