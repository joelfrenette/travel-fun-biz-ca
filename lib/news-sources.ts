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
  /** 'feed' (default) = RSS or Atom. 'json' = the Canadian advisory snapshot, read by parseAdvisoryJson. */
  kind?: 'feed' | 'json'
  /** The name shown to readers in "Reported by". */
  name: string
  feedUrl: string
  tier: NewsTier
  defaultCategory: NewsCategory
  /** Hosts an item link may point to (the host itself or any subdomain). An item linking anywhere else is dropped. */
  linkHosts: string[]
  enabled: boolean
  confidence: 'verified' | 'documented' | 'convention' | 'unverified'
  docs: string
  /** A feed that is a snapshot of EVERY country can be bigger than MAX_FEED_BYTES. Its own size cap (bytes), used for both the
   * download and the parse. Omit for the normal cap. */
  maxBytes?: number
  /** A snapshot feed lists more entries than MAX_ITEMS_PER_FEED: read up to this many, newest first. Omit for the normal cap. */
  maxItems?: number
  /** Natural-hazard feed (GDACS, USGS). Such an item is a NEWS BRIEF only: it is never a travel advisory level change, it never
   * touches the country advisory pages, it can NEVER be enrolled for social posting (lib/news-distribution.ts refuses it), it goes
   * stale after NEWS_FAST_MAX_AGE_HOURS like a storm, and it goes through the same brief gate as every tier 1 notice. */
  hazard?: boolean
  /** Hazard feeds only: the most new items one read may store (a burst of events cannot flood the table). Omit for MAX_NEW_PER_SOURCE. */
  maxNew?: number
  /** Hazard feeds only: GDACS event types kept (the feed's own gdacs:eventtype code), and the alert levels kept (gdacs:alertlevel).
   * Applied at read time by hazardAdmits (lib/news-relevance.ts). */
  hazardEventTypes?: readonly string[]
  hazardAlertLevels?: readonly string[]
  /** The publisher asks bots to visit only inside this window, in minutes after 00:00 UTC [from, to). The feed is not fetched outside
   * it (lib/news-sources.ts inVisitWindow). Omit for no window. */
  visitWindowUtc?: readonly [number, number]
  /** Item links arrive as http:// but the same address answers over https (a 302 to https). Link hosts listed here are upgraded to
   * https when the feed is parsed; nothing else is ever upgraded. */
  upgradeHttpLinks?: boolean
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
    // The State Department's own Travel Advisories API host (an Atom document of all ~218 advisories, about 600 KB, checked 2026-11-01).
    // The old feed on travel.state.gov answered HTTP 403 to our robots.txt request from production, so it was never read. This host's
    // robots.txt is a 404 (no rules), and the robots check below still runs for it like for every source. The ITEM links stay on
    // travel.state.gov, which is why linkHosts is unchanged.
    feedUrl: 'https://cadataapi.state.gov/api/XMLTravelAdvisories',
    tier: 1,
    defaultCategory: 'advisory',
    linkHosts: ['travel.state.gov'],
    enabled: true,
    confidence: 'verified',
    docs: 'https://cadataapi.state.gov/ (the State Department Travel Advisories API page; /api/XMLTravelAdvisories is the Atom feed). Checked with a plain fetch on 2026-11-01: valid Atom, 218 entries, robots.txt 404.',
    maxBytes: 3_000_000,
    maxItems: 400,
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
  // Canada's advisories are a JSON open-data snapshot of ALL countries (not RSS), read by the defensive JSON reader in
  // lib/news-feed.ts (parseAdvisoryJson). Only countries whose advisory text or date CHANGED since the saved state become items.
  {
    key: 'gac-advisories',
    name: 'the Government of Canada',
    kind: 'json',
    feedUrl: 'https://data.international.gc.ca/travel-voyage/index-alpha-eng.json',
    tier: 1,
    defaultCategory: 'advisory',
    linkHosts: ['travel.gc.ca'],
    enabled: true,
    confidence: 'documented',
    docs: 'Government of Canada open data, travel advisories (data.international.gc.ca/travel-voyage). Read only after the offline JSON checks (scripts/check-news-json.ts); an unknown shape is skipped with a Needs attention note.',
  },
  // Natural-hazard feeds (added 2026-11-01). NEWS ONLY: see NewsSource.hazard. Both switch off without a deploy through the
  // news_sources_off setting (the admin News screen toggles it per key). Format, robots and terms were checked by hand on 2026-11-01.
  {
    key: 'gdacs-alerts',
    name: 'the Global Disaster Alert and Coordination System (GDACS)',
    // RSS 2.0 of every GDACS event of the last 24 hours (about 120 items, 360 KB; the 7 day feed is 1.4 MB). The "gdacs:" namespace
    // adds eventtype (EQ, TC, FL, VO, WF, DR), alertlevel (Green, Orange, Red) and a population estimate. Only Orange and Red events of
    // type EQ, TC, FL, VO and WF are kept: a Green event is not a travel decision, and a drought item names up to 30 countries for
    // weeks (it is left out on purpose). Tropical cyclones of the Pacific and Indian Ocean arrive here as type TC (GDACS builds them
    // from the official warning centres), so this feed is also the Pacific and Indian Ocean cyclone coverage.
    feedUrl: 'https://www.gdacs.org/xml/rss_24h.xml',
    tier: 1,
    defaultCategory: 'disaster',
    linkHosts: ['gdacs.org'],
    enabled: true,
    confidence: 'verified',
    docs: 'Checked with a plain fetch on 2026-11-01: valid RSS 2.0, 117 items, feed says "copyright public domain". robots.txt: "User-agent: *" with an empty Disallow, plus a non-standard "Request-rate: 1/60" and "Visit-time: 0400-0645" (UTC); we read at most once in 30 minutes and ONLY inside 04:00 to 06:45 UTC. Terms (gdacs.org/About/termofuse.aspx) forbid nothing and say the notifications are automatic, "as is", and not a substitute for official alerts: we quote the headline, the feed description and the link, nothing else. Item links are http:// and answer 302 to https.',
    maxBytes: 1_500_000,
    maxItems: 150,
    hazard: true,
    maxNew: 3,
    hazardEventTypes: ['EQ', 'TC', 'FL', 'VO', 'WF'],
    hazardAlertLevels: ['orange', 'red'],
    visitWindowUtc: [4 * 60, 6 * 60 + 45],
    upgradeHttpLinks: true,
  },
  {
    key: 'usgs-quakes',
    name: 'the US Geological Survey',
    // Atom feed of USGS "significant" earthquakes of the past day (USGS decides which are significant). Empty most days: a feed with
    // no <entry> is a valid answer, not an error (parseFeed). The past-week feed is not used: an old event updated by a reviewer would
    // look new again, and a day is all a 36 hour brief can use.
    feedUrl: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/significant_day.atom',
    tier: 1,
    defaultCategory: 'disaster',
    linkHosts: ['earthquake.usgs.gov', 'usgs.gov'],
    enabled: true,
    confidence: 'verified',
    docs: 'Checked with a plain fetch on 2026-11-01: valid Atom (the day feed was empty, the week feed had 1 entry, the month feed 17). robots.txt is a 404 (no rules). USGS-authored information is in the US public domain (usgs.gov/information-policies-and-instructions/copyrights-and-credits). Feeds update every minute; we read at most once in 30 minutes.',
    maxBytes: 200_000,
    maxItems: 20,
    hazard: true,
    maxNew: 3,
  },
  {
    key: 'skift',
    name: 'Skift',
    feedUrl: 'https://skift.com/feed/',
    tier: 2,
    defaultCategory: 'industry',
    linkHosts: ['skift.com'],
    enabled: true,
    confidence: 'verified',
    docs: 'Checked with a plain fetch on 2026-10-17: valid RSS, 10 items.',
  },
  {
    key: 'cruise-industry-news',
    name: 'Cruise Industry News',
    feedUrl: 'https://www.cruiseindustrynews.com/feed/',
    tier: 2,
    defaultCategory: 'industry',
    linkHosts: ['cruiseindustrynews.com'],
    enabled: true,
    confidence: 'verified',
    docs: 'Checked with a plain fetch on 2026-10-17: valid RSS, 15 items.',
  },
  {
    key: 'cruise-hive',
    name: 'Cruise Hive',
    feedUrl: 'https://www.cruisehive.com/feed',
    tier: 2,
    defaultCategory: 'industry',
    linkHosts: ['cruisehive.com'],
    enabled: true,
    confidence: 'verified',
    docs: 'Checked with a plain fetch on 2026-10-17: valid RSS, 9 items.',
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
/** Storms and breaking official notices go stale fast: past this many hours they are not stored, expired, and never published. */
export const NEWS_FAST_MAX_AGE_HOURS = 36

/** How old an item may be before it is no longer news: 36 hours for a storm, a breaking notice or any natural-hazard feed item
 * (pass `sourceKey`), 7 days for the rest. */
export function maxAgeMs(category: string, breaking: boolean, sourceKey?: string): number {
  const fast = category === 'storm' || breaking || (!!sourceKey && !!sourceByKey(sourceKey)?.hazard)
  return fast ? NEWS_FAST_MAX_AGE_HOURS * 3_600_000 : NEWS_MAX_AGE_DAYS * 86_400_000
}

/** True when the source is a natural-hazard feed: its items are news briefs only and are never enrolled for social posting. */
export const isHazardSource = (key: string | null | undefined): boolean => !!key && !!sourceByKey(key)?.hazard

/** True when `nowMs` is inside the source's visit window (UTC), or the source has none. Pure. */
export function inVisitWindow(source: Pick<NewsSource, 'visitWindowUtc'>, nowMs: number): boolean {
  if (!source.visitWindowUtc) return true
  const d = new Date(nowMs)
  const minute = d.getUTCHours() * 60 + d.getUTCMinutes()
  const [from, to] = source.visitWindowUtc
  return minute >= from && minute < to
}

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

// Pure values shared with the admin News screen (a client component). Kept here so that screen never imports server-only
// code (node:crypto, supabase) through news-feed or news-ingest.
export const FEED_FAIL_LIMIT = 3

/** Pure: "a, b ,c" -> Set(a, b, c), lower-cased, junk ignored. */
export function parseSourcesOff(value: string | null | undefined): Set<string> {
  return new Set(
    String(value ?? '')
      .split(',')
      .map((k) => k.trim().toLowerCase())
      .filter((k) => /^[a-z0-9-]{2,40}$/.test(k)),
  )
}
