import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { healTodayCard } from '@/lib/today-heal-fns'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// POST {id}  Auto-heal ONE Today card: runs the single existing, capped repair that card kind has (lib/today-card-actions.ts says which
//            kinds have one), once. The answer is kept for the day per card, so a second press returns it without running anything.
//            The repairs respect the automation kill switch, their own switches and daily caps and quality gates, and log an Undo.
export async function POST(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const body = (await request.json().catch(() => null)) as { id?: unknown } | null
    const out = await healTodayCard(getSupabaseAdmin(), body?.id)
    if (!out.ok) return NextResponse.json({ error: out.error }, { status: out.status })
    return NextResponse.json({ ok: true, result: out.result })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}
