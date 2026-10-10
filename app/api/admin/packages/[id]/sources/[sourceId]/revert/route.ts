import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { getPackageById } from '@/lib/packages'
import { completenessScore } from '@/lib/package-completeness'
import { getSource } from '@/lib/package-sources'
import { revertSourceEdits } from '@/lib/package-enrich'

export const maxDuration = 30

// POST: put back everything this source changed on the trip page. A field that was edited by hand after the
// source wrote it is left alone and listed in `skipped`.
export async function POST(request: Request, { params }: { params: { id: string; sourceId: string } }) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const admin = getSupabaseAdmin()
  const source = await getSource(admin, params.id, params.sourceId)
  if (!source) return NextResponse.json({ error: 'Source not found' }, { status: 404 })
  const result = await revertSourceEdits(admin, params.id, source)
  const pkg = await getPackageById(params.id)
  return NextResponse.json({ ...result, completeness: pkg ? completenessScore(pkg) : null })
}
