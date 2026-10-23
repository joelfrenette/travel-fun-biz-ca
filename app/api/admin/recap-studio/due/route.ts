import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { recapsDue, snoozeTrips } from '@/lib/recap-store'
import { dueTitle } from '@/lib/recap-studio'

export const dynamic = 'force-dynamic'

// The daily recap prompt's list (Recap Studio): published past trips with no recap or a thin one, minus the snoozed.
//   GET                             { title, trips: [{ id, name, why, href }] }
//   POST {action:'snooze', ids}     hides those trips for 7 days
export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const trips = await recapsDue(getSupabaseAdmin())
    return NextResponse.json({ title: dueTitle(trips.length), trips })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const body = (await request.json().catch(() => null)) as { action?: unknown; ids?: unknown } | null
  if (!body || body.action !== 'snooze' || !Array.isArray(body.ids)) return NextResponse.json({ error: 'Send {action:"snooze", ids}.' }, { status: 400 })
  const ids = body.ids.filter((x): x is string => typeof x === 'string' && /^[0-9a-f-]{36}$/i.test(x)).slice(0, 100)
  const err = await snoozeTrips(getSupabaseAdmin(), ids)
  return err ? NextResponse.json({ error: err }, { status: 500 }) : NextResponse.json({ ok: true, snoozed: ids.length })
}
