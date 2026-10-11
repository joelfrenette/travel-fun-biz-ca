import { NextResponse } from 'next/server'
import { draftGate } from '@/lib/agent-gate'
import { agentDraftView } from '@/lib/agent-submissions'
import { addOwnPhotos } from '@/lib/trip-wizard'
import { AGENT_FILES_MAX_BYTES, MAX_PHOTOS_PER_DAY, isEditableState } from '@/lib/agent-invites'
import { claimSlots } from '@/lib/slots'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

// PUBLIC route behind an agent link (WP13, step 3): the agent's own photos for their own draft. Multipart "file", several
// allowed, 4 MB together per request. Checked as real PNG, JPG or WebP pictures, resized by the same code as every trip
// photo, and logged on the draft so Joel can undo them.
export async function POST(request: Request, { params }: { params: { token: string; id: string } }) {
  const g = await draftGate(request, params.token, params.id)
  if (!g.ok) return NextResponse.json({ error: g.error }, { status: g.status })
  if (!isEditableState(g.sub.submission_state)) return NextResponse.json({ error: 'This trip is with Joel, so it cannot be changed now.' }, { status: 409 })
  const form = await request.formData().catch(() => null)
  const files = (form?.getAll('file') ?? []).filter((f): f is File => f instanceof File)
  if (files.length === 0) return NextResponse.json({ error: 'Choose at least one photo.' }, { status: 400 })
  if (files.reduce((n, f) => n + f.size, 0) > AGENT_FILES_MAX_BYTES) return NextResponse.json({ error: 'Those photos are over 4 MB together. Add fewer or smaller ones at a time.' }, { status: 413 })
  // Per-link daily photo ceiling: one atomic slot per photo that will actually be stored, taken before the upload.
  const r = await addOwnPhotos(g.admin, g.sub.package_id as string, await Promise.all(files.map(async (f) => ({ name: f.name, bytes: Buffer.from(await f.arrayBuffer()) }))), `Added by ${g.invite.agent_name} (own photos)`, {
    allow: (n) => claimSlots(g.admin, `agent_photo:${g.invite.id}`, n, MAX_PHOTOS_PER_DAY),
  })
  const draft = await agentDraftView(g.admin, g.invite, g.sub)
  if (r.refused) return NextResponse.json({ ok: false, added: 0, error: r.refused, skipped: r.skipped.map((s) => `${s.name}: ${s.reason}`), draft }, { status: 409 })
  return NextResponse.json({ ok: !r.error, added: r.added, skipped: r.skipped.map((s) => `${s.name}: ${s.reason}`), error: r.error ? 'Could not add the photos. Please try again.' : null, draft }, { status: r.error ? 500 : 200 })
}
