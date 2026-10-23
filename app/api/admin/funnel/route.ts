import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { getFunnel } from '@/lib/funnel'
import { parseRange, rangeDays } from '@/lib/dashboard-range'

// site_visits has no write path yet so this is cheap today, but it's a growing table once that
// changes - sized explicitly rather than relying on the platform default.
export const maxDuration = 30

// ?range=7|30|365|all (dashboard pills) wins; else ?days=N (older callers), default 28.
export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const params = new URL(request.url).searchParams
    const days = params.has('range') ? rangeDays(parseRange(params.get('range'))) : Number(params.get('days')) || 28
    const funnel = await getFunnel(getSupabaseAdmin(), days)
    return NextResponse.json(funnel)
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}
