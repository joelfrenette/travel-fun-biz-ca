import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { getFunnel } from '@/lib/funnel'

// site_visits has no write path yet so this is cheap today, but it's a growing table once that
// changes - sized explicitly rather than relying on the platform default.
export const maxDuration = 30

export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const days = Number(new URL(request.url).searchParams.get('days')) || 28
    const funnel = await getFunnel(getSupabaseAdmin(), days)
    return NextResponse.json(funnel)
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}
