import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { buildValueReport } from '@/lib/value'
import { collectValueData } from '@/lib/value-data'
import { buildDataRoomCsv } from '@/lib/value-export'

export const maxDuration = 60

/** Aggregate-only CSV for a buyer's data room: metrics, the estimate and its assumptions, monthly revenue. */
export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const csv = buildDataRoomCsv(buildValueReport(await collectValueData(getSupabaseAdmin())))
    return new Response(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="website-value-${new Date().toISOString().slice(0, 10)}.csv"`,
        'Cache-Control': 'no-store',
      },
    })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}
