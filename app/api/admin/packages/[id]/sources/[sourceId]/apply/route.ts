import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { getPackageById } from '@/lib/packages'
import { completenessScore } from '@/lib/package-completeness'
import { getSource } from '@/lib/package-sources'
import { applyEnrichment, type FieldChange } from '@/lib/package-enrich'

export const maxDuration = 30

// POST {fields: string[]}: the admin clicked "Replace" or "Use this" on these fields of a stored proposal.
// It never calls the AI: the proposal was made (and checked) when the source was read. Held copy cannot be
// applied. Each change is logged on the source and can be reverted.
export async function POST(request: Request, { params }: { params: { id: string; sourceId: string } }) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const body = (await request.json().catch(() => null)) as { fields?: unknown } | null
  const fields = Array.isArray(body?.fields) ? (body!.fields as unknown[]).filter((f): f is string => typeof f === 'string') : []
  if (fields.length === 0) return NextResponse.json({ error: 'Choose at least one field.' }, { status: 400 })

  const admin = getSupabaseAdmin()
  const source = await getSource(admin, params.id, params.sourceId)
  if (!source) return NextResponse.json({ error: 'Source not found' }, { status: 404 })
  const proposal = (source.extracted_fields as { proposal?: { facts?: FieldChange[]; copy?: FieldChange[] } } | null)?.proposal
  const all = [...(proposal?.facts ?? []), ...(proposal?.copy ?? [])]
  const chosen = all.filter((c) => fields.includes(c.field))
  if (chosen.length === 0) return NextResponse.json({ error: 'Those fields are not in this source.' }, { status: 400 })

  const pkg = await getPackageById(params.id)
  if (!pkg) return NextResponse.json({ error: 'Package not found' }, { status: 404 })
  const result = await applyEnrichment(admin, pkg, chosen, source.id, 'click')
  return NextResponse.json({ applied: result.applied, skipped: result.skipped, completeness: completenessScore(result.pkg ?? pkg) })
}
