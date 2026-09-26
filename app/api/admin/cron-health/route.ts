import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { readCronRuns } from '@/lib/cron-heartbeat'
import { judgeAllCrons } from '@/lib/cron-health'

export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const runs = await readCronRuns(getSupabaseAdmin())
    return NextResponse.json({ crons: judgeAllCrons(runs) })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}
