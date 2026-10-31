import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { isLeadAckOn } from '@/lib/lead-ack'
import { itinerarySecret } from '@/lib/itinerary-magnet'
import { getTripQuizMode, readQuizCounts, setTripQuizMode } from '@/lib/trip-quiz-store'
import { quizTotals } from '@/lib/trip-quiz'

// Admin: the "Find your trip in 60 seconds" switch (app_settings trip_quiz_mode, off by default), what it needs, and the funnel
// numbers (app_settings trip_quiz_funnel): today and the last 7 days. Shown on System health next to the itinerary switch.
export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const admin = getSupabaseAdmin()
  const counts = await readQuizCounts(admin)
  const now = new Date()
  return NextResponse.json({
    on: (await getTripQuizMode(admin)) === 'on',
    secretReady: !!itinerarySecret(),
    ackOn: await isLeadAckOn(admin).catch(() => false),
    today: quizTotals(counts, now, 1),
    week: quizTotals(counts, now, 7),
  })
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const body = await request.json().catch(() => ({}))
  const on = body.on === true
  const { error } = await setTripQuizMode(getSupabaseAdmin(), on ? 'on' : 'off')
  if (error) return NextResponse.json({ error }, { status: 500 })
  return NextResponse.json({ on })
}
