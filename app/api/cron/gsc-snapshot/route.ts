import { NextResponse } from 'next/server'
import { cronUnauthorized } from '@/lib/cron-auth'
import { withCronHeartbeat } from '@/lib/cron-heartbeat'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { takeRankingSnapshot } from '@/lib/rankings-snapshot'
import { connectKeywordsToRankingPages } from '@/lib/keyword-pages'

// Factory Phase 5: SEO/indexing. Dormant by the same two switches as every other cron here:
// CRON_SECRET must be set (cronUnauthorized 503s until then), and Search Console itself must be
// configured (GOOGLE_SERVICE_ACCOUNT_KEY + GA4_PROPERTY_ID's sibling, SEARCH_CONSOLE_SITE_URL) or
// takeRankingSnapshot just reports that and writes nothing.
export const dynamic = 'force-dynamic'
// Search Console query/page data + the snapshot write grow with how much content exists -
// sized explicitly rather than relying on the platform default.
export const maxDuration = 60

async function handle(request: Request) {
  const denied = cronUnauthorized(request)
  if (denied) return denied
  try {
    const note = await takeRankingSnapshot(getSupabaseAdmin())
    // Then connect every keyword that has no target page yet to the page Google really shows for it.
    // A failure here never fails the snapshot itself.
    let connected = ''
    try {
      const n = await connectKeywordsToRankingPages(getSupabaseAdmin())
      if (n) connected = `; connected ${n} keyword${n === 1 ? '' : 's'} to the page they rank on`
    } catch (e) {
      console.error('[cron:gsc-snapshot] keyword connection failed:', e)
    }
    return NextResponse.json({ ok: true, result: `${note}${connected}` })
  } catch (error) {
    // Without this, a cron failure's real cause only ever existed in the JSON body sent back to
    // Vercel's own caller - the Logs tab showed the request but no error text at all (found
    // 2026-09-28 debugging a real gsc-snapshot failure with nothing to go on but a 500).
    console.error('[cron:gsc-snapshot]', error)
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}

export const GET = withCronHeartbeat('gsc-snapshot', handle)
