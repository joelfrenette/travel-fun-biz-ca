import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { getPackageById } from '@/lib/packages'
import { completenessScore } from '@/lib/package-completeness'
import {
  listSources,
  createFileSource,
  createUrlSource,
  createTextSource,
  createSignedUpload,
  registerUploadedFile,
  signedPreviewUrl,
  MAX_FILE_BYTES,
  MAX_PDF_PAGES,
  MAX_IMAGES_PER_PACKAGE,
  SIGNED_URL_SECONDS,
} from '@/lib/package-sources'

export const maxDuration = 60

// Sources for one trip page (WP11). GET lists them (each uploaded file with a 60 second preview link) and the
// page's completeness. POST adds one source and costs nothing: the AI only runs when the admin presses
// Extract (see ./[sourceId]/extract).
//   multipart/form-data with a "file"      a small screenshot or PDF (a request is limited to about 4.5 MB)
//   JSON {url}                             a link
//   JSON {text}                            pasted text
//   JSON {action:'upload-url'}             step 1 for a big file: a one-time link to the private bucket
//   JSON {action:'register', path, name}   step 2 for a big file: check it and add it

export async function GET(request: Request, { params }: { params: { id: string } }) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const pkg = await getPackageById(params.id)
  if (!pkg) return NextResponse.json({ error: 'Package not found' }, { status: 404 })
  const admin = getSupabaseAdmin()
  const listed = await listSources(admin, params.id)
  if (!listed.ok) return NextResponse.json({ error: listed.error, completeness: completenessScore(pkg) }, { status: listed.status })
  const sources = await Promise.all(listed.value.map(async (s) => ({ ...s, preview_url: await signedPreviewUrl(admin, s) })))
  return NextResponse.json({
    sources,
    completeness: completenessScore(pkg),
    limits: { maxFileBytes: MAX_FILE_BYTES, maxPdfPages: MAX_PDF_PAGES, maxImages: MAX_IMAGES_PER_PACKAGE, previewSeconds: SIGNED_URL_SECONDS },
  })
}

export async function POST(request: Request, { params }: { params: { id: string } }) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const pkg = await getPackageById(params.id)
  if (!pkg) return NextResponse.json({ error: 'Package not found' }, { status: 404 })
  const admin = getSupabaseAdmin()

  const type = request.headers.get('content-type') || ''
  let result
  if (type.includes('multipart/form-data')) {
    const form = await request.formData().catch(() => null)
    const file = form?.get('file')
    if (!(file instanceof File)) return NextResponse.json({ error: 'No file provided' }, { status: 400 })
    if (file.size > MAX_FILE_BYTES) return NextResponse.json({ error: 'That file is larger than 10 MB. Save a smaller copy and try again.' }, { status: 413 })
    result = await createFileSource(admin, params.id, { name: file.name, bytes: Buffer.from(await file.arrayBuffer()) })
  } else {
    const body = (await request.json().catch(() => null)) as { action?: unknown; url?: unknown; text?: unknown; path?: unknown; name?: unknown } | null
    if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
    if (body.action === 'upload-url') {
      const r = await createSignedUpload(admin, params.id)
      return r.ok ? NextResponse.json(r.value) : NextResponse.json({ error: r.error }, { status: r.status })
    }
    if (body.action === 'register') {
      if (typeof body.path !== 'string') return NextResponse.json({ error: 'path is required' }, { status: 400 })
      result = await registerUploadedFile(admin, params.id, body.path, typeof body.name === 'string' ? body.name : '')
    } else if (typeof body.url === 'string' && body.url.trim()) {
      result = await createUrlSource(admin, params.id, body.url)
    } else if (typeof body.text === 'string' && body.text.trim()) {
      result = await createTextSource(admin, params.id, body.text)
    } else {
      return NextResponse.json({ error: 'Send a file, a link or some text.' }, { status: 400 })
    }
  }
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
  const { extracted_text, ...source } = result.value
  return NextResponse.json({ source: { ...source, text_chars: extracted_text?.length ?? 0 } })
}
