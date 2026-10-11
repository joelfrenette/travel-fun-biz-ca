import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { getSubmissionForPackage, decideSubmission } from '@/lib/agent-submissions'

// An agent's submission for one trip (WP13), for the editor banner. GET: who sent it and where it stands (null when the
// trip was not sent by an agent). POST {action:'approve'} publishes it (refused while a required field is empty);
// POST {action:'reject', note} sends it back to the agent with a note they can read on their page, and keeps it a draft.
export async function GET(request: Request, { params }: { params: { id: string } }) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const s = await getSubmissionForPackage(getSupabaseAdmin(), params.id)
    return NextResponse.json({ submission: s ? { id: s.id, agent_name: s.agent_name, agent_email: s.agent_email, message: s.message, dates_note: s.dates_note, state: s.submission_state, review_note: s.review_note, created_at: s.created_at, submitted_at: s.submitted_at } : null })
  } catch {
    // before migration 0036 the table does not exist: no banner
    return NextResponse.json({ submission: null })
  }
}

export async function POST(request: Request, { params }: { params: { id: string } }) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const body = (await request.json().catch(() => null)) as { action?: unknown; note?: unknown } | null
  if (!body || (body.action !== 'approve' && body.action !== 'reject')) return NextResponse.json({ error: 'Send action approve or reject.' }, { status: 400 })
  const r = await decideSubmission(getSupabaseAdmin(), params.id, body.action, typeof body.note === 'string' ? body.note : undefined)
  if (!r.ok) return NextResponse.json({ error: r.error, missing: 'missing' in r ? r.missing : undefined }, { status: r.status })
  return NextResponse.json({ ok: true, state: r.state })
}
