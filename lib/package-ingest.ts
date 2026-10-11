import type { SupabaseClient } from '@supabase/supabase-js'
import { createPackage, getPackageById, type DbPackage } from '@/lib/packages'
import { completenessScore } from '@/lib/package-completeness'
import { extractPackageDraft, extractPackageDraftFromImages, extractPackageDraftFromPdf, fetchSourceText, type ExtractedDraft, type ModelUsage } from '@/lib/package-extract'
import { prepareImages } from '@/lib/screenshot-slices'
import { proposeEnrichment, applyEnrichment, autoFaqs, commitEdits, type Enrichment } from '@/lib/package-enrich'
import { getSource, downloadSourceFile, downloadSourceImages, saveExtraction, markSourceFailed, estimateCostUsd, savePhotoCandidates, type PackageEdit, type PhotoCandidate } from '@/lib/package-sources'
import { autoPickPhotos, type PhotoAddResult } from '@/lib/supplier-photos'
import { findDestinationPhoto, isPexelsConfigured, type PexelsPhoto } from '@/lib/pexels'
import { uploadImagePackageVariants, type PackageImageUrls } from '@/lib/import-package'
import { generateSlug } from '@/lib/utils'

// Reading one stored source and filling the trip page from it (growth loop WP11, WP12, WP13). This is the ONE place
// the work happens; the admin route (POST /api/admin/packages/[id]/sources/[sourceId]/extract) and the public
// agent submission route both call it, so an agent's trip gets exactly the same grounded extraction, copy,
// FAQs and photos as one Joel adds himself. Nothing here checks who is asking: the CALLER does that (the admin route
// with isAuthorized, the agent route with a validated invite token).

/** A claimed source that never finished (the function was killed) can be claimed again after this long. */
export const STALE_CLAIM_MS = 5 * 60_000

export interface IngestResult {
  /** The HTTP status the admin route answers with. */
  status: number
  /** The JSON the admin route answers with (an `error` string on failure). */
  body: Record<string, unknown>
  /** Column names that were filled in (empty on failure). */
  applied: string[]
  /** True when the source was read (even if a later step had a problem). */
  read: boolean
}

// ─── The illustrative cover (WP13) ──────────────────────────────────────────────────

/**
 * Edits that give a trip with NO cover a stock photo of its destination: image_url and its square, portrait and banner
 * shapes, and image_source 'pexels'. Each is its own edit, so Revert clears the cover only while this source's photo is
 * still what is there. Pure. The credit says it is a picture of the place, not of this trip.
 */
export function planIllustrativeCover(
  row: Record<string, unknown>,
  stored: PackageImageUrls,
  photo: Pick<PexelsPhoto, 'photographer'>,
  at: string,
): { updates: Record<string, unknown>; edits: PackageEdit[] } {
  const updates: Record<string, unknown> = {}
  const edits: PackageEdit[] = []
  const credit = `Pexels photo by ${photo.photographer} (illustrative picture of the destination, not of this trip)`
  if (typeof row.image_url === 'string' && row.image_url.trim()) return { updates, edits }
  if (!stored.image_url) return { updates, edits }
  for (const f of ['image_url', 'image_url_square', 'image_url_portrait', 'image_url_banner'] as const) {
    const next = stored[f]
    if (!next) continue
    edits.push({ field: f, before: row[f] ?? null, after: next, method: 'auto', at, credit })
    updates[f] = next
  }
  edits.push({ field: 'image_source', before: row.image_source ?? null, after: 'pexels', method: 'auto', at, credit })
  updates.image_source = 'pexels'
  return { updates, edits }
}

export interface CoverDeps {
  findPhoto?: (query: string) => Promise<Pick<PexelsPhoto, 'url' | 'photographer'> | null>
  upload?: (url: string, slugBase: string) => Promise<PackageImageUrls>
  configured?: () => boolean
}

/**
 * Screenshot and PDF sources have no usable trip photo (a screenshot is never a cover). When the trip still has NO cover
 * after everything else, use a real stock photo of its destination, clearly illustrative. Needs the destination (typed
 * or read from the source): a trip with no destination gets nothing rather than a search for its placeholder name.
 * Logged on the source with Revert. Never throws.
 */
export async function addIllustrativeCover(admin: SupabaseClient, packageId: string, sourceId: string, deps: CoverDeps = {}): Promise<{ added: boolean; skipped?: string; pkg: DbPackage | null }> {
  try {
    const pkg = await getPackageById(packageId)
    if (!pkg) return { added: false, skipped: 'The trip page could not be read.', pkg: null }
    if (pkg.image_url && pkg.image_url.trim()) return { added: false, pkg }
    const destination = (pkg.destination ?? '').trim()
    if (!destination) return { added: false, skipped: 'No destination yet, so no cover photo was chosen.', pkg }
    if (!(deps.configured ?? isPexelsConfigured)()) return { added: false, skipped: 'Pexels is not set up, so no cover photo was chosen.', pkg }
    const photo = await (deps.findPhoto ?? findDestinationPhoto)(destination)
    if (!photo) return { added: false, skipped: 'No stock photo was found for the destination.', pkg }
    const stored = await (deps.upload ?? uploadImagePackageVariants)(photo.url, pkg.slug || 'trip')
    if (!stored.image_url) return { added: false, skipped: 'The cover photo could not be copied into our storage.', pkg }
    const latest = await getPackageById(packageId)
    if (!latest) return { added: false, skipped: 'The trip page could not be read.', pkg }
    const plan = planIllustrativeCover(latest as unknown as Record<string, unknown>, stored, photo, new Date().toISOString())
    if (plan.edits.length === 0) return { added: false, pkg: latest }
    const r = await commitEdits(admin, packageId, sourceId, plan.updates, plan.edits, [], latest)
    if (r.applied.length === 0) return { added: false, skipped: r.skipped[0]?.reason ?? 'The cover photo was not saved.', pkg: latest }
    return { added: true, pkg: r.pkg ?? latest }
  } catch (e) {
    console.error('[package-ingest] cover failed', e)
    return { added: false, skipped: e instanceof Error ? e.message : 'Choosing a cover photo failed', pkg: null }
  }
}

// ─── Reading a source ─────────────────────────────────────────────────────────────

/**
 * Reads one source and fills what can be filled. This is the only place the AI runs for a source:
 *   1. ONE extraction call (screenshot or PDF: the file goes to the model as an image or document block; link
 *      or text: the text goes in). Every number, date and link is then checked against the source text.
 *   2. At most ONE copy-writing call, only if the page has empty copy fields, from the same source text.
 *   3. At most ONE FAQ call (WP12), only when the trip then has a description of 150+ words and no FAQs; so a
 *      source costs at most 3 model calls. A link source also lists its photos and copies up to 6 into the
 *      gallery (no model call: plain downloads and uploads).
 *   4. A trip that still has no cover gets a stock photo of its destination (WP13, no model call).
 * Then facts that are empty on the page and grounded are written (never from a screenshot or PDF: those are
 * click-only for prices, dates, links, duration and group size), and clean copy for empty fields is written.
 * Nothing that already has a value is overwritten here. Each change is logged on the source for Revert.
 *
 * Money rule: once the paid extraction has come back, a later failure never throws it away. The result is saved
 * first, a problem afterwards is recorded on the source as a note, and the source stays "read" so a retry cannot
 * pay twice.
 */
export async function ingestSourceForPackage(admin: SupabaseClient, packageId: string, sourceId: string, opts: { safeFetch?: boolean } = {}): Promise<IngestResult> {
  const source = await getSource(admin, packageId, sourceId)
  if (!source) return { status: 404, body: { error: 'Source not found' }, applied: [], read: false }
  // A trip photo (WP14) is for the gallery and is never read by the model, whoever asks.
  if (source.kind === 'photo') return { status: 400, body: { error: 'A trip photo is not read by the AI.' }, applied: [], read: false }
  const kind = source.kind as 'screenshot' | 'pdf' | 'url' | 'text'

  // Atomic claim: one extraction per source unless the last try failed (or a claim went stale), so a double click
  // cannot pay twice.
  const staleBefore = new Date(Date.now() - STALE_CLAIM_MS).toISOString()
  const { data: claimed } = await admin
    .from('package_sources')
    .update({ model_calls: 1, updated_at: new Date().toISOString() })
    .eq('id', source.id)
    .or(`and(model_calls.eq.0,status.in.(uploaded,failed)),and(model_calls.eq.1,status.eq.uploaded,updated_at.lt.${staleBefore})`)
    .select('id')
    .maybeSingle()
  if (!claimed) return { status: 409, body: { error: 'This source was already read (or is being read right now). Add it again to read it a second time.' }, applied: [], read: false }

  // Before the paid call comes back: free to retry, so the claim is given back.
  const failBeforePay = async (status: number, message: string): Promise<IngestResult> => {
    await markSourceFailed(admin, source.id, message, { resetCalls: true })
    return { status, body: { error: message }, applied: [], read: false }
  }
  // After it: keep what was paid for, note the problem, and do not allow a second paid read.
  const keepAfterPay = async (message: string): Promise<IngestResult> => {
    await admin.from('package_sources').update({ status: 'extracted', error: message.slice(0, 500), updated_at: new Date().toISOString() }).eq('id', source.id)
    return { status: 500, body: { error: `${message} The source was read and kept; nothing was lost.` }, applied: [], read: true }
  }

  let paid = false
  try {
    const pkg = await getPackageById(packageId)
    if (!pkg) return await failBeforePay(404, 'Package not found')

    let transcript = ''
    let draft: ExtractedDraft | null = null
    let usage: ModelUsage = { input: 0, output: 0 }
    let photos: PhotoCandidate[] = []

    if (source.kind === 'screenshot' || source.kind === 'pdf') {
      const label = source.file_name ?? ''
      let r
      if (source.kind === 'pdf') {
        const bytes = await downloadSourceFile(admin, source)
        if (!bytes) return await failBeforePay(404, 'The stored file could not be read (missing, or over 10 MB). Delete this source and add it again.')
        r = await extractPackageDraftFromPdf(bytes, label)
      } else {
        // One screenshot or a set dropped together: every picture is scaled and, when tall, cut into overlapping strips
        // (lib/screenshot-slices.ts); all strips go to the model in order in ONE call.
        const pictures = await downloadSourceImages(admin, source)
        if (!pictures) return await failBeforePay(404, 'The stored file could not be read (missing, or over 10 MB). Delete this source and add it again.')
        const prepared = await prepareImages(pictures)
        if (prepared.error) return await failBeforePay(413, prepared.error)
        r = await extractPackageDraftFromImages(prepared.images, label, prepared.sliced)
      }
      if (r.error) return await failBeforePay(r.error.status, r.error.message)
      draft = r.draft
      transcript = r.transcript
      usage = r.usage
    } else {
      let text = source.extracted_text ?? ''
      if (source.kind === 'url') {
        // safeFetch (the public agent path): hop-by-hop redirects, every hop checked. The admin path keeps the plain follow
        // because Joel may paste an http link; it is one flag to switch on.
        const f = await fetchSourceText(source.source_url ?? '', { safe: opts.safeFetch })
        if (f.error) return await failBeforePay(f.error.status, f.error.message)
        text = f.text
        photos = f.photos
      }
      const r = await extractPackageDraft(text, source.kind === 'url' ? (source.source_url ?? undefined) : undefined)
      if (r.error) return await failBeforePay(r.error.status, r.error.message)
      draft = r.draft
      transcript = text
      usage = r.usage ?? usage
    }
    paid = true

    // Save the paid result straight away (facts only for now), before anything else can fail.
    const saveError = await saveExtraction(admin, source.id, {
      extracted_text: transcript,
      extracted_fields: { draft, proposal: { facts: [], copy: [], copyNote: 'Reading finished; the proposal is being prepared.' } },
      model: draft.model,
      input_tokens: usage.input,
      output_tokens: usage.output,
      model_calls: 1,
    })
    if (saveError) return await keepAfterPay(`Could not save what was found (${saveError}).`)

    let enrichment: Enrichment
    try {
      enrichment = await proposeEnrichment(pkg, draft, { transcript, kind, sourceUrl: source.kind === 'url' ? (source.source_url ?? undefined) : undefined })
    } catch (e) {
      return await keepAfterPay(`Writing the page copy failed (${e instanceof Error ? e.message : 'unknown error'}).`)
    }
    const inputTokens = usage.input + (enrichment.usage?.input ?? 0)
    const outputTokens = usage.output + (enrichment.usage?.output ?? 0)
    const saved = await saveExtraction(admin, source.id, {
      extracted_text: transcript,
      extracted_fields: { draft, proposal: { facts: enrichment.facts, copy: enrichment.copy, copyNote: enrichment.copyNote ?? null } },
      model: draft.model,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      model_calls: 1 + enrichment.calls,
    })
    if (saved) return await keepAfterPay(`Could not save the proposal (${saved}).`)

    const auto = [...enrichment.facts, ...enrichment.copy].filter((c) => c.autoApply)
    let applied: Awaited<ReturnType<typeof applyEnrichment>> = { applied: [], skipped: [], pkg }
    if (auto.length) {
      try {
        applied = await applyEnrichment(admin, pkg, auto, source.id, 'auto')
      } catch (e) {
        return await keepAfterPay(`Filling in the trip page failed (${e instanceof Error ? e.message : 'unknown error'}). Open Review and use the buttons.`)
      }
    } else {
      // Nothing was filled in, but a trip that already has a long description and no FAQs still gets them (WP12).
      const f = await autoFaqs(admin, pkg, source.id)
      applied = { applied: f.applied, skipped: [], pkg: f.pkg ?? pkg, faqCalls: f.calls, faqUsage: f.usage }
    }

    // Supplier photos (WP12): a link source only. The candidates found on the page are stored, then up to 6 are
    // copied into our storage and added to the gallery. A problem here never undoes what was paid for or applied.
    let photoResult: PhotoAddResult | null = null
    let photoNote: string | null = null
    if (source.kind === 'url' && photos.length) {
      try {
        photoNote = await savePhotoCandidates(admin, source.id, photos)
        const fresh = await getSource(admin, packageId, source.id)
        if (fresh) photoResult = await autoPickPhotos(admin, packageId, { ...fresh, photo_candidates: photos }, { budgetMs: 60_000 })
      } catch (e) {
        photoNote = `Adding the photos failed (${e instanceof Error ? e.message : 'unknown error'}). Nothing else was affected.`
      }
    }

    // Illustrative cover (WP13): only when the trip STILL has no cover (a supplier photo above wins). A screenshot is
    // never used as a picture; this is a stock photo of the destination, logged and Revert-able.
    const cover = await addIllustrativeCover(admin, packageId, source.id)

    const faqCalls = applied.faqCalls ?? 0
    const totalIn = inputTokens + (applied.faqUsage?.input ?? 0)
    const totalOut = outputTokens + (applied.faqUsage?.output ?? 0)
    const appliedColumns = [...applied.applied, ...(photoResult?.added.length ? ['gallery_urls'] : []), ...(cover.added ? ['image_url'] : [])]
    return {
      status: 200,
      read: true,
      applied: appliedColumns,
      body: {
        applied: appliedColumns,
        skipped: applied.skipped,
        found: { facts: enrichment.facts.length, copy: enrichment.copy.length, missing: draft.missing, dropped: draft.dropped },
        copyNote: enrichment.copyNote ?? null,
        photos: source.kind === 'url' ? { found: photos.length, added: photoResult?.added.length ?? 0, skipped: photoResult?.skipped ?? [], note: photoNote ?? photoResult?.error ?? null } : null,
        cover: { added: cover.added, note: cover.skipped ?? null },
        cost: { inputTokens: totalIn, outputTokens: totalOut, modelCalls: 1 + enrichment.calls + faqCalls, estimatedUsd: estimateCostUsd(totalIn, totalOut) },
        completeness: completenessScore(cover.pkg ?? photoResult?.pkg ?? applied.pkg ?? pkg),
      },
    }
  } catch (error) {
    console.error('[package-ingest] failed', error)
    const message = error instanceof Error ? error.message : 'Extraction failed'
    return paid ? await keepAfterPay(message) : await failBeforePay(500, message)
  }
}

// ─── A draft with nothing in it yet (WP13) ──────────────────────────────────────────

/**
 * Creates an unpublished draft trip so the intake can run against a real row. Only what the caller knows is stored
 * (a name, optionally a destination and the supplier); the text columns the table requires are empty strings, never
 * invented values. No stock photo here: that waits until the trip has a real destination (see addIllustrativeCover).
 */
export async function createDraftPackage(input: { name: string; destination?: string; supplier?: string }): Promise<{ pkg: DbPackage | null; error: { status: number; message: string } | null }> {
  const name = input.name.replace(/\s+/g, ' ').trim().slice(0, 120)
  if (name.length < 3) return { pkg: null, error: { status: 400, message: 'A trip name of at least 3 letters is required.' } }
  const suffix = Math.random().toString(36).slice(2, 6)
  const slug = `${generateSlug(name).slice(0, 80)}-${suffix}`
  const { pkg, error } = await createPackage({
    name,
    slug,
    destination: (input.destination ?? '').trim().slice(0, 120),
    duration: '',
    price_display: '',
    status: 'draft',
    supplier: input.supplier?.trim() ? input.supplier.trim().slice(0, 120) : null,
  })
  if (error || !pkg) {
    if (error?.code === '23505') return { pkg: null, error: { status: 409, message: 'A trip with that name already exists. Try again.' } }
    return { pkg: null, error: { status: 500, message: error?.message || 'Failed to create the draft' } }
  }
  return { pkg, error: null }
}
