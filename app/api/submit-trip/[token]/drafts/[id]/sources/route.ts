import { NextResponse } from 'next/server'
import { draftGate } from '@/lib/agent-gate'
import { mayAddSource, publicUrlRejection } from '@/lib/agent-submissions'
import { validateSource, AGENT_FILES_MAX_BYTES } from '@/lib/agent-invites'
import { createFileSource, createImageSetSource, createUrlSource, createTextSource, MAX_FILE_BYTES } from '@/lib/package-sources'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// PUBLIC route behind an agent link (WP13): adds ONE source to the agent's own draft, which costs nothing (the AI runs
// in ./[sourceId]). Multipart with "file" (several screenshots dropped together are one source; a PDF goes alone), or
// JSON {url} or {text}. The pictures in one request share 4 MB (the server's request limit). A link must pass
// publicUrlRejection before it is stored. The agent gets back only the new source's id.
export async function POST(request: Request, { params }: { params: { token: string; id: string } }) {
  const g = await draftGate(request, params.token, params.id)
  if (!g.ok) return NextResponse.json({ error: g.error }, { status: g.status })
  const may = await mayAddSource(g.admin, g.invite, g.sub)
  if (!may.ok) return NextResponse.json({ error: may.error }, { status: may.status })
  const pkgId = g.sub.package_id as string

  const type = request.headers.get('content-type') || ''
  let result
  if (type.includes('multipart/form-data')) {
    const form = await request.formData().catch(() => null)
    const files = (form?.getAll('file') ?? []).filter((f): f is File => f instanceof File)
    const v = validateSource({ fileCount: files.length, url: form?.get('url'), text: form?.get('text') })
    if (!v.ok) return NextResponse.json({ error: v.errors[0] }, { status: 400 })
    if (files.some((f) => f.size > MAX_FILE_BYTES) || files.reduce((n, f) => n + f.size, 0) > AGENT_FILES_MAX_BYTES) {
      return NextResponse.json({ error: 'Those files are over 4 MB together. Drop fewer or smaller ones, or add them in two goes.' }, { status: 413 })
    }
    const loaded = await Promise.all(files.map(async (f) => ({ name: f.name, bytes: Buffer.from(await f.arrayBuffer()) })))
    result = loaded.length === 1 ? await createFileSource(g.admin, pkgId, loaded[0]) : await createImageSetSource(g.admin, pkgId, loaded)
  } else {
    const body = (await request.json().catch(() => null)) as { url?: unknown; text?: unknown } | null
    if (!body) return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
    const v = validateSource({ url: body.url, text: body.text, fileCount: 0 })
    if (!v.ok) return NextResponse.json({ error: v.errors[0] }, { status: 400 })
    if (v.value.kind === 'url') {
      const bad = await publicUrlRejection(v.value.url)
      if (bad) return NextResponse.json({ error: bad }, { status: 400 })
      result = await createUrlSource(g.admin, pkgId, v.value.url)
    } else {
      result = await createTextSource(g.admin, pkgId, v.value.text)
    }
  }
  if (!result.ok) return NextResponse.json({ error: result.status >= 500 ? 'Could not save that. Please try again.' : result.error }, { status: result.status })
  return NextResponse.json({ ok: true, sourceId: result.value.id })
}
