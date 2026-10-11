import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { getPackageById } from '@/lib/packages'
import { completenessScore } from '@/lib/package-completeness'
import { getSource } from '@/lib/package-sources'
import { addSourcePhotos, removeSourcePhotos, photoViews, PHOTO_RULES } from '@/lib/supplier-photos'

export const maxDuration = 120

// Photos found on a link source's page (WP12). The first 6 are added automatically when the link is read; this
// route is the admin's way to add more or take one out.
//   POST {add: [photo addresses]}      copy those photos into our storage and append them to the gallery. Each must
//                                      be one of the photos listed on the source (an address from the request that
//                                      is not on that list is refused). At most 6 per request, 12 in the gallery.
//   POST {remove: [addresses]}         take photos this source added back out of the gallery (the supplier address
//                                      or our stored copy). The stored files stay in storage.
// Every change is a logged edit on the source, so "Revert its changes" still puts the gallery back.
const MAX_PER_REQUEST = 6

export async function POST(request: Request, { params }: { params: { id: string; sourceId: string } }) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const body = (await request.json().catch(() => null)) as { add?: unknown; remove?: unknown } | null
  if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length < 2000) : [])
  const add = strings(body.add)
  const remove = strings(body.remove)
  if (add.length === 0 && remove.length === 0) return NextResponse.json({ error: 'Send {add: [...]} or {remove: [...]}.' }, { status: 400 })
  if (add.length > MAX_PER_REQUEST) return NextResponse.json({ error: `Add at most ${MAX_PER_REQUEST} photos at a time.` }, { status: 400 })

  const admin = getSupabaseAdmin()
  const source = await getSource(admin, params.id, params.sourceId)
  if (!source) return NextResponse.json({ error: 'Source not found' }, { status: 404 })
  if (source.kind !== 'url') return NextResponse.json({ error: 'Only a link source has photos.' }, { status: 400 })

  let removed: string[] = []
  const skipped: { url: string; reason: string }[] = []
  let added: { photo: string; stored: string; cover: boolean }[] = []
  let current = source

  if (remove.length) {
    const r = await removeSourcePhotos(admin, params.id, source, remove)
    if (r.error) return NextResponse.json({ error: r.error }, { status: 500 })
    removed = r.removed
    skipped.push(...r.skipped)
    // The log changed; read it again before adding anything in the same request.
    if (add.length) current = (await getSource(admin, params.id, params.sourceId)) ?? source
  }
  if (add.length) {
    const r = await addSourcePhotos(admin, params.id, current, add, { max: MAX_PER_REQUEST, method: 'click', budgetMs: 90_000 })
    if (r.error) return NextResponse.json({ error: r.error }, { status: 500 })
    added = r.added
    skipped.push(...r.skipped)
  }

  const [pkg, fresh] = await Promise.all([getPackageById(params.id), getSource(admin, params.id, params.sourceId)])
  return NextResponse.json({
    added,
    removed,
    skipped,
    gallery_urls: pkg?.gallery_urls ?? [],
    photos: photoViews(fresh?.photo_candidates, fresh?.package_edits ?? []),
    galleryMax: PHOTO_RULES.galleryMax,
    completeness: pkg ? completenessScore(pkg) : null,
  })
}
