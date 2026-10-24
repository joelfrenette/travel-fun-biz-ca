import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { getTopKeywords } from '@/lib/dashboard-keywords-data'
import { parseRange } from '@/lib/dashboard-range'

export const maxDuration = 45

// The searches that brought the most Google clicks for the dashboard range (?range=7|30|365|all), each with the page Google shows and the
// page chosen in Keyword Research. Read only, cached 10 minutes, no AI and no credits. Not connected or unreadable is said, never a zero.
export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const range = parseRange(new URL(request.url).searchParams.get('range'))
    return NextResponse.json(await getTopKeywords(getSupabaseAdmin(), range))
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}
