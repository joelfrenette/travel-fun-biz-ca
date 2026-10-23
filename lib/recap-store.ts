import type { SupabaseClient } from '@supabase/supabase-js'
import { getSetting, setSetting } from '@/lib/app-settings'
import { getPackageById, getNextTripForRecap, type DbPackage } from '@/lib/packages'
import { completenessScore } from '@/lib/package-completeness'
import { createPhotoSource, downloadSourceFile, objectSize, SOURCES_BUCKET } from '@/lib/package-sources'
import { addTripPhotoToGallery, listTripPhotos, notesOf, publishRecap, undoRecap, type TripPhotoView } from '@/lib/recap-run'
import { hasRecap, isPastTrip } from '@/lib/past-trip'
import { composeDraft, gateDraft, quickAnswerOf, recapOf, traceSentences, traceSourcesFor, type CallFn, type DraftInput, type DraftTrip, type Faq, type RecapDraft, type TracedSentence } from '@/lib/recap-draft'
import {
  answersToNotes, buildRecapEmail, cleanText, containsContact, CONTACT_MESSAGE, detectImage, filledAnswerCount, isShareTokenFormat, noDashes, orderWithCover, parseBundle, QUESTION_IDS, recapBundleKey, recapChecklist,
  recapSnoozeKey, selectRecapDue, studioPath, shareExpiry, sharePath, shareState, SHARES_PER_TRIP_MAX, snoozeUntil, studioKey, validateQuote, ANSWER_MAX, PHOTO_MAX_BYTES, PHOTOS_MAX, GALLERY_PICK,
  type DueRow, type DueTrip, type Quote, type RecapBundle, type ShareKind, type StudioAnswers,
} from '@/lib/recap-studio'
import { claimSlot } from '@/lib/slots'
import { generateShareToken, hashShareToken } from '@/lib/recap-token'
import { notifyTo } from '@/lib/alerts'

// The database side of the Recap Studio. Everything here is admin or token gated by its caller. Two storage places:
//   app_settings (works before the migration): the Studio's working state, the private draft, the published bundle, snoozes;
//   recap_shares / recap_submissions (migration 0053): the public links and what came in through them.
// Before migration 0053 every share and submission call answers with MIGRATION_HINT instead of failing.

export const MIGRATION_HINT = 'The Recap Studio links need migration 0053 (supabase/migrations/0053_recap_studio.sql) to be run first.'
const isMissingTable = (m: string) => /recap_shares|recap_submissions|does not exist|schema cache|relation/i.test(m)
export const draftKey = (packageId: string) => `recap_draft2:${packageId}`
export const bundlePrevKey = (packageId: string) => `recap_bundle_prev:${packageId}`

// ─── Reading and saving the Studio's working state ──────────────────────────────────────

export interface OwnQuote extends Quote {
  id: string
  at: string
}

export interface StudioState {
  answers: StudioAnswers
  /** Photo source ids Joel wants in the gallery, in order. */
  photoOrder: string[]
  coverId: string | null
  /** Quotes Joel typed himself, each with the permission tick. */
  quotes: OwnQuote[]
  updatedAt: string | null
}

const EMPTY_STATE: StudioState = { answers: {}, photoOrder: [], coverId: null, quotes: [], updatedAt: null }

export async function readStudio(admin: SupabaseClient, packageId: string): Promise<StudioState> {
  try {
    const o = JSON.parse((await getSetting(admin, studioKey(packageId))) ?? 'null') as Partial<StudioState> | null
    if (!o || typeof o !== 'object') return { ...EMPTY_STATE }
    return {
      answers: cleanAnswersLoose(o.answers).answers,
      photoOrder: (Array.isArray(o.photoOrder) ? o.photoOrder : []).filter((x): x is string => typeof x === 'string').slice(0, PHOTOS_MAX),
      coverId: typeof o.coverId === 'string' ? o.coverId : null,
      quotes: (Array.isArray(o.quotes) ? o.quotes : []).filter((q): q is OwnQuote => !!q && typeof q.id === 'string' && typeof q.text === 'string' && typeof q.name === 'string').slice(0, 20),
      updatedAt: typeof o.updatedAt === 'string' ? o.updatedAt : null,
    }
  } catch {
    return { ...EMPTY_STATE }
  }
}

/** For autosave: keeps what is fine, drops what is empty, reports what was refused. Never throws. */
export function cleanAnswersLoose(input: unknown): { answers: StudioAnswers; errors: string[] } {
  const src = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const answers: StudioAnswers = {}
  const errors: string[] = []
  for (const id of QUESTION_IDS) {
    const raw = cleanText(src[id], ANSWER_MAX + 1, true)
    if (!raw) continue
    if (raw.length > ANSWER_MAX) {
      errors.push(`An answer is longer than ${ANSWER_MAX} characters.`)
      answers[id] = raw.slice(0, ANSWER_MAX)
      continue
    }
    if (containsContact(raw)) {
      errors.push(CONTACT_MESSAGE)
      continue
    }
    answers[id] = noDashes(raw)
  }
  return { answers, errors }
}

async function writeStudio(admin: SupabaseClient, packageId: string, s: StudioState): Promise<string | null> {
  const r = await setSetting(admin, studioKey(packageId), JSON.stringify({ ...s, updatedAt: new Date().toISOString() }))
  return r.error ?? null
}

/** Autosave. Any of answers, photoOrder, coverId may be sent. Returns what was refused so the page can say so. */
export async function saveStudio(admin: SupabaseClient, packageId: string, patch: { answers?: unknown; photoOrder?: unknown; coverId?: unknown }): Promise<{ ok: true; state: StudioState; errors: string[] } | { ok: false; error: string }> {
  const cur = await readStudio(admin, packageId)
  const errors: string[] = []
  if (patch.answers !== undefined) {
    const c = cleanAnswersLoose(patch.answers)
    cur.answers = c.answers
    errors.push(...c.errors)
  }
  if (patch.photoOrder !== undefined) cur.photoOrder = (Array.isArray(patch.photoOrder) ? patch.photoOrder : []).filter((x): x is string => typeof x === 'string' && /^[0-9a-f-]{8,40}$/i.test(x)).slice(0, PHOTOS_MAX)
  if (patch.coverId !== undefined) cur.coverId = typeof patch.coverId === 'string' && patch.coverId ? patch.coverId : null
  const err = await writeStudio(admin, packageId, cur)
  return err ? { ok: false, error: `Could not save: ${err}` } : { ok: true, state: cur, errors }
}

/** Joel's own quote: needs the permission tick like any other. Stored approved, because Joel is the one adding it. */
export async function addOwnQuote(admin: SupabaseClient, packageId: string, input: Parameters<typeof validateQuote>[0]): Promise<{ ok: true; state: StudioState } | { ok: false; errors: string[] }> {
  const v = validateQuote(input)
  if (!v.ok) return v
  const cur = await readStudio(admin, packageId)
  if (cur.quotes.length >= 20) return { ok: false, errors: ['That is plenty of quotes for one trip.'] }
  cur.quotes.push({ id: `q${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, text: v.value.text, name: v.value.name, at: new Date().toISOString() })
  const err = await writeStudio(admin, packageId, cur)
  return err ? { ok: false, errors: [`Could not save: ${err}`] } : { ok: true, state: cur }
}

export async function removeOwnQuote(admin: SupabaseClient, packageId: string, quoteId: string): Promise<string | null> {
  const cur = await readStudio(admin, packageId)
  cur.quotes = cur.quotes.filter((q) => q.id !== quoteId)
  return writeStudio(admin, packageId, cur)
}

// ─── Share links ────────────────────────────────────────────────────────────────────────

export interface ShareRow {
  id: string
  package_id: string
  kind: ShareKind
  agent_name: string | null
  created_at: string
  expires_at: string
  revoked_at: string | null
  uses: number
  last_used_at: string | null
}

const SHARE_COLS = 'id, package_id, kind, agent_name, created_at, expires_at, revoked_at, uses, last_used_at'

export type StoreResult<T> = { ok: true; value: T } | { ok: false; status: number; error: string }
const bad = (status: number, error: string): { ok: false; status: number; error: string } => ({ ok: false, status, error })
const dbError = (m: string) => (isMissingTable(m) ? MIGRATION_HINT : m)

/** Makes a link for ONE trip. The token is returned once and only its hash is stored. */
export async function createShare(admin: SupabaseClient, packageId: string, kind: ShareKind, agentName: string | null, now: Date = new Date()): Promise<StoreResult<{ token: string; path: string; share: ShareRow }>> {
  const active = await admin.from('recap_shares').select('id', { count: 'exact', head: true }).eq('package_id', packageId).is('revoked_at', null).gt('expires_at', now.toISOString())
  if (active.error) return bad(500, dbError(active.error.message))
  if ((active.count ?? 0) >= SHARES_PER_TRIP_MAX) return bad(409, `This trip already has ${SHARES_PER_TRIP_MAX} active links. Revoke one first.`)
  const token = generateShareToken()
  const name = cleanText(agentName, 40).replace(/[^\p{L}'’ -]/gu, '').trim() || null
  const { data, error } = await admin
    .from('recap_shares')
    .insert({ token_hash: hashShareToken(token), package_id: packageId, kind, agent_name: name, expires_at: shareExpiry(now).toISOString() })
    .select(SHARE_COLS)
    .single()
  if (error || !data) return bad(500, dbError(error?.message ?? 'Could not make the link.'))
  return { ok: true, value: { token, path: sharePath(token), share: data as ShareRow } }
}

export async function listShares(admin: SupabaseClient, packageId: string): Promise<ShareRow[]> {
  const { data, error } = await admin.from('recap_shares').select(SHARE_COLS).eq('package_id', packageId).order('created_at', { ascending: false }).limit(20)
  return error ? [] : ((data ?? []) as ShareRow[])
}

export async function revokeShare(admin: SupabaseClient, packageId: string, shareId: string): Promise<string | null> {
  const { error } = await admin.from('recap_shares').update({ revoked_at: new Date().toISOString() }).eq('id', shareId).eq('package_id', packageId).is('revoked_at', null)
  return error ? dbError(error.message) : null
}

/** The link's row, or null. The token is checked for shape first, then looked up BY HASH. Throws only when the tables are missing. */
export async function getShareByToken(admin: SupabaseClient, token: string): Promise<ShareRow | null> {
  if (!isShareTokenFormat(token)) return null
  const { data, error } = await admin.from('recap_shares').select(SHARE_COLS).eq('token_hash', hashShareToken(token)).maybeSingle()
  if (error) throw new Error(dbError(error.message))
  return (data as ShareRow | null) ?? null
}

export { shareState }

// ─── Submissions (always pending first) ────────────────────────────────────────────────

export interface SubmissionRow {
  id: string
  package_id: string
  share_id: string | null
  kind: 'answers' | 'quote' | 'photo'
  payload: Record<string, unknown>
  status: 'pending' | 'approved' | 'rejected'
  submitted_by: string | null
  created_at: string
  decided_at: string | null
}

export async function addSubmission(admin: SupabaseClient, share: ShareRow, kind: SubmissionRow['kind'], payload: Record<string, unknown>): Promise<StoreResult<SubmissionRow>> {
  const { data, error } = await admin.from('recap_submissions').insert({ package_id: share.package_id, share_id: share.id, kind, payload, status: 'pending', submitted_by: share.agent_name }).select('*').single()
  if (error || !data) return bad(500, dbError(error?.message ?? 'Could not save that.'))
  await admin.from('recap_shares').update({ uses: share.uses + 1, last_used_at: new Date().toISOString() }).eq('id', share.id)
  return { ok: true, value: data as SubmissionRow }
}

export async function listSubmissions(admin: SupabaseClient, packageId: string, status?: SubmissionRow['status']): Promise<SubmissionRow[]> {
  let q = admin.from('recap_submissions').select('*').eq('package_id', packageId)
  if (status) q = q.eq('status', status)
  const { data, error } = await q.order('created_at', { ascending: true }).limit(200)
  return error ? [] : ((data ?? []) as SubmissionRow[])
}

/** Pending counts per trip, for Needs attention. [] before the migration. */
export async function pendingByTrip(admin: SupabaseClient): Promise<{ packageId: string; n: number }[]> {
  const { data, error } = await admin.from('recap_submissions').select('package_id').eq('status', 'pending').limit(500)
  if (error) return []
  const counts = new Map<string, number>()
  for (const r of (data ?? []) as { package_id: string }[]) counts.set(r.package_id, (counts.get(r.package_id) ?? 0) + 1)
  return [...counts].map(([packageId, n]) => ({ packageId, n }))
}

export async function studioMigrated(admin: SupabaseClient): Promise<boolean> {
  const { error } = await admin.from('recap_shares').select('id', { head: true, count: 'exact' }).limit(1)
  return !error
}

/** What is shown on the page for each kind of submission, as safe text. */
export function submissionSummary(s: SubmissionRow): string {
  if (s.kind === 'quote') return `"${String(s.payload.text ?? '')}" (${String(s.payload.name ?? '')})`
  if (s.kind === 'answers') return QUESTION_IDS.map((id) => (typeof (s.payload.answers as StudioAnswers | undefined)?.[id] === 'string' ? (s.payload.answers as StudioAnswers)[id] : '')).filter(Boolean).join(' | ')
  return String(s.payload.name ?? 'photo')
}

/** Joel's decision on one item. Approve (optionally with his edit of the text), or reject. An approved photo is copied into the
 * trip's private photo list; a rejected photo is deleted from storage. Nothing here publishes anything. */
export async function decideSubmission(admin: SupabaseClient, packageId: string, submissionId: string, action: 'approve' | 'reject', edits?: { text?: unknown; answers?: unknown }): Promise<StoreResult<SubmissionRow>> {
  const { data, error } = await admin.from('recap_submissions').select('*').eq('id', submissionId).eq('package_id', packageId).maybeSingle()
  if (error) return bad(500, dbError(error.message))
  const row = data as SubmissionRow | null
  if (!row) return bad(404, 'That item was not found.')
  if (row.status !== 'pending') return bad(409, 'That item was already decided.')
  let payload = row.payload
  if (action === 'approve') {
    if (row.kind === 'quote' && edits?.text !== undefined) {
      const v = validateQuote({ text: edits.text, firstName: String(row.payload.name ?? '').split(' ')[0], lastName: String(row.payload.name ?? '').split(' ')[1] ?? '', consent: row.payload.consent === true })
      if (!v.ok) return bad(400, v.errors[0])
      payload = { ...row.payload, text: v.value.text }
    }
    if (row.kind === 'answers' && edits?.answers !== undefined) {
      const c = cleanAnswersLoose(edits.answers)
      if (c.errors.length) return bad(400, c.errors[0])
      payload = { ...row.payload, answers: c.answers }
    }
    if (row.kind === 'quote' && row.payload.consent !== true) return bad(422, 'This quote has no permission tick, so it cannot be approved.')
    if (row.kind === 'photo') {
      const moved = await movePhotoToTrip(admin, packageId, row)
      if (!moved.ok) return moved
    }
  } else if (row.kind === 'photo' && typeof row.payload.path === 'string') {
    await admin.storage.from(SOURCES_BUCKET).remove([row.payload.path]).catch(() => null)
  }
  const status = action === 'approve' ? 'approved' : 'rejected'
  const upd = await admin.from('recap_submissions').update({ status, payload, decided_at: new Date().toISOString() }).eq('id', submissionId).eq('status', 'pending').select('*').maybeSingle()
  if (upd.error) return bad(500, dbError(upd.error.message))
  return { ok: true, value: (upd.data as SubmissionRow | null) ?? { ...row, status, payload } }
}

// ─── Photos sent through a link ─────────────────────────────────────────────────────────

export const sharePhotoPrefix = (packageId: string) => `recap-share/${packageId}/`

/** Step 1 for the public page: a one-time upload link straight to the private bucket (a request here is limited to about 4.5 MB). */
export async function createShareUpload(admin: SupabaseClient, packageId: string): Promise<StoreResult<{ path: string; token: string }>> {
  const path = `${sharePhotoPrefix(packageId)}${Date.now()}-${Math.random().toString(36).slice(2, 10)}.upload`
  const { data, error } = await admin.storage.from(SOURCES_BUCKET).createSignedUploadUrl(path)
  if (error || !data) return bad(500, 'Could not prepare the upload. Please try again.')
  return { ok: true, value: { path, token: data.token } }
}

/** Removes the picture's metadata (GPS and the rest) by re-encoding with sharp, when sharp can read the format. HEIC often cannot be
 * read, so it is kept as it is and marked, and the admin is told. Never throws. */
export async function stripMetadata(bytes: Buffer, mime: string): Promise<{ bytes: Buffer; stripped: boolean }> {
  try {
    const sharp = (await import('sharp')).default
    const img = sharp(bytes, { failOn: 'none' }).rotate()
    const out = mime === 'image/png' ? await img.png().toBuffer() : mime === 'image/webp' ? await img.webp({ quality: 90 }).toBuffer() : await img.jpeg({ quality: 90 }).toBuffer()
    return { bytes: out, stripped: true }
  } catch {
    return { bytes, stripped: false }
  }
}

/** Step 2: checks the stored file (size, real type), strips its metadata, and records it as a PENDING photo. A file that fails is deleted. */
export async function registerSharePhoto(admin: SupabaseClient, share: ShareRow, path: string, name: string): Promise<StoreResult<SubmissionRow>> {
  const prefix = sharePhotoPrefix(share.package_id)
  if (!path.startsWith(prefix) || path.includes('..') || path.length > 200) return bad(400, 'That upload does not belong to this link.')
  const drop = async () => { await admin.storage.from(SOURCES_BUCKET).remove([path]).catch(() => null) }
  const { count } = await admin.from('recap_submissions').select('id', { count: 'exact', head: true }).eq('share_id', share.id).eq('kind', 'photo')
  if ((count ?? 0) >= PHOTOS_MAX) {
    await drop()
    return bad(409, `You can send up to ${PHOTOS_MAX} photos in all.`)
  }
  const size = await objectSize(admin, path)
  if (size == null || size <= 0 || size > PHOTO_MAX_BYTES) {
    await drop()
    return bad(size != null && size > PHOTO_MAX_BYTES ? 413 : 422, size != null && size > PHOTO_MAX_BYTES ? 'That photo is over 12 MB. Please send a smaller copy.' : 'That photo could not be checked, so it was removed. Please try again.')
  }
  const bytes = await downloadSourceFile(admin, { storage_path: path })
  const kind = bytes ? detectImage(bytes) : null
  if (!bytes || !kind) {
    await drop()
    return bad(400, 'Only JPG, PNG, WebP and HEIC photos can be sent.')
  }
  const clean = await stripMetadata(bytes, kind.mime)
  if (clean.stripped) {
    const up = await admin.storage.from(SOURCES_BUCKET).upload(path, clean.bytes, { contentType: kind.mime, upsert: true })
    if (up.error) {
      await drop()
      return bad(500, 'The photo could not be saved. Please try again.')
    }
  }
  return addSubmission(admin, share, 'photo', { path, name: cleanText(name, 120) || `photo.${kind.ext}`, mime: kind.mime, bytes: clean.bytes.length, metadataStripped: clean.stripped })
}

/** Approving a photo: it moves into the trip's own private photo list (the same list as Joel's photos). HEIC is converted when it can be. */
async function movePhotoToTrip(admin: SupabaseClient, packageId: string, row: SubmissionRow): Promise<StoreResult<true>> {
  const path = typeof row.payload.path === 'string' ? row.payload.path : ''
  if (!path.startsWith(sharePhotoPrefix(packageId))) return bad(400, 'That photo is not stored where it should be.')
  const bytes = await downloadSourceFile(admin, { storage_path: path })
  if (!bytes) return bad(404, 'The stored photo could not be read.')
  let useBytes = bytes
  let kind = detectImage(bytes)
  if (kind?.mime === 'image/heic') {
    try {
      const sharp = (await import('sharp')).default
      useBytes = await sharp(bytes, { failOn: 'none' }).rotate().jpeg({ quality: 90 }).toBuffer()
      kind = detectImage(useBytes)
    } catch {
      return bad(422, 'This is a HEIC photo and the server cannot convert it. Reject it and ask for a JPG, or save it as JPG yourself and add it with Choose photos.')
    }
  }
  if (!kind || kind.mime === 'image/heic') return bad(422, 'That photo type cannot be used.')
  const made = await createPhotoSource(admin, packageId, { name: String(row.payload.name ?? `photo.${kind.ext}`), bytes: useBytes })
  if (!made.ok) return bad(made.status, made.error)
  await admin.storage.from(SOURCES_BUCKET).remove([path]).catch(() => null)
  return { ok: true, value: true }
}

export async function pendingPhotoPreview(admin: SupabaseClient, row: SubmissionRow): Promise<string | null> {
  const path = typeof row.payload.path === 'string' ? row.payload.path : ''
  if (!path) return null
  const { data } = await admin.storage.from(SOURCES_BUCKET).createSignedUrl(path, 60)
  return data?.signedUrl ?? null
}

// ─── Email to Joel ──────────────────────────────────────────────────────────────────────

export interface NotifyDeps {
  fetchImpl?: typeof fetch
  claim?: (key: string) => Promise<boolean>
  env?: { key?: string; to?: string; from?: string }
  siteUrl?: string
}

/** One short email when something new waits for review: no names and no words from the notes. At most one per link per hour. Never throws. */
export async function notifyRecapSubmission(admin: SupabaseClient, shareId: string, packageId: string, tripName: string, counts: { answers: number; quotes: number; photos: number }, deps: NotifyDeps = {}): Promise<'sent' | 'throttled' | 'not-configured' | 'failed'> {
  try {
    const key = (deps.env?.key ?? process.env.RESEND_API_KEY)?.trim()
    const to = deps.env?.to ?? notifyTo()
    if (!key || !to) return 'not-configured'
    const hour = new Date().toISOString().slice(0, 13)
    const claimed = await (deps.claim ?? ((k: string) => claimSlot(admin, k, 1)))(`recap_notified:${shareId}:${hour}`)
    if (!claimed) return 'throttled'
    const siteUrl = deps.siteUrl ?? (await import('@/lib/site')).SITE_URL
    const mail = buildRecapEmail(tripName, counts, `${siteUrl}${studioPath(packageId)}`)
    const res = await (deps.fetchImpl ?? fetch)('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: deps.env?.from ?? process.env.ALERT_FROM_EMAIL?.trim() ?? 'TravelFunBiz Autopilot <onboarding@resend.dev>', to: [to], subject: mail.subject, text: mail.text }),
      signal: AbortSignal.timeout(15_000),
    })
    return res.ok ? 'sent' : 'failed'
  } catch {
    return 'failed'
  }
}

// ─── The daily prompt ───────────────────────────────────────────────────────────────────

const DUE_COLUMNS = 'id, slug, name, status, available_to, recap_mode, recap_summary, gallery_urls, ai_faqs'

/** Past trips to prompt about today (snoozes applied). [] when the recap columns do not exist yet (migration 0037). */
export async function recapsDue(admin: SupabaseClient, now: Date = new Date()): Promise<DueTrip[]> {
  const { data, error } = await admin.from('travel_packages').select(DUE_COLUMNS).eq('status', 'published')
  if (error) {
    if (/recap_mode|recap_summary|column|schema cache/i.test(error.message)) return []
    throw new Error(error.message)
  }
  const rows = (data ?? []) as DueRow[]
  const snoozes: Record<string, string | null> = {}
  const { data: sn } = await admin.from('app_settings').select('key, value').like('key', 'recap_snooze:%')
  for (const s of (sn ?? []) as { key: string; value: string }[]) snoozes[s.key.slice('recap_snooze:'.length)] = s.value
  return selectRecapDue(rows, snoozes, now)
}

export async function snoozeTrips(admin: SupabaseClient, packageIds: string[], now: Date = new Date()): Promise<string | null> {
  for (const id of packageIds) {
    const r = await setSetting(admin, recapSnoozeKey(id), snoozeUntil(now))
    if (r.error) return r.error
  }
  return null
}

// ─── Draft, publish, undo ──────────────────────────────────────────────────────────────

export interface StoredDraft {
  draft: RecapDraft
  blockers: string[]
  at: string
  edited: boolean
}

export async function readDraft2(admin: SupabaseClient, packageId: string): Promise<StoredDraft | null> {
  try {
    const o = JSON.parse((await getSetting(admin, draftKey(packageId))) ?? 'null') as StoredDraft | null
    return o && o.draft && typeof o.draft.summary === 'string' ? o : null
  } catch {
    return null
  }
}

/** Pure: the quotes the page may show and the draft may rely on. Joel's own (permission ticked when added) plus submitted quotes that
 * are APPROVED and carry the permission tick. A pending or rejected quote is never in this list. */
export function approvedQuotesFrom(own: { text: string; name: string }[], subs: SubmissionRow[]): Quote[] {
  return [
    ...own.map((q) => ({ text: q.text, name: q.name })),
    ...subs.filter((s) => s.kind === 'quote' && s.status === 'approved' && s.payload.consent === true).map((s) => ({ text: String(s.payload.text ?? ''), name: String(s.payload.name ?? '') })),
  ].filter((q) => q.text && q.name)
}

/** Pure: the answers a person sent that Joel approved, as notes. Pending and rejected answers are never used. */
export function approvedAnswerNotes(subs: SubmissionRow[]) {
  return subs.filter((s) => s.kind === 'answers' && s.status === 'approved').flatMap((s) => answersToNotes((s.payload.answers ?? {}) as StudioAnswers))
}

/** Everything the writer may use: journal notes, Joel's answers, answers an agent sent that Joel approved, and approved quotes. */
export async function gatherInput(admin: SupabaseClient, pkg: DbPackage): Promise<DraftInput> {
  const studio = await readStudio(admin, pkg.id)
  const subs = await listSubmissions(admin, pkg.id)
  const approvedAnswers = approvedAnswerNotes(subs)
  const quotes: Quote[] = approvedQuotesFrom(studio.quotes, subs)
  const unapproved = subs.filter((s) => s.kind === 'quote' && s.status !== 'approved').map((s) => String(s.payload.text ?? ''))
  const next = await getNextTripForRecap(pkg).catch(() => null)
  const trip: DraftTrip = {
    name: pkg.name,
    destination: pkg.destination,
    country: pkg.country,
    category: pkg.category,
    duration: pkg.duration,
    available_from: pkg.available_from,
    available_to: pkg.available_to,
    short_description: pkg.short_description,
    full_description: pkg.full_description,
    highlights: pkg.highlights,
    slug: pkg.slug,
    price_includes: pkg.price_includes as string | string[] | null,
    next_trip: next ? { name: next.name, slug: next.slug } : null,
  }
  return { trip, notes: [...notesOf(pkg), ...answersToNotes(studio.answers), ...approvedAnswers], quotes, unapprovedQuoteTexts: unapproved }
}

/** "Write the draft": ONE model call (at most 5 a day per trip). The result is saved PRIVATE with the gate's verdict. */
export async function writeDraft(admin: SupabaseClient, packageId: string, deps: { call?: CallFn; configured?: boolean; skipDailyCap?: boolean } = {}): Promise<StoreResult<StoredDraft>> {
  const pkg = await getPackageById(packageId)
  if (!pkg) return bad(404, 'Trip not found.')
  const input = await gatherInput(admin, pkg)
  if (!deps.skipDailyCap && !(await claimSlot(admin, `recap_draft:${packageId}`, 5))) return bad(429, 'You have written 5 drafts for this trip today. Edit the one you have, or try again tomorrow.')
  const composed = await composeDraft(input, deps)
  if (!composed.ok) return bad(422, composed.error)
  const stored: StoredDraft = { draft: composed.draft, blockers: composed.blockers, at: new Date().toISOString(), edited: false }
  const saved = await setSetting(admin, draftKey(packageId), JSON.stringify(stored))
  if (saved.error) return bad(500, `The draft was written but could not be saved: ${saved.error}`)
  return { ok: true, value: stored }
}

/** Joel's inline edit of the private draft. It is checked again; an edit that fails stays private with its reasons. */
export async function editDraft(admin: SupabaseClient, packageId: string, patch: { summary?: unknown; highlights?: unknown; takeaways?: unknown; faqs?: unknown }): Promise<StoreResult<StoredDraft>> {
  const pkg = await getPackageById(packageId)
  const cur = await readDraft2(admin, packageId)
  if (!pkg || !cur) return bad(404, 'There is no draft to edit. Write the draft first.')
  const lines = (v: unknown, max: number) => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(/\r?\n/) : []).map((x) => noDashes(cleanText(x, 200))).filter(Boolean).slice(0, max)
  const draft: RecapDraft = { ...cur.draft }
  if (patch.summary !== undefined) draft.summary = noDashes(cleanText(patch.summary, 3000, true))
  if (patch.highlights !== undefined) draft.highlights = lines(patch.highlights, 6)
  if (patch.takeaways !== undefined) draft.takeaways = lines(patch.takeaways, 4)
  if (Array.isArray(patch.faqs)) {
    const faqs: Faq[] = (patch.faqs as { question?: unknown; answer?: unknown }[]).map((f) => ({ question: noDashes(cleanText(f?.question, 140)), answer: noDashes(cleanText(f?.answer, 700, true)) })).filter((f) => f.question && f.answer)
    draft.faqs = faqs
  }
  const input = await gatherInput(admin, pkg)
  const stored: StoredDraft = { draft, blockers: gateDraft(draft, input), at: new Date().toISOString(), edited: true }
  const saved = await setSetting(admin, draftKey(packageId), JSON.stringify(stored))
  return saved.error ? bad(500, saved.error) : { ok: true, value: stored }
}

/** The draft with each sentence traced to the note or stored fact behind it. */
export function traceDraft(draft: RecapDraft, input: DraftInput): { summary: TracedSentence[]; highlights: TracedSentence[]; faqs: { question: string; answer: TracedSentence[] }[]; takeaways: TracedSentence[] } {
  const sources = traceSourcesFor(input)
  return {
    summary: traceSentences(draft.summary, sources),
    highlights: draft.highlights.flatMap((h) => traceSentences(h, sources)),
    faqs: draft.faqs.map((f) => ({ question: f.question, answer: traceSentences(f.answer, sources) })),
    takeaways: draft.takeaways.flatMap((t) => traceSentences(t, sources)),
  }
}

/** FAQs for the trip row: the recap's six first, then the trip's earlier FAQs that do not repeat a question. At most 12. */
export function mergeFaqs(recap: Faq[], existing: unknown): Faq[] {
  const seen = new Set(recap.map((f) => f.question.toLowerCase()))
  const old = (Array.isArray(existing) ? existing : []).filter((f): f is Faq => !!f && typeof (f as Faq).question === 'string' && typeof (f as Faq).answer === 'string' && !seen.has((f as Faq).question.toLowerCase()))
  return [...recap, ...old].slice(0, 12)
}

/**
 * The big Publish button. Fails closed: the draft is checked again against the notes as they are NOW, and a draft the gate holds is
 * never published. Then, in order: the chosen photos go into the gallery (cover first); the recap text, highlights and FAQs go live
 * in one LOGGED step (so Undo restores them; IndexNow is pinged by that step); and the page bundle (quick answer, takeaways, approved
 * quotes, search text) is saved. The trip is never unpublished and its address never changes.
 */
export async function publishStudio(admin: SupabaseClient, packageId: string): Promise<StoreResult<{ photosAdded: number; photoProblems: string[] }>> {
  const pkg = await getPackageById(packageId)
  if (!pkg) return bad(404, 'Trip not found.')
  const stored = await readDraft2(admin, packageId)
  if (!stored) return bad(409, 'Write the draft first.')
  const input = await gatherInput(admin, pkg)
  const blockers = gateDraft(stored.draft, input)
  if (blockers.length) return bad(422, `The checks hold this draft back: ${blockers.slice(0, 3).join('; ')}.`)

  const studio = await readStudio(admin, packageId)
  const photos = await listTripPhotos(admin, packageId)
  const wanted = orderWithCover(studio.photoOrder.filter((id) => photos.some((p) => p.id === id)), studio.coverId).slice(0, GALLERY_PICK)
  let photosAdded = 0
  const photoProblems: string[] = []
  for (const id of wanted) {
    if (photos.find((p) => p.id === id)?.added) continue
    const r = await addTripPhotoToGallery(admin, packageId, id)
    if (r.ok) photosAdded++
    else photoProblems.push(r.error)
  }

  const fresh = (await getPackageById(packageId)) ?? pkg
  const done = await publishRecap(admin, packageId, recapOf(stored.draft), 'generate', { ai_faqs: mergeFaqs(stored.draft.faqs, fresh.ai_faqs) })
  if (!done.ok) return bad(done.status, done.error)

  const prev = await getSetting(admin, recapBundleKey(packageId))
  if (prev) await setSetting(admin, bundlePrevKey(packageId), prev)
  const bundle: RecapBundle = {
    quickAnswer: quickAnswerOf(stored.draft),
    takeaways: stored.draft.takeaways,
    quotes: input.quotes,
    metaTitle: stored.draft.metaTitle,
    metaDescription: stored.draft.metaDescription,
    publishedAt: new Date().toISOString(),
  }
  const w = await setSetting(admin, recapBundleKey(packageId), JSON.stringify(bundle))
  if (w.error) return bad(500, `The recap is live but the extra page parts could not be saved: ${w.error}`)
  await admin.from('app_settings').delete().eq('key', draftKey(packageId))
  return { ok: true, value: { photosAdded, photoProblems } }
}

/** Undo: the recap text, highlights, FAQs and mode go back (the logged step), and the page bundle goes back to what it was. Photos
 * keep their own "Take out" buttons. */
export async function undoStudio(admin: SupabaseClient, packageId: string): Promise<{ reverted: string[]; skipped: { field: string; reason: string }[] }> {
  const r = await undoRecap(admin, packageId)
  const prev = await getSetting(admin, bundlePrevKey(packageId))
  if (prev) {
    await setSetting(admin, recapBundleKey(packageId), prev)
    await admin.from('app_settings').delete().eq('key', bundlePrevKey(packageId))
  } else {
    await admin.from('app_settings').delete().eq('key', recapBundleKey(packageId))
  }
  return r
}

export async function readBundle(admin: SupabaseClient, packageId: string): Promise<RecapBundle | null> {
  return parseBundle(await getSetting(admin, recapBundleKey(packageId)).catch(() => null))
}

// ─── The state the Studio page shows ───────────────────────────────────────────────────

export async function studioView(admin: SupabaseClient, packageId: string) {
  const pkg = await getPackageById(packageId)
  if (!pkg) return null
  const [studio, photos, subs, shares, stored, bundle, migrated] = await Promise.all([
    readStudio(admin, packageId),
    listTripPhotos(admin, packageId),
    listSubmissions(admin, packageId, 'pending'),
    listShares(admin, packageId),
    readDraft2(admin, packageId),
    readBundle(admin, packageId),
    studioMigrated(admin),
  ])
  const input = await gatherInput(admin, pkg)
  const pending = await Promise.all(subs.map(async (s) => ({ id: s.id, kind: s.kind, by: (typeof s.payload.submitterName === 'string' && s.payload.submitterName) || s.submitted_by, at: s.created_at, summary: submissionSummary(s), payload: s.kind === 'photo' ? { name: s.payload.name, metadataStripped: s.payload.metadataStripped === true, mime: s.payload.mime } : s.payload, previewUrl: s.kind === 'photo' ? await pendingPhotoPreview(admin, s) : null })))
  const order = orderWithCover(studio.photoOrder.filter((id) => photos.some((p) => p.id === id)), studio.coverId)
  const projectedGallery = [...(pkg.gallery_urls ?? [])]
  for (const id of order) if (!photos.find((p) => p.id === id)?.added && projectedGallery.length < GALLERY_PICK) projectedGallery.push(`pending:${id}`)
  const faqCount = stored ? stored.draft.faqs.length : Array.isArray(pkg.ai_faqs) ? pkg.ai_faqs.length : 0
  const scoreInput = {
    photoCount: Math.max((pkg.gallery_urls ?? []).length, projectedGallery.length),
    hasCover: !!studio.coverId || !!pkg.image_url,
    answersFilled: filledAnswerCount(studio.answers),
    hasSummary: hasRecap(pkg) || (!!stored && stored.blockers.length === 0),
    faqCount,
    approvedQuotes: input.quotes.length,
  }
  const recapScoreNow = recapChecklist({ photoCount: (pkg.gallery_urls ?? []).length, hasCover: !!pkg.image_url, answersFilled: 0, hasSummary: hasRecap(pkg), faqCount: Array.isArray(pkg.ai_faqs) ? pkg.ai_faqs.length : 0, approvedQuotes: bundle?.quotes.length ?? 0 })
  const recapScoreAfter = recapChecklist(scoreInput)
  const thinBefore = completenessScore(pkg).score
  const thinAfter = completenessScore({ ...pkg, gallery_urls: projectedGallery, ai_faqs: stored ? mergeFaqs(stored.draft.faqs, pkg.ai_faqs) : pkg.ai_faqs }).score
  return {
    migrated,
    trip: { id: pkg.id, name: pkg.name, slug: pkg.slug, destination: pkg.destination, available_to: pkg.available_to, isPast: isPastTrip(pkg), hasRecap: hasRecap(pkg), summary: pkg.recap_summary ?? '' },
    studio,
    photos: photos as TripPhotoView[],
    photoOrder: order,
    pending,
    shares: shares.map((s) => ({ ...s, state: shareState(s, new Date()) })),
    draft: stored,
    trace: stored ? traceDraft(stored.draft, input) : null,
    quotes: input.quotes,
    bundle,
    score: { now: recapScoreNow.score, after: recapScoreAfter.score, items: recapScoreAfter.items, thin: recapScoreAfter.thin },
    thin: { before: thinBefore, after: thinAfter },
  }
}
