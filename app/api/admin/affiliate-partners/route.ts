import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { dedupeSlug } from '@/lib/affiliate-go'
import { normalizePartnerInput } from '@/lib/affiliate-partners'

const PARTNER_COLUMNS = 'id, slug, name, logo_url, partner_id, search_template, disclosure, status, sort_order, created_at'

// Create a partner. Listing happens through GET /api/admin/affiliate-links (one screen, one read).
export async function POST(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const body = await request.json().catch(() => ({}))
    const parsed = normalizePartnerInput(body as Record<string, unknown>)
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })

    const admin = getSupabaseAdmin()
    const { data: existing, error: existingError } = await admin.from('affiliate_partners').select('slug')
    if (existingError) throw new Error(existingError.message)
    const slug = dedupeSlug(parsed.value.slug, (existing ?? []).map((r) => r.slug))

    const { data, error } = await admin.from('affiliate_partners').insert({ ...parsed.value, slug }).select(PARTNER_COLUMNS).single()
    if (error) throw new Error(error.message)
    return NextResponse.json({ partner: data }, { status: 201 })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}
