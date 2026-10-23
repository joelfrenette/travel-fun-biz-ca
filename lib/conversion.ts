// Conversion loop (visit -> lead): pure helpers, no imports, so scripts/check-conversion-loop.ts can prove them offline.
// Nothing here invents a number, a price, a deadline or a promise about how fast we reply. Copy is built only from a
// stored subject (destination, trip, keyword) and the site phone.

/** Where a page sits in the funnel. Used to label leads and visits by page type. */
export type PageType = 'guide' | 'blog' | 'compare' | 'best-time' | 'from-city' | 'trip' | 'home' | 'other'

export const PAGE_TYPE_LABELS: Record<PageType, string> = {
  guide: 'Guide pages',
  blog: 'Blog posts',
  compare: 'Compare pages',
  'best-time': 'Best-time pages',
  'from-city': 'From-city pages',
  trip: 'Trip pages',
  home: 'Home page',
  other: 'Other pages',
}

const GUIDE_PREFIXES = ['destinations', 'hotels', 'resorts', 'cruise-lines', 'ships', 'river-cruises', 'yachts']

/** The page type of a path such as /blog/some-post. Query strings and hashes are ignored. */
export function pageTypeOfPath(raw: string | null | undefined): PageType {
  const path = (raw ?? '').split(/[?#]/)[0].trim().toLowerCase()
  if (path === '' || path === '/') return raw ? 'home' : 'other'
  const first = path.replace(/^\/+/, '').split('/')[0]
  if (first === 'blog') return 'blog'
  if (first === 'compare') return 'compare'
  if (first === 'best-time-to-visit') return 'best-time'
  if (first === 'from') return 'from-city'
  if (first === 'packages') return 'trip'
  if (GUIDE_PREFIXES.includes(first)) return 'guide'
  return 'other'
}

// ---- Context-aware call to action -------------------------------------------------------------------------------

export const CTA_BLOCK_IDS = ['after_quick_answer', 'end_of_page'] as const
export type CtaBlockId = (typeof CTA_BLOCK_IDS)[number]

// En and em dash, built from char codes so this file itself stays free of them.
const LONG_DASHES = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`, 'g')

/** The generic subject used when a page has no usable stored subject (news, very long titles). */
export const GENERIC_SUBJECT = 'your next trip'

/** A subject safe to put in a heading: single spaces, no dashes that read as em dashes, short. Empty or too long gives the generic one. */
export function cleanSubject(raw: string | null | undefined, max = 48): string {
  const s = (raw ?? '')
    .replace(LONG_DASHES, '-')
    .replace(/\s+/g, ' ')
    .replace(/[?!]+$/g, '')
    .trim()
  if (!s || s.length > max) return GENERIC_SUBJECT
  return s
}

export interface ContextCtaCopy {
  heading: string
  body: string
  /** Says what happens after the visitor acts. Makes no promise about how fast. */
  nextStep: string
  /** What the one primary button does. Call or text when a number exists, otherwise the enquiry. */
  primary: 'call' | 'enquiry'
  primaryLabel: string
  secondaryLabel: string | null
}

export function contextCtaCopy(input: { subject?: string | null; phone?: string | null }): ContextCtaCopy {
  const subject = cleanSubject(input.subject)
  const phone = (input.phone ?? '').trim()
  const heading = `Planning ${subject}? Talk to a travel advisor.`
  if (phone) {
    return {
      heading,
      body: 'Call or text our AI agent, or send a short enquiry. Your name and email is all we need.',
      nextStep: 'Your enquiry goes to a travel advisor, who replies by email.',
      primary: 'call',
      primaryLabel: `Call or text ${phone}`,
      secondaryLabel: 'Or send an enquiry',
    }
  }
  return {
    heading,
    body: 'Send a short enquiry. Your name and email is all we need.',
    nextStep: 'Your enquiry goes to a travel advisor, who replies by email.',
    primary: 'enquiry',
    primaryLabel: 'Send an enquiry',
    secondaryLabel: null,
  }
}

/** Splits rendered article HTML right after the Quick answer paragraph. No Quick answer: the whole article is the first part. */
export function splitAfterQuickAnswer(html: string): [string, string] {
  const at = html.indexOf('class="quick-answer"')
  if (at < 0) return [html, '']
  const close = html.indexOf('</p>', at)
  if (close < 0) return [html, '']
  const cut = close + '</p>'.length
  return [html.slice(0, cut), html.slice(cut)]
}

// ---- Pre-fill ---------------------------------------------------------------------------------------------------

/** What a visitor is asking about, kept short and free of control characters, for the message line and the URL. */
export function cleanTopic(raw: string | null | undefined, max = 80): string {
  return (raw ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(LONG_DASHES, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

/** Enquiry link: the contact form with the trip pre-chosen and, when known, what the visitor was reading about. The query goes BEFORE the hash. */
export function enquiryHrefWithContext(packageName?: string | null, topic?: string | null): string {
  const pkg = (packageName ?? '').replace(/\s+/g, ' ').trim() || 'Custom Package'
  const about = cleanTopic(topic)
  const q = `package=${encodeURIComponent(pkg)}${about ? `&about=${encodeURIComponent(about)}` : ''}`
  return `/?${q}#contact`
}

/** The first line of the message when a visitor arrives from a page about something. Empty when nothing is known. */
export function aboutLine(topic: string | null | undefined): string {
  const about = cleanTopic(topic)
  return about ? `I am interested in: ${about}.` : ''
}

/** The message to send: the context line first, then whatever the visitor typed. */
export function messageWithContext(topic: string | null | undefined, typed: string | null | undefined): string {
  const line = aboutLine(topic)
  const own = (typed ?? '').trim()
  if (line && own) return `${line} ${own}`
  return line || own
}

// ---- Events (only fired where consent-gated gtag exists, see lib/analytics-client.ts) ----------------------------

export const CONVERSION_EVENTS = ['cta_view', 'cta_click', 'form_start', 'form_submit', 'thank_you_view'] as const
export type ConversionEvent = (typeof CONVERSION_EVENTS)[number]

// ---- Funnel by page type (admin) --------------------------------------------------------------------------------

export interface PageTypeFunnelRow {
  type: PageType
  label: string
  /** Visits that landed on this page type. null = visits are not being recorded, never zero. */
  visits: number | null
  /** Real (non-test) leads whose form was on this page type. */
  leads: number
  /** Leads per 100 visits, one decimal. null when visits are not measured or are zero. */
  per100: number | null
}

/** Counts landing paths and lead page paths by page type. visitPaths = null means visits are not measured at all. */
export function funnelByPageType(visitPaths: (string | null)[] | null, leadPaths: (string | null)[]): PageTypeFunnelRow[] {
  const visits = new Map<PageType, number>()
  const leads = new Map<PageType, number>()
  for (const p of visitPaths ?? []) {
    const t = pageTypeOfPath(p)
    visits.set(t, (visits.get(t) ?? 0) + 1)
  }
  for (const p of leadPaths) {
    const t = pageTypeOfPath(p)
    leads.set(t, (leads.get(t) ?? 0) + 1)
  }
  const types = (Object.keys(PAGE_TYPE_LABELS) as PageType[]).filter((t) => visits.has(t) || leads.has(t))
  return types
    .map((type) => {
      const v = visitPaths === null ? null : (visits.get(type) ?? 0)
      const l = leads.get(type) ?? 0
      return { type, label: PAGE_TYPE_LABELS[type], visits: v, leads: l, per100: v && v > 0 ? Math.round((l / v) * 1000) / 10 : null }
    })
    .sort((a, b) => b.leads - a.leads || (b.visits ?? 0) - (a.visits ?? 0))
}
