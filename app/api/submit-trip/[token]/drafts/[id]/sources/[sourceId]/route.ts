import { NextResponse } from 'next/server'
import { draftGate } from '@/lib/agent-gate'
import { publicUrlRejection, agentDraftView } from '@/lib/agent-submissions'
import { isUuid, isEditableState, filledLabels } from '@/lib/agent-invites'
import { getSource } from '@/lib/package-sources'
import { ingestSourceForPackage } from '@/lib/package-ingest'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

// PUBLIC route behind an agent link (WP13): reads one source of the agent's own draft with the SAME shared ingest the
// admin uses (lib/package-ingest.ts), so the draft gets the same grounded facts, copy, FAQs, photos and cover. The
// agent is told which parts of the trip page were filled (names only) and, when something went wrong, a plain sentence;
// never costs, model names, dropped values or internal errors.
export async function POST(request: Request, { params }: { params: { token: string; id: string; sourceId: string } }) {
  const g = await draftGate(request, params.token, params.id)
  if (!g.ok) return NextResponse.json({ error: g.error }, { status: g.status })
  if (!isEditableState(g.sub.submission_state)) return NextResponse.json({ error: 'This trip is with Joel, so it cannot be changed now.' }, { status: 409 })
  if (!isUuid(params.sourceId)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const pkgId = g.sub.package_id as string
  const source = await getSource(g.admin, pkgId, params.sourceId)
  if (!source) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (source.kind === 'url') {
    const bad = await publicUrlRejection(source.source_url ?? '')
    if (bad) return NextResponse.json({ error: bad }, { status: 400 })
  }

  const r = await ingestSourceForPackage(g.admin, pkgId, params.sourceId, { safeFetch: true })
  const draft = await agentDraftView(g.admin, g.invite, g.sub)
  if (r.status === 200) return NextResponse.json({ ok: true, filled: filledLabels(r.applied), draft })
  const message =
    r.status === 409 ? 'That one was already read.' : r.status === 400 || r.status === 413 || r.status === 422 ? String(r.body.error ?? 'We could not read enough from that.') : 'We could not read that one just now. You can try again, or add it a different way.'
  return NextResponse.json({ ok: false, error: message, draft }, { status: r.status === 200 ? 200 : r.status === 409 ? 409 : 422 })
}
