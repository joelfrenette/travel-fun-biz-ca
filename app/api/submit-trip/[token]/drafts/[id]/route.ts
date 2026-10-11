import { NextResponse } from 'next/server'
import { draftGate } from '@/lib/agent-gate'
import { agentDraftView, saveAgentEdits, sendSubmission } from '@/lib/agent-submissions'
import { cleanDraftEdits, isEditableState, filledLabels } from '@/lib/agent-invites'
import { completeTrip, improveField, isImproveField } from '@/lib/trip-wizard'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

// PUBLIC route behind an agent link (WP13): one of THIS agent's drafts. GET the draft's own page data, PATCH the plain
// text fields, POST {action: 'complete' | 'improve' | 'send'}. A locked draft (sent to Joel, or published) is read only.
type Ctx = { params: { token: string; id: string } }

export async function GET(request: Request, { params }: Ctx) {
  const g = await draftGate(request, params.token, params.id)
  if (!g.ok) return NextResponse.json({ error: g.error }, { status: g.status })
  const view = await agentDraftView(g.admin, g.invite, g.sub)
  if (!view) return NextResponse.json({ error: 'That trip was not found.' }, { status: 404 })
  return NextResponse.json({ draft: view })
}

export async function PATCH(request: Request, { params }: Ctx) {
  const g = await draftGate(request, params.token, params.id)
  if (!g.ok) return NextResponse.json({ error: g.error }, { status: g.status })
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  if (!body) return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  const edits = cleanDraftEdits(body)
  if (!edits.ok) return NextResponse.json({ error: edits.errors[0] }, { status: 400 })
  const r = await saveAgentEdits(g.admin, g.sub, edits.value)
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status })
  const view = await agentDraftView(g.admin, g.invite, g.sub)
  return NextResponse.json({ ok: true, draft: view })
}

export async function POST(request: Request, { params }: Ctx) {
  const g = await draftGate(request, params.token, params.id)
  if (!g.ok) return NextResponse.json({ error: g.error }, { status: g.status })
  const body = (await request.json().catch(() => null)) as { action?: unknown; field?: unknown } | null
  if (!body) return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  const pkgId = g.sub.package_id as string

  if (body.action === 'send') {
    const r = await sendSubmission(g.admin, g.invite, g.sub)
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status })
    return NextResponse.json({ ok: true })
  }

  // The AI steps change the draft, so they need an unlocked draft.
  if (!isEditableState(g.sub.submission_state)) return NextResponse.json({ error: 'This trip is with Joel, so it cannot be changed now.' }, { status: 409 })

  if (body.action === 'complete') {
    const r = await completeTrip(g.admin, pkgId)
    const view = await agentDraftView(g.admin, g.invite, g.sub)
    return NextResponse.json({ ok: r.ok, error: r.ok ? null : (r.error ?? 'Could not complete the trip.'), filled: filledLabels(r.applied), draft: view }, { status: r.ok ? 200 : 422 })
  }
  if (body.action === 'improve') {
    if (!isImproveField(body.field)) return NextResponse.json({ error: 'That field cannot be rewritten.' }, { status: 400 })
    const r = await improveField(g.admin, pkgId, body.field)
    const view = await agentDraftView(g.admin, g.invite, g.sub)
    return NextResponse.json({ ok: r.ok, applied: r.applied, error: r.error ?? null, draft: view }, { status: r.ok ? 200 : 422 })
  }
  return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
}
