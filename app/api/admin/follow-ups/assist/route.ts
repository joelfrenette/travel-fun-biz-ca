import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { isFollowId } from '@/lib/followups'
import { loadFollowups } from '@/lib/followups-run'
import { runAssist } from '@/lib/followups-assist-run'

export const dynamic = 'force-dynamic'
export const maxDuration = 45

// POST {id, force?}  "Do this for me" for one task on today's follow-ups list. Drafts text into a box (or re-reads the SEO audit);
//                    it NEVER sends, posts or publishes anything. The answer is cached for the day per task, and the AI is called at
//                    most 10 times a day (a fixed template is used after that). Admin only; the task must be on today's list.
export async function POST(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const body = (await request.json().catch(() => null)) as { id?: unknown; force?: unknown } | null
    if (!body || !isFollowId(body.id)) return NextResponse.json({ error: 'That is not a task id.' }, { status: 400 })
    const admin = getSupabaseAdmin()
    const list = await loadFollowups(admin)
    const item = list.items.find((i) => i.id === body.id)
    if (!item) return NextResponse.json({ error: 'That task is not on today\'s list any more. Reload the list.' }, { status: 404 })
    const r = await runAssist(admin, item, { force: body.force === true })
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status })
    return NextResponse.json({ ok: true, cached: r.cached, result: r.result })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}
