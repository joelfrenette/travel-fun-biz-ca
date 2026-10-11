import type { SupabaseClient } from '@supabase/supabase-js'
import { getPackageById, updatePackage, type DbPackage, type JournalEntry } from '@/lib/packages'
import { getSetting, setSetting } from '@/lib/app-settings'
import { commitEdits, revertSourceEdits } from '@/lib/package-enrich'
import { downloadSourceFile, signedPreviewUrl, RECAP_LOG_NAME, type PackageEdit, type PackageSourceRow } from '@/lib/package-sources'
import { addedPhotos, planPhotoAdds, PHOTO_RULES } from '@/lib/supplier-photos'
import { composeRecap, cleanRecap, recapBlockers, recapGrounding, usableNotes, notesWordCount, NOTES_MIN_WORDS, type Recap, type RecapNote } from '@/lib/recap-composer'
import { cleanAlertTag, hasRecap, isPastTrip, normaliseRecapMode, todayYmd, type RecapMode } from '@/lib/past-trip'

// The server side of the "Convert to Past Trip" panel (growth loop WP14). Joel's call (2026-10-11): "Write the
// recap" writes AND publishes in one step when the quality gate is clean. A recap the gate holds is saved as an
// unpublished draft (app_settings) with the reasons shown. Every published change is logged as an edit on a
// small "Recap" source row of the trip, so "Undo recap" restores what was there before (the same log and the
// same Revert the Add details card uses). Nothing here ever unpublishes or hides a trip.

export { RECAP_LOG_NAME }
export const recapDraftKey = (packageId: string) => `recap_draft:${packageId}`

export interface RecapDraft {
  summary: string
  highlights: string[]
  blockers: string[]
  at: string
  /** A clean recap waiting for the admin's one-click "Replace the live recap?" (a recap is already live). */
  readyToReplace?: boolean
}

export async function readDraft(admin: SupabaseClient, packageId: string): Promise<RecapDraft | null> {
  try {
    const parsed = JSON.parse((await getSetting(admin, recapDraftKey(packageId))) ?? 'null') as RecapDraft | null
    return parsed && typeof parsed.summary === 'string' ? parsed : null
  } catch {
    return null
  }
}

async function clearDraft(admin: SupabaseClient, packageId: string): Promise<void> {
  await admin.from('app_settings').delete().eq('key', recapDraftKey(packageId))
}

/** The journal as notes for the writer: only entries with something written. */
export function notesOf(pkg: Pick<DbPackage, 'journal_entries'>): RecapNote[] {
  return usableNotes((pkg.journal_entries ?? []) as JournalEntry[])
}

/** The Recap log row of a trip (created on first use). Its edits are the Undo recap history. */
async function logSource(admin: SupabaseClient, packageId: string): Promise<{ id: string; package_edits: PackageEdit[] } | null> {
  const { data: found } = await admin.from('package_sources').select('id, package_edits').eq('package_id', packageId).eq('kind', 'text').eq('file_name', RECAP_LOG_NAME).limit(1).maybeSingle()
  if (found) return found as { id: string; package_edits: PackageEdit[] }
  const { data, error } = await admin
    .from('package_sources')
    // model_calls 1 and a note as its text: the Add details card can never "read" this row with the model.
    .insert({ package_id: packageId, kind: 'text', file_name: RECAP_LOG_NAME, extracted_text: 'Log of recap changes on this trip. Not a source to read.', status: 'uploaded', model_calls: 1 })
    .select('id, package_edits')
    .single()
  return error || !data ? null : (data as { id: string; package_edits: PackageEdit[] })
}

export type RecapResult = { ok: true; pkg: DbPackage | null; changed: string[] } | { ok: false; status: number; error: string }

/**
 * Publishes a recap that has passed the gate, as logged edits. recap_mode becomes 'recap' only when the trip is in
 * 'auto' and its dates have passed (so a later date change cannot flip a finished trip back); otherwise the mode
 * the admin chose is kept.
 */
async function publishRecap(admin: SupabaseClient, packageId: string, recap: Recap, method: PackageEdit['method']): Promise<RecapResult> {
  const fresh = await getPackageById(packageId)
  if (!fresh) return { ok: false, status: 404, error: 'The trip page could not be read.' }
  const log = await logSource(admin, packageId)
  if (!log) return { ok: false, status: 500, error: 'The recap could not be recorded, so it was not published.' }
  const at = new Date().toISOString()
  const mode = normaliseRecapMode(fresh.recap_mode)
  const nextMode: RecapMode = mode === 'auto' && isPastTrip({ available_to: fresh.available_to, recap_mode: 'auto' }, todayYmd()) ? 'recap' : mode
  const updates: Record<string, unknown> = { recap_summary: recap.summary, recap_highlights: recap.highlights, recap_generated_at: at }
  const edits: PackageEdit[] = [
    { field: 'recap_summary', before: fresh.recap_summary ?? null, after: recap.summary, method, at },
    { field: 'recap_highlights', before: fresh.recap_highlights ?? [], after: recap.highlights, method, at },
    { field: 'recap_generated_at', before: fresh.recap_generated_at ?? null, after: at, method, at },
  ]
  if (nextMode !== mode) {
    updates.recap_mode = nextMode
    edits.push({ field: 'recap_mode', before: mode, after: nextMode, method, at })
  }
  const r = await commitEdits(admin, packageId, log.id, updates, edits, [], fresh)
  if (r.applied.length === 0) return { ok: false, status: 500, error: r.skipped[0]?.reason ?? 'The recap could not be saved. If you have not yet, run migration 0037.' }
  await clearDraft(admin, packageId)
  return { ok: true, pkg: r.pkg, changed: r.applied }
}

export type WriteResult =
  | { ok: true; published: true; recap: Recap; pkg: DbPackage | null }
  | { ok: true; published: false; recap: Recap; blockers: string[]; replaceable?: boolean }
  | { ok: false; status: number; error: string }

/** "Write the recap": ONE model call, then the gate; published at once when clean, else saved as a draft with reasons.
 * When a recap is already live (it may have been edited by hand), a clean new one is saved as a draft that waits for
 * one click (replaceWithDraft) instead of silently overwriting it. */
export async function writeRecap(admin: SupabaseClient, packageId: string): Promise<WriteResult> {
  const pkg = await getPackageById(packageId)
  if (!pkg) return { ok: false, status: 404, error: 'Trip not found.' }
  const composed = await composeRecap(pkg, notesOf(pkg))
  if (!composed.ok) return { ok: false, status: 422, error: composed.error }
  const replacing = hasRecap(pkg)
  if (composed.blockers.length > 0 || replacing) {
    const draft: RecapDraft = { summary: composed.recap.summary, highlights: composed.recap.highlights, blockers: composed.blockers, at: new Date().toISOString(), ...(replacing && composed.blockers.length === 0 ? { readyToReplace: true } : {}) }
    const saved = await setSetting(admin, recapDraftKey(packageId), JSON.stringify(draft))
    if (saved.error) return { ok: false, status: 500, error: `The recap was written but could not be saved: ${saved.error}` }
    return { ok: true, published: false, recap: composed.recap, blockers: composed.blockers, ...(draft.readyToReplace ? { replaceable: true } : {}) }
  }
  const done = await publishRecap(admin, packageId, composed.recap, 'generate')
  if (!done.ok) return done
  return { ok: true, published: true, recap: composed.recap, pkg: done.pkg }
}

/** The one click after "Replace the live recap?": publishes the waiting draft, after running the gate on it again
 * against the notes as they are now. A draft the gate held is never published here. */
export async function replaceWithDraft(admin: SupabaseClient, packageId: string): Promise<{ ok: true; pkg: DbPackage | null } | { ok: false; status: number; error: string }> {
  const draft = await readDraft(admin, packageId)
  if (!draft || !draft.readyToReplace) return { ok: false, status: 409, error: 'There is no new recap waiting to replace the live one. Click Write it again.' }
  const pkg = await getPackageById(packageId)
  if (!pkg) return { ok: false, status: 404, error: 'Trip not found.' }
  const recap = cleanRecap({ summary: draft.summary, highlights: draft.highlights })
  const notes = notesOf(pkg)
  if (recapBlockers(recap, recapGrounding(pkg, notes), pkg.name).length > 0 || notesWordCount(notes) < NOTES_MIN_WORDS) return { ok: false, status: 422, error: 'The notes changed and the waiting recap no longer passes the checks. Click Write it again.' }
  const done = await publishRecap(admin, packageId, recap, 'generate')
  return done.ok ? { ok: true, pkg: done.pkg } : done
}

/** The admin's own edit of the recap text. Same gate; published at once when clean (a held edit is not saved). */
export async function saveEditedRecap(admin: SupabaseClient, packageId: string, input: { summary?: unknown; highlights?: unknown }): Promise<{ ok: true; recap: Recap; pkg: DbPackage | null } | { ok: false; status: number; error: string; blockers?: string[] }> {
  const pkg = await getPackageById(packageId)
  if (!pkg) return { ok: false, status: 404, error: 'Trip not found.' }
  const recap = cleanRecap({ summary: input.summary, highlights: typeof input.highlights === 'string' ? input.highlights.split(/\r?\n/) : input.highlights })
  const blockers = recapBlockers(recap, recapGrounding(pkg, notesOf(pkg)), pkg.name)
  if (blockers.length) return { ok: false, status: 422, error: 'The checks did not accept that text.', blockers }
  const done = await publishRecap(admin, packageId, recap, 'click')
  return done.ok ? { ok: true, recap, pkg: done.pkg } : done
}

/** "Undo recap": puts back every field the recap changed (the earlier text, the mode, the date). A field you edited
 * outside this panel since is left alone and listed. */
export async function undoRecap(admin: SupabaseClient, packageId: string): Promise<{ reverted: string[]; skipped: { field: string; reason: string }[] }> {
  await clearDraft(admin, packageId)
  const { data } = await admin.from('package_sources').select('id, package_edits').eq('package_id', packageId).eq('kind', 'text').eq('file_name', RECAP_LOG_NAME).limit(1).maybeSingle()
  if (!data) return { reverted: [], skipped: [] }
  return revertSourceEdits(admin, packageId, data as Pick<PackageSourceRow, 'id' | 'package_edits'>)
}

// ─── Settings: mode, next trip, alert tag, journal notes ─────────────────────────────

const YMD = /^\d{4}-\d{2}-\d{2}$/

export function cleanJournal(value: unknown): JournalEntry[] | null {
  if (!Array.isArray(value) || value.length > 60) return null
  const out: JournalEntry[] = []
  for (const e of value as Record<string, unknown>[]) {
    if (!e || typeof e !== 'object') return null
    const date = typeof e.date === 'string' ? e.date.trim() : ''
    const title = typeof e.title === 'string' ? e.title.trim().slice(0, 200) : ''
    const body = typeof e.body === 'string' ? e.body.trim().slice(0, 4000) : ''
    if (!date && !title && !body) continue // a blank row
    if (!YMD.test(date) || !title) return null // the public journal needs a date and a title
    out.push({ date, title, body })
  }
  return out.sort((a, b) => a.date.localeCompare(b.date))
}

export async function saveSettings(
  packageId: string,
  input: { recap_mode?: unknown; next_trip_slug?: unknown; alert_tag?: unknown; journal_entries?: unknown },
): Promise<{ ok: true; pkg: DbPackage } | { ok: false; status: number; error: string }> {
  const updates: Partial<DbPackage> = {}
  if (input.recap_mode !== undefined) {
    if (input.recap_mode !== 'auto' && input.recap_mode !== 'recap' && input.recap_mode !== 'live') return { ok: false, status: 400, error: 'recap_mode must be auto, recap or live.' }
    updates.recap_mode = input.recap_mode
  }
  if (input.next_trip_slug !== undefined) {
    const s = typeof input.next_trip_slug === 'string' ? input.next_trip_slug.trim() : ''
    if (s && !/^[a-z0-9][a-z0-9._-]{0,160}$/i.test(s)) return { ok: false, status: 400, error: 'That is not a trip address.' }
    updates.next_trip_slug = s || null
  }
  if (input.alert_tag !== undefined) {
    const raw = typeof input.alert_tag === 'string' ? input.alert_tag.trim() : ''
    const tag = raw ? cleanAlertTag(raw) : null
    if (raw && !tag) return { ok: false, status: 400, error: 'The alert tag can use letters, numbers, dashes, colons and underscores (for example alert:cruises).' }
    updates.alert_tag = tag
  }
  if (input.journal_entries !== undefined) {
    const journal = cleanJournal(input.journal_entries)
    if (!journal) return { ok: false, status: 400, error: 'Each journal note needs a date and a title.' }
    updates.journal_entries = journal
  }
  if (Object.keys(updates).length === 0) return { ok: false, status: 400, error: 'Nothing to save.' }
  const pkg = await updatePackage(packageId, updates)
  if (!pkg) return { ok: false, status: 500, error: 'The trip could not be saved. If you have not yet, run migration 0037 (supabase/migrations/0037_trip_recap.sql).' }
  return { ok: true, pkg }
}

// ─── Trip photos ────────────────────────────────────────────────────────────────────

export interface TripPhotoView {
  id: string
  file_name: string | null
  preview_url: string | null
  /** In the gallery right now because of this row. */
  added: boolean
  stored: string | null
}

export async function listTripPhotos(admin: SupabaseClient, packageId: string): Promise<TripPhotoView[]> {
  const { data } = await admin.from('package_sources').select('*').eq('package_id', packageId).eq('kind', 'photo').order('created_at', { ascending: true })
  const rows = (data ?? []) as PackageSourceRow[]
  return Promise.all(
    rows.map(async (r) => {
      const hit = r.storage_path ? addedPhotos(r.package_edits ?? []).get(r.storage_path) : undefined
      return { id: r.id, file_name: r.file_name, preview_url: await signedPreviewUrl(admin, r), added: !!hit, stored: hit?.stored ?? null }
    }),
  )
}

/**
 * Copies one trip photo from the private bucket into the public gallery: resized by the same pipeline as every other
 * trip image, appended to gallery_urls (12 at most), and logged as an edit on the photo's row, so the Undo button
 * (the source revert route) takes it out again. Never throws.
 */
export async function addTripPhotoToGallery(admin: SupabaseClient, packageId: string, sourceId: string): Promise<{ ok: true; stored: string; pkg: DbPackage | null } | { ok: false; status: number; error: string }> {
  try {
    const { data } = await admin.from('package_sources').select('*').eq('id', sourceId).eq('package_id', packageId).eq('kind', 'photo').maybeSingle()
    const row = data as PackageSourceRow | null
    if (!row?.storage_path) return { ok: false, status: 404, error: 'Photo not found.' }
    if (addedPhotos(row.package_edits ?? []).has(row.storage_path)) return { ok: false, status: 409, error: 'That photo is already in the gallery.' }
    const pkg = await getPackageById(packageId)
    if (!pkg) return { ok: false, status: 404, error: 'Trip not found.' }
    if ((pkg.gallery_urls ?? []).length >= PHOTO_RULES.galleryMax) return { ok: false, status: 409, error: `The gallery already has ${PHOTO_RULES.galleryMax} photos, the most a trip page holds. Take one out first.` }
    const bytes = await downloadSourceFile(admin, row)
    if (!bytes) return { ok: false, status: 404, error: 'The stored photo could not be read. Delete it and add it again.' }
    const { uploadGeneratedImageVariants } = await import('@/lib/import-package')
    const stored = await uploadGeneratedImageVariants(bytes, `${pkg.slug || 'trip'}-recap`)
    if (!stored.image_url) return { ok: false, status: 500, error: 'The photo could not be copied into storage.' }
    const latest = (await getPackageById(packageId)) ?? pkg
    const plan = planPhotoAdds(latest as unknown as Record<string, unknown>, [{ photo: row.storage_path, stored }], { credit: null, method: 'click', at: new Date().toISOString() })
    if (plan.edits.length === 0) return { ok: false, status: 409, error: plan.skipped[0]?.reason ?? 'The photo was not added.' }
    const r = await commitEdits(admin, packageId, row.id, plan.updates, plan.edits, [], latest)
    if (r.applied.length === 0) return { ok: false, status: 500, error: r.skipped[0]?.reason ?? 'The photo was not added.' }
    return { ok: true, stored: stored.image_url, pkg: r.pkg }
  } catch (e) {
    console.error('[recap-run] add photo failed', e)
    return { ok: false, status: 500, error: e instanceof Error ? e.message : 'Adding the photo failed.' }
  }
}

// ─── Next-trip choices ──────────────────────────────────────────────────────────────

export interface UpcomingChoice {
  slug: string
  name: string
  category: string
  available_from: string | null
}

/** Published trips that have not happened, soonest first: the dropdown of "Join the next trip" targets. */
export async function upcomingChoices(admin: SupabaseClient, excludeId: string): Promise<UpcomingChoice[]> {
  const { data } = await admin.from('travel_packages').select('id, slug, name, category, available_from, available_to, recap_mode').eq('status', 'published')
  const today = todayYmd()
  return ((data ?? []) as { id: string; slug: string; name: string; category: string; available_from: string | null; available_to: string | null; recap_mode?: string | null }[])
    .filter((p) => p.id !== excludeId && !isPastTrip(p, today))
    .sort((a, b) => (a.available_from ?? '9999').localeCompare(b.available_from ?? '9999'))
    .map((p) => ({ slug: p.slug, name: p.name, category: p.category, available_from: p.available_from }))
}
