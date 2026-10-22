import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { readOptimizerSummary } from '@/lib/optimizer-run'

export const maxDuration = 30

// The Optimizer card on Content Autopilot. Read only: no write, no AI call, no posting.
export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const r = await readOptimizerSummary(getSupabaseAdmin())
    if (!r.ok) return NextResponse.json({ error: r.reason }, { status: 500 })
    return NextResponse.json({ ...r.summary, corrupt: r.corrupt })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}
