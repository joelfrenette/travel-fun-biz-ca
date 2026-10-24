import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { isFollowId } from '@/lib/followups'
import { loadFollowups, tickFollowup } from '@/lib/followups-run'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

// GET   today's follow-ups: up to 8 tasks built fresh each day from the growth tips, the best SEO fixes, leads waiting for a reply,
//       the social routine, link building, past-trip recaps, the setup steps still open and the weekly jobs. ?force=1 builds it again.
// POST  {id, op: done | later | reopen}  tick one task of today's list (Done, push to Later, or take the tick back).
// Read only apart from saving the list and the ticks in app_settings. No AI call, nothing posted.
export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const force = new URL(request.url).searchParams.get('force') === '1'
    return NextResponse.json(await loadFollowups(getSupabaseAdmin(), { force }))
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const body = (await request.json().catch(() => null)) as { id?: unknown; op?: unknown } | null
    if (!body || !isFollowId(body.id)) return NextResponse.json({ error: 'That is not a task id.' }, { status: 400 })
    if (body.op !== 'done' && body.op !== 'later' && body.op !== 'reopen') return NextResponse.json({ error: 'op must be done, later or reopen.' }, { status: 400 })
    const r = await tickFollowup(getSupabaseAdmin(), body.id, body.op)
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status })
    return NextResponse.json({ ok: true, ...r.selection })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}
