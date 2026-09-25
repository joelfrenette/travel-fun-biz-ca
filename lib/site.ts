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
