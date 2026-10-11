import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { isUuid } from '@/lib/agent-invites'

// DELETE revokes a link (WP13): it stops working at once, for starting AND for continuing drafts. Nothing is deleted:
// the drafts and their history stay.
export async function DELETE(request: Request, { params }: { params: { id: string } }) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!isUuid(params.id)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const { data, error } = await getSupabaseAdmin().from('agent_invites').update({ revoked_at: new Date().toISOString() }).eq('id', params.id).is('revoked_at', null).select('id').maybeSingle()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data) return NextResponse.json({ error: 'That link was not found, or it was already revoked.' }, { status: 404 })
  return NextResponse.json({ ok: true })
}
