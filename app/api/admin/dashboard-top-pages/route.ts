import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { getTopPages } from '@/lib/dashboard-top-data'
import { parseRange } from '@/lib/dashboard-range'

export const maxDuration = 30

// The 10 pages with the most visits for the dashboard range (?range=7|30|365|all): recorded visits, GA4 page views, leads. Read-only.
export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const range = parseRange(new URL(request.url).searchParams.get('range'))
    return NextResponse.json(await getTopPages(getSupabaseAdmin(), range))
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}
