import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { getGuideById, deleteGuide, guidePath, guideKinds, setGuideStatus, isMissingScopeColumn } from '@/lib/guides'
import { validateGuideEdit, type EditableTextField } from '@/lib/guide-edit'
import { deleteEdits, editsLoggable, insertEdits, storedValue } from '@/lib/content-edits'
import type { ContentEdit } from '@/lib/content-repair'
import { pingIndexNow } from '@/lib/indexnow'
import { enrollGuideIfDue } from '@/lib/guide-distribution'

type Props = { params: { id: string } }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// GET the full guide (any status) for the admin preview page.
export async function GET(request: Request, { params }: Props) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!UUID.test(params.id)) return NextResponse.json({ error: 'Not a guide id.' }, { status: 400 })
  const guide = await getGuideById(getSupabaseAdmin(), params.id)
  if (!guide) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json({ guide })
}

async function editGuide(id: string, body: unknown) {
  const checked = validateGuideEdit(body)
  if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 400 })
  const { patch } = checked
  const admin = getSupabaseAdmin()
  const guide = await getGuideById(admin, id)
  if (!guide) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (patch.parent_slug && patch.parent_slug === guide.slug) return NextResponse.json({ error: 'A page cannot be its own parent.' }, { status: 400 })
  if (patch.review_state === 'rejected' && guide.status === 'published') return NextResponse.json({ error: 'Unpublish the page first; only a draft can be rejected.' }, { status: 409 })

  // Log, then apply: the audit rows go in first and are taken back if the page update fails.
  const path = guidePath(guide.kind, guide.slug)
  const edits: ContentEdit[] = []
  const changes: Record<string, unknown> = {}
  for (const [field, after] of Object.entries(patch.text) as [EditableTextField, string][]) {
    const before = storedValue('guide', guide as unknown as Record<string, unknown>, field)
    if (before === after) continue
    edits.push({ content_type: 'guide', content_id: guide.id, path, field, reason: 'Edited by hand in the admin Pages list', before, after, method: 'fixer', published_after: guide.status === 'published', cost_usd: 0 })
    changes[field] = after
  }
  if ('scope' in patch) changes.scope = patch.scope
  if ('parent_slug' in patch) changes.parent_slug = patch.parent_slug
  if ('review_state' in patch) changes.review_state = patch.review_state
  if (Object.keys(changes).length === 0) return NextResponse.json({ ok: true, unchanged: true })

  let logged: string[] = []
  if (edits.length > 0) {
    if (!(await editsLoggable(admin))) return NextResponse.json({ error: 'Text edits are logged so you can undo them, and the log is not set up yet (migration 0033). Nothing was changed.' }, { status: 409 })
    const inserted = await insertEdits(admin, edits)
    if (inserted.error) return NextResponse.json({ error: `Could not log the edit, so nothing was changed (${inserted.error}).` }, { status: 500 })
    logged = inserted.ids
  }
  const { error } = await admin.from('guides').update({ ...changes, updated_at: new Date().toISOString() }).eq('id', id)
  if (error) {
    await deleteEdits(admin, logged)
    const needs = isMissingScopeColumn(error.message) ? ' Apply migration 0041 (supabase/migrations/0041_guide_scope.sql) first.' : ''
    return NextResponse.json({ error: `Could not save the change: ${error.message}.${needs}` }, { status: isMissingScopeColumn(error.message) ? 409 : 500 })
  }
  if (guide.status === 'published') await pingIndexNow([path, '/sitemap.xml']).catch(() => undefined)
  return NextResponse.json({ ok: true, edited: edits.length, guide: await getGuideById(admin, id) })
}

// PATCH { status: 'published' | 'draft' }  publish or unpublish one guide. An admin may publish a guide the
// quality gate held back (the reasons are in its quality_notes); that is the admin's call.
export async function PATCH(request: Request, { params }: Props) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!UUID.test(params.id)) return NextResponse.json({ error: 'Not a guide id.' }, { status: 400 })
  const body = await request.json().catch(() => ({}))
  // An edit of the scope, the parent, the review state or a meta/OG text (WP16). The text edits are written to the
  // audit log first, so the Content edits screen can Undo them.
  if (body.status === undefined) return editGuide(params.id, body)
  if (body.status !== 'published' && body.status !== 'draft') return NextResponse.json({ error: 'status must be "published" or "draft".' }, { status: 400 })
  const result = await setGuideStatus(getSupabaseAdmin(), params.id, body.status)
  if (result.error || !result.guide) return NextResponse.json({ error: result.error ?? 'Not found' }, { status: 500 })
  // Publishing enrols the guide for social posting (one guide a day, mode-gated; never throws). Unpublishing does not enrol.
  if (body.status === 'published') await enrollGuideIfDue(getSupabaseAdmin(), result.guide)
  if (body.status === 'published') await pingIndexNow([guidePath(result.guide.kind, result.guide.slug), guideKinds[result.guide.kind].urlPrefix, '/sitemap.xml'])
  return NextResponse.json({ ok: true, guide: result.guide })
}

export async function DELETE(request: Request, { params }: Props) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!UUID.test(params.id)) return NextResponse.json({ error: 'Not a guide id.' }, { status: 400 })
  const { error } = await deleteGuide(getSupabaseAdmin(), params.id)
  if (error) return NextResponse.json({ error }, { status: 500 })
  return NextResponse.json({ ok: true })
}
