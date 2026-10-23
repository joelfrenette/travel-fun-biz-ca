import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { getSearchRange } from '@/lib/dashboard-data'
import { parseRange } from '@/lib/dashboard-range'

export const maxDuration = 30

// Google Search Console clicks and impressions for the dashboard range (?range=7|30|365|all). Falls back to the stored 28-day snapshot.
export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const range = parseRange(new URL(request.url).searchParams.get('range'))
    return NextResponse.json(await getSearchRange(getSupabaseAdmin(), range))
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}
