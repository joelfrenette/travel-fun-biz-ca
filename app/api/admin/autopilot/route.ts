import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { isAutopilotOn, setAutopilot, autopilotReadiness, getVideosPerWeek, setVideosPerWeek, runAutopilotTick } from '@/lib/autopilot'
import { shotstackEnv } from '@/lib/shotstack'
import { readCronRuns } from '@/lib/cron-heartbeat'
import { judgeCron } from '@/lib/cron-health'

export const maxDuration = 300

export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const admin = getSupabaseAdmin()
    const [on, readiness, videosPerWeek, runs, pipeline] = await Promise.all([
      isAutopilotOn(admin),
      autopilotReadiness(admin),
      getVideosPerWeek(admin),
      readCronRuns(admin),
      admin.from('content_pipeline').select('*').order('created_at', { ascending: false }).limit(15),
    ])
    const slugs = (pipeline.data ?? []).map((r: { slug: string }) => r.slug)
    const { data: posts } = slugs.length ? await admin.from('posts').select('slug, title').in('slug', slugs) : { data: [] }
    const titles = new Map((posts ?? []).map((p: { slug: string; title: string }) => [p.slug, p.title]))
    return NextResponse.json({
      on,
      readiness,
      videosPerWeek,
      shotstackEnv: shotstackEnv(),
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
    if (body.action === 'run') {
      return NextResponse.json({ note: await runAutopilotTick(admin) })
    }
    return NextResponse.json({ error: 'Nothing to do - pass on, videosPerWeek, or {action: "run"}.' }, { status: 400 })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}
