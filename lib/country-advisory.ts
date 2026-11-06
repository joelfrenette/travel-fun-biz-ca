// Travel advisories (one evergreen page per country). PURE helpers only: no database, no network, no clock except what is
// passed in. The database side is lib/country-advisory-store.ts, the social side lib/country-advisory-social.ts.
//
// Rules this file enforces (scripts/check-country-advisories.ts proves each one):
//   - Every field is optional. An empty field is left empty and not shown. Nothing is guessed, defaulted or combined.
//   - A government level is shown only as the government's own words, in quote marks, with the source named. It is never
//     turned into a score, a colour or a stronger phrase.
//   - The UK feed has no level. The UK block shows the update line, its date and the link, never a level.
//   - The US block shows the State Department's own level wording from its feed title ("Level 3: Reconsider Travel"), its lead-in
//     sentence, the date and the link. The number is never turned into a colour, a score or a comparison with another government.
//   - Two feeds are merged into one country only when both names reduce to the same slug through the explicit alias list
//     below. A name that does not match stays a separate country (and is reported, not merged).

export const ADVISORY_MODE_KEY = 'country_advisories_mode'
export type AdvisoryMode = 'off' | 'log' | 'on'

/** off (default; anything unreadable or unrecognised is off): nothing is written and no page exists. log: the ingest writes
 * the tables and no public page renders. on: pages render, are listed in the sitemap and are linked. Exact match only. */
export function parseAdvisoryMode(raw: string | null | undefined): AdvisoryMode {
  return raw === 'log' || raw === 'on' ? raw : 'off'
}

export const CA_ADVISORY_SOURCE_KEY = 'gac-advisories'
export const UK_ADVISORY_SOURCE_KEY = 'uk-fcdo'
export const US_ADVISORY_SOURCE_KEY = 'us-state-dept'
export const CA_ADVISORY_HOSTS = ['travel.gc.ca']
export const UK_ADVISORY_HOSTS = ['gov.uk']
export const US_ADVISORY_HOSTS = ['travel.state.gov']

/** The Canadian block says it could not be confirmed once the last successful read of the Canada feed is older than this. */
export const STALE_AFTER_DAYS = 3
/** A social post for a country goes out at most once in this many days. */
export const SOCIAL_MIN_GAP_DAYS = 7
export const SLUG_MAX = 60

const DAY_MS = 86_400_000
const EN_DASH = String.fromCharCode(0x2013)
const EM_DASH = String.fromCharCode(0x2014)
const DASH_RUN = new RegExp(`\\s*[${EN_DASH}${EM_DASH}]\\s*`, 'g')
const RANGE_DASH = new RegExp(`(?<=\\w)${EN_DASH}(?=\\w)`, 'g')
const COMBINING = new RegExp('[' + String.fromCharCode(0x0300) + '-' + String.fromCharCode(0x036f) + ']', 'g')
const CURLY_APOS = new RegExp('[' + String.fromCharCode(0x2018, 0x2019) + ']', 'g')

/** Plain-text clean-up of feed text: tags out, spaces collapsed, em and en dashes turned into commas or hyphens. */
export function stripDashes(text: string): string {
  return text.replace(RANGE_DASH, '-').replace(DASH_RUN, ', ')
}
export function plain(text: string | null | undefined): string {
  return stripDashes((text ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim())
}

// ---------------------------------------------------------------------------------------------------
// Country names -> slug
// ---------------------------------------------------------------------------------------------------

/** Name as a bare slug: accents off, "&" as "and", apostrophes dropped, a leading "the" dropped, "st" as "saint". No alias applied. */
export function bareSlug(name: string): string {
  let s = (name ?? '').normalize('NFKD').replace(COMBINING, '').replace(CURLY_APOS, "'").toLowerCase()
  s = s.replace(/&/g, ' and ').replace(/'/g, '')
  s = s.replace(/\bst\.?(?=\s)/g, 'saint').replace(/\bste\.?(?=\s)/g, 'sainte')
  s = s.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  s = s.replace(/^the-/, '')
  return s
}

/** Explicit, reviewed spellings that differ between the Canadian and UK feeds (or inside one). Key = bareSlug of the variant,
 * value = the one slug the page lives at. Anything NOT listed is never merged with anything else. Add a pair here only after
 * checking both feeds; the check script lists every pair. */
export const COUNTRY_ALIASES: Readonly<Record<string, string>> = {
  turkiye: 'turkey',
  'czech-republic': 'czechia',
  'cabo-verde': 'cape-verde',
  swaziland: 'eswatini',
  'cote-divoire': 'ivory-coast',
  burma: 'myanmar',
  'myanmar-burma': 'myanmar',
  'burma-myanmar': 'myanmar',
  'east-timor': 'timor-leste',
  macedonia: 'north-macedonia',
  'viet-nam': 'vietnam',
  'russian-federation': 'russia',
  'united-states-of-america': 'united-states',
  usa: 'united-states',
  uk: 'united-kingdom',
  gambia: 'gambia',
  'south-korea': 'south-korea',
  'korea-south': 'south-korea',
  'republic-of-korea': 'south-korea',
  'north-korea': 'north-korea',
  'korea-north': 'north-korea',
  'democratic-peoples-republic-of-korea': 'north-korea',
  'bosnia-herzegovina': 'bosnia-and-herzegovina',
  'democratic-republic-of-the-congo': 'democratic-republic-of-the-congo',
  'congo-democratic-republic': 'democratic-republic-of-the-congo',
  'congo-democratic-republic-of-the': 'democratic-republic-of-the-congo',
  'dr-congo': 'democratic-republic-of-the-congo',
  'democratic-republic-of-congo': 'democratic-republic-of-the-congo',
  'congo-kinshasa': 'democratic-republic-of-the-congo',
  'republic-of-the-congo': 'republic-of-the-congo',
  'congo-republic': 'republic-of-the-congo',
  'congo-republic-of-the': 'republic-of-the-congo',
  'republic-of-congo': 'republic-of-the-congo',
  'congo-brazzaville': 'republic-of-the-congo',
  'lao-peoples-democratic-republic': 'laos',
  'st-kitts-and-nevis': 'saint-kitts-and-nevis',
  'st-lucia': 'saint-lucia',
  'st-vincent-and-the-grenadines': 'saint-vincent-and-the-grenadines',
}

/** The page slug for a country name, or null when the name cannot make a safe slug. */
export function countrySlugOf(name: string): string | null {
  const bare = bareSlug(name)
  if (!bare || bare.length > SLUG_MAX) return null
  const mapped = COUNTRY_ALIASES[bare] ?? bare
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(mapped) ? mapped : null
}

export const isCountrySlug = (s: string): boolean => s.length > 0 && s.length <= SLUG_MAX && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(s)

/** Names that exist in only one of the two lists after matching (for a Needs attention note). Pure. Nothing is merged here. */
export function unmatchedNames(canada: string[], uk: string[]): { onlyCanada: string[]; onlyUk: string[]; unusable: string[] } {
  const unusable: string[] = []
  const slugs = (names: string[]) => {
    const m = new Map<string, string>()
    for (const n of names) {
      const s = countrySlugOf(n)
      if (!s) unusable.push(n)
      else if (!m.has(s)) m.set(s, n)
    }
    return m
  }
  const c = slugs(canada)
  const u = slugs(uk)
  return {
    onlyCanada: [...c.entries()].filter(([s]) => !u.has(s)).map(([, n]) => n).sort(),
    onlyUk: [...u.entries()].filter(([s]) => !c.has(s)).map(([, n]) => n).sort(),
    unusable: unusable.sort(),
  }
}

// ---------------------------------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------------------------------

export interface CountryAdvisoryRow {
  slug: string
  name: string
  iso: string | null
  guide_slug: string | null
  ca_level: string | null
  ca_text: string | null
  ca_source_url: string | null
  ca_source_published_at: string | null
  ca_checked_at: string | null
  uk_text: string | null
  uk_source_url: string | null
  uk_source_published_at: string | null
  uk_checked_at: string | null
  us_level: string | null
  us_text: string | null
  us_source_url: string | null
  us_source_published_at: string | null
  us_checked_at: string | null
  status: 'draft' | 'published'
  updated_at?: string | null
}

export type AdvisoryLogKind = 'level_change' | 'text_update'

export interface AdvisoryLogRow {
  country_slug: string
  source_key: string
  guid: string
  kind: AdvisoryLogKind
  level_from: string | null
  level_to: string | null
  text: string | null
  source_url: string | null
  source_published_at: string | null
  news_item_id?: string | null
  created_at?: string | null
}

/** The columns that exist before migration 0064. The store falls back to these while the us_ columns are missing. */
export const ADVISORY_COLUMNS_LEGACY =
  'slug, name, iso, guide_slug, ca_level, ca_text, ca_source_url, ca_source_published_at, ca_checked_at, uk_text, uk_source_url, uk_source_published_at, uk_checked_at, status, updated_at'
export const US_COLUMN_NAMES = ['us_level', 'us_text', 'us_source_url', 'us_source_published_at', 'us_checked_at'] as const
export const ADVISORY_COLUMNS = `${ADVISORY_COLUMNS_LEGACY}, ${US_COLUMN_NAMES.join(', ')}`

/** A row read before migration 0064 has every us_ field empty. */
export const withNoUs = (row: Record<string, unknown>): CountryAdvisoryRow =>
  ({ us_level: null, us_text: null, us_source_url: null, us_source_published_at: null, us_checked_at: null, ...row }) as unknown as CountryAdvisoryRow

// ---------------------------------------------------------------------------------------------------
// Cleaning feed text
// ---------------------------------------------------------------------------------------------------

/** The level wording as the feed gave it: spaces collapsed, at most 160 characters. Null when empty. Never reworded. */
export function cleanLevel(text: string | null | undefined): string | null {
  const t = plain(text)
  return t ? t.slice(0, 160) : null
}

export const sameLevel = (a: string | null | undefined, b: string | null | undefined): boolean =>
  (a ?? '').trim().replace(/\s+/g, ' ').toLowerCase() === (b ?? '').trim().replace(/\s+/g, ' ').toLowerCase()

const QUOTE_MIN = 8
const QUOTE_MAX = 220

/** ONE short sentence of the government's own text, word for word. The first sentence only; null when it is missing, too short
 * or longer than QUOTE_MAX (a long sentence is never cut, because a cut quote can say something the government did not).
 * Pass `unsafe` (looksLikeInjection) to refuse text that talks to a model. */
export function shortQuote(text: string | null | undefined, unsafe?: (t: string) => boolean): string | null {
  const t = plain(text)
  if (!t) return null
  const m = /^(.+?[.!?])(?=\s|$)/.exec(t)
  const first = (m ? m[1] : t).trim()
  if (first.length < QUOTE_MIN || first.length > QUOTE_MAX) return null
  if (unsafe && unsafe(first)) return null
  return first.replace(/"/g, "'")
}

/** True when `url` is https and its host is (a subdomain of) one of the hosts. */
export function urlOnHosts(url: string | null | undefined, hosts: readonly string[]): boolean {
  if (!url) return false
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && hosts.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`))
  } catch {
    return false
  }
}

const validIso = (v: string | null | undefined): string | null => (v && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null)
const hasData = (r: Pick<CountryAdvisoryRow, 'ca_level' | 'ca_text' | 'uk_text'> & Partial<Pick<CountryAdvisoryRow, 'us_level' | 'us_text'>>): boolean =>
  !!(r.ca_level || r.ca_text || r.uk_text || r.us_level || r.us_text)
export { hasData as rowHasData }

// ---------------------------------------------------------------------------------------------------
// Feed events -> row and log (the dual write, decided in plain code)
// ---------------------------------------------------------------------------------------------------

export interface CaEvent {
  iso: string
  name: string
  level: string
  description: string
  url: string
  publishedAt: string | null
  guid: string
  newsItemId?: string | null
}

export interface UkEvent {
  country: string
  summary: string
  url: string
  publishedAt: string | null
  guid: string
  newsItemId?: string | null
}

export type WritePlan =
  | { ok: true; row: CountryAdvisoryRow; log: AdvisoryLogRow | null; created: boolean }
  | { ok: false; reason: 'unmatched-name' | 'iso-conflict'; note: string }

const blankRow = (slug: string, name: string): CountryAdvisoryRow => ({
  slug, name, iso: null, guide_slug: null,
  ca_level: null, ca_text: null, ca_source_url: null, ca_source_published_at: null, ca_checked_at: null,
  uk_text: null, uk_source_url: null, uk_source_published_at: null, uk_checked_at: null,
  us_level: null, us_text: null, us_source_url: null, us_source_published_at: null, us_checked_at: null,
  status: 'published',
})

/** What a changed Canadian advisory writes. `prevLevel` is the level the news state held before this read (used only when the row
 * has no level yet). A country whose name makes no safe slug, or whose slug is already held by another Canadian code, is NOT
 * written: the note says why and nothing is merged or guessed. */
export function planCanadaWrite(existing: CountryAdvisoryRow | null, ev: CaEvent, prevLevel: string | null, nowIso: string, unsafe?: (t: string) => boolean): WritePlan {
  const slug = countrySlugOf(ev.name)
  if (!slug) return { ok: false, reason: 'unmatched-name', note: `Canada country name "${ev.name.slice(0, 60)}" does not make a safe page address, so it was not stored.` }
  const iso = ev.iso.trim().toLowerCase().slice(0, 40) || null
  if (existing && existing.iso && iso && existing.iso !== iso) {
    return { ok: false, reason: 'iso-conflict', note: `Canada countries "${existing.iso}" and "${iso}" both map to the page "${slug}", so the second was not stored.` }
  }
  const level = cleanLevel(ev.level)
  const quote = shortQuote(ev.description, unsafe)
  const from = existing?.ca_level || cleanLevel(prevLevel) || null
  const kind: AdvisoryLogKind = from && level && !sameLevel(from, level) ? 'level_change' : 'text_update'
  const url = urlOnHosts(ev.url, CA_ADVISORY_HOSTS) ? ev.url : null
  const base = existing ?? blankRow(slug, plain(ev.name).slice(0, 80))
  const row: CountryAdvisoryRow = {
    ...base,
    name: existing?.name || plain(ev.name).slice(0, 80),
    iso: base.iso ?? iso,
    ca_level: level,
    ca_text: quote,
    ca_source_url: url,
    ca_source_published_at: validIso(ev.publishedAt),
    ca_checked_at: nowIso,
  }
  const log: AdvisoryLogRow = {
    country_slug: slug,
    source_key: CA_ADVISORY_SOURCE_KEY,
    guid: ev.guid.slice(0, 400),
    kind,
    level_from: kind === 'level_change' ? from : null,
    level_to: level,
    text: quote,
    source_url: url,
    source_published_at: validIso(ev.publishedAt),
    news_item_id: ev.newsItemId ?? null,
  }
  return { ok: true, row, log, created: !existing }
}

/** What a UK FCDO update writes: the update line, the date, the link. There is no level to write. An update older than the one
 * already on the row is logged but does not replace the row's current line. */
export function planUkWrite(existing: CountryAdvisoryRow | null, ev: UkEvent, nowIso: string, unsafe?: (t: string) => boolean): WritePlan {
  const slug = countrySlugOf(ev.country)
  if (!slug) return { ok: false, reason: 'unmatched-name', note: `UK country name "${ev.country.slice(0, 60)}" does not make a safe page address, so it was not stored.` }
  const line = shortQuote(ev.summary, unsafe)
  const url = urlOnHosts(ev.url, UK_ADVISORY_HOSTS) ? ev.url : null
  const published = validIso(ev.publishedAt)
  const base = existing ?? blankRow(slug, plain(ev.country).slice(0, 80))
  const older = !!(existing?.uk_source_published_at && published && Date.parse(published) < Date.parse(existing.uk_source_published_at))
  const row: CountryAdvisoryRow = older
    ? base
    : { ...base, uk_text: line, uk_source_url: url, uk_source_published_at: published, uk_checked_at: nowIso }
  const log: AdvisoryLogRow = {
    country_slug: slug,
    source_key: UK_ADVISORY_SOURCE_KEY,
    guid: ev.guid.slice(0, 400),
    kind: 'text_update',
    level_from: null,
    level_to: null,
    text: line,
    source_url: url,
    source_published_at: published,
    news_item_id: ev.newsItemId ?? null,
  }
  return { ok: true, row, log, created: !existing }
}

// ---------------------------------------------------------------------------------------------------
// US Department of State
// ---------------------------------------------------------------------------------------------------

export interface UsEvent {
  /** The country as the feed titles it ("Mexico", "Burma (Myanmar)"). */
  country: string
  /** The State Department's own level wording from the feed title, for example "Level 3: Reconsider Travel". */
  level: string
  /** The description HTML or text as the feed gave it; only the lead-in sentence is ever used. */
  description: string
  url: string
  publishedAt: string | null
  guid: string
  newsItemId?: string | null
}

const US_QUOTE_MAX = 300
const US_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"' }
const decodeEntities = (t: string): string =>
  t.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m
    }
    return US_ENTITIES[e.toLowerCase()] ?? m
  })

/** The State Department's lead-in sentence, word for word: the text in front of "Read the entire Travel Advisory" (or, when that
 * marker is missing, the first paragraph). Tags are removed without adding words; only spacing around commas is tidied. Null when
 * it is missing, shorter than QUOTE_MIN, or longer than US_QUOTE_MAX (it is never cut: a cut quote can say what the government did
 * not). Pass `unsafe` (looksLikeInjection) to refuse text that talks to a model. */
export function usQuote(description: string | null | undefined, unsafe?: (t: string) => boolean): string | null {
  const html = description ?? ''
  if (!html.trim()) return null
  const marker = /Read the entire Travel Advisory/i
  const lead = marker.test(html) ? html.split(marker)[0] : html.split(/<\/p>|<ul|<h\d/i)[0]
  const text = plain(decodeEntities(lead.replace(/<\/?(?:p|br|li|ul|div|h\d)\b[^>]*>/gi, ' ').replace(/<[^>]*>/g, '')))
    .replace(/\s+([,.;:!?])/g, '$1')
    .trim()
  if (text.length < QUOTE_MIN || text.length > US_QUOTE_MAX) return null
  if (unsafe && unsafe(text)) return null
  return text.replace(/"/g, "'")
}

const US_TITLE = new RegExp(`^(.{2,80}?)\\s+[-\\u2013\\u2014]\\s+(Level\\s+[1-4]\\b.*)$`)

/** Reads the State Department travel advisories text (every entry, not only the first few). Two shapes are read: the Atom document of
 * the official API (cadataapi.state.gov /api/XMLTravelAdvisories: <entry> with a <link href>, <id>, <published> and an HTML-escaped
 * <summary>; the one the source uses) and the older RSS (<item> with <link>, <pubDate>, <description>). Entries that are not a
 * "<Country> - Level N: ..." advisory (a Travel Alert, for example) are skipped, never guessed. Pure. */
export function parseUsAdvisoryFeed(xml: string): UsEvent[] {
  const out: UsEvent[] = []
  const tag = (block: string, name: string): string => {
    const m = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i').exec(block)
    if (!m) return ''
    const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(m[1])
    return cdata ? cdata[1] : decodeEntities(m[1])
  }
  // An Atom <link> has its address in href (rel="alternate" or no rel preferred), never as text.
  const atomHref = (block: string): string => {
    const links = [...block.matchAll(/<link\b([^>]*)>/gi)].map((l) => l[1])
    const attr = (s: string, a: string) => new RegExp(`\\b${a}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(s)
    const pick = links.find((l) => !attr(l, 'rel') || (attr(l, 'rel')?.[1] ?? attr(l, 'rel')?.[2]) === 'alternate') ?? links[0]
    const h = pick ? attr(pick, 'href') : null
    return h ? decodeEntities(h[1] ?? h[2] ?? '').trim() : ''
  }
  const isAtom = /<entry\b/i.test(xml)
  const blocks = isAtom ? xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi) : xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)
  for (const m of blocks) {
    const block = m[1]
    const title = plain(decodeEntities(tag(block, 'title')).replace(new RegExp(`[${EN_DASH}${EM_DASH}]`, 'g'), '-'))
    const t = US_TITLE.exec(title)
    if (!t) continue
    const url = (isAtom ? atomHref(block) : tag(block, 'link')).trim()
    const pub = (isAtom ? tag(block, 'published').trim() || tag(block, 'updated').trim() : tag(block, 'pubDate').trim())
    // A date with a zone (GMT, UTC, Z or an offset) is read as given; a bare date is read as midnight GMT.
    const parsed = pub ? Date.parse(/GMT|UTC|Z$|[+-]\d{2}:?\d{2}$/.test(pub) ? pub : `${pub} 00:00:00 GMT`) : NaN
    const publishedAt = Number.isFinite(parsed) ? new Date(parsed).toISOString() : null
    out.push({
      country: t[1].trim(),
      level: t[2].trim(),
      description: tag(block, isAtom ? 'summary' : 'description'),
      url,
      publishedAt,
      guid: `${tag(block, isAtom ? 'id' : 'guid').trim() || url}|${publishedAt ?? ''}|${t[2].trim()}`.slice(0, 400),
    })
  }
  return out
}

/** What a State Department advisory writes. Same rules as the Canada and UK plans: an older entry than the one on the row is logged
 * but does not replace it; a level that differs from the stored one is a level_change; nothing is guessed. */
export function planUsWrite(existing: CountryAdvisoryRow | null, ev: UsEvent, nowIso: string, unsafe?: (t: string) => boolean): WritePlan {
  const slug = countrySlugOf(ev.country)
  if (!slug) return { ok: false, reason: 'unmatched-name', note: `US country name "${ev.country.slice(0, 60)}" does not make a safe page address, so it was not stored.` }
  const level = cleanLevel(ev.level)
  const quote = usQuote(ev.description, unsafe)
  const url = urlOnHosts(ev.url, US_ADVISORY_HOSTS) ? ev.url : null
  const published = validIso(ev.publishedAt)
  const from = existing?.us_level ?? null
  const kind: AdvisoryLogKind = from && level && !sameLevel(from, level) ? 'level_change' : 'text_update'
  const base = existing ?? blankRow(slug, plain(ev.country).slice(0, 80))
  const older = !!(existing?.us_source_published_at && published && Date.parse(published) < Date.parse(existing.us_source_published_at))
  const row: CountryAdvisoryRow = older
    ? base
    : { ...base, us_level: level, us_text: quote, us_source_url: url, us_source_published_at: published, us_checked_at: nowIso }
  const log: AdvisoryLogRow = {
    country_slug: slug,
    source_key: US_ADVISORY_SOURCE_KEY,
    guid: ev.guid.slice(0, 400),
    kind,
    level_from: kind === 'level_change' ? from : null,
    level_to: level,
    text: quote,
    source_url: url,
    source_published_at: published,
    news_item_id: ev.newsItemId ?? null,
  }
  return { ok: true, row, log, created: !existing }
}

export interface UsFeedPlan {
  /** Entries to write (new, changed, or the first US entry on a country that already has a page). */
  write: UsEvent[]
  /** Slugs whose stored US level and date the feed repeats, so their "last checked" moves. */
  confirmed: string[]
}

/** Decides what a full read of the US feed does. A country WITHOUT a page gets one only when its entry is newer than `maxAgeDays`
 * (so the first read does not create a page for every country in the feed); a country with a page is updated, or confirmed when the
 * feed repeats what is stored. Pure. */
export function planUsFeed(
  events: UsEvent[],
  rows: Pick<CountryAdvisoryRow, 'slug' | 'us_level' | 'us_source_published_at'>[],
  nowMs: number,
  maxAgeDays: number,
): UsFeedPlan {
  const bySlug = new Map(rows.map((r) => [r.slug, r]))
  const write: UsEvent[] = []
  const confirmed: string[] = []
  const seen = new Set<string>()
  for (const ev of events) {
    const slug = countrySlugOf(ev.country)
    if (!slug || seen.has(slug)) continue
    seen.add(slug)
    const row = bySlug.get(slug)
    const pub = validIso(ev.publishedAt)
    if (!row) {
      if (pub && nowMs - Date.parse(pub) <= maxAgeDays * DAY_MS) write.push(ev)
      continue
    }
    const same = !!row.us_level && sameLevel(row.us_level, cleanLevel(ev.level)) && (row.us_source_published_at ? Date.parse(row.us_source_published_at) : null) === (pub ? Date.parse(pub) : null)
    if (same) confirmed.push(slug)
    else write.push(ev)
  }
  return { write, confirmed }
}

// ---------------------------------------------------------------------------------------------------
// One-time backfill: every country in a full snapshot gets its row, not only the ones that changed
// ---------------------------------------------------------------------------------------------------

/** 'uk-full-backfill' is the UK list read ONCE from the GOV.UK Content API (every country, not only the 20 the Atom feed lists). */
export type BackfillSource = 'ca' | 'uk' | 'us' | 'uk-full-backfill'
export const BACKFILL_SOURCES: readonly BackfillSource[] = ['ca', 'uk', 'us', 'uk-full-backfill']
/** The attribution the Open Government Licence v3.0 asks for when no specific statement is given. Shown on every UK block. */
export const UK_OGL_ATTRIBUTION = 'Contains public sector information licensed under the Open Government Licence v3.0.'
export const UK_OGL_URL = 'https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/'
/** app_settings key of the guard: JSON {"v":1,"done":{"ca":"<iso>","uk":"<iso>","us":"<iso>"}}. A source in `done` is never backfilled again. */
export const BACKFILL_STATE_KEY = 'country_advisories_backfill'
export const backfillSourceOfKey = (sourceKey: string): BackfillSource | null =>
  sourceKey === CA_ADVISORY_SOURCE_KEY ? 'ca' : sourceKey === UK_ADVISORY_SOURCE_KEY ? 'uk' : sourceKey === US_ADVISORY_SOURCE_KEY ? 'us' : null

/** Pure. Reads the guard text; anything unreadable is "nothing done yet" (a re-run is harmless: see planBackfill). */
export function parseBackfillState(raw: string | null | undefined): Partial<Record<BackfillSource, string>> {
  try {
    const p = JSON.parse(raw ?? 'null') as { v?: number; done?: Record<string, unknown> } | null
    if (!p || p.v !== 1 || typeof p.done !== 'object' || p.done === null) return {}
    const out: Partial<Record<BackfillSource, string>> = {}
    for (const s of BACKFILL_SOURCES) if (typeof p.done[s] === 'string' && p.done[s]) out[s] = p.done[s] as string
    return out
  } catch {
    return {}
  }
}

const hasSourceData = (src: BackfillSource, r: CountryAdvisoryRow): boolean => (src === 'ca' ? !!(r.ca_level || r.ca_text) : src === 'uk' || src === 'uk-full-backfill' ? !!r.uk_text : !!(r.us_level || r.us_text))

export type BackfillInput = { source: 'ca'; events: CaEvent[] } | { source: 'uk'; events: UkEvent[] } | { source: 'uk-full-backfill'; events: UkEvent[] } | { source: 'us'; events: UsEvent[] }

export interface BackfillPlan {
  /** The full rows to save: new rows, and existing rows that had nothing yet from this source (all their other fields kept as read). */
  rows: CountryAdvisoryRow[]
  created: number
  filled: number
  /** Countries left alone: the row already has data from this source (it is never overwritten), or the entry had nothing to show. */
  skipped: number
  notes: string[]
}

/** Pure. What the one-time backfill saves for a full snapshot of one source. ADDITIVE ONLY: a row that already has data from this
 * source is left exactly as it is, an entry that would leave the source's fields empty is skipped (no empty pages), and nothing is
 * written to the update log (the backfill is "what the government says now", not a claim that anything just changed). The text,
 * level, link and date are the same ones the live dual write stores, built by the same plan functions. Running it again on the saved
 * rows changes nothing (every country then already has data). */
export function planBackfill(input: BackfillInput, existing: CountryAdvisoryRow[], nowIso: string, unsafe?: (t: string) => boolean): BackfillPlan {
  const bySlug = new Map(existing.map((r) => [r.slug, r]))
  const touched = new Map<string, { row: CountryAdvisoryRow; created: boolean }>()
  const out: BackfillPlan = { rows: [], created: 0, filled: 0, skipped: 0, notes: [] }
  const note = (n: string) => {
    if (out.notes.length < 5 && !out.notes.includes(n)) out.notes.push(n)
  }
  const each = <T>(events: T[], nameOf: (e: T) => string, plan: (cur: CountryAdvisoryRow | null, e: T) => WritePlan) => {
    for (const ev of events) {
      const slug = countrySlugOf(nameOf(ev))
      const cur = slug ? (bySlug.get(slug) ?? null) : null
      if (cur && hasSourceData(input.source, cur)) {
        out.skipped++
        continue
      }
      const p = plan(cur, ev)
      if (!p.ok) {
        note(p.note)
        continue
      }
      if (!hasSourceData(input.source, p.row)) {
        out.skipped++
        continue
      }
      bySlug.set(p.row.slug, p.row)
      // A slug is touched at most once: the second entry for it finds the data the first one just put on the row and is skipped.
      touched.set(p.row.slug, { row: p.row, created: !cur })
    }
  }
  if (input.source === 'ca') each(input.events, (e) => e.name, (cur, e) => planCanadaWrite(cur, e, null, nowIso, unsafe))
  else if (input.source === 'uk' || input.source === 'uk-full-backfill') each(input.events, (e) => e.country, (cur, e) => planUkWrite(cur, e, nowIso, unsafe))
  else each(input.events, (e) => e.country, (cur, e) => planUsWrite(cur, e, nowIso, unsafe))
  for (const t of touched.values()) {
    out.rows.push(t.row)
    if (t.created) out.created++
    else out.filled++
  }
  return out
}

/** Rows whose Canadian level the latest snapshot CONFIRMS (same country code, same level wording as stored). Only these get a
 * fresh ca_checked_at, so a country that changed but was held back is never marked as checked. */
export function confirmedSlugs(snapshot: { stateKey?: string; stateLevel?: string }[], rows: Pick<CountryAdvisoryRow, 'slug' | 'iso' | 'ca_level'>[]): string[] {
  const byIso = new Map<string, string>()
  for (const s of snapshot) if (s.stateKey && s.stateLevel) byIso.set(s.stateKey.toLowerCase(), s.stateLevel)
  return rows.filter((r) => r.iso && r.ca_level && byIso.has(r.iso) && sameLevel(r.ca_level, cleanLevel(byIso.get(r.iso)))).map((r) => r.slug)
}

// ---------------------------------------------------------------------------------------------------
// Page view model
// ---------------------------------------------------------------------------------------------------

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
/** "October 31, 2026" in UTC, or null when the value is not a real date. */
export function dateLabel(iso: string | null | undefined): string | null {
  const t = iso ? Date.parse(iso) : NaN
  if (!Number.isFinite(t)) return null
  const d = new Date(t)
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`
}

export const sourceLabel = (sourceKey: string): string | null =>
  sourceKey === CA_ADVISORY_SOURCE_KEY
    ? 'Government of Canada'
    : sourceKey === UK_ADVISORY_SOURCE_KEY
      ? 'UK Foreign, Commonwealth and Development Office'
      : sourceKey === US_ADVISORY_SOURCE_KEY
        ? 'US Department of State'
        : null

export interface CanadaBlock {
  level: string | null
  quote: string | null
  sourceUrl: string | null
  publishedLabel: string | null
  checkedLabel: string | null
  stale: boolean
  staleNote: string | null
}
export type UsBlock = CanadaBlock
export interface UkBlock {
  updateLine: string | null
  sourceUrl: string | null
  publishedLabel: string | null
  /** When we last read the UK feed for this country (uk_checked_at), as a date. */
  checkedLabel: string | null
}
export interface LogEntry {
  dateLabel: string | null
  source: string
  text: string
  quote: string | null
  sourceUrl: string | null
}
export interface AdvisoryView {
  slug: string
  name: string
  path: string
  title: string
  h1: string
  description: string
  hasData: boolean
  /** Index in search only when the page has real current data. */
  indexable: boolean
  canada: CanadaBlock | null
  uk: UkBlock | null
  /** The US Department of State block; null (not shown) unless the row has a US value. */
  us: UsBlock | null
  log: LogEntry[]
  dateModified: string | null
  guideSlug: string | null
}

export const advisoryPath = (slug: string): string => `/travel-advisories/${slug}`
export const ADVISORY_INDEX_PATH = '/travel-advisories'

/** The country page a ledger slug belongs to, or null (so a bad slug can never point at some other page). */
export function countryOfAdvisoryLedgerSlug(ledgerSlug: string): string | null {
  const m = /^advisory-([a-z0-9]+(?:-[a-z0-9]+)*)-\d{8}$/.exec(ledgerSlug)
  return m ? m[1] : null
}

/** The country slug from a ledger path "/travel-advisories/<country>", or null. */
export function countryOfAdvisoryPath(path: string): string | null {
  const m = /^\/travel-advisories\/([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(path)
  return m ? m[1] : null
}

/** The wording a Canadian types. Canada first when it has data, otherwise the UK form. */
export function advisoryTitle(row: Pick<CountryAdvisoryRow, 'name' | 'ca_level' | 'ca_text' | 'uk_text'> & Partial<Pick<CountryAdvisoryRow, 'us_level' | 'us_text'>>): string {
  const canada = !!(row.ca_level || row.ca_text)
  if (canada) return `Canada travel advisory for ${row.name}`
  // A page that has only a US entry is titled for it; a page with a UK line keeps the UK form (the title never changes when a US line is added).
  if (!row.uk_text && (row.us_level || row.us_text)) return `US travel advisory for ${row.name}`
  return `UK travel advice for ${row.name}`
}

/** One honest line for the top of the advisory pages. No claim of real time or of accuracy. */
export const FRESHNESS_NOTE =
  'This page is built from official government feeds that we read about every 30 minutes. Please confirm with the official source before you travel.'

export const STALE_NOTE ='We could not confirm this today. Check the official source.'

export function isStale(checkedAt: string | null | undefined, now: Date): boolean {
  const t = checkedAt ? Date.parse(checkedAt) : NaN
  return !Number.isFinite(t) || now.getTime() - t > STALE_AFTER_DAYS * DAY_MS
}

function maxIsoOf(values: (string | null | undefined)[]): string | null {
  let best: number | null = null
  for (const v of values) {
    const t = v ? Date.parse(v) : NaN
    if (Number.isFinite(t) && (best === null || t > best)) best = t
  }
  return best === null ? null : new Date(best).toISOString()
}

/** The newest real change on a page: official publish dates and log entries. Never "now", never a check time. */
export function latestChange(row: CountryAdvisoryRow, log: AdvisoryLogRow[]): string | null {
  return maxIsoOf([row.ca_source_published_at, row.uk_source_published_at, row.us_source_published_at, ...log.map((l) => l.source_published_at ?? l.created_at)])
}

/** Builds everything the page prints from one row and its log. Pure. Only fields the row has are filled in. */
export function buildAdvisoryView(row: CountryAdvisoryRow, log: AdvisoryLogRow[], now: Date): AdvisoryView {
  const caHas = !!(row.ca_level || row.ca_text)
  const ukHas = !!row.uk_text
  const canada: CanadaBlock | null = caHas
    ? (() => {
        const stale = isStale(row.ca_checked_at, now)
        return {
          level: row.ca_level,
          quote: row.ca_text,
          sourceUrl: row.ca_source_url,
          publishedLabel: dateLabel(row.ca_source_published_at),
          checkedLabel: dateLabel(row.ca_checked_at),
          stale,
          staleNote: stale ? STALE_NOTE : null,
        }
      })()
    : null
  const uk: UkBlock | null = ukHas ? { updateLine: row.uk_text, sourceUrl: row.uk_source_url, publishedLabel: dateLabel(row.uk_source_published_at), checkedLabel: dateLabel(row.uk_checked_at) } : null
  const usHas = !!(row.us_level || row.us_text)
  const us: UsBlock | null = usHas
    ? (() => {
        const stale = isStale(row.us_checked_at, now)
        return {
          level: row.us_level,
          quote: row.us_text,
          sourceUrl: row.us_source_url,
          publishedLabel: dateLabel(row.us_source_published_at),
          checkedLabel: dateLabel(row.us_checked_at),
          stale,
          staleNote: stale ? STALE_NOTE : null,
        }
      })()
    : null
  const entries: LogEntry[] = [...log]
    .sort((a, b) => (Date.parse(b.source_published_at ?? b.created_at ?? '') || 0) - (Date.parse(a.source_published_at ?? a.created_at ?? '') || 0))
    .map((l) => {
      const source = sourceLabel(l.source_key) ?? 'Official source'
      const q = (v: string) => v.replace(/"/g, "'")
      const text =
        l.source_key === US_ADVISORY_SOURCE_KEY
          ? l.kind === 'level_change' && l.level_to
            ? l.level_from
              ? `The US Department of State changed its advisory from "${q(l.level_from)}" to "${q(l.level_to)}".`
              : `The US Department of State set its advisory to "${q(l.level_to)}".`
            : 'The US Department of State updated its advisory.'
          : l.kind === 'level_change' && l.level_to
          ? l.level_from
            ? `The Government of Canada changed its advisory from "${l.level_from.replace(/"/g, "'")}" to "${l.level_to.replace(/"/g, "'")}".`
            : `The Government of Canada set its advisory to "${l.level_to.replace(/"/g, "'")}".`
          : l.source_key === UK_ADVISORY_SOURCE_KEY
            ? 'The UK FCDO updated its travel advice.'
            : 'The Government of Canada updated its advisory.'
      return { dateLabel: dateLabel(l.source_published_at ?? l.created_at), source, text, quote: l.text, sourceUrl: l.source_url }
    })
  const data = caHas || ukHas || usHas
  const modified = latestChange(row, log)
  const parts: string[] = []
  if (canada?.level) parts.push(`The Government of Canada's advisory for ${row.name} reads: "${canada.level.replace(/"/g, "'")}".`)
  if (us?.level) parts.push(`The US Department of State's advisory reads: "${us.level.replace(/"/g, "'")}".`)
  if (uk?.updateLine) parts.push(`The UK FCDO's latest update line is shown with its link.`)
  const description = data
    ? `${parts.join(' ')} Official sources, dates and links on one page. Always check the government page before you travel.`.slice(0, 300)
    : `Travel advisory information for ${row.name} is not available on this page yet. Check the official government sources.`
  return {
    slug: row.slug,
    name: row.name,
    path: advisoryPath(row.slug),
    title: advisoryTitle(row),
    h1: advisoryTitle(row),
    description,
    hasData: data,
    indexable: data && row.status === 'published',
    canada,
    uk,
    us,
    log: entries,
    dateModified: modified,
    guideSlug: row.guide_slug,
  }
}

/** schema.org: a WebPage about a Country with dateModified and the official pages as isBasedOn and citation. No review, rating or
 * announcement markup: none of those fits a page that quotes a government. Optional fields are left out, never invented. */
export function buildAdvisoryJsonLd(view: AdvisoryView, absoluteUrl: (p: string) => string): object {
  const sources: { '@type': 'WebPage'; url: string; name: string; publisher: { '@type': 'GovernmentOrganization'; name: string } }[] = []
  if (view.canada?.sourceUrl) sources.push({ '@type': 'WebPage', url: view.canada.sourceUrl, name: `Government of Canada travel advice for ${view.name}`, publisher: { '@type': 'GovernmentOrganization', name: 'Government of Canada' } })
  if (view.uk?.sourceUrl) sources.push({ '@type': 'WebPage', url: view.uk.sourceUrl, name: `UK FCDO travel advice for ${view.name}`, publisher: { '@type': 'GovernmentOrganization', name: 'UK Foreign, Commonwealth and Development Office' } })
  if (view.us?.sourceUrl) sources.push({ '@type': 'WebPage', url: view.us.sourceUrl, name: `US Department of State travel advisory for ${view.name}`, publisher: { '@type': 'GovernmentOrganization', name: 'US Department of State' } })
  return {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: view.title,
    description: view.description,
    url: absoluteUrl(view.path),
    about: { '@type': 'Country', name: view.name },
    ...(view.dateModified ? { dateModified: view.dateModified } : {}),
    ...(sources.length ? { isBasedOn: sources, citation: sources.map((s) => s.url) } : {}),
  }
}

// ---------------------------------------------------------------------------------------------------
// Index, sitemap, links
// ---------------------------------------------------------------------------------------------------

export interface IndexRow {
  slug: string
  name: string
  path: string
  title: string
  level: string | null
  ukLine: boolean
  /** The US Department of State's own level wording, or null. */
  usLevel: string | null
  updatedLabel: string | null
}

/** One line per published country that has data, A to Z. */
export function buildIndexRows(rows: CountryAdvisoryRow[], logsBySlug: Record<string, AdvisoryLogRow[]> = {}): IndexRow[] {
  return rows
    .filter((r) => r.status === 'published' && hasData(r))
    .map((r) => ({
      slug: r.slug,
      name: r.name,
      path: advisoryPath(r.slug),
      title: advisoryTitle(r),
      level: r.ca_level,
      ukLine: !!r.uk_text,
      usLevel: r.us_level,
      updatedLabel: dateLabel(latestChange(r, logsBySlug[r.slug] ?? [])),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export interface SitemapEntry {
  path: string
  lastModified: string | null
}

/** The sitemap lines for these pages. Empty unless the mode is exactly 'on'. Only published rows with data are listed, and the
 * date is the newest real change (never the time of the request). */
export function advisorySitemapEntries(mode: AdvisoryMode, rows: CountryAdvisoryRow[], logsBySlug: Record<string, AdvisoryLogRow[]> = {}): SitemapEntry[] {
  if (mode !== 'on') return []
  const pages = rows.filter((r) => r.status === 'published' && hasData(r)).sort((a, b) => a.slug.localeCompare(b.slug))
  if (pages.length === 0) return []
  const entries = pages.map((r) => ({ path: advisoryPath(r.slug), lastModified: latestChange(r, logsBySlug[r.slug] ?? []) }))
  return [{ path: ADVISORY_INDEX_PATH, lastModified: maxIsoOf(entries.map((e) => e.lastModified)) }, ...entries]
}

/** The advisory page a destination guide should link to, or null. A guide links only when it is the guide the row names
 * (guide_slug, hand-set) or has the very same slug as the country; the page must be published with data and the mode 'on'. */
export function advisoryLinkForGuide(mode: AdvisoryMode, guideSlug: string, rows: CountryAdvisoryRow[]): { name: string; path: string; label: string } | null {
  if (mode !== 'on') return null
  const row = rows.find((r) => r.status === 'published' && hasData(r) && (r.guide_slug === guideSlug || (!r.guide_slug && r.slug === guideSlug)))
  return row ? { name: row.name, path: advisoryPath(row.slug), label: advisoryTitle(row) } : null
}
