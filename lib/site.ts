// Site identity for this deployment. The .ca and .com are the same code; NEXT_PUBLIC_SITE_ID
// picks the profile and a handful of NEXT_PUBLIC_SITE_* vars can override single fields.
// Never fork the code for the .com: add to the profile instead.
import type { Currency } from '@/lib/currency'

export type SiteId = 'ca' | 'us'

export interface SiteProfile {
  id: SiteId
  name: string
  url: string
  /** Open Graph locale, e.g. en_CA */
  locale: string
  /** ISO 3166-1 alpha-2, used in schema.org address and lead tagging */
  country: 'CA' | 'US'
  /** Currency shown to a first-time visitor (prices are stored in USD and converted). */
  defaultCurrency: Currency
  phone: string
  addressLines: string[]
  address: { locality: string; region: string; postalCode: string }
  registrations: string[]
  /** Where privacy, terms and the other legal pages live. */
  legalBaseUrl: string
  /** One sentence: what this site is for. Reuses the existing metadata description
   * (app/layout.tsx) rather than a second, possibly-drifting copy of the same idea. */
  tagline: string
  /** The IANA zone every schedule (the autoblog/social posting window, admin timestamps) runs on
   * — never UTC. A reasonable operational default from each profile's own city above, not a
   * legal fact; trivial to correct if wrong. */
  timeZone: string
  timeZoneLabel: string
  /**
   * Left blank on purpose, like `phone`/`addressLines` on the US profile above: the registered
   * legal entity name and the jurisdiction whose law governs the terms are compliance facts
   * (factory decision 8), not something to infer from a city name. Set them once Joel supplies
   * the real values; every consumer must treat '' as "not yet supplied," never render a blank
   * legal page as if it were complete.
   */
  legalEntity: string
  governingLaw: string
  /**
   * Nomad's SITE.handle assumes one bare handle used on every platform. TravelFunBiz's real
   * accounts don't share one (see content/footer.ts socialPromos: MostPartiesMostFun on Facebook,
   * solotravelexpert on Instagram, travelfunjoel on TikTok) — so this stays '' rather than picking
   * one and calling it "the" handle. Read the real per-platform links from socialPromos instead.
   */
  handle: string
}

const PROFILES: Record<SiteId, SiteProfile> = {
  ca: {
    id: 'ca',
    name: 'TravelFunBiz.ca',
    url: 'https://travelfunbiz.ca',
    locale: 'en_CA',
    country: 'CA',
    defaultCurrency: 'cad',
    phone: '(365) 800-6363',
    addressLines: ['375 University Avenue, Suite 1072', 'Toronto, ON M5G 2J5'],
    address: { locality: 'Toronto', region: 'ON', postalCode: 'M5G 2J5' },
    registrations: ['Florida Seller of Travel # ST42324', 'California Seller of Travel # 2154919-50'],
    legalBaseUrl: 'https://www.travelfunbiz.com',
    tagline: 'Hosted group trips, river and ocean cruises, and singles getaways with real travel advisors.',
    timeZone: 'America/Toronto',
    timeZoneLabel: 'ET',
    legalEntity: '',
    governingLaw: '',
    handle: '',
  },
  us: {
    // US company profile. Phone and street address are intentionally blank until Joel supplies
    // them; the footer and schema.org markup skip empty fields rather than show made-up data.
    id: 'us',
    name: 'TravelFunBiz.com',
    url: 'https://travelfunbiz.com',
    locale: 'en_US',
    country: 'US',
    defaultCurrency: 'usd',
    phone: '',
    addressLines: [],
    address: { locality: 'Boca Raton', region: 'FL', postalCode: '' },
    registrations: ['Florida Seller of Travel # ST42324', 'California Seller of Travel # 2154919-50'],
    legalBaseUrl: 'https://www.travelfunbiz.com',
    tagline: 'Hosted group trips, river and ocean cruises, and singles getaways with real travel advisors.',
    timeZone: 'America/New_York',
    timeZoneLabel: 'ET',
    legalEntity: '',
    governingLaw: '',
    handle: '',
  },
}

function resolveSite(): SiteProfile {
  const id: SiteId = process.env.NEXT_PUBLIC_SITE_ID === 'us' ? 'us' : 'ca'
  const base = PROFILES[id]
  return {
    ...base,
    url: (process.env.NEXT_PUBLIC_SITE_URL || base.url).replace(/\/$/, ''),
    name: process.env.NEXT_PUBLIC_SITE_NAME || base.name,
    locale: process.env.NEXT_PUBLIC_SITE_LOCALE || base.locale,
    phone: process.env.NEXT_PUBLIC_SITE_PHONE ?? base.phone,
  }
}

// The other company's live URL, once it runs this same codebase (config-driven, not a fork).
// Unset until that .com replica exists — do not point this at the current WordPress travelfunbiz.com,
// which has a different URL structure and is not a page-for-page match.
export const SIBLING_SITE_URL = (process.env.NEXT_PUBLIC_SIBLING_SITE_URL || '').replace(/\/$/, '') || null
const SIBLING_LOCALE = process.env.NEXT_PUBLIC_SITE_ID === 'us' ? 'en-CA' : 'en-US'

export const site: SiteProfile = resolveSite()

export const SITE_ID = site.id
export const SITE_URL = site.url
export const SITE_NAME = site.name
export const SITE_LOCALE = site.locale
export const DEFAULT_OG_IMAGE = `${SITE_URL}/group-of-friends-having-fun-on-tropical-beach-vaca.jpg`

export function absoluteUrl(path: string): string {
  return path.startsWith('http') ? path : `${SITE_URL}${path.startsWith('/') ? path : `/${path}`}`
}

/** "2026-09-03" + "2026-09-16" -> "Sep 3 – 16, 2026"; single date -> "Sep 3, 2026". */
export function formatDateRange(from: string | null, to: string | null): string | null {
  const parse = (s: string | null) => {
    if (!s) return null
    const d = new Date(`${s}T00:00:00`)
    return Number.isNaN(d.getTime()) ? null : d
  }
  const a = parse(from), b = parse(to)
  if (!a && !b) return null
  const fmt = (d: Date, opts: Intl.DateTimeFormatOptions) => d.toLocaleDateString('en-CA', opts)
  if (a && b) {
    if (a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth()) {
      return `${fmt(a, { month: 'short', day: 'numeric' })} – ${b.getDate()}, ${b.getFullYear()}`
    }
    if (a.getFullYear() === b.getFullYear()) {
      return `${fmt(a, { month: 'short', day: 'numeric' })} – ${fmt(b, { month: 'short', day: 'numeric' })}, ${b.getFullYear()}`
    }
    return `${fmt(a, { month: 'short', day: 'numeric', year: 'numeric' })} – ${fmt(b, { month: 'short', day: 'numeric', year: 'numeric' })}`
  }
  return fmt((a || b) as Date, { month: 'short', day: 'numeric', year: 'numeric' })
}

/**
 * hreflang alternates for a path shared by both sites (same slug on each). Returns null until
 * NEXT_PUBLIC_SIBLING_SITE_URL is set, so we never tell Google about a counterpart page that
 * doesn't exist yet. Once the .com replica is live, set that env var on both deployments.
 */
export function hreflangAlternates(path: string): Record<string, string> | undefined {
  if (!SIBLING_SITE_URL) return undefined
  const here = SITE_LOCALE.startsWith('en_CA') || SITE_ID === 'ca' ? 'en-CA' : 'en-US'
  const clean = path.startsWith('/') ? path : `/${path}`
  return {
    [here]: absoluteUrl(clean),
    [SIBLING_LOCALE]: `${SIBLING_SITE_URL}${clean}`,
    'x-default': absoluteUrl(clean),
  }
}
