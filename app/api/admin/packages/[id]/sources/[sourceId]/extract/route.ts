import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { getPackageById } from '@/lib/packages'
import { completenessScore } from '@/lib/package-completeness'
import { extractPackageDraft, extractPackageDraftFromImage, extractPackageDraftFromPdf, fetchSourceText, type ExtractedDraft, type ModelUsage } from '@/lib/package-extract'
import { proposeEnrichment, applyEnrichment } from '@/lib/package-enrich'
import { getSource, downloadSourceFile, saveExtraction, markSourceFailed, estimateCostUsd } from '@/lib/package-sources'

export const maxDuration = 300

// POST: read one source and fill what can be filled. This is the only place the AI runs for a source, and only
// when an admin presses the button:
//   1. ONE extraction call (screenshot or PDF: the file goes to the model as an image or document block; link
//      or text: the text goes in). Every number, date and link is then checked against the source text.
//   2. At most ONE copy-writing call, only if the page has empty copy fields, from the same source text.
// Then facts that are empty on the page and grounded are written, and clean copy for empty fields is written.
// Nothing that already has a value is overwritten here. Each change is logged on the source for Revert.
export async function POST(request: Request, { params }: { params: { id: string; sourceId: string } }) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const admin = getSupabaseAdmin()
  const source = await getSource(admin, params.id, params.sourceId)
  if (!source) return NextResponse.json({ error: 'Source not found' }, { status: 404 })

  // Atomic claim: one extraction per source unless the last try failed, so a double click cannot pay twice.
  const { data: claimed } = await admin
    .from('package_sources')
    .update({ model_calls: 1, updated_at: new Date().toISOString() })
    .eq('id', source.id)
    .eq('model_calls', 0)
    .in('status', ['uploaded', 'failed'])
    .select('id')
    .maybeSingle()
  if (!claimed) return NextResponse.json({ error: 'This source was already read (or is being read right now). Add it again to read it a second time.' }, { status: 409 })

  const fail = async (status: number, message: string) => {
    await markSourceFailed(admin, source.id, message)
    await admin.from('package_sources').update({ model_calls: 0 }).eq('id', source.id)
    return NextResponse.json({ error: message }, { status })
  }

  try {
    const pkg = await getPackageById(params.id)
    if (!pkg) return await fail(404, 'Package not found')

    let transcript = ''
    let draft: ExtractedDraft | null = null
    let usage: ModelUsage = { input: 0, output: 0 }

    if (source.kind === 'screenshot' || source.kind === 'pdf') {
      const bytes = await downloadSourceFile(admin, source)
      if (!bytes) return await fail(404, 'The stored file could not be read. Delete this source and add it again.')
      const label = source.file_name ?? ''
      const r =
        source.kind === 'pdf'
          ? await extractPackageDraftFromPdf(bytes, label)
          : await extractPackageDraftFromImage(bytes, (source.mime_type as 'image/png' | 'image/jpeg' | 'image/webp') ?? 'image/png', label)
      if (r.error) return await fail(r.error.status, r.error.message)
      draft = r.draft
      transcript = r.transcript
      usage = r.usage
    } else {
      let text = source.extracted_text ?? ''
      if (source.kind === 'url') {
        const f = await fetchSourceText(source.source_url ?? '')
        if (f.error) return await fail(f.error.status, f.error.message)
        text = f.text
      }
      const r = await extractPackageDraft(text, source.kind === 'url' ? (source.source_url ?? undefined) : undefined)
      if (r.error) return await fail(r.error.status, r.error.message)
      draft = r.draft
      transcript = text
      usage = r.usage ?? usage
    }

    const enrichment = await proposeEnrichment(pkg, draft, { transcript })
    const inputTokens = usage.input + (enrichment.usage?.input ?? 0)
    const outputTokens = usage.output + (enrichment.usage?.output ?? 0)
    const saveError = await saveExtraction(admin, source.id, {
      extracted_text: transcript,
      extracted_fields: { draft, proposal: { facts: enrichment.facts, copy: enrichment.copy, copyNote: enrichment.copyNote ?? null } },
      model: draft.model,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      model_calls: 1 + enrichment.calls,
    })
    if (saveError) return await fail(500, `Could not save what was found: ${saveError}`)

    const auto = [...enrichment.facts, ...enrichment.copy].filter((c) => c.autoApply)
    const applied = auto.length ? await applyEnrichment(admin, pkg, auto, source.id, 'auto') : { applied: [], skipped: [], pkg }

    return NextResponse.json({
      applied: applied.applied,
      skipped: applied.skipped,
      found: { facts: enrichment.facts.length, copy: enrichment.copy.length, missing: draft.missing, dropped: draft.dropped },
      copyNote: enrichment.copyNote ?? null,
      cost: { inputTokens, outputTokens, modelCalls: 1 + enrichment.calls, estimatedUsd: estimateCostUsd(inputTokens, outputTokens) },
      completeness: completenessScore(applied.pkg ?? pkg),
    })
  } catch (error) {
    console.error('[package-sources] extract failed', error)
    return await fail(500, error instanceof Error ? error.message : 'Extraction failed')
  }
}
