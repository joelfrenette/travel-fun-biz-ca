import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { getTopPosts } from '@/lib/dashboard-top-data'
import { parseRange } from '@/lib/dashboard-range'

export const maxDuration = 30

// Which social posts, networks and hook styles sent the most visits for the dashboard range (?range=7|30|365|all). Read-only.
export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const range = parseRange(new URL(request.url).searchParams.get('range'))
    return NextResponse.json(await getTopPosts(getSupabaseAdmin(), range))
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}
