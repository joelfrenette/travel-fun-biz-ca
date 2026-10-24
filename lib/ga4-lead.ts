// GA4 lead measurement: pure helpers, no imports, so they run in the browser, on the server and in scripts/check-ga4-lead.ts.
//
// Three jobs:
//   1. read the GA4 client id out of the _ga cookie (only ever called after the visitor accepted analytics)
//   2. decide which GA4 event a click is, and which params may go with it (no personal data, ever)
//   3. build the server-side Measurement Protocol request for a saved lead (lib/ga4-mp.ts sends it)

/** A GA4 client id: two numbers joined by a dot ("1234567890.1712345678"). */
export const GA_CLIENT_ID_RE = /^[0-9]{5,12}\.[0-9]{5,12}$/

/** True when the value is a well-formed GA4 client id. */
export function isGaClientId(v: unknown): v is string {
  return typeof v === 'string' && GA_CLIENT_ID_RE.test(v)
}

/**
 * The client id from a cookie string ("a=b; _ga=GA1.1.123456789.1712345678; c=d") or a bare _ga value.
 * It is the LAST TWO numeric parts of the _ga value ("GA1.2.123456789.1712345678" gives "123456789.1712345678").
 * Anything that does not validate gives null.
 */
export function gaClientIdFromCookie(cookies: string | null | undefined): string | null {
  const text = (cookies ?? '').trim()
  if (!text) return null
  let value = text
  const m = text.match(/(?:^|;\s*)_ga=([^;\s]*)/)
  if (m) value = m[1]
  else if (text.includes('=')) return null // a cookie string with no _ga in it
  try {
    value = decodeURIComponent(value)
  } catch {
    /* use it as it is */
  }
  const parts = value.split('.')
  if (parts.length < 4 || !/^GA\d+$/.test(parts[0])) return null
  const id = `${parts[parts.length - 2]}.${parts[parts.length - 1]}`
  return isGaClientId(id) ? id : null
}

/** The consent gate for the client id: nothing is read from the cookie unless the visitor accepted analytics. */
export function gaClientIdIfConsented(analyticsConsented: boolean, cookies: string | null | undefined): string | null {
  if (!analyticsConsented) return null
  return gaClientIdFromCookie(cookies)
}

// ---- Event names and params ----------------------------------------------------------------------------------------

export const GA4_EVENT_NAMES = ['generate_lead', 'click_to_call', 'click_to_text', 'book_call_click', 'affiliate_click'] as const
export type Ga4EventName = (typeof GA4_EVENT_NAMES)[number]

/** The ONLY params an event may carry. Nothing else is ever sent: no name, email, phone number, message or full URL. */
export const GA4_PARAM_WHITELIST = ['trip_name', 'source', 'intent', 'page_path', 'method', 'affiliate_slug'] as const

const EMAIL_LIKE = /[^\s@]+@[^\s@]+\.[^\s@]+/
const PHONE_LIKE = /(?:\+?\d[\d\s().-]{7,}\d)/

/** Keeps whitelisted params only, as short strings; a value that looks like an email or a phone number is dropped. */
export function sanitizeEventParams(params: Record<string, unknown> | null | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!params) return out
  for (const key of GA4_PARAM_WHITELIST) {
    const raw = params[key]
    if (typeof raw !== 'string') continue
    const v = raw.trim().slice(0, 100)
    // Paths and slugs can hold dates or numbers that look like a phone number; they are checked for an email only.
    const isPathLike = key === 'page_path' || key === 'affiliate_slug'
    if (!v || EMAIL_LIKE.test(v) || (!isPathLike && PHONE_LIKE.test(v))) continue
    out[key] = v
  }
  return out
}

export interface Ga4Context {
  /** The visitor accepted analytics. */
  consent: boolean
  /** NEXT_PUBLIC_GA_ID (G-XXXXXXXXXX). Missing: nothing fires. */
  gaId: string | null | undefined
}

/** The event to send, or null when consent is missing, the GA id is missing, or the name is not one of ours. */
export function buildGa4Event(name: string, params: Record<string, unknown> | undefined, ctx: Ga4Context): { name: Ga4EventName; params: Record<string, string> } | null {
  if (!ctx.consent) return null
  if (!ctx.gaId || !/^G-[A-Z0-9]{4,20}$/i.test(ctx.gaId)) return null
  if (!(GA4_EVENT_NAMES as readonly string[]).includes(name)) return null
  return { name: name as Ga4EventName, params: sanitizeEventParams(params) }
}

/** The GA4 event a clicked link stands for, with its safe params. A tel: or sms: number is never copied into the params. */
export function classifyLinkClick(href: string | null | undefined, pagePath?: string, siteHost?: string): { name: Ga4EventName; params: Record<string, string> } | null {
  const h = (href ?? '').trim()
  if (!h) return null
  const lower = h.toLowerCase()
  const page = pagePath ? { page_path: pagePath } : {}
  if (lower.startsWith('tel:')) return { name: 'click_to_call', params: sanitizeEventParams({ ...page, method: 'tel_link' }) }
  if (lower.startsWith('sms:')) return { name: 'click_to_text', params: sanitizeEventParams({ ...page, method: 'sms_link' }) }
  // Affiliate redirect: /go/<slug> on this site, relative or absolute. Only the slug travels.
  // An absolute link counts only when it points at this site (siteHost); other hosts are not our redirect.
  const go = h.match(/^(?:https?:\/\/([^/]+))?\/go\/([a-z0-9][a-z0-9-]{0,80})(?:[/?#]|$)/i)
  if (go && go[1] && (!siteHost || go[1].toLowerCase() !== siteHost.toLowerCase())) return null
  if (go) return { name: 'affiliate_click', params: sanitizeEventParams({ ...page, affiliate_slug: go[2].toLowerCase(), method: 'go_link' }) }
  return null
}

/** Params for generate_lead: trip name, where the visitor came from, and what they asked for. Value-less on purpose. */
export function leadEventParams(input: { tripName?: string | null; source?: string | null; intent?: string | null; pagePath?: string | null; method?: string | null }): Record<string, string> {
  return sanitizeEventParams({
    trip_name: input.tripName ?? undefined,
    source: input.source || 'direct',
    intent: input.intent || 'info',
    page_path: input.pagePath ?? undefined,
    method: input.method ?? undefined,
  })
}

// ---- Server-side Measurement Protocol ------------------------------------------------------------------------------

export interface MpInput {
  measurementId: string | null | undefined
  apiSecret: string | null | undefined
  clientId: string | null | undefined
  isTest?: boolean
  tripName?: string | null
  source?: string | null
  intent?: string | null
}

export interface MpRequest {
  url: string
  body: { client_id: string; events: { name: 'generate_lead'; params: Record<string, string | number> }[] }
}

/**
 * The Measurement Protocol request for one saved lead, or null (nothing to send) when the secret, the measurement id or a
 * valid client id is missing, or the lead is a test. The body carries the client id (an anonymous GA visitor id) and
 * whitelisted params only; no name, email, phone or message.
 */
export function buildMeasurementProtocolRequest(i: MpInput): MpRequest | null {
  if (i.isTest) return null
  const secret = (i.apiSecret ?? '').trim()
  const mid = (i.measurementId ?? '').trim()
  if (!secret || !/^G-[A-Z0-9]{4,20}$/i.test(mid)) return null
  if (!isGaClientId(i.clientId)) return null
  const params = leadEventParams({ tripName: i.tripName, source: i.source, intent: i.intent, method: 'server_lead' })
  return {
    url: `https://www.google-analytics.com/mp/collect?measurement_id=${encodeURIComponent(mid)}&api_secret=${encodeURIComponent(secret)}`,
    body: { client_id: i.clientId, events: [{ name: 'generate_lead', params: { ...params, engagement_time_msec: 1 } }] },
  }
}
