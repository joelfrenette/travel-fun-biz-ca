import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { addOwnPhotos } from '@/lib/trip-wizard'
import { AGENT_FILES_MAX_BYTES } from '@/lib/agent-invites'

export const maxDuration = 120

// POST multipart (field "file", several allowed): the person's own photos go into the gallery (WP13 step 3). A request
// is limited to about 4.5 MB on Vercel, so the pictures in one request share 4 MB; send more in another request.
export async function POST(request: Request, { params }: { params: { id: string } }) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const form = await request.formData().catch(() => null)
  const files = (form?.getAll('file') ?? []).filter((f): f is File => f instanceof File)
  if (files.length === 0) return NextResponse.json({ error: 'No photos provided' }, { status: 400 })
  if (files.reduce((n, f) => n + f.size, 0) > AGENT_FILES_MAX_BYTES) return NextResponse.json({ error: 'Those photos are over 4 MB together. Send fewer or smaller ones at a time.' }, { status: 413 })
  const r = await addOwnPhotos(getSupabaseAdmin(), params.id, await Promise.all(files.map(async (f) => ({ name: f.name, bytes: Buffer.from(await f.arrayBuffer()) }))), 'Added by an admin in the add-a-trip wizard (own photos)')
  if (r.refused) return NextResponse.json({ added: 0, skipped: r.skipped, error: r.refused }, { status: 409 })
  return NextResponse.json({ added: r.added, skipped: r.skipped, error: r.error ?? null }, { status: r.error ? 500 : 200 })
}
