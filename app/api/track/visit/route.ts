import { allowKey } from '@/lib/abuse-guard'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { SITE_URL } from '@/lib/site'
import { handleVisit, RATE_LIMIT } from '@/lib/visit-tracking'

// Consent-gated first-party visit beacon. Switched OFF by default: while app_settings visit_tracking is not "on" this
// answers 204 and stores nothing. All the rules live in lib/visit-tracking.ts (handleVisit). Public by design (visitors
// call it), so it never trusts the browser: the channel is recomputed here, the body is size-limited, and no IP or
// user agent is stored. No cookies are set.
export const dynamic = 'force-dynamic'

const noContent = () => new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } })

export async function POST(request: Request) {
  try {
    const bodyText = await request.text()
    const siteHost = new URL(SITE_URL).hostname
    const res = await handleVisit({
      admin: getSupabaseAdmin(),
      headers: request.headers,
      bodyText,
      siteHost,
      limiter: (vid) => allowKey(RATE_LIMIT.bucket, vid, RATE_LIMIT.limit, RATE_LIMIT.windowSeconds),
    })
    if (res.status === 204) return noContent()
    return new Response(null, { status: res.status, headers: { 'Cache-Control': 'no-store' } })
  } catch {
    return noContent() // an unconfigured database or any failure stays silent for the visitor
  }
}
