import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { isVisitTrackingOn, setVisitTracking } from '@/lib/visit-tracking'

// The on/off switch for first-party visit tracking. Off by default; turn it on only after the lawyer has approved the cookie wording.
export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  return NextResponse.json({ on: await isVisitTrackingOn(getSupabaseAdmin()) })
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const body = await request.json().catch(() => ({}))
  const on = body.on === true
  const { error } = await setVisitTracking(getSupabaseAdmin(), on)
  if (error) return NextResponse.json({ error }, { status: 500 })
  return NextResponse.json({ on })
}
