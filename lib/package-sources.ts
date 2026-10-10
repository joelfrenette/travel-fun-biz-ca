import type { SupabaseClient } from '@supabase/supabase-js'

// Sources an admin adds to a trip page (growth loop WP11): a screenshot, a PDF, a link or pasted text. Each
// one is a row in package_sources (migration 0034); uploaded files live in the PRIVATE bucket
// package-sources, never a public URL, and the admin preview uses a 60 second signed link. The row keeps what
// the model could read (extracted_text), the grounded draft, and the audit trail of every change applied
// from it (package_edits), so a source can be deleted and its edits reverted.

export const SOURCES_BUCKET = 'package-sources'
export const MAX_FILE_BYTES = 10 * 1024 * 1024
export const MAX_PDF_PAGES = 30
export const MAX_IMAGES_PER_PACKAGE = 5
export const MAX_TEXT_CHARS = 160_000
export const SIGNED_URL_SECONDS = 60

export type SourceKind = 'screenshot' | 'pdf' | 'url' | 'text'
export type SourceStatus = 'uploaded' | 'extracted' | 'applied' | 'failed'

/** One logged change. `before` and `after` are the column values (a list stays a list). */
export interface PackageEdit {
  field: string
  before: unknown
  after: unknown
  method: 'auto' | 'click'
  at: string
  reverted?: boolean
}

export interface PackageSourceRow {
  id: string
  package_id: string
  kind: SourceKind
  storage_path: string | null
  public_url: string | null
  source_url: string | null
  file_name: string | null
  mime_type: string | null
  file_bytes: number | null
  extracted_text: string | null
  extracted_fields: unknown
  applied_fields: string[]
  package_edits: PackageEdit[]
  status: SourceStatus
  error: string | null
  model: string | null
  input_tokens: number | null
  output_tokens: number | null
  model_calls: number
  created_at: string
  updated_at: string
}

export type SourceResult<T> = { ok: true; value: T } | { ok: false; status: number; error: string }
const fail = (status: number, error: string): { ok: false; status: number; error: string } => ({ ok: false, status, error })

/** The file types accepted. Detected from the first bytes, not from the name or the type the browser claims. */
export type DetectedFile = { kind: 'screenshot'; mediaType: 'image/png' | 'image/jpeg' | 'image/webp'; ext: string } | { kind: 'pdf'; mediaType: 'application/pdf'; ext: string }

export function detectFile(buf: Buffer): DetectedFile | null {
  if (buf.length >= 8 && buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') return { kind: 'screenshot', mediaType: 'image/png', ext: 'png' }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { kind: 'screenshot', mediaType: 'image/jpeg', ext: 'jpg' }
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return { kind: 'screenshot', mediaType: 'image/webp', ext: 'webp' }
  if (buf.length >= 5 && buf.toString('latin1', 0, 5) === '%PDF-') return { kind: 'pdf', mediaType: 'application/pdf', ext: 'pdf' }
  return null
}

/** Pages in a PDF, counted from its page objects. A cheap guard against sending a 400 page catalogue to the
 * model; returns 0 when the count cannot be read (a compressed object stream), which the caller treats as
 * unknown rather than blocking. */
export function pdfPageCount(buf: Buffer): number {
  const text = buf.toString('latin1')
  const counts = [...text.matchAll(/\/Count\s+(\d+)/g)].map((m) => Number(m[1]))
  if (counts.length) return Math.max(...counts)
  return (text.match(/\/Type\s*\/Page[^s]/g) ?? []).length
}

/** The uploaded name, made safe to show and to store (the stored object key never uses it). */
function cleanName(name: string): string {
  return name.replace(/[\u0000-\u001f\\/]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120)
}

/** Rough dollars for a model call, for the admin to see. An estimate at Sonnet-class rates (3 and 15 dollars
 * per million input and output tokens), labelled as an estimate wherever it is shown. */
export function estimateCostUsd(inputTokens: number | null, outputTokens: number | null): number {
  return Math.round((((inputTokens ?? 0) * 3 + (outputTokens ?? 0) * 15) / 1_000_000) * 10_000) / 10_000
}

/** Rows for one package, newest first. The (large) extracted text is not sent to the browser; its length is. */
export async function listSources(admin: SupabaseClient, packageId: string): Promise<SourceResult<(Omit<PackageSourceRow, 'extracted_text'> & { text_chars: number; cost_usd: number })[]>> {
  const { data, error } = await admin.from('package_sources').select('*').eq('package_id', packageId).order('created_at', { ascending: false })
  if (error) return fail(500, /relation .* does not exist|package_sources/i.test(error.message) ? 'The package_sources table is missing: run migration 0034 (supabase/migrations/0034_package_sources.sql) in the Supabase SQL editor.' : error.message)
  return {
    ok: true,
    value: ((data ?? []) as PackageSourceRow[]).map(({ extracted_text, ...rest }) => ({ ...rest, text_chars: extracted_text?.length ?? 0, cost_usd: estimateCostUsd(rest.input_tokens, rest.output_tokens) })),
  }
}

export async function getSource(admin: SupabaseClient, packageId: string, sourceId: string): Promise<PackageSourceRow | null> {
  const { data } = await admin.from('package_sources').select('*').eq('id', sourceId).eq('package_id', packageId).maybeSingle()
  return (data as PackageSourceRow | null) ?? null
}

/** Stores an uploaded screenshot or PDF in the private bucket and adds its row. Nothing is read by the model yet. */
export async function createFileSource(admin: SupabaseClient, packageId: string, file: { name: string; bytes: Buffer }): Promise<SourceResult<PackageSourceRow>> {
  if (file.bytes.length === 0) return fail(400, 'That file is empty.')
  if (file.bytes.length > MAX_FILE_BYTES) return fail(413, 'That file is larger than 10 MB. Save a smaller copy and try again.')
  const detected = detectFile(file.bytes)
  if (!detected) return fail(400, 'Only PNG, JPG, WebP screenshots and PDF files are accepted.')
  if (detected.kind === 'pdf') {
    const pages = pdfPageCount(file.bytes)
    if (pages > MAX_PDF_PAGES) return fail(413, `That PDF has ${pages} pages. The limit is ${MAX_PDF_PAGES}. Save just the pages about this trip and try again.`)
  } else {
    const { count } = await admin.from('package_sources').select('id', { count: 'exact', head: true }).eq('package_id', packageId).eq('kind', 'screenshot')
    if ((count ?? 0) >= MAX_IMAGES_PER_PACKAGE) return fail(409, `This trip already has ${MAX_IMAGES_PER_PACKAGE} screenshots. Delete one before adding another.`)
  }

  const path = `${packageId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${detected.ext}`
  const up = await admin.storage.from(SOURCES_BUCKET).upload(path, file.bytes, { contentType: detected.mediaType, upsert: false })
  if (up.error) {
    return fail(500, /bucket not found/i.test(up.error.message) ? 'The private storage bucket package-sources is missing: run migration 0034 in the Supabase SQL editor.' : up.error.message)
  }
  const { data, error } = await admin
    .from('package_sources')
    .insert({ package_id: packageId, kind: detected.kind, storage_path: path, file_name: cleanName(file.name) || `upload.${detected.ext}`, mime_type: detected.mediaType, file_bytes: file.bytes.length, status: 'uploaded' })
    .select('*')
    .single()
  if (error || !data) {
    await admin.storage.from(SOURCES_BUCKET).remove([path])
    return fail(500, error?.message ?? 'Could not save the source.')
  }
  return { ok: true, value: data as PackageSourceRow }
}

/** A link source. The page is fetched when extraction runs, not now. Only public http(s) links. */
export async function createUrlSource(admin: SupabaseClient, packageId: string, url: string): Promise<SourceResult<PackageSourceRow>> {
  let parsed: URL
  try {
    parsed = new URL(url.trim())
  } catch {
    return fail(400, 'That is not a valid web address.')
  }
  if (!/^https?:$/.test(parsed.protocol)) return fail(400, 'Only http and https links can be used.')
  const { data, error } = await admin.from('package_sources').insert({ package_id: packageId, kind: 'url', source_url: parsed.toString(), status: 'uploaded' }).select('*').single()
  if (error || !data) return fail(500, error?.message ?? 'Could not save the source.')
  return { ok: true, value: data as PackageSourceRow }
}

/** Pasted text. Stored as the extracted text straight away: it is its own transcript. */
export async function createTextSource(admin: SupabaseClient, packageId: string, text: string): Promise<SourceResult<PackageSourceRow>> {
  const clean = text.replace(/\r\n?/g, '\n').trim()
  if (clean.length < 40) return fail(400, 'Paste more text: at least a few sentences about the trip.')
  if (clean.length > MAX_TEXT_CHARS) return fail(413, `That text is too long (limit ${MAX_TEXT_CHARS.toLocaleString('en-CA')} characters).`)
  const { data, error } = await admin.from('package_sources').insert({ package_id: packageId, kind: 'text', extracted_text: clean, status: 'uploaded' }).select('*').single()
  if (error || !data) return fail(500, error?.message ?? 'Could not save the source.')
  return { ok: true, value: data as PackageSourceRow }
}

/** A link to look at the uploaded file for 60 seconds (admin preview). Null for links and pasted text. */
export async function signedPreviewUrl(admin: SupabaseClient, row: Pick<PackageSourceRow, 'storage_path'>): Promise<string | null> {
  if (!row.storage_path) return null
  const { data, error } = await admin.storage.from(SOURCES_BUCKET).createSignedUrl(row.storage_path, SIGNED_URL_SECONDS)
  return error ? null : (data?.signedUrl ?? null)
}

/** The uploaded file's bytes, read with the service role. */
export async function downloadSourceFile(admin: SupabaseClient, row: Pick<PackageSourceRow, 'storage_path'>): Promise<Buffer | null> {
  if (!row.storage_path) return null
  const { data, error } = await admin.storage.from(SOURCES_BUCKET).download(row.storage_path)
  if (error || !data) return null
  return Buffer.from(await data.arrayBuffer())
}

/** Saves what extraction found. `extracted_fields` holds {draft, proposal, ...} as the caller built it. */
export async function saveExtraction(
  admin: SupabaseClient,
  id: string,
  patch: { extracted_text: string; extracted_fields: unknown; model: string | null; input_tokens: number; output_tokens: number; model_calls: number },
): Promise<string | null> {
  const { error } = await admin.from('package_sources').update({ ...patch, status: 'extracted', error: null, updated_at: new Date().toISOString() }).eq('id', id)
  return error?.message ?? null
}

export async function markSourceFailed(admin: SupabaseClient, id: string, message: string): Promise<void> {
  await admin.from('package_sources').update({ status: 'failed', error: message.slice(0, 500), updated_at: new Date().toISOString() }).eq('id', id)
}

/** Removes the row and its stored file. The caller reverts edits first when the admin asked for that; this
 * refuses while applied changes are still live, because deleting the row would lose the way to undo them. */
export async function deleteSource(admin: SupabaseClient, row: PackageSourceRow): Promise<SourceResult<true>> {
  const live = (row.package_edits ?? []).filter((e) => !e.reverted)
  if (live.length) return fail(409, `This source changed ${live.length} field${live.length === 1 ? '' : 's'} on the trip page. Revert its changes first, or choose "Revert and delete".`)
  if (row.storage_path) await admin.storage.from(SOURCES_BUCKET).remove([row.storage_path])
  const { error } = await admin.from('package_sources').delete().eq('id', row.id)
  return error ? fail(500, error.message) : { ok: true, value: true }
}
