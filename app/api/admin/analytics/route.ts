import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getGa4Report, isGa4Configured } from '@/lib/ga4'

export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!isGa4Configured()) return NextResponse.json({ configured: false })
  try {
    const report = await getGa4Report(14)
    return NextResponse.json({ configured: true, ...report })
  } catch (error) {
    return NextResponse.json({ configured: true, error: error instanceof Error ? error.message : 'GA4 request failed' }, { status: 502 })
  }
}
