import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { GUIDE_KINDS, isGuideKind, listGuideCandidates, listGuidesAdmin } from '@/lib/guides'
import { getGuideCaps, setGuideCaps, readCapUsage, writeGuide, pickNextCandidate, getGuidePublishMode, setGuidePublishMode, buildBackfillPlan, loadBackfillProgress } from '@/lib/guide-run'
import { BACKFILL_DEFAULT_BATCH, BACKFILL_HARD_MAX, backfillProgress, clampBatchCap, estimateBackfill, readBackfillState, saveBackfillState } from '@/lib/guide-backfill'
import { readGuideFailures } from '@/lib/guide-failures'
import { guideSocialNetworks } from '@/lib/guide-distribution'
import { generateSlug } from '@/lib/utils'

// Writing a guide takes two AI calls (about two minutes at the outside).
export const maxDuration = 300

// GET: every guide (any status), what could be written next, the caps and how much of them is used.
export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const admin = getSupabaseAdmin()
    const [guides, candidates, caps, usage, failures, publishMode] = await Promise.all([
      listGuidesAdmin(admin),
      listGuideCandidates(admin),
      getGuideCaps(admin),
      readCapUsage(admin),
      readGuideFailures(admin),
      getGuidePublishMode(admin),
    ])
    const counts = GUIDE_KINDS.map((kind) => ({
      kind,
      published: guides.filter((g) => g.kind === kind && g.status === 'published').length,
      draft: guides.filter((g) => g.kind === kind && g.status === 'draft').length,
      candidates: candidates.filter((c) => c.kind === kind).length,
    }))
    const posted = await guideSocialNetworks(admin)
    const backfillState = await readBackfillState(admin)
    const backfill = backfillState
      ? { started_at: backfillState.started_at, batch_cap: backfillState.batch_cap, cancelled_at: backfillState.cancelled_at, listed: backfillState.entries.length, ...backfillProgress(backfillState, guides, failures) }
      : null
    return NextResponse.json({ guides, candidates, caps, usage, counts, failures, publishMode, posted, backfill })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}

// POST { action: 'write-next' }                         write the next guide in the rotation now (not capped)
// POST { action: 'write', kind, name, parent_slug? }  write one guide now (the button; ignores the daily and
//                                                      weekly caps, still takes the run lock; publishes
//                                                      only when the quality gate is clean)
// POST { action: 'caps', perDay, perWeek }              change the pipeline caps
export async function POST(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const body = await request.json().catch(() => ({}))
    const admin = getSupabaseAdmin()

    if (body.action === 'caps') {
      const { error } = await setGuideCaps(admin, Number(body.perDay), Number(body.perWeek))
      if (error) return NextResponse.json({ error }, { status: 400 })
      return NextResponse.json({ ok: true })
    }

    // Backfill, step 1 (WP16): the DRY RUN. Lists the pages the published trips would queue and what writing them could
    // cost. Makes no AI call and writes nothing.
    if (body.action === 'backfill-plan') {
      const plan = await buildBackfillPlan(admin)
      const active = await loadBackfillProgress(admin)
      return NextResponse.json({
        dryRun: true,
        pages: plan.entries,
        skipped: plan.skipped,
        byKind: plan.byKind,
        namedCount: plan.namedCount,
        estimateAll: estimateBackfill(plan.entries.length),
        suggestedBatch: clampBatchCap(undefined, plan.entries.length),
        defaultBatch: BACKFILL_DEFAULT_BATCH,
        hardMax: BACKFILL_HARD_MAX,
        alreadyRunning: active ? { written: active.progress.written, waiting: active.progress.waiting, remainingBatch: active.progress.remainingBatch } : null,
      })
    }

    // Backfill, step 2: START (once). Needs the batch size Joel chose after reading the estimate, and confirm: true.
    if (body.action === 'backfill-start') {
      if (body.confirm !== true) return NextResponse.json({ error: 'Read the estimate, choose how many pages to write now, then confirm.' }, { status: 400 })
      const requested = Number(body.batchCap)
      if (!Number.isInteger(requested) || requested < 1) return NextResponse.json({ error: 'Choose how many pages to write in the first batch (1 or more).' }, { status: 400 })
      const earlier = await loadBackfillProgress(admin)
      if (earlier && earlier.progress.waiting > 0) return NextResponse.json({ error: 'A backfill is already running. It keeps going on its own at the daily cap; cancel it first if you want to start over.' }, { status: 409 })
      const plan = await buildBackfillPlan(admin)
      if (plan.entries.length === 0) return NextResponse.json({ error: 'There is nothing to backfill: every page the trips name already exists, or was skipped.' }, { status: 409 })
      // expectedCount is required: it proves the list Joel looked at is the list being started.
      const expected = Number(body.expectedCount)
      if (!Number.isInteger(expected) || expected < 1) return NextResponse.json({ error: 'Run the preview first; the start needs the number of pages you looked at.' }, { status: 400 })
      if (expected !== plan.entries.length) {
        return NextResponse.json({ error: `The list changed since you looked (${expected} pages then, ${plan.entries.length} now). Run the preview again.` }, { status: 409 })
      }
      // Names Joel unticked in the preview are left out of the stored list (kind:slug).
      const exclude = new Set(Array.isArray(body.exclude) ? (body.exclude as unknown[]).filter((x): x is string => typeof x === 'string') : [])
      const entries = plan.entries.filter((e) => !exclude.has(`${e.kind}:${e.slug}`))
      if (entries.length === 0) return NextResponse.json({ error: 'Every page was unticked, so there is nothing to start.' }, { status: 409 })
      const batchCap = clampBatchCap(requested, entries.length)
      const saved = await saveBackfillState(admin, { started_at: new Date().toISOString(), batch_cap: batchCap, entries, cancelled_at: null })
      if (saved.error) return NextResponse.json({ error: saved.error }, { status: 500 })
      return NextResponse.json({ ok: true, listed: entries.length, excluded: plan.entries.length - entries.length, batchCap, estimate: estimateBackfill(batchCap), note: `Backfill started: ${entries.length} pages listed, the first ${batchCap} will be written above the daily cap by the next pipeline passes, the rest at the daily cap. Pages that name a business are saved as drafts for you to check.` })
    }

    if (body.action === 'backfill-cancel') {
      const state = await readBackfillState(admin)
      if (!state) return NextResponse.json({ error: 'There is no backfill to cancel.' }, { status: 409 })
      const saved = await saveBackfillState(admin, { ...state, cancelled_at: new Date().toISOString() })
      if (saved.error) return NextResponse.json({ error: saved.error }, { status: 500 })
      return NextResponse.json({ ok: true, note: 'Backfill cancelled. Pages already written stay; the daily cap goes back to normal.' })
    }

    if (body.action === 'write-next') {
      // The same choice the pipeline would make (kind rotation, failed ones skipped), but not capped.
      const cand = await pickNextCandidate(admin, await listGuideCandidates(admin))
      if (!cand) return NextResponse.json({ error: 'No candidates left: everything is written, or skipped after repeated failures.' }, { status: 409 })
      const result = await writeGuide(admin, cand, { source: 'admin' })
      if (!result.ok) return NextResponse.json({ error: result.note }, { status: result.failed ? 502 : 409 })
      return NextResponse.json({ note: result.note, published: result.published, blockers: result.blockers ?? [] })
    }

    if (body.action === 'write') {
      if (!isGuideKind(body.kind)) return NextResponse.json({ error: 'Pick a kind of guide.' }, { status: 400 })
      const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : ''
      if (name.length < 2) return NextResponse.json({ error: 'Give the guide a name.' }, { status: 400 })
      const slug = generateSlug(name)
      if (!slug) return NextResponse.json({ error: 'That name has no letters or numbers to make a web address from.' }, { status: 400 })
      const parent = typeof body.parent_slug === 'string' && body.parent_slug.trim() ? generateSlug(body.parent_slug) : null
      const result = await writeGuide(admin, { kind: body.kind, name, slug, parent_slug: parent, origin: 'seed' }, { source: 'admin' })
      if (!result.ok) return NextResponse.json({ error: result.note }, { status: result.failed ? 502 : 409 })
      return NextResponse.json({ note: result.note, published: result.published, blockers: result.blockers ?? [], guide: result.guide ? { id: result.guide.id, kind: result.guide.kind, slug: result.guide.slug } : null })
    }

    return NextResponse.json({ error: 'Nothing to do. Pass {action: "write"} or {action: "caps"}.' }, { status: 400 })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}

// PATCH { publishMode: 'draft' | 'publish' }  the one-click switch on the Autopilot guides card
export async function PATCH(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const body = await request.json().catch(() => ({}))
    const { error } = await setGuidePublishMode(getSupabaseAdmin(), String(body.publishMode ?? ''))
    if (error) return NextResponse.json({ error }, { status: 400 })
    return NextResponse.json({ ok: true, publishMode: body.publishMode })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}
