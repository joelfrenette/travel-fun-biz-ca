import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { getPackageById } from '@/lib/packages'
import { createPhotoSource, createSignedUpload, registerUploadedPhoto, getSource, deleteSource, MAX_FILE_BYTES } from '@/lib/package-sources'

export const maxDuration = 60

// Trip photos for the Convert to Past Trip panel (WP14): the admin's own pictures, stored in the PRIVATE bucket as
// 'photo' rows (never read by the model). Copying one into the public gallery is the panel's separate, logged step.
//   POST multipart "file"                  a photo up to about 4 MB through this server
//   POST {action:'upload-url'}             step 1 for a bigger photo (a one-time link to the private bucket)
//   POST {action:'register', path, name}   step 2: check it and add it
//   DELETE ?sourceId=...                   remove a photo (refused while it is in the gallery: undo that first)

export async function POST(request: Request, { params }: { params: { id: string } }) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!(await getPackageById(params.id))) return NextResponse.json({ error: 'Package not found' }, { status: 404 })
  const admin = getSupabaseAdmin()

  const type = request.headers.get('content-type') || ''
  let result
  if (type.includes('multipart/form-data')) {
    const form = await request.formData().catch(() => null)
    const file = form?.get('file')
    if (!(file instanceof File)) return NextResponse.json({ error: 'No file provided' }, { status: 400 })
    if (file.size > MAX_FILE_BYTES) return NextResponse.json({ error: 'That photo is larger than 10 MB. Save a smaller copy and try again.' }, { status: 413 })
    result = await createPhotoSource(admin, params.id, { name: file.name, bytes: Buffer.from(await file.arrayBuffer()) })
  } else {
    const body = (await request.json().catch(() => null)) as { action?: unknown; path?: unknown; name?: unknown } | null
    if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
    if (body.action === 'upload-url') {
      const r = await createSignedUpload(admin, params.id)
      return r.ok ? NextResponse.json(r.value) : NextResponse.json({ error: r.error }, { status: r.status })
    }
    if (body.action === 'register' && typeof body.path === 'string') {
      result = await registerUploadedPhoto(admin, params.id, body.path, typeof body.name === 'string' ? body.name : '')
    } else {
      return NextResponse.json({ error: 'Send a photo.' }, { status: 400 })
    }
  }
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
  return NextResponse.json({ id: result.value.id })
}

export async function DELETE(request: Request, { params }: { params: { id: string } }) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const sourceId = new URL(request.url).searchParams.get('sourceId')
  if (!sourceId) return NextResponse.json({ error: 'sourceId is required' }, { status: 400 })
  const admin = getSupabaseAdmin()
  const row = await getSource(admin, params.id, sourceId)
  if (!row || row.kind !== 'photo') return NextResponse.json({ error: 'Photo not found' }, { status: 404 })
  const r = await deleteSource(admin, row)
  return r.ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: r.error }, { status: r.status })
}
