import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { CTR_TRIP_PROPOSALS_MAX, readTripProposals, readTripsMode } from '@/lib/ctr-loop'

export const dynamic = 'force-dynamic'

// Admin, read only: the title and description proposals the click-rate loop logged for trip pages (app_settings ctr_trip_proposals,
// newest first, at most 30). Nothing here, or anywhere in the loop, changes a trip: a person copies a proposal into the trip by hand.
export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const admin = getSupabaseAdmin()
    const [on, list] = await Promise.all([readTripsMode(admin), readTripProposals(admin)])
    if (list.error) return NextResponse.json({ error: `Could not read the trip proposals (${list.error})` }, { status: 500 })
    return NextResponse.json({ mode: on ? 'log' : 'off', max: CTR_TRIP_PROPOSALS_MAX, proposals: list.proposals })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}
