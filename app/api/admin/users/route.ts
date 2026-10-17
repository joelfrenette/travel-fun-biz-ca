import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { aiCostByFeatureDay, leadStats, loginStats, visitorStats, type ApiCallLite, type AuthEventLite, type LeadLite, type VisitLite } from '@/lib/users-analytics'

export const maxDuration = 60

const DAY = 86_400_000

/** One read for the four tabs. A table that is not there yet (migration not applied) returns an empty tab with a note, never a 500. */
export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const admin = getSupabaseAdmin()
    const now = Date.now()
    const iso = (days: number) => new Date(now - days * DAY).toISOString()
    const [calls, auth, leads, visits] = await Promise.all([
      admin.from('api_calls').select('ts, feature, input_tokens, output_tokens, est_cost_usd, ok').gte('ts', iso(60)).limit(100000),
      admin.from('auth_events').select('ts, kind').gte('ts', iso(200)).limit(20000),
      // The message is read only to count and take common words on the server; it is never sent back.
      admin.from('leads').select('utm_source, page_path, message').eq('is_test', false).gte('created_at', iso(90)).limit(5000),
      admin.from('site_visits').select('channel, landing_path, created_at').gte('created_at', iso(30)).limit(20000),
    ])
    const note = (r: { error: { message: string } | null }, migration: string) => (r.error ? `Not available yet: ${migration} is not applied.` : '')
    return NextResponse.json({
      ai: { ...aiCostByFeatureDay((calls.data ?? []) as ApiCallLite[]), note: note(calls, 'migration 0044') },
      logins: { ...loginStats((auth.data ?? []) as AuthEventLite[]), note: note(auth, 'migration 0045') },
      leads: { ...leadStats((leads.data ?? []) as LeadLite[]), days: 90 },
      visitors: { ...visitorStats((visits.data ?? []) as VisitLite[]), days: 30 },
    })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}
