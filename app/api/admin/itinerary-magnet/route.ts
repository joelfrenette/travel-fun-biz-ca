import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { isLeadAckOn } from '@/lib/lead-ack'
import { itinerarySecret } from '@/lib/itinerary-magnet'
import { getItineraryMagnetMode, readItineraryCounts, setItineraryMagnetMode } from '@/lib/itinerary-magnet-store'

// Admin: the "Send me the itinerary and dates" switch (app_settings itinerary_magnet_mode, off by default), what it needs, and
// how many requests each trip has had (app_settings itinerary_requests). Shown on System health.
export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const admin = getSupabaseAdmin()
  const counts = await readItineraryCounts(admin)
  const trips = Object.entries(counts)
    .map(([slug, v]) => ({ slug, count: v.count, last: v.last }))
    .sort((a, b) => b.count - a.count)
  return NextResponse.json({
    on: (await getItineraryMagnetMode(admin)) === 'on',
    secretReady: !!itinerarySecret(),
    ackOn: await isLeadAckOn(admin).catch(() => false),
    trips,
  })
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const body = await request.json().catch(() => ({}))
  const on = body.on === true
  const { error } = await setItineraryMagnetMode(getSupabaseAdmin(), on ? 'on' : 'off')
  if (error) return NextResponse.json({ error }, { status: 500 })
  return NextResponse.json({ on })
}
