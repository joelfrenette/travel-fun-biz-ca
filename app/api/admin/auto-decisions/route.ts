import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { isPolicyName, readDecisions, readPolicySwitches, setPolicySwitch, undoAutoDecision } from '@/lib/auto-decisions'
import { readWatchdogRecord } from '@/lib/funnel-watchdog'
import { readHitlExceptions } from '@/lib/hitl-exceptions'

export const dynamic = 'force-dynamic'

// Read-only list of the automatic decisions (newest first, 20), the on/off switch of each, the funnel watchdog result, and what is left
// for a person. POST does exactly two things: take one reversible decision back (Undo), or flip one policy's switch.
export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const admin = getSupabaseAdmin()
    const [log, switches, watchdog, exceptions] = await Promise.all([readDecisions(admin), readPolicySwitches(admin), readWatchdogRecord(admin), readHitlExceptions(admin)])
    return NextResponse.json({ decisions: [...log].reverse().slice(0, 20), switches, watchdog, exceptions: exceptions.items, exceptionsUnreadable: exceptions.unreadable })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const body = await request.json().catch(() => ({}))
    const admin = getSupabaseAdmin()
    if (body.action === 'undo') {
      if (typeof body.at !== 'string' || !isPolicyName(body.policy) || typeof body.subject !== 'string') return NextResponse.json({ error: 'at, policy and subject are required' }, { status: 400 })
      const log = await readDecisions(admin)
      const entry = log.find((e) => e.at === body.at && e.policy === body.policy && e.subject === body.subject)
      if (!entry) return NextResponse.json({ error: 'That decision is no longer in the log.' }, { status: 404 })
      const r = await undoAutoDecision(admin, entry)
      return NextResponse.json({ ok: r.ok, message: r.message }, { status: r.ok ? 200 : 409 })
    }
    if (body.action === 'switch') {
      if (!isPolicyName(body.policy) || typeof body.on !== 'boolean') return NextResponse.json({ error: 'policy and on (true or false) are required' }, { status: 400 })
      const { error } = await setPolicySwitch(admin, body.policy, body.on)
      if (error) return NextResponse.json({ error }, { status: 500 })
      return NextResponse.json({ ok: true, policy: body.policy, on: body.on })
    }
    return NextResponse.json({ error: 'Nothing to do - pass {action: "undo", at, policy, subject} or {action: "switch", policy, on}.' }, { status: 400 })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}
