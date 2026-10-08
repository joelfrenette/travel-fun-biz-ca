import { NextResponse } from 'next/server'
import { cronUnauthorized } from '@/lib/cron-auth'
import { withCronHeartbeat } from '@/lib/cron-heartbeat'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { runAutopilotTick } from '@/lib/autopilot'

// Advances every recent post's repurposing pipeline (carousel, short video) one bounded step per
// run, every 30 minutes. A no-op until the Autopilot switch is on (app_settings.autopilot_mode),
// so scheduling it is safe before anything is configured. The text/photo post itself is written
// by /api/cron/autoblog and sent by /api/cron/distribute; this handles everything built on top.
export const dynamic = 'force-dynamic'
export const maxDuration = 300

export const GET = withCronHeartbeat('autopilot', async (request: Request) => {
  const denied = cronUnauthorized(request)
  if (denied) return denied
  try {
    const note = await runAutopilotTick(getSupabaseAdmin())
    return NextResponse.json({ note })
  } catch (error) {
    console.error('[cron:autopilot]', error)
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
})
