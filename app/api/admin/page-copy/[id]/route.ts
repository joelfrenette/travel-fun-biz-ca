import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { getPageCopyById, deletePageCopy, setPageCopyStatus } from '@/lib/page-copy'
import { pingIndexNow } from '@/lib/indexnow'

type Props = { params: { id: string } }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// GET the full copy (any status) for a preview.
export async function GET(request: Request, { params }: Props) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!UUID.test(params.id)) return NextResponse.json({ error: 'Not a page copy id.' }, { status: 400 })
  const copy = await getPageCopyById(getSupabaseAdmin(), params.id)
  if (!copy) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json({ copy })
}

// PATCH { status: 'published' | 'draft' }  publish or unpublish one page's copy. An admin may publish copy the
// quality gate held back (the reasons are in its quality_notes); that is the admin's call.
export async function PATCH(request: Request, { params }: Props) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!UUID.test(params.id)) return NextResponse.json({ error: 'Not a page copy id.' }, { status: 400 })
  const body = await request.json().catch(() => ({}))
  if (body.status !== 'published' && body.status !== 'draft') return NextResponse.json({ error: 'status must be "published" or "draft".' }, { status: 400 })
  const result = await setPageCopyStatus(getSupabaseAdmin(), params.id, body.status)
  if (result.error || !result.copy) return NextResponse.json({ error: result.error ?? 'Not found' }, { status: 500 })
  if (body.status === 'published') await pingIndexNow([result.copy.path, '/sitemap.xml'])
  return NextResponse.json({ ok: true, copy: result.copy })
}

export async function DELETE(request: Request, { params }: Props) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!UUID.test(params.id)) return NextResponse.json({ error: 'Not a page copy id.' }, { status: 400 })
  const { error } = await deletePageCopy(getSupabaseAdmin(), params.id)
  if (error) return NextResponse.json({ error }, { status: 500 })
  return NextResponse.json({ ok: true })
}
