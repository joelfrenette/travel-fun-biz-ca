import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { thinTrips } from '@/lib/trip-kit-run'

// The trips "Fill all thin pages" will go through, thinnest first. The admin page then calls the per-trip fill route one
// trip at a time and shows progress. No AI call is made here.
export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  return NextResponse.json({ trips: await thinTrips(getSupabaseAdmin()) })
}
