import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { dedupeSlug } from '@/lib/affiliate-go'
import { normalizeAffiliateLinkInput, summarizeClicksByLink, clicksFor, saveLink, LINK_COLUMNS, LINK_COLUMNS_0048, LINK_COLUMNS_OLD } from '@/lib/affiliate-links-admin'
import { summarizePartnerClicks, type PartnerClickRow, type PartnerRow } from '@/lib/affiliate-partners'
import { advancedOf, applyAdvanced, orphanPartners, partnerForLink, readAdvanced, validateAdvanced } from '@/lib/affiliate-link-partner'
import { refreshAfterChange } from '@/lib/affiliate-refresh'

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
    // Migration 0049 adds category. Reads fall back one step at a time: with category, without it (0048 only), then the old columns.
    const linksMid = linksNew.error ? await admin.from('affiliate_links').select(LINK_COLUMNS_0048).order('sort_order').order('created_at', { ascending: false }) : linksNew
    const migrated = !linksMid.error && !partnerClicksRes.error && !partnersRes.error
    const linksRes = linksMid.error ? await admin.from('affiliate_links').select(LINK_COLUMNS_OLD).order('sort_order').order('created_at', { ascending: false }) : linksMid
    if (linksRes.error) throw new Error(linksRes.error.message)
    if (cardClicksRes.error) throw new Error(cardClicksRes.error.message)

    const cardClicks = (cardClicksRes.data ?? []) as { link_id: string | null; created_at: string }[]
    const partnerClickRows = (partnerClicksRes.error ? [] : partnerClicksRes.data ?? []) as { partner_id: string | null; guide_key: string | null; created_at: string }[]
    const clicks: { link_id: string | null; created_at: string; partner_id?: string | null; guide_key?: string | null }[] = [
      ...cardClicks,
      ...partnerClickRows.map((c) => ({ ...c, link_id: null })),
    ]
    const counts = summarizeClicksByLink(clicks)
    // (the select above is typed loosely on purpose: the column list differs before and after migration 0048)
    const partnerClicks = summarizePartnerClicks(clicks.map((c) => ({ partner_id: c.partner_id ?? null, guide_key: c.guide_key ?? null, created_at: c.created_at })) as PartnerClickRow[])
    const partnerRows = (partnersRes.error ? [] : (partnersRes.data ?? [])) as unknown as (PartnerRow & { created_at?: string })[]
    const noClicks = { total: 0, last7: 0, last30: 0 }
    // ONE list: each link carries its search button settings (the partner row it points at, or the one with the same short
    // name, which is adopted on its next save). Partner rows that no link claims come back separately as "search button only".
    const links = ((linksRes.data ?? []) as unknown as { id: string; slug: string | null; partner_id?: string | null }[]).map((link) => {
      const { partner, adopted } = partnerForLink(link, partnerRows)
      return {
        ...link,
        clicks: clicksFor(counts, link.id),
        advanced: advancedOf(partner),
        searchStatus: partner?.status ?? null,
        partnerAdopted: adopted,
        searchClicks: partner ? partnerClicks.byPartner[partner.id] ?? noClicks : null,
      }
    })
    const searchOnly = orphanPartners(links, partnerRows).map((p) => ({
      id: p.id,
      name: p.name,
      slug: p.slug,
      status: p.status,
      hasSearch: !!p.search_template,
      clicks: partnerClicks.byPartner[p.id] ?? noClicks,
    }))
    const pages = Object.entries(partnerClicks.byPage)
      .map(([key, c]) => ({ key, ...c }))
      .sort((a, b) => b.last30 - a.last30 || b.total - a.total)
      .slice(0, 50)

    return NextResponse.json({
      links,
      searchOnly,
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
    // The advanced (search button) settings are checked before anything is written.
    const advanced = readAdvanced(body as Record<string, unknown>)
    const advancedCheck = validateAdvanced(advanced)
    if (!advancedCheck.ok) return NextResponse.json({ error: advancedCheck.error }, { status: advancedCheck.status })

    const admin = getSupabaseAdmin()
    // A brand-new card never 500s on a slug collision — it's deduped against every taken slug
    // (auto-generated or typed by hand) the same way Phase 6's own dedupeSlug expects to be used.
    const { data: existing, error: existingError } = await admin.from('affiliate_links').select('slug')
    if (existingError) throw new Error(existingError.message)
    const slug = dedupeSlug(parsed.value.slug, (existing ?? []).map((r) => r.slug))

    const saved = await saveLink(admin, { ...parsed.value, slug })
    if (!saved.ok) return NextResponse.json({ error: saved.error }, { status: saved.status })
    if (advanced) {
      const s = saved.data as { id: string; slug: string; status: string; merchant: string | null; title: string | null; sort_order: number; partner_id?: string | null }
      const applied = await applyAdvanced(admin, { ...s, partner_id: s.partner_id ?? null }, advanced)
      if (!applied.ok) return NextResponse.json({ error: `The link was saved, but its search button settings were not: ${applied.error}` }, { status: applied.status })
    }
    const refreshed = await refreshAfterChange(admin)
    return NextResponse.json({ link: { ...saved.data, clicks: { total: 0, last7: 0, last30: 0 } }, refreshed }, { status: 201 })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}
