import { NextResponse } from 'next/server'
import { agentGate } from '@/lib/agent-gate'
import { listSubmissions, startDraft } from '@/lib/agent-submissions'
import { isHoneypotFilled } from '@/lib/abuse-guard'
import { inviteState, blockMessage, validateStart, STATE_LABEL, MAX_DRAFTS_PER_DAY, MAX_SOURCES_PER_DAY, dailyAllowance } from '@/lib/agent-invites'

export const dynamic = 'force-dynamic'

// PUBLIC route behind an agent link (WP13). GET: the agent's name and their own drafts (so they can pick one up where
// they left off). POST {action:'start'}: starts a new draft. The token is validated first (lib/agent-gate.ts); the
// answer holds nothing but this agent's own drafts and plain limits.
export async function GET(request: Request, { params }: { params: { token: string } }) {
  const g = await agentGate(request, params.token)
  if (!g.ok) return NextResponse.json({ error: g.error }, { status: g.status })
  const now = new Date()
  const subs = await listSubmissions(g.admin, g.invite)
  const state = inviteState(g.invite, now)
  const day = dailyAllowance(subs.map((s) => s.created_at), now, MAX_DRAFTS_PER_DAY)
  return NextResponse.json({
    agentName: g.invite.agent_name,
    expiresAt: g.invite.expires_at,
    drafts: subs.map((s) => ({ id: s.id, tripName: s.trip_name ?? 'Untitled trip', state: s.submission_state, stateLabel: STATE_LABEL[s.submission_state], reviewNote: s.review_note, updatedAt: s.updated_at })),
    canStart: state.ok && day.allowed,
    startNote: !state.ok ? blockMessage(state.reason) : !day.allowed ? 'You have started as many trips as you can today. You can keep working on the ones below.' : null,
    limits: { draftsPerDay: MAX_DRAFTS_PER_DAY, sourcesPerDay: MAX_SOURCES_PER_DAY },
  })
}

export async function POST(request: Request, { params }: { params: { token: string } }) {
  const g = await agentGate(request, params.token)
  if (!g.ok) return NextResponse.json({ error: g.error }, { status: g.status })
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  if (!body) return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  if (isHoneypotFilled(body)) return NextResponse.json({ ok: true })
  if (body.action !== 'start') return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
  // The trip name is optional in the wizard (the AI proposes one); a placeholder keeps the row valid until then.
  const typed = typeof body.tripName === 'string' ? body.tripName.trim() : ''
  const v = validateStart({ tripName: typed || `New trip ${new Date().toISOString().slice(0, 10)}`, destination: body.destination, message: body.message })
  if (!v.ok) return NextResponse.json({ error: v.errors[0] }, { status: 400 })
  const r = await startDraft(g.admin, g.invite, v.value)
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status })
  return NextResponse.json({ ok: true, draftId: r.submission.id })
}
