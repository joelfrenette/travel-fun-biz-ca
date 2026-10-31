// Travel advisories (one evergreen page per country). PURE helpers only: no database, no network, no clock except what is
// passed in. The database side is lib/country-advisory-store.ts, the social side lib/country-advisory-social.ts.
//
// Rules this file enforces (scripts/check-country-advisories.ts proves each one):
//   - Every field is optional. An empty field is left empty and not shown. Nothing is guessed, defaulted or combined.
//   - A government level is shown only as the government's own words, in quote marks, with the source named. It is never
//     turned into a score, a colour or a stronger phrase.
//   - The UK feed has no level. The UK block shows the update line, its date and the link, never a level.
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
export const CA_ADVISORY_HOSTS = ['travel.gc.ca']
export const UK_ADVISORY_HOSTS = ['gov.uk']

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

export const ADVISORY_COLUMNS =
  'slug, name, iso, guide_slug, ca_level, ca_text, ca_source_url, ca_source_published_at, ca_checked_at, uk_text, uk_source_url, uk_source_published_at, uk_checked_at, status, updated_at'

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
const hasData = (r: Pick<CountryAdvisoryRow, 'ca_level' | 'ca_text' | 'uk_text'>): boolean => !!(r.ca_level || r.ca_text || r.uk_text)
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
  sourceKey === CA_ADVISORY_SOURCE_KEY ? 'Government of Canada' : sourceKey === UK_ADVISORY_SOURCE_KEY ? 'UK Foreign, Commonwealth and Development Office' : null

export interface CanadaBlock {
  level: string | null
  quote: string | null
  sourceUrl: string | null
  publishedLabel: string | null
  checkedLabel: string | null
  stale: boolean
  staleNote: string | null
}
export interface UkBlock {
  updateLine: string | null
  sourceUrl: string | null
  publishedLabel: string | null
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
export function advisoryTitle(row: Pick<CountryAdvisoryRow, 'name' | 'ca_level' | 'ca_text' | 'uk_text'>): string {
  const canada = !!(row.ca_level || row.ca_text)
  return canada ? `Canada travel advisory for ${row.name}` : `UK travel advice for ${row.name}`
}

export const STALE_NOTE = 'We could not confirm this today. Check the official source.'

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
  return maxIsoOf([row.ca_source_published_at, row.uk_source_published_at, ...log.map((l) => l.source_published_at ?? l.created_at)])
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
  const uk: UkBlock | null = ukHas ? { updateLine: row.uk_text, sourceUrl: row.uk_source_url, publishedLabel: dateLabel(row.uk_source_published_at) } : null
  const entries: LogEntry[] = [...log]
    .sort((a, b) => (Date.parse(b.source_published_at ?? b.created_at ?? '') || 0) - (Date.parse(a.source_published_at ?? a.created_at ?? '') || 0))
    .map((l) => {
      const source = sourceLabel(l.source_key) ?? 'Official source'
      const text =
        l.kind === 'level_change' && l.level_to
          ? l.level_from
            ? `The Government of Canada changed its advisory from "${l.level_from.replace(/"/g, "'")}" to "${l.level_to.replace(/"/g, "'")}".`
            : `The Government of Canada set its advisory to "${l.level_to.replace(/"/g, "'")}".`
          : l.source_key === UK_ADVISORY_SOURCE_KEY
            ? 'The UK FCDO updated its travel advice.'
            : 'The Government of Canada updated its advisory.'
      return { dateLabel: dateLabel(l.source_published_at ?? l.created_at), source, text, quote: l.text, sourceUrl: l.source_url }
    })
  const data = caHas || ukHas
  const modified = latestChange(row, log)
  const parts: string[] = []
  if (canada?.level) parts.push(`The Government of Canada's advisory for ${row.name} reads: "${canada.level.replace(/"/g, "'")}".`)
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
