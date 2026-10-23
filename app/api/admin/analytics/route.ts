import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getGa4RangeReport, isGa4Configured } from '@/lib/ga4'
import { parseRange } from '@/lib/dashboard-range'

// GA4 sessions by channel for the dashboard range (?range=7|30|365|all, default 30). Cached 10 minutes per range.
export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!isGa4Configured()) return NextResponse.json({ configured: false })
  const range = parseRange(new URL(request.url).searchParams.get('range'))
  try {
    const report = await getGa4RangeReport(range)
    return NextResponse.json({ configured: true, ...report })
  } catch (error) {
    return NextResponse.json({ configured: true, error: error instanceof Error ? error.message : 'GA4 request failed' }, { status: 502 })
  }
}
