// Ported from Nomad Escape Plan's lib/traffic-source.ts (Factory Phase 3: tracking foundation),
// trimmed to the pure classifier only. Nomad's file also owns first-party cookies (nep_src,
// nep_lt) that remember a visitor's first/last touch client-side - that part is NOT ported here:
// writing tracking cookies needs a consent banner in front of it, and the actual consent-notice
// wording is Joel's decision to supply (Decision 8, still outstanding - see GAP-REPORT.md/
// ADOPTION-LOG.md). Shipping the cookie-writing route before that wording exists would be one
// wire-up away from tracking a real visitor with no compliant notice in front of it. This file is
// the safe, code-only half: classification is just string matching, and nothing here writes
// anything to a visitor's browser or the database yet.
//
// "MODULAR: nothing site-specific" per Nomad's own comment - copied unchanged where it's pure.
export type Channel = 'search' | 'paid_search' | 'social' | 'paid_social' | 'email' | 'referral' | 'bio' | 'direct' | 'other'

export const CHANNELS: readonly Channel[] = ['search', 'paid_search', 'social', 'paid_social', 'email', 'referral', 'bio', 'direct', 'other']

const SEARCH_HOSTS: [RegExp, string][] = [
  [/(^|\.)google\.[a-z.]+$/, 'google'],
  [/(^|\.)bing\.com$/, 'bing'],
  [/(^|\.)yahoo\.[a-z.]+$/, 'yahoo'],
  [/(^|\.)duckduckgo\.com$/, 'duckduckgo'],
  [/(^|\.)ecosia\.org$/, 'ecosia'],
  [/(^|\.)search\.brave\.com$/, 'brave'],
  [/(^|\.)yandex\.[a-z.]+$/, 'yandex'],
  [/(^|\.)baidu\.com$/, 'baidu'],
  [/^com\.google\.android\.googlequicksearchbox$/, 'google'],
]

const SOCIAL_HOSTS: [RegExp, string][] = [
  [/(^|\.)(facebook\.com|fb\.com|fb\.me)$/, 'facebook'],
  [/(^|\.)instagram\.com$/, 'instagram'],
  [/(^|\.)linkedin\.com$|^lnkd\.in$/, 'linkedin'],
  [/^t\.co$|(^|\.)(x\.com|twitter\.com)$/, 'x'],
  [/(^|\.)threads\.(net|com)$/, 'threads'],
  [/(^|\.)bsky\.app$/, 'bluesky'],
  [/(^|\.)pinterest\.[a-z.]+$|^pin\.it$/, 'pinterest'],
  [/(^|\.)(youtube\.com|youtu\.be)$/, 'youtube'],
  [/(^|\.)tiktok\.com$/, 'tiktok'],
  [/(^|\.)reddit\.com$/, 'reddit'],
  [/^com\.linkedin\.android$/, 'linkedin'],
  [/^com\.facebook\.(katana|lite|orca)$/, 'facebook'],
  [/^com\.instagram\.android$/, 'instagram'],
  [/^com\.instagram\.barcelona$/, 'threads'],
  [/^(com\.zhiliaoapp\.musically|com\.ss\.android\.ugc\.trill)$/, 'tiktok'],
  [/^com\.pinterest$/, 'pinterest'],
  [/^com\.google\.android\.youtube$/, 'youtube'],
  [/^com\.twitter\.android$/, 'x'],
  [/^xyz\.blueskyweb\.app$/, 'bluesky'],
  [/^com\.reddit\.frontpage$/, 'reddit'],
]

const PAID_SEARCH_MEDIUMS = /^(cpc|ppc|paid[-_ ]?search|sem)$/i
const PAID_SOCIAL_MEDIUMS = /^(paid[-_ ]?social|social[-_ ]?paid|paidsocial)$/i
const EMAIL_MEDIUMS = /^(e[-_ ]?mail([-_ ]?marketing)?|newsletter)$/i
const REFERRAL_MEDIUMS = /^(referral|ref|affiliate|ambassador)$/i
const BIO_MEDIUMS = /^(bio|link[-_ ]?in[-_ ]?bio|linkinbio)$/i
const SOCIAL_MEDIUMS = /^(social|social-media|social_media|sm|reel|story)$/i
const SEARCH_MEDIUMS = /^(organic|search)$/i

export function hostOf(url: string | null | undefined): string {
  try {
    return url ? new URL(url).hostname.toLowerCase().replace(/^www\./, '') : ''
  } catch {
    return ''
  }
}

export type ClickId = 'gclid' | 'msclkid' | 'fbclid' | ''

export function clickIdOf(params: { has(name: string): boolean }): ClickId {
  if (params.has('gclid') || params.has('gbraid') || params.has('wbraid')) return 'gclid'
  if (params.has('msclkid')) return 'msclkid'
  if (params.has('fbclid')) return 'fbclid'
  return ''
}

export function classifyVisit(input: {
  referrer?: string | null
  utmSource?: string | null
  utmMedium?: string | null
  clickId?: ClickId | string | null
  hasRef?: boolean | null
  siteHost?: string | null
}): { channel: Channel; source: string; referrerHost: string } {
  const utmSource = (input.utmSource ?? '').trim().toLowerCase().slice(0, 60)
  const medium = (input.utmMedium ?? '').trim()
  const clickId = input.clickId ?? ''
  let referrerHost = hostOf(input.referrer)
  const site = (input.siteHost ?? '').toLowerCase().replace(/^www\./, '')
  if (site && referrerHost === site) referrerHost = ''
  const out = (channel: Channel, fallback: string) => ({ channel, source: utmSource || referrerHost || fallback, referrerHost })

  if (medium) {
    if (PAID_SEARCH_MEDIUMS.test(medium)) return out('paid_search', 'paid_search')
    if (PAID_SOCIAL_MEDIUMS.test(medium)) return out('paid_social', 'paid_social')
    if (EMAIL_MEDIUMS.test(medium)) return out('email', 'email')
    if (REFERRAL_MEDIUMS.test(medium)) return out('referral', 'referral')
    if (BIO_MEDIUMS.test(medium)) return out('bio', 'bio')
    if (SOCIAL_MEDIUMS.test(medium)) return out('social', 'social')
    if (SEARCH_MEDIUMS.test(medium)) return out('search', 'search')
  }

  if (clickId === 'gclid') return { channel: 'paid_search', source: utmSource || 'google', referrerHost }
  if (clickId === 'msclkid') return { channel: 'paid_search', source: utmSource || 'bing', referrerHost }

  if (utmSource.startsWith('ref-') || input.hasRef) return out('referral', 'referral')
  if (EMAIL_MEDIUMS.test(utmSource)) return out('email', 'email')

  for (const [re, name] of SEARCH_HOSTS) if (re.test(referrerHost)) return { channel: 'search', source: name, referrerHost }
  for (const [re, name] of SOCIAL_HOSTS) if (re.test(referrerHost)) return { channel: 'social', source: name, referrerHost }
  if (clickId === 'fbclid') return { channel: 'social', source: utmSource || 'facebook', referrerHost }

  if (utmSource) return { channel: 'other', source: utmSource, referrerHost }
  if (!referrerHost) return { channel: 'direct', source: 'direct', referrerHost }
  return { channel: 'other', source: referrerHost, referrerHost }
}

export interface SourceTouch {
  channel: Channel
  source: string
  medium: string
  campaign: string
  content: string
  landing: string
  ts: number
}

/** The whole touch for a landing: classification plus the tags worth remembering. Pure - the
 * caller supplies the URL and decides what to do with the result (nothing here writes a cookie
 * or a database row). */
export function touchForLanding(input: { href: string; referrer?: string | null; siteHost?: string | null; now?: number }): SourceTouch {
  let params = new URLSearchParams()
  let path = ''
  try {
    const u = new URL(input.href)
    params = u.searchParams
    path = u.pathname
  } catch {
    /* not a full URL - classify from the referrer alone */
  }
  const { channel, source } = classifyVisit({
    referrer: input.referrer,
    utmSource: params.get('utm_source'),
    utmMedium: params.get('utm_medium'),
    clickId: clickIdOf(params),
    hasRef: !!params.get('ref')?.trim(),
    siteHost: input.siteHost,
  })
  return {
    channel,
    source,
    medium: (params.get('utm_medium') ?? '').toLowerCase(),
    campaign: params.get('utm_campaign') ?? '',
    content: params.get('utm_content') ?? '',
    landing: path,
    ts: input.now ?? Date.now(),
  }
}
