import { NextResponse } from 'next/server'
import { cronUnauthorized } from '@/lib/cron-auth'
import { withCronHeartbeat } from '@/lib/cron-heartbeat'
import { runAutoblog } from '@/lib/autoblog-run'

// Factory Phase 2: blog/autoblog. Dormant by two independent switches: CRON_SECRET must be set
// (cronUnauthorized returns 503 until then) AND app_settings.autoblog_mode must be 'draft' or
// 'publish' (runAutoblog no-ops on 'off', the default). Scheduling this in vercel.json is safe
// before either switch is on - Vercel calling an unconfigured route just costs a 503, not an
// AI call, a DB write, or anything public.
export const dynamic = 'force-dynamic'
// blog-composer.ts's own per-step timeouts allow up to ~290s of sequential Anthropic calls
// (40s + 40s + 170s + 40s) plus the cover-image fetch/upload on top - give it headroom, matching
// the pattern already used by extract-draft/generate-field/destinations-generate routes.
export const maxDuration = 300

export const GET = withCronHeartbeat('autoblog', async (request: Request) => {
  const denied = cronUnauthorized(request)
  if (denied) return denied
  try {
    const result = await runAutoblog({ scheduled: true })
    return NextResponse.json(result)
  } catch (error) {
    console.error('[cron:autoblog]', error)
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
})
