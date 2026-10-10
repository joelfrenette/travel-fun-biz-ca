import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { GUIDE_KINDS, isGuideKind, listGuideCandidates, listGuidesAdmin } from '@/lib/guides'
import { getGuideCaps, setGuideCaps, readCapUsage, writeGuide, pickNextCandidate, getGuidePublishMode, setGuidePublishMode } from '@/lib/guide-run'
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
    return NextResponse.json({ guides, candidates, caps, usage, counts, failures, publishMode, posted })
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
