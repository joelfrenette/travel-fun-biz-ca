import { NextResponse } from 'next/server'
import { cronUnauthorized } from '@/lib/cron-auth'
import { withCronHeartbeat } from '@/lib/cron-heartbeat'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { runDistribution } from '@/lib/distribution'

// Factory Phase 6/16.24 (distribution): dormant by three independent switches - CRON_SECRET must
// be set, app_settings.distribution_mode must not be 'off' (runDistribution no-ops on 'off'; both
// 'prepare' and 'auto' let an already-queued row post - see lib/distribution.ts), and
// UPLOAD_POST_API_KEY must be set. Scheduling this in vercel.json is safe before any of those are
// on - an unconfigured server just costs a 503, not a real post.
export const dynamic = 'force-dynamic'
// Bounded to 5 rows per run (see lib/distribution.ts) but each row is a real network call to
// Upload-Post - sized explicitly rather than relying on the platform default.
export const maxDuration = 60

export const GET = withCronHeartbeat('distribute', async (request: Request) => {
  const denied = cronUnauthorized(request)
  if (denied) return denied
  try {
    const note = await runDistribution(getSupabaseAdmin())
    return NextResponse.json({ note })
  } catch (error) {
    console.error('[cron:distribute]', error)
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
})
