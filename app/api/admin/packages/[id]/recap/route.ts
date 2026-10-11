import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { getPackageById } from '@/lib/packages'
import { defaultAlertTag, effectiveAlertTag, hasRecap, isPastTrip, normaliseRecapMode } from '@/lib/past-trip'
import { RECAP_NOTES_MIN } from '@/lib/recap-composer'
import { addTripPhotoToGallery, listTripPhotos, notesOf, readDraft, saveEditedRecap, saveSettings, undoRecap, upcomingChoices, writeRecap } from '@/lib/recap-run'
import { MAX_TRIP_PHOTOS } from '@/lib/package-sources'

export const maxDuration = 120

// The Convert to Past Trip panel's API (WP14). Every call is admin only.
//   GET                                   the trip's recap state, its trip photos and the next-trip choices
//   POST {action:'settings', ...}         recap_mode, next_trip_slug, alert_tag, journal_entries (any of them)
//   POST {action:'write'}                 ONE model call from the journal notes; published at once when the checks
//                                         pass (logged, Undo works), else saved as an unpublished draft with reasons
//   POST {action:'edit', summary, highlights}   the admin's own wording, same checks, published at once (logged)
//   POST {action:'undo'}                  puts back what the recap changed
//   POST {action:'photo-add', sourceId}   copies one trip photo into the gallery (logged on the photo, Undo works)
// Nothing here unpublishes a trip.

export async function GET(request: Request, { params }: { params: { id: string } }) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const pkg = await getPackageById(params.id)
  if (!pkg) return NextResponse.json({ error: 'Package not found' }, { status: 404 })
  const admin = getSupabaseAdmin()
  const [photos, draft, choices] = await Promise.all([listTripPhotos(admin, params.id), readDraft(admin, params.id), upcomingChoices(admin, params.id)])
  return NextResponse.json({
    migrated: pkg.recap_mode !== undefined,
    mode: normaliseRecapMode(pkg.recap_mode),
    isPast: isPastTrip(pkg),
    hasRecap: hasRecap(pkg),
    summary: pkg.recap_summary ?? '',
    highlights: pkg.recap_highlights ?? [],
    generatedAt: pkg.recap_generated_at ?? null,
    draft,
    nextTripSlug: pkg.next_trip_slug ?? '',
    alertTag: pkg.alert_tag ?? '',
    defaultAlertTag: defaultAlertTag(pkg.category),
    effectiveAlertTag: effectiveAlertTag(pkg),
    journal: pkg.journal_entries ?? [],
    notesUsable: notesOf(pkg).length,
    notesNeeded: RECAP_NOTES_MIN,
    galleryCount: (pkg.gallery_urls ?? []).length,
    photos,
    maxPhotos: MAX_TRIP_PHOTOS,
    choices,
    slug: pkg.slug,
  })
}

export async function POST(request: Request, { params }: { params: { id: string } }) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  if (!body || typeof body.action !== 'string') return NextResponse.json({ error: 'Send {action}.' }, { status: 400 })
  const admin = getSupabaseAdmin()
  if (!(await getPackageById(params.id))) return NextResponse.json({ error: 'Package not found' }, { status: 404 })

  if (body.action === 'settings') {
    const r = await saveSettings(params.id, body)
    return r.ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: r.error }, { status: r.status })
  }
  if (body.action === 'write') {
    const r = await writeRecap(admin, params.id)
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status })
    return NextResponse.json(r.published ? { published: true, summary: r.recap.summary, highlights: r.recap.highlights } : { published: false, summary: r.recap.summary, highlights: r.recap.highlights, blockers: r.blockers })
  }
  if (body.action === 'edit') {
    const r = await saveEditedRecap(admin, params.id, body)
    return r.ok ? NextResponse.json({ published: true, summary: r.recap.summary, highlights: r.recap.highlights }) : NextResponse.json({ error: r.error, blockers: r.blockers ?? [] }, { status: r.status })
  }
  if (body.action === 'undo') {
    return NextResponse.json(await undoRecap(admin, params.id))
  }
  if (body.action === 'photo-add') {
    if (typeof body.sourceId !== 'string') return NextResponse.json({ error: 'sourceId is required' }, { status: 400 })
    const r = await addTripPhotoToGallery(admin, params.id, body.sourceId)
    return r.ok ? NextResponse.json({ stored: r.stored, gallery_urls: r.pkg?.gallery_urls ?? [] }) : NextResponse.json({ error: r.error }, { status: r.status })
  }
  return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
}
