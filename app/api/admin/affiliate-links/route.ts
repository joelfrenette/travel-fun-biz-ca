import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { dedupeSlug } from '@/lib/affiliate-go'
import { normalizeAffiliateLinkInput, summarizeClicksByLink, clicksFor } from '@/lib/affiliate-links-admin'

const LINK_COLUMNS = 'id, slug, status, url, merchant, title, sort_order, created_at, updated_at'

export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const admin = getSupabaseAdmin()
    const [{ data: links, error: linksError }, { data: clicks, error: clicksError }] = await Promise.all([
      admin.from('affiliate_links').select(LINK_COLUMNS).order('sort_order').order('created_at', { ascending: false }),
      admin.from('affiliate_clicks').select('link_id, created_at').limit(5000),
    ])
    if (linksError) throw new Error(linksError.message)
    if (clicksError) throw new Error(clicksError.message)

    const counts = summarizeClicksByLink(clicks ?? [])
    const rows = (links ?? []).map((link) => ({ ...link, clicks: clicksFor(counts, link.id) }))
    return NextResponse.json({ links: rows })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const body = await request.json().catch(() => ({}))
    const parsed = normalizeAffiliateLinkInput(body)
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })

    const admin = getSupabaseAdmin()
    // A brand-new card never 500s on a slug collision — it's deduped against every taken slug
    // (auto-generated or typed by hand) the same way Phase 6's own dedupeSlug expects to be used.
    const { data: existing, error: existingError } = await admin.from('affiliate_links').select('slug')
    if (existingError) throw new Error(existingError.message)
    const slug = dedupeSlug(parsed.value.slug, (existing ?? []).map((r) => r.slug))

    const { data, error } = await admin
      .from('affiliate_links')
      .insert({ ...parsed.value, slug })
      .select(LINK_COLUMNS)
      .single()
    if (error) throw new Error(error.message)
    return NextResponse.json({ link: { ...data, clicks: { total: 0, last7: 0, last30: 0 } } }, { status: 201 })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}
