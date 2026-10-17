import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { readAllPages, type PagedResult } from '@/lib/paged-read'
import { isVisitTrackingOn } from '@/lib/visit-tracking'
import { aiCostByFeatureDay, leadStats, loginStats, visitorStats, type ApiCallLite, type AuthEventLite, type LeadLite, type VisitLite } from '@/lib/users-analytics'

export const maxDuration = 60

const DAY = 86_400_000

/** One read for the four tabs. A table that is not there yet (migration not applied) returns an empty tab with a note, never a 500.
 * Every list is read page by page (PostgREST stops a single response at 1000 rows), and a tab whose read did not finish shows a note
 * and no numbers, never a total that only covers the first pages. */
export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const admin = getSupabaseAdmin()
    const now = Date.now()
    const iso = (days: number) => new Date(now - days * DAY).toISOString()
    const trackingOn = await isVisitTrackingOn(admin)
    const empty = { rows: [], ok: true } as PagedResult<never>
    const [calls, auth, leads, visits] = await Promise.all([
      readAllPages<ApiCallLite>((from, to) =>
        admin.from('api_calls').select('ts, feature, input_tokens, output_tokens, est_cost_usd, ok').gte('ts', iso(60)).order('ts', { ascending: false }).range(from, to),
      ),
      readAllPages<AuthEventLite>((from, to) => admin.from('auth_events').select('ts, kind').gte('ts', iso(200)).order('ts', { ascending: false }).range(from, to)),
      // The message is read only to count and take common words on the server; it is never sent back.
      readAllPages<LeadLite>((from, to) =>
        admin.from('leads').select('utm_source, page_path, message').eq('is_test', false).gte('created_at', iso(90)).order('created_at', { ascending: false }).range(from, to),
      ),
      // Visitors are read only while visit tracking is switched on (the same gate the funnel uses).
      trackingOn
        ? readAllPages<VisitLite>((from, to) =>
            admin.from('site_visits').select('channel, landing_path, last_path, page_views, duration_s, created_at').gte('created_at', iso(30)).order('created_at', { ascending: false }).range(from, to),
          )
        : Promise.resolve(empty as PagedResult<VisitLite>),
    ])
    const note = (r: PagedResult<unknown>, migration: string) => (r.ok ? '' : r.capped ? 'Not available: too many rows to read in one go.' : `Not available yet: ${migration} is not applied, or the read failed.`)
    const rowsOf = <T,>(r: PagedResult<T>): T[] => (r.ok ? r.rows : [])
    return NextResponse.json({
      ai: { ...aiCostByFeatureDay(rowsOf(calls)), note: note(calls, 'migration 0044') },
      logins: { ...loginStats(rowsOf(auth)), note: note(auth, 'migration 0045') },
      leads: { ...leadStats(rowsOf(leads)), days: 90, note: note(leads, 'the leads table') },
      visitors: { ...visitorStats(rowsOf(visits)), days: 30, note: trackingOn ? note(visits, 'the visit log') : '' },
    })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}
