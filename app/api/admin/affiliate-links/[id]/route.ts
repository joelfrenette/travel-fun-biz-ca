import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { normalizeAffiliateLinkInput } from '@/lib/affiliate-links-admin'

const LINK_COLUMNS = 'id, slug, status, url, merchant, title, sort_order, created_at, updated_at'

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const body = await request.json().catch(() => ({}))
    const parsed = normalizeAffiliateLinkInput(body)
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })

    const admin = getSupabaseAdmin()
    // Editing keeps its own slug unless the admin typed a different one — a real collision here
    // is a mistake worth a clear error, not a silent rename, so this does NOT dedupe automatically.
    const { data: taken, error: takenError } = await admin.from('affiliate_links').select('slug').neq('id', params.id)
    if (takenError) throw new Error(takenError.message)
    if ((taken ?? []).some((r) => r.slug === parsed.value.slug)) {
      return NextResponse.json({ error: `The short link "/go/${parsed.value.slug}" is already used by another card.` }, { status: 409 })
    }

    const { data, error } = await admin
      .from('affiliate_links')
      .update({ ...parsed.value, updated_at: new Date().toISOString() })
      .eq('id', params.id)
      .select(LINK_COLUMNS)
      .single()
    if (error) throw new Error(error.message)
    return NextResponse.json({ link: data })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}

export async function DELETE(request: Request, { params }: { params: { id: string } }) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const admin = getSupabaseAdmin()
    const { error } = await admin.from('affiliate_links').delete().eq('id', params.id)
    if (error) throw new Error(error.message)
    return NextResponse.json({ ok: true })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}
