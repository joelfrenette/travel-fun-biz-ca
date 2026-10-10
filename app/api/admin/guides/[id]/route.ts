import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { getGuideById, deleteGuide, guidePath, guideKinds, setGuideStatus } from '@/lib/guides'
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

// PATCH { status: 'published' | 'draft' }  publish or unpublish one guide. An admin may publish a guide the
// quality gate held back (the reasons are in its quality_notes); that is the admin's call.
export async function PATCH(request: Request, { params }: Props) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!UUID.test(params.id)) return NextResponse.json({ error: 'Not a guide id.' }, { status: 400 })
  const body = await request.json().catch(() => ({}))
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
