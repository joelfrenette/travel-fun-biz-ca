import type { SupabaseClient } from '@supabase/supabase-js'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { cardHref, isRealLink, isValidSlug, usesGoLink } from '@/lib/affiliate-go'
import { DEFAULT_DISCLOSURE, GUIDE_SLUG_PATTERN, fillSearchTemplate, guideKey, partnerGoPath, type PartnerRow } from '@/lib/affiliate-partners'
import { guidePath, isGuideKind, type GuideKind } from '@/lib/guides'

// WP21: the data behind the "Fun things to do in <place>" block, and the lookup behind
// /go/p/<partner>/<kind>/<slug>. Nothing here invents a tour, a price, a rating or an availability:
// a card shows only what an admin typed, and an automatic search button shows only the partner's name.
// No AI call is made anywhere in this feature.

export interface LinkRow {
  id: string
  slug: string | null
  status: string
  url: string
  merchant: string | null
  title: string | null
  sort_order: number
  partner_id: string | null
  guide_kind: string | null
  guide_slug: string | null
  image_url: string | null
  note: string | null
}

export interface ThingsCard {
  id: string
  title: string
  partnerName: string
  note: string | null
  imageUrl: string | null
  /** Always the /go/<slug> short link. */
  href: string
}

export interface ThingsSearch {
  partnerSlug: string
  partnerName: string
  logoUrl: string | null
  /** /go/p/<partner>/<kind>/<slug> */
  href: string
}

export interface ThingsToDo {
  cards: ThingsCard[]
  searches: ThingsSearch[]
  /** Distinct wording to show near the block. Empty only when there is nothing to show. */
  disclosures: string[]
  usesDefaultDisclosure: boolean
}

export const EMPTY_THINGS: ThingsToDo = { cards: [], searches: [], disclosures: [], usesDefaultDisclosure: false }

const bySort = <T extends { sort_order: number }>(a: T, b: T) => a.sort_order - b.sort_order

/** Pure: which cards and search buttons does this page get? Active partners and active, real, pinned links only. */
export function buildThingsToDo(input: { links: LinkRow[]; partners: PartnerRow[]; kind: GuideKind; slug: string }): ThingsToDo {
  const active = input.partners.filter((p) => p.status === 'active').sort(bySort)
  const byId = new Map(active.map((p) => [p.id, p]))

  const cards: ThingsCard[] = []
  const shownPartners = new Set<string | null>()
  for (const l of [...input.links].sort(bySort)) {
    if (l.status !== 'active' || l.guide_kind !== input.kind || l.guide_slug !== input.slug) continue
    if (!usesGoLink({ url: l.url, slug: l.slug })) continue
    // A card tied to a partner that is hidden or still a draft is not shown.
    const partner = l.partner_id ? byId.get(l.partner_id) : null
    if (l.partner_id && !partner) continue
    const partnerName = partner?.name ?? l.merchant ?? ''
    const title = (l.title ?? '').trim() || partnerName
    if (!title) continue
    cards.push({
      id: l.id,
      title,
      partnerName,
      note: l.note?.trim() || null,
      imageUrl: l.image_url && isRealLink(l.image_url) ? l.image_url : null,
      href: cardHref({ url: l.url, slug: l.slug }),
    })
    shownPartners.add(partner?.id ?? null)
  }

  const searches: ThingsSearch[] = []
  for (const p of active) {
    if (!p.search_template || !isValidSlug(p.slug)) continue
    searches.push({ partnerSlug: p.slug, partnerName: p.name, logoUrl: p.logo_url, href: partnerGoPath(p.slug, input.kind, input.slug) })
    shownPartners.add(p.id)
  }

  const disclosures: string[] = []
  let usesDefaultDisclosure = false
  if (cards.length > 0 || searches.length > 0) {
    for (const key of shownPartners) {
      const text = key ? byId.get(key)?.disclosure?.trim() : null
      if (text) {
        if (!disclosures.includes(text)) disclosures.push(text)
      } else usesDefaultDisclosure = true
    }
  }
  return { cards, searches, disclosures, usesDefaultDisclosure }
}

export const disclosureTexts = (t: ThingsToDo): string[] => (t.usesDefaultDisclosure ? [DEFAULT_DISCLOSURE, ...t.disclosures] : t.disclosures)

const LINK_COLUMNS = 'id, slug, status, url, merchant, title, sort_order, partner_id, guide_kind, guide_slug, image_url, note'
const PARTNER_COLUMNS = 'id, slug, name, logo_url, partner_id, search_template, disclosure, status, sort_order'

/** Server read. Any failure (including migration 0048 not applied yet) is an empty block, never an error page. */
export async function loadThingsToDo(kind: GuideKind, slug: string, admin?: SupabaseClient): Promise<ThingsToDo> {
  try {
    const db = admin ?? getSupabaseAdmin()
    const [partnersRes, linksRes] = await Promise.all([
      db.from('affiliate_partners').select(PARTNER_COLUMNS).eq('status', 'active').order('sort_order'),
      db.from('affiliate_links').select(LINK_COLUMNS).eq('status', 'active').eq('guide_kind', kind).eq('guide_slug', slug).order('sort_order'),
    ])
    if (partnersRes.error || linksRes.error) return EMPTY_THINGS
    return buildThingsToDo({ links: (linksRes.data ?? []) as LinkRow[], partners: (partnersRes.data ?? []) as PartnerRow[], kind, slug })
  } catch {
    return EMPTY_THINGS
  }
}

// ---------- /go/p/<partner>/<kind>/<slug> ----------

export interface PartnerGoResult {
  /** Where to send the visitor: the filled partner link, or this site's own page (never anything from the request). */
  location: string
  /** Set only when the visitor is really going to the partner; this is the click to log. */
  click: { partnerId: string; partnerName: string; guideKey: string } | null
}

/** Looks the partner and the page up by the two slugs in the URL, fills the STORED template with the page's
 * name, and answers where to go. The request supplies no URL, so there is no open redirect: the only outside
 * destination possible is the stored template, filled, on its own host. Anything off (unknown or inactive
 * partner, unknown page, a template that no longer validates) goes to the page on this site, or the home page. */
export async function resolvePartnerGo(input: {
  admin: SupabaseClient
  reader: SupabaseClient
  partnerSlug: string
  kind: string
  slug: string
  siteUrl: string
  destinationName?: (slug: string) => Promise<string | null>
}): Promise<PartnerGoResult> {
  const home = `${input.siteUrl.replace(/\/+$/, '')}/`
  const kind = String(input.kind ?? '').trim().toLowerCase()
  const slug = String(input.slug ?? '').trim().toLowerCase()
  const partnerSlug = String(input.partnerSlug ?? '').trim().toLowerCase()
  if (!isGuideKind(kind) || !GUIDE_SLUG_PATTERN.test(slug)) return { location: home, click: null }
  const own = `${input.siteUrl.replace(/\/+$/, '')}${guidePath(kind, slug)}`
  if (!isValidSlug(partnerSlug)) return { location: own, click: null }

  try {
    const { data: partner } = await input.admin.from('affiliate_partners').select(PARTNER_COLUMNS).eq('slug', partnerSlug).eq('status', 'active').maybeSingle()
    const p = partner as PartnerRow | null
    if (!p || !p.search_template) return { location: own, click: null }

    let name: string | null = null
    const { data: guide } = await input.reader.from('guides').select('name').eq('kind', kind).eq('slug', slug).eq('status', 'published').maybeSingle()
    name = ((guide as { name?: string } | null)?.name ?? '').trim() || null
    if (!name && kind === 'destinations' && input.destinationName) name = (await input.destinationName(slug).catch(() => null)) ?? null
    if (!name) return { location: home, click: null }

    const filled = fillSearchTemplate(p.search_template, name, p.partner_id)
    if (!filled.ok) return { location: own, click: null }
    return { location: filled.url, click: { partnerId: p.id, partnerName: p.name, guideKey: guideKey(kind, slug) } }
  } catch {
    return { location: own, click: null }
  }
}

/** Writes one partner search click to the existing ledger (affiliate_clicks). No IP and no user agent are stored,
 * exactly like card clicks. Never throws: a lost click log must never matter to the visitor. */
export async function logPartnerClick(admin: SupabaseClient, click: NonNullable<PartnerGoResult['click']>, ctx: { page: string | null; referrerHost: string | null }): Promise<boolean> {
  try {
    const { error } = await admin
      .from('affiliate_clicks')
      .insert({ link_id: null, merchant: click.partnerName, partner_id: click.partnerId, guide_key: click.guideKey, page: ctx.page, channel: null, channel_source: null, referrer_host: ctx.referrerHost })
    return !error
  } catch {
    return false
  }
}
