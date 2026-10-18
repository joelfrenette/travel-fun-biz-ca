import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { normalizePartnerInput } from '@/lib/affiliate-partners'

const PARTNER_COLUMNS = 'id, slug, name, logo_url, partner_id, search_template, disclosure, status, sort_order, created_at'

// Edit or hide a partner. There is no delete: a partner is retired by setting its status to hidden, which keeps its
// click history and takes its buttons and cards off every page at once.
export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const body = await request.json().catch(() => ({}))
    const parsed = normalizePartnerInput(body as Record<string, unknown>)
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })

    const admin = getSupabaseAdmin()
    const { data: taken, error: takenError } = await admin.from('affiliate_partners').select('slug').neq('id', params.id)
    if (takenError) throw new Error(takenError.message)
    if ((taken ?? []).some((r) => r.slug === parsed.value.slug)) {
      return NextResponse.json({ error: `The partner slug "${parsed.value.slug}" is already used by another partner.` }, { status: 409 })
    }

    const { data, error } = await admin.from('affiliate_partners').update(parsed.value).eq('id', params.id).select(PARTNER_COLUMNS).single()
    if (error) throw new Error(error.message)
    return NextResponse.json({ partner: data })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}
