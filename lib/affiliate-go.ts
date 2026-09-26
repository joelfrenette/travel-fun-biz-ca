import { SITE_URL } from '@/lib/site'

// Ported from Nomad Escape Plan's lib/affiliate-go.ts (Factory Phase 6: affiliate layer),
// near-verbatim - its own header calls it "MODULAR: nothing site-specific... copy unchanged to a
// sibling site." Short links for affiliate cards: /go/<slug>. Anywhere a card's link is pasted
// (site pages, emails, social bios), the short link is used instead of the merchant's raw
// tracking URL, so changing a link once in an admin screen fixes every copy that was ever
// published. No admin screen to CREATE affiliate_links exists yet in this project (that's the
// "Affiliate Code Manager," still Coming Soon in lib/admin-nav.ts) - this phase ships the /go
// redirect and click ledger only, so it's a real no-op today: an empty affiliate_links table
// means every /go/<slug> just falls through to the home page.
export const GO_PREFIX = '/go'

/** Lowercase letters, digits and dashes; starts with a letter or digit; 2-41 characters. Same rule as the database check. */
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,40}$/

export const isValidSlug = (slug: string | null | undefined): slug is string => !!slug && SLUG_PATTERN.test(slug)

/** A name -> a slug: "Trip.com" -> "trip-com". Kept to 36 characters so a "-2" / "-17"
 * de-duplication suffix still fits. Anything too short to be a slug becomes "link". */
export function slugify(input: string | null | undefined): string {
  const s = String(input ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 36)
    .replace(/-+$/, '')
  return s.length >= 2 ? s : 'link'
}

/** The first of base, base-2, base-3 ... that isn't already taken. */
export function dedupeSlug(base: string, taken: Iterable<string | null | undefined>): string {
  const used = new Set<string>()
  for (const t of taken) if (t) used.add(t.toLowerCase())
  if (!used.has(base)) return base
  for (let n = 2; ; n++) {
    const next = `${base}-${n}`
    if (!used.has(next)) return next
  }
}

/** Is this a real, working affiliate link? An http(s) URL, not the empty "https://" stub and not
 * a seeded placeholder ("REPLACE...", "your-link", example.com). */
export function isRealLink(url: string | null | undefined): boolean {
  const t = (url ?? '').trim()
  if (t.length <= 8 || t === 'https://' || /REPLACE|your-?link|example\.com/i.test(t)) return false
  try {
    const u = new URL(t)
    return u.protocol === 'https:' || u.protocol === 'http:'
  } catch {
    return false
  }
}

/** Site-relative short link: "/go/safe-travel". */
export const goPath = (slug: string) => `${GO_PREFIX}/${encodeURIComponent(slug)}`

/** Absolute short link for emails, bios and documents: "https://travelfunbiz.ca/go/safe-travel". */
export const goUrl = (slug: string, origin: string = SITE_URL) => `${origin.replace(/\/+$/, '')}${goPath(slug)}`

type CardLike = { url: string; slug?: string | null }

/** True when this card's clicks should go through /go (it has a slug and a real link). */
export const usesGoLink = (card: CardLike) => isValidSlug(card.slug) && isRealLink(card.url)

/** Where a card's button should point: its short link when it has one, else the stored URL. */
export const cardHref = (card: CardLike) => (usesGoLink(card) ? goPath(card.slug as string) : card.url)

/** True for a site-relative short link ("/go/safe-travel"). */
export const isGoPath = (href: string | null | undefined) => (href ?? '').startsWith(`${GO_PREFIX}/`)

/** rel for an affiliate link. Both carry "sponsored nofollow" (Google's guidance for paid
 * links). A /go link keeps the Referer so the redirect can log which page the click came from -
 * /go itself answers with Referrer-Policy: no-referrer, so the merchant still never sees our
 * page. A raw merchant URL gets noreferrer. */
export const affiliateRel = (href: string | null | undefined) =>
  isGoPath(href) ? 'sponsored nofollow noopener' : 'sponsored nofollow noopener noreferrer'

/** The columns /go needs from a card. */
export interface GoCard {
  id: string
  slug: string | null
  status: string
  url: string
  merchant: string | null
}

/** Where /go/<slug> sends a visitor. Only ever one of two places: the stored URL of an ACTIVE
 * card with a real link, or the site's own fallback page. Nothing from the request is ever used
 * as a destination, so /go can't be turned into an open redirect. */
export function goDestination(card: GoCard | null | undefined, fallback: string): { location: string; card: GoCard | null } {
  if (card && card.status === 'active' && isRealLink(card.url)) {
    return { location: new URL(card.url.trim()).href, card }
  }
  return { location: fallback, card: null }
}

/** What the Referer header tells us about where the click happened: same site -> the path is
 * kept as the click's page; elsewhere -> only the host, never the full URL; none -> nothing. */
export function refererParts(referer: string | null | undefined, requestUrl: string): { page: string | null; referrerHost: string | null } {
  if (!referer) return { page: null, referrerHost: null }
  try {
    const r = new URL(referer)
    const here = new URL(requestUrl)
    if (r.host === here.host) return { page: r.pathname.slice(0, 200) || '/', referrerHost: null }
    return { page: null, referrerHost: r.hostname.toLowerCase().replace(/^www\./, '').slice(0, 120) }
  } catch {
    return { page: null, referrerHost: null }
  }
}

/** Crawlers and link-preview fetchers. They still get the same redirect - their visit just isn't counted as a click. */
export const isLikelyBot = (userAgent: string | null | undefined) =>
  !userAgent || /bot|crawl|spider|slurp|preview|facebookexternalhit|embedly|whatsapp|telegram|discord|curl|wget|python-requests|headless/i.test(userAgent)
