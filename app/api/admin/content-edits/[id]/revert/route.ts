import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { revertEdit } from '@/lib/content-edits'

type Props = { params: { id: string } }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// POST { force?: boolean }   put the `before` text of one automatic edit back on its page.
// If the field has changed since the edit, nothing is written (409) unless force is true.
export async function POST(request: Request, { params }: Props) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!UUID.test(params.id)) return NextResponse.json({ error: 'Not an edit id.' }, { status: 400 })
  try {
    const body = await request.json().catch(() => ({}))
    const result = await revertEdit(getSupabaseAdmin(), params.id, { force: body.force === true })
    if (result.needsForce) return NextResponse.json({ error: result.error, needsForce: true }, { status: 409 })
    if (!result.ok) return NextResponse.json({ error: result.error ?? 'Could not revert.' }, { status: 400 })
    return NextResponse.json({ ok: true })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}
