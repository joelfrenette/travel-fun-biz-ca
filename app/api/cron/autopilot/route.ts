import { NextResponse } from 'next/server'
import { cronUnauthorized } from '@/lib/cron-auth'
import { withCronHeartbeat } from '@/lib/cron-heartbeat'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { runPipeline } from '@/lib/pipeline'

// The one scheduled job: runs the whole content pipeline (write, post, carousel, video, posting) in
// order every 15 minutes, doing whatever is due. A no-op until the Autopilot switch is on. The
// separate autoblog and distribute routes remain as manual entry points but are no longer scheduled.
export const dynamic = 'force-dynamic'
export const maxDuration = 300

export const GET = withCronHeartbeat('autopilot', async (request: Request) => {
  const denied = cronUnauthorized(request)
  if (denied) return denied
  try {
    const run = await runPipeline(getSupabaseAdmin())
    return NextResponse.json({ note: run.steps.map((x) => `${x.step}: ${x.note}`).join(' | ') })
  } catch (error) {
    console.error('[cron:autopilot]', error)
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
})
