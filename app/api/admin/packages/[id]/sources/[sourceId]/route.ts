import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { getSource, deleteSource } from '@/lib/package-sources'
import { revertSourceEdits } from '@/lib/package-enrich'

export const maxDuration = 30

// DELETE a source and its stored file. Refuses while the source still has live changes on the trip page
// (deleting it would lose the way to undo them); add ?revert=1 to revert those changes first.
export async function DELETE(request: Request, { params }: { params: { id: string; sourceId: string } }) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const admin = getSupabaseAdmin()
  let source = await getSource(admin, params.id, params.sourceId)
  if (!source) return NextResponse.json({ error: 'Source not found' }, { status: 404 })

  const revertFirst = new URL(request.url).searchParams.get('revert') === '1'
  let reverted: string[] = []
  let left: { field: string; reason: string }[] = []
  if (revertFirst) {
    const r = await revertSourceEdits(admin, params.id, source)
    reverted = r.reverted
    left = r.skipped
    // A field someone changed since is left alone (reported below), so the row has nothing live left to undo.
    source = { ...source, package_edits: (source.package_edits ?? []).map((e) => ({ ...e, reverted: true })) }
  }
  const res = await deleteSource(admin, source)
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.status })
  return NextResponse.json({ success: true, reverted, left })
}
