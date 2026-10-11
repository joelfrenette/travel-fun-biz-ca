import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { readPromotionState, startPromotion, updatePromotion, type PromotionAction } from '@/lib/promotion'

// The Promote this package panel's API (WP15). Every call is admin only.
//   GET                          the trip's promotion state: whether it can be promoted, the plan, and its progress
//   POST {action:'start'}        builds the plan: tracks the trip's phrases, saves blog ideas (ONE bounded AI call),
//                                puts its guides first in line, queues ONE social post. Nothing posts or renders here.
//   POST {action:'pause'|'resume'|'done'|'retry-social'}
// A trip that already happened is refused, and a trip can be promoted once every 30 days.

export const maxDuration = 120

const ACTIONS: PromotionAction[] = ['pause', 'resume', 'done', 'retry-social']

export async function GET(request: Request, { params }: { params: { id: string } }) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const state = await readPromotionState(getSupabaseAdmin(), params.id)
    if (!state) return NextResponse.json({ error: 'Package not found' }, { status: 404 })
    return NextResponse.json(state)
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Could not read the promotion' }, { status: 500 })
  }
}

export async function POST(request: Request, { params }: { params: { id: string } }) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  if (!body || typeof body.action !== 'string') return NextResponse.json({ error: 'Send {action}.' }, { status: 400 })
  const admin = getSupabaseAdmin()
  try {
    if (body.action === 'start') {
      const r = await startPromotion(admin, params.id)
      if (!r.ok) return NextResponse.json({ error: r.error, code: r.code, failures: r.failures ?? [] }, { status: r.status })
      return NextResponse.json({ ok: true, promotion: r.promotion, failures: r.failures })
    }
    if (ACTIONS.includes(body.action as PromotionAction)) {
      const r = await updatePromotion(admin, params.id, body.action as PromotionAction)
      return r.ok ? NextResponse.json({ ok: true, note: r.note }) : NextResponse.json({ error: r.error }, { status: r.status })
    }
    return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Something went wrong' }, { status: 500 })
  }
}
