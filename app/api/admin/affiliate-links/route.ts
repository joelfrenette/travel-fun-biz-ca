import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { dedupeSlug } from '@/lib/affiliate-go'
import { normalizeAffiliateLinkInput, summarizeClicksByLink, clicksFor, saveLink, LINK_COLUMNS, LINK_COLUMNS_OLD } from '@/lib/affiliate-links-admin'
import { summarizePartnerClicks, type PartnerClickRow } from '@/lib/affiliate-partners'

const PARTNER_COLUMNS = 'id, slug, name, logo_url, partner_id, search_template, disclosure, status, sort_order, created_at'

export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const admin = getSupabaseAdmin()
    // Migration 0048 adds the new columns and the partners table. Until it is applied each read falls back to
    // the old columns, so this screen keeps working and the new sections simply show empty.
    // Card clicks and partner clicks are read with separate queries so neither can push the other out of its window.
    const [linksNew, cardClicksRes, partnerClicksRes, partnersRes, guidesRes] = await Promise.all([
      admin.from('affiliate_links').select(LINK_COLUMNS).order('sort_order').order('created_at', { ascending: false }),
      admin.from('affiliate_clicks').select('link_id, created_at').not('link_id', 'is', null).order('created_at', { ascending: false }).limit(5000),
      admin.from('affiliate_clicks').select('partner_id, guide_key, created_at').not('partner_id', 'is', null).order('created_at', { ascending: false }).limit(5000),
      admin.from('affiliate_partners').select(PARTNER_COLUMNS).order('sort_order').order('created_at'),
      admin.from('guides').select('kind, slug, name').eq('status', 'published').order('name').limit(2000),
    ])
    const migrated = !linksNew.error && !partnerClicksRes.error && !partnersRes.error
    const linksRes = linksNew.error ? await admin.from('affiliate_links').select(LINK_COLUMNS_OLD).order('sort_order').order('created_at', { ascending: false }) : linksNew
    if (linksRes.error) throw new Error(linksRes.error.message)
    if (cardClicksRes.error) throw new Error(cardClicksRes.error.message)

    const cardClicks = (cardClicksRes.data ?? []) as { link_id: string | null; created_at: string }[]
    const partnerClickRows = (partnerClicksRes.error ? [] : partnerClicksRes.data ?? []) as { partner_id: string | null; guide_key: string | null; created_at: string }[]
    const clicks: { link_id: string | null; created_at: string; partner_id?: string | null; guide_key?: string | null }[] = [
      ...cardClicks,
      ...partnerClickRows.map((c) => ({ ...c, link_id: null })),
    ]
    const counts = summarizeClicksByLink(clicks)
    const links = ((linksRes.data ?? []) as unknown as { id: string }[]).map((link) => ({ ...link, clicks: clicksFor(counts, link.id) }))
    // (the select above is typed loosely on purpose: the column list differs before and after migration 0048)

    const partnerClicks = summarizePartnerClicks(clicks.map((c) => ({ partner_id: c.partner_id ?? null, guide_key: c.guide_key ?? null, created_at: c.created_at })) as PartnerClickRow[])
    const partnerRows: { id: string }[] = partnersRes.error ? [] : ((partnersRes.data ?? []) as unknown as { id: string }[])
    const partners = partnerRows.map((p) => ({
      ...p,
      clicks: partnerClicks.byPartner[p.id] ?? { total: 0, last7: 0, last30: 0 },
    }))
    const pages = Object.entries(partnerClicks.byPage)
      .map(([key, c]) => ({ key, ...c }))
      .sort((a, b) => b.last30 - a.last30 || b.total - a.total)
      .slice(0, 50)

    return NextResponse.json({
      links,
      partners,
      pages,
      partnerClicksAll: partnerClicks.all,
      guides: guidesRes.error ? [] : guidesRes.data ?? [],
      migrated,
    })
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

    const saved = await saveLink(admin, { ...parsed.value, slug })
    if (!saved.ok) return NextResponse.json({ error: saved.error }, { status: saved.status })
    return NextResponse.json({ link: { ...saved.data, clicks: { total: 0, last7: 0, last30: 0 } } }, { status: 201 })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}
