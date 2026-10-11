import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { getPackageById } from '@/lib/packages'
import { completenessScore } from '@/lib/package-completeness'
import { extractPackageDraft, extractPackageDraftFromImage, extractPackageDraftFromPdf, fetchSourceText, type ExtractedDraft, type ModelUsage } from '@/lib/package-extract'
import { proposeEnrichment, applyEnrichment, autoFaqs, type Enrichment } from '@/lib/package-enrich'
import { getSource, downloadSourceFile, saveExtraction, markSourceFailed, estimateCostUsd, savePhotoCandidates, type PhotoCandidate } from '@/lib/package-sources'
import { autoPickPhotos, type PhotoAddResult } from '@/lib/supplier-photos'

export const maxDuration = 300

/** A claimed source that never finished (the function was killed) can be claimed again after this long. */
const STALE_CLAIM_MS = 5 * 60_000

// POST: read one source and fill what can be filled. This is the only place the AI runs for a source, and only
// when an admin presses the button:
//   1. ONE extraction call (screenshot or PDF: the file goes to the model as an image or document block; link
//      or text: the text goes in). Every number, date and link is then checked against the source text.
//   2. At most ONE copy-writing call, only if the page has empty copy fields, from the same source text.
//   3. At most ONE FAQ call (WP12), only when the trip then has a description of 150+ words and no FAQs; so a
//      source costs at most 3 model calls. A link source also lists its photos and copies up to 6 into the
//      gallery (no model call: plain downloads and uploads).
// Then facts that are empty on the page and grounded are written (never from a screenshot or PDF: those are
// click-only for prices, dates, links, duration and group size), and clean copy for empty fields is written.
// Nothing that already has a value is overwritten here. Each change is logged on the source for Revert.
//
// Money rule: once the paid extraction has come back, a later failure never throws it away. The result is saved
// first, a problem afterwards is recorded on the source as a note, and the source stays "read" so a retry cannot
// pay twice.
export async function POST(request: Request, { params }: { params: { id: string; sourceId: string } }) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const admin = getSupabaseAdmin()
  const source = await getSource(admin, params.id, params.sourceId)
  if (!source) return NextResponse.json({ error: 'Source not found' }, { status: 404 })

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
  if (!claimed) return NextResponse.json({ error: 'This source was already read (or is being read right now). Add it again to read it a second time.' }, { status: 409 })

  // Before the paid call comes back: free to retry, so the claim is given back.
  const failBeforePay = async (status: number, message: string) => {
    await markSourceFailed(admin, source.id, message, { resetCalls: true })
    return NextResponse.json({ error: message }, { status })
  }
  // After it: keep what was paid for, note the problem, and do not allow a second paid read.
  const keepAfterPay = async (message: string) => {
    await admin.from('package_sources').update({ status: 'extracted', error: message.slice(0, 500), updated_at: new Date().toISOString() }).eq('id', source.id)
    return NextResponse.json({ error: `${message} The source was read and kept; nothing was lost.` }, { status: 500 })
  }

  let paid = false
  try {
    const pkg = await getPackageById(params.id)
    if (!pkg) return await failBeforePay(404, 'Package not found')

    let transcript = ''
    let draft: ExtractedDraft | null = null
    let usage: ModelUsage = { input: 0, output: 0 }
    let photos: PhotoCandidate[] = []

    if (source.kind === 'screenshot' || source.kind === 'pdf') {
      const bytes = await downloadSourceFile(admin, source)
      if (!bytes) return await failBeforePay(404, 'The stored file could not be read (missing, or over 10 MB). Delete this source and add it again.')
      const label = source.file_name ?? ''
      const r =
        source.kind === 'pdf'
          ? await extractPackageDraftFromPdf(bytes, label)
          : await extractPackageDraftFromImage(bytes, (source.mime_type as 'image/png' | 'image/jpeg' | 'image/webp') ?? 'image/png', label)
      if (r.error) return await failBeforePay(r.error.status, r.error.message)
      draft = r.draft
      transcript = r.transcript
      usage = r.usage
    } else {
      let text = source.extracted_text ?? ''
      if (source.kind === 'url') {
        const f = await fetchSourceText(source.source_url ?? '')
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
      enrichment = await proposeEnrichment(pkg, draft, { transcript, kind: source.kind, sourceUrl: source.kind === 'url' ? (source.source_url ?? undefined) : undefined })
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
        const fresh = await getSource(admin, params.id, source.id)
        if (fresh) photoResult = await autoPickPhotos(admin, params.id, { ...fresh, photo_candidates: photos }, { budgetMs: 60_000 })
      } catch (e) {
        photoNote = `Adding the photos failed (${e instanceof Error ? e.message : 'unknown error'}). Nothing else was affected.`
      }
    }

    const faqCalls = applied.faqCalls ?? 0
    const totalIn = inputTokens + (applied.faqUsage?.input ?? 0)
    const totalOut = outputTokens + (applied.faqUsage?.output ?? 0)
    return NextResponse.json({
      applied: [...applied.applied, ...(photoResult?.added.length ? ['gallery_urls'] : [])],
      skipped: applied.skipped,
      found: { facts: enrichment.facts.length, copy: enrichment.copy.length, missing: draft.missing, dropped: draft.dropped },
      copyNote: enrichment.copyNote ?? null,
      photos: source.kind === 'url' ? { found: photos.length, added: photoResult?.added.length ?? 0, skipped: photoResult?.skipped ?? [], note: photoNote ?? photoResult?.error ?? null } : null,
      cost: { inputTokens: totalIn, outputTokens: totalOut, modelCalls: 1 + enrichment.calls + faqCalls, estimatedUsd: estimateCostUsd(totalIn, totalOut) },
      completeness: completenessScore(photoResult?.pkg ?? applied.pkg ?? pkg),
    })
  } catch (error) {
    console.error('[package-sources] extract failed', error)
    const message = error instanceof Error ? error.message : 'Extraction failed'
    return paid ? await keepAfterPay(message) : await failBeforePay(500, message)
  }
}
