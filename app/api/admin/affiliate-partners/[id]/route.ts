import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { isMissingPartnersTable, lockedPartnerSlug, normalizePartnerInput, PARTNERS_MIGRATION_MESSAGE } from '@/lib/affiliate-partners'

const PARTNER_COLUMNS = 'id, slug, name, logo_url, partner_id, search_template, disclosure, status, sort_order, created_at'

// Edit or hide a partner. There is no delete: a partner is retired by setting its status to hidden, which keeps its
// click history and takes its buttons and cards off every page at once. The slug is fixed after creation.
export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
    const admin = getSupabaseAdmin()
    const { data: current, error: currentError } = await admin.from('affiliate_partners').select('slug').eq('id', params.id).maybeSingle()
    if (currentError) {
      if (isMissingPartnersTable(currentError.message)) return NextResponse.json({ error: PARTNERS_MIGRATION_MESSAGE }, { status: 409 })
      throw new Error(currentError.message)
    }
    if (!current) return NextResponse.json({ error: 'That partner no longer exists.' }, { status: 404 })
    const locked = lockedPartnerSlug((current as { slug: string }).slug, body.slug)
    if (!locked.ok) return NextResponse.json({ error: locked.error }, { status: 400 })

    const parsed = normalizePartnerInput({ ...body, slug: locked.slug })
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })

    const { data, error } = await admin.from('affiliate_partners').update(parsed.value).eq('id', params.id).select(PARTNER_COLUMNS).single()
    if (error) {
      if (isMissingPartnersTable(error.message)) return NextResponse.json({ error: PARTNERS_MIGRATION_MESSAGE }, { status: 409 })
      throw new Error(error.message)
    }
    return NextResponse.json({ partner: data })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}
