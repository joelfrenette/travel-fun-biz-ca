import { SITE_URL } from '@/lib/site'

// Growth loop WP20, travel news auto-poster: THE ALLOWLIST. Nothing is ever fetched that is not listed here, and
// only `enabled` sources are fetched. A feed URL is a fixed constant in code: it is never read from a database row,
// a setting, or a feed item, so a poisoned feed cannot send the fetcher somewhere else.
//
// Tier 1 = an official government feed (hurricanes, travel advisories). Tier 2 = a trade outlet's public RSS.
// Only the feed's own item fields are used (title, link, date, short description). Article pages are NEVER fetched.
//
// `confidence` is an honest note about how sure the author is that the URL exists and is a public feed:
//   documented  the publisher documents this exact feed on a public page (see `docs`)
//   convention  a WordPress-style /feed/ path; very likely, but not documented by the publisher
//   unverified  recalled from memory; MUST be opened once by a person before `enabled` is switched on
// No feed was fetched while this file was written (development is offline), so even "documented" means documented,
// not tested. A source that fails 3 times in a row raises a Needs attention item with plain steps.

export type NewsTier = 1 | 2

export type NewsCategory = 'storm' | 'disaster' | 'advisory' | 'entry' | 'disruption' | 'health' | 'legislation' | 'unrest' | 'industry'

export interface NewsSource {
  key: string
  /** The name shown to readers in "Reported by". */
  name: string
  feedUrl: string
  tier: NewsTier
  defaultCategory: NewsCategory
  /** Hosts an item link may point to (the host itself or any subdomain). An item linking anywhere else is dropped. */
  linkHosts: string[]
  enabled: boolean
  confidence: 'documented' | 'convention' | 'unverified'
  docs: string
}

export const NEWS_SOURCES: readonly NewsSource[] = [
  {
    key: 'nhc-atlantic',
    name: 'the US National Hurricane Center',
    feedUrl: 'https://www.nhc.noaa.gov/index-at.xml',
    tier: 1,
    defaultCategory: 'storm',
    linkHosts: ['nhc.noaa.gov'],
    enabled: true,
    confidence: 'documented',
    docs: 'https://www.nhc.noaa.gov/aboutrss.shtml (Atlantic basin RSS)',
  },
  {
    key: 'nhc-pacific',
    name: 'the US National Hurricane Center',
    feedUrl: 'https://www.nhc.noaa.gov/index-ep.xml',
    tier: 1,
    defaultCategory: 'storm',
    linkHosts: ['nhc.noaa.gov'],
    enabled: true,
    confidence: 'documented',
    docs: 'https://www.nhc.noaa.gov/aboutrss.shtml (Eastern North Pacific basin RSS)',
  },
  {
    key: 'us-state-dept',
    name: 'the US Department of State',
    feedUrl: 'https://travel.state.gov/_res/rss/TAsTWs.xml',
    tier: 1,
    defaultCategory: 'advisory',
    linkHosts: ['travel.state.gov'],
    enabled: true,
    confidence: 'documented',
    docs: 'https://travel.state.gov (RSS page lists Travel Advisories and Alerts)',
  },
  {
    key: 'uk-fcdo',
    name: 'the UK Foreign, Commonwealth and Development Office',
    feedUrl: 'https://www.gov.uk/foreign-travel-advice.atom',
    tier: 1,
    defaultCategory: 'advisory',
    linkHosts: ['gov.uk'],
    enabled: true,
    confidence: 'documented',
    docs: 'https://www.gov.uk/foreign-travel-advice (every GOV.UK finder offers an Atom feed)',
  },
  {
    key: 'gac-advisories',
    name: 'the Government of Canada',
    feedUrl: 'https://travel.gc.ca/travelling/advisories/rss',
    tier: 1,
    defaultCategory: 'advisory',
    linkHosts: ['travel.gc.ca'],
    enabled: false,
    confidence: 'unverified',
    docs: 'Open travel.gc.ca, find the RSS or "get updates" link for travel advisories, confirm the exact URL, fix feedUrl here, then set enabled to true.',
  },
  {
    key: 'skift',
    name: 'Skift',
    feedUrl: 'https://skift.com/feed/',
    tier: 2,
    defaultCategory: 'industry',
    linkHosts: ['skift.com'],
    enabled: false,
    confidence: 'convention',
    docs: 'WordPress /feed/ convention. Open it in a browser once; if it shows items, set enabled to true.',
  },
  {
    key: 'cruise-industry-news',
    name: 'Cruise Industry News',
    feedUrl: 'https://www.cruiseindustrynews.com/feed/',
    tier: 2,
    defaultCategory: 'industry',
    linkHosts: ['cruiseindustrynews.com'],
    enabled: false,
    confidence: 'unverified',
    docs: 'Open the publisher RSS page, confirm the exact feed URL, fix feedUrl here, then set enabled to true.',
  },
  {
    key: 'cruise-hive',
    name: 'Cruise Hive',
    feedUrl: 'https://www.cruisehive.com/feed',
    tier: 2,
    defaultCategory: 'industry',
    linkHosts: ['cruisehive.com'],
    enabled: false,
    confidence: 'convention',
    docs: 'WordPress /feed convention. Open it in a browser once; if it shows items, set enabled to true.',
  },
]

/** What the fetcher says about itself. A plain description plus a way to reach us. */
export const NEWS_USER_AGENT = `TravelFunBizNewsReader/1.0 (+${SITE_URL}; reads public RSS and Atom feeds only; contact via the site)`
/** The word in robots.txt that names us. */
export const NEWS_ROBOTS_TOKEN = 'travelfunbiznewsreader'

export const FETCH_TIMEOUT_MS = 10_000
export const MAX_FEED_BYTES = 1_000_000
export const MAX_ROBOTS_BYTES = 100_000
/** A source is fetched at most once in this long. */
export const MIN_FETCH_INTERVAL_MS = 30 * 60_000
export const MAX_REDIRECTS = 2
export const MAX_ITEMS_PER_FEED = 40
export const SUMMARY_MAX_CHARS = 600
export const TITLE_MAX_CHARS = 200
/** Items older than this are not stored, and stored items older than this are expired. */
export const NEWS_MAX_AGE_DAYS = 7

export const enabledSources = (): NewsSource[] => NEWS_SOURCES.filter((s) => s.enabled)
export const sourceByKey = (key: string): NewsSource | undefined => NEWS_SOURCES.find((s) => s.key === key)

/** True only for the exact feed URL of an ENABLED source, over https. Anything else is never fetched. */
export function isAllowedFeedUrl(url: string): boolean {
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:' || u.username || u.password) return false
    return enabledSources().some((s) => s.feedUrl === u.toString() || s.feedUrl === url)
  } catch {
    return false
  }
}

const hostMatches = (host: string, allowed: string) => host === allowed || host.endsWith(`.${allowed}`)

/** True when `link` is an https address on one of the source's own hosts. */
export function linkAllowedFor(source: NewsSource, link: string): boolean {
  try {
    const u = new URL(link)
    if (u.protocol !== 'https:' || u.username || u.password) return false
    const host = u.hostname.toLowerCase()
    return source.linkHosts.some((h) => hostMatches(host, h))
  } catch {
    return false
  }
}

/** True when a redirect target stays on the source's feed host or one of its link hosts, over https. */
export function redirectAllowedFor(source: NewsSource, target: string): boolean {
  try {
    const u = new URL(target)
    if (u.protocol !== 'https:') return false
    const host = u.hostname.toLowerCase()
    return host === new URL(source.feedUrl).hostname.toLowerCase() || source.linkHosts.some((h) => hostMatches(host, h))
  } catch {
    return false
  }
}
