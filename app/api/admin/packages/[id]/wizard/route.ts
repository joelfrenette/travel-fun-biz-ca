import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { completeTrip, improveField, isImproveField, publishTrip } from '@/lib/trip-wizard'
import { estimateCostUsd } from '@/lib/package-sources'
import { getPackageById } from '@/lib/packages'
import { completenessScore } from '@/lib/package-completeness'
import { missingFacts } from '@/lib/trip-checklist'

export const maxDuration = 120

// The add-a-trip wizard, admin side (WP13). JSON actions on one trip:
//   {action:'complete'}               the "complete the trip" pass (name, category, tags, short description, FAQs, checklist)
//   {action:'improve', field}         "Improve with AI" on one text field, grounded in the stored sources only
//   {action:'publish'}                Publish now (refuses while a required field is empty)
// Reading and adding sources use the existing /sources routes; own photos use ./photos.
export async function POST(request: Request, { params }: { params: { id: string } }) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const body = (await request.json().catch(() => null)) as { action?: unknown; field?: unknown } | null
  if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  const admin = getSupabaseAdmin()

  if (body.action === 'complete') {
    const r = await completeTrip(admin, params.id)
    return NextResponse.json(
      { ok: r.ok, error: r.error ?? null, applied: r.applied, notes: r.notes, missing: r.missing, calls: r.calls, cost: { modelCalls: r.calls, estimatedUsd: estimateCostUsd(r.usage.input, r.usage.output) }, completeness: r.pkg ? completenessScore(r.pkg) : null },
      { status: r.ok ? 200 : 422 },
    )
  }
  if (body.action === 'improve') {
    if (!isImproveField(body.field)) return NextResponse.json({ error: 'That field cannot be rewritten.' }, { status: 400 })
    const r = await improveField(admin, params.id, body.field)
    return NextResponse.json({ ok: r.ok, applied: r.applied, error: r.error ?? null, held: r.held ?? null, cost: { modelCalls: r.calls, estimatedUsd: estimateCostUsd(r.usage.input, r.usage.output) } }, { status: r.ok ? 200 : 422 })
  }
  if (body.action === 'publish') {
    const r = await publishTrip(params.id)
    if (!r.ok) return NextResponse.json({ error: r.error, missing: r.missing ?? [] }, { status: r.status })
    return NextResponse.json({ ok: true, slug: r.pkg.slug })
  }
  if (body.action === 'state') {
    const pkg = await getPackageById(params.id)
    if (!pkg) return NextResponse.json({ error: 'Package not found' }, { status: 404 })
    return NextResponse.json({ missing: missingFacts(pkg as unknown as Record<string, unknown>), completeness: completenessScore(pkg) })
  }
  return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
}
