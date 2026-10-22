import type { GuideCandidate, GuideKind } from '@/lib/guides'
import type { GuideScope } from '@/lib/guide-scope'
import { generateSlug } from '@/lib/utils'

// The planned destination guides (growth loop): every country, port, city and named place where the agency has planned trips
// or packages, taken from the sister site's sitemap (docs/factory/GUIDE-PLAN-DESTINATIONS.md, supplied by the owner on
// 2026-10-22). NAMES ONLY: no facts. A planned trip is NOT evidence of a personal visit, so the writer is told to write a plain,
// generic destination guide (see PLANNED_PLACE_RULE) and the usual quality gate applies unchanged.
//
// Pure code, no database, no import of runtime values from lib/guides.ts (guides.ts imports this file), so it runs in the
// browser, in the admin and in the offline check.

export type PlanScope = 'country' | 'city' | 'port' | 'attraction'

export interface PlannedPlace {
  kind: 'destinations'
  name: string
  slug: string
  scope: PlanScope
  /** The country page this one sits under. Null for a country. */
  parent_slug: string | null
  country: string
  /** Other slugs a real destination or an existing guide may already use for the same place. */
  aliases: string[]
  /** Where the name came from. */
  source: string
  /** How many times the place appears in the supplied list (every place is listed once). */
  mentions: number
  /** For a country: how many planned places it holds. Zero for a place. */
  places: number
}

export const PLAN_SOURCE_NOTE = 'planned trips on the sister site'

/** The words the writer must follow for a planned place. Appended to the writer's prompt (lib/guide-composer.ts). */
export const PLANNED_PLACE_RULE =
  'PLANNED PLACE RULE: this page is for a place where the agency has trips planned, but a planned trip is NOT evidence that anyone from the agency has been there. Never write "we visited", "our clients loved", "our travellers", "our team has been" or anything that suggests a visit, a past group or a review. State no itinerary, schedule, day plan or route as fact, and make no claim about what the agency arranges here beyond the one approved line "we can help you plan a group trip". Write a plain, generic, guidebook-level destination guide.'

/** Display names with diacritics become plain ASCII slugs ("Dürnstein" to "durnstein"). Letters that do not decompose are mapped by hand. */
export function planSlug(name: string): string {
  return name
    .replace(/ð/g, 'd').replace(/Ð/g, 'D').replace(/þ/g, 'th').replace(/Þ/g, 'Th').replace(/ø/g, 'o').replace(/Ø/g, 'O').replace(/ı/g, 'i').replace(/ł/g, 'l').replace(/Ł/g, 'L').replace(/ß/g, 'ss').replace(/æ/g, 'ae').replace(/Æ/g, 'Ae')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

// Places that are ports of call or cruise ports in the supplied list; everything else listed is a city or town unless it is an attraction.
const PORT_NAMES = new Set(
  [
    'Nassau', 'CocoCay', 'Ocean Cay', 'Zeebrugge', 'Split', 'Dubrovnik', 'Limassol', 'Port Said', 'Safaga', 'Piraeus', 'Civitavecchia', 'Livorno', 'Naples', 'Southampton', 'Fort Lauderdale', 'Miami',
    'Montego Bay', 'Roatán', 'Costa Maya', 'Puerto Plata', 'Kotor', 'Akureyri', 'Ísafjörður', 'Geiranger', 'Ålesund', 'Bergen', 'San Juan', 'Kuşadası', 'Barcelona', 'Palma de Mallorca', 'Marseille',
    'Cannes', 'Nice', 'Ashdod', 'Haifa',
  ].map(planSlug),
)
// Named natural or historic sights rather than towns.
const ATTRACTION_NAMES = new Set(
  [
    'Plitvice Lakes', 'Mali Ston Bay', 'Telašćica', 'Kornati', 'Blue Lagoon', 'Golden Circle', 'Reykjanes Peninsula', 'Masada', 'Dead Sea', 'Pompeii', 'Cinque Terre', 'Chichén Itzá', 'Zaanse Schans', 'Kinderdijk',
    'Keukenhof', 'Ephesus', 'Monreale', 'Agrigento', 'Piazza Armerina',
  ].map(planSlug),
)

/** The supplied table: country, then its places. St. Barths is the same place as the Saint Barthélemy territory, so it is kept as an alias
 * of that page and not as a second guide. */
const TABLE: { country: string; aliases?: string[]; places: string[] }[] = [
  { country: 'Austria', places: ['Dürnstein', 'Melk', 'Salzburg', 'Linz', 'Vienna'] },
  { country: 'Bahamas', places: ['Nassau', 'CocoCay', 'Ocean Cay', 'Bimini'] },
  { country: 'Belgium', places: ['Zeebrugge', 'Bruges', 'Brussels'] },
  { country: 'British Virgin Islands', aliases: ['bvi'], places: [] },
  { country: 'Croatia', places: ['Zagreb', 'Plitvice Lakes', 'Split', 'Trogir', 'Ston', 'Mali Ston Bay', 'Dubrovnik', 'Cavtat', 'Rab', 'Vodice', 'Zadar', 'Molat', 'Sali', 'Telašćica', 'Kornati'] },
  { country: 'Cyprus', places: ['Limassol', 'Nicosia'] },
  { country: 'Dominican Republic', places: ['Punta Cana', 'Miches', 'Puerto Plata'] },
  { country: 'Egypt', places: ['Port Said', 'Cairo', 'Safaga', 'Luxor'] },
  { country: 'France', places: ['Cannes', 'Antibes', 'Marseille', 'Nice'] },
  { country: 'Greece', places: ['Athens', 'Piraeus', 'Mykonos', 'Santorini', 'Oia', 'Patmos', 'Rhodes', 'Lindos'] },
  { country: 'Honduras', places: ['Roatán'] },
  { country: 'Hungary', places: ['Budapest', 'Esztergom'] },
  { country: 'Iceland', places: ['Akureyri', 'Ísafjörður', 'Reykjavík', 'Reykjanes Peninsula', 'Blue Lagoon', 'Golden Circle'] },
  { country: 'Israel', places: ['Ashdod', 'Jerusalem', 'Haifa', 'Masada', 'Dead Sea'] },
  {
    country: 'Italy',
    places: [
      'Civitavecchia', 'Rome', 'Livorno', 'Florence', 'Pisa', 'Naples', 'Pompeii', 'Sorrento', 'Positano', 'Amalfi', 'Ravello', 'Montecatini Terme', 'Lucca', 'San Gimignano', 'Cinque Terre', 'Siena', 'Bologna',
      'Taormina', 'Matera', 'Palermo', 'Monreale', 'Agrigento', 'Piazza Armerina', 'Giardini Naxos',
    ],
  },
  { country: 'Jamaica', places: ['Montego Bay'] },
  { country: 'Mexico', places: ['Cancún', 'Costa Maya', 'Chichén Itzá', 'Isla Mujeres', 'Holbox'] },
  { country: 'Montenegro', places: ['Kotor', 'Perast'] },
  { country: 'Netherlands', places: ['Amsterdam', 'Zaanse Schans', 'Enkhuizen', 'Rotterdam', 'Kinderdijk', 'Keukenhof'] },
  { country: 'Norway', places: ['Bergen', 'Geiranger', 'Ålesund'] },
  { country: 'Puerto Rico', places: ['San Juan'] },
  { country: 'Saint Barthélemy', aliases: ['st-barths', 'saint-barths', 'st-barthelemy'], places: [] },
  { country: 'Slovakia', places: ['Bratislava'] },
  { country: 'Slovenia', places: ['Ljubljana', 'Bled'] },
  { country: 'Spain', places: ['Barcelona', 'Palma de Mallorca', 'Valldemossa', 'Ibiza'] },
  // The list names it "Türkiye (Turkey)". The page uses the English name the site already has a seed for.
  { country: 'Turkey', aliases: ['turkiye'], places: ['Kuşadası', 'Ephesus', 'Istanbul'] },
  { country: 'United Arab Emirates', aliases: ['uae'], places: ['Dubai'] },
  { country: 'United Kingdom', aliases: ['uk', 'great-britain'], places: ['Southampton', 'London'] },
  { country: 'United States', aliases: ['usa', 'us'], places: ['Miami', 'Fort Lauderdale', 'Albuquerque', 'Santa Fe'] },
]

/** Names in the supplied file that are covered by another entry instead of getting a page of their own (checked by the offline test). */
export const PLAN_FILE_ALIASES: Record<string, string> = {
  'Türkiye (Turkey)': 'Turkey',
  'St. Barths': 'Saint Barthélemy',
  '(territory only)': '',
}

function build(): PlannedPlace[] {
  const countryRows = TABLE.map((row) => ({ row, slug: planSlug(row.country) }))
  const out: PlannedPlace[] = []
  const order = [...countryRows].sort((a, b) => b.row.places.length - a.row.places.length || a.row.country.localeCompare(b.row.country))
  for (const { row, slug } of order) {
    out.push({ kind: 'destinations', name: row.country, slug, scope: 'country', parent_slug: null, country: row.country, aliases: row.aliases ?? [], source: PLAN_SOURCE_NOTE, mentions: 1, places: row.places.length })
  }
  for (const { row, slug } of order) {
    for (const place of row.places) {
      const pSlug = planSlug(place)
      const scope: PlanScope = ATTRACTION_NAMES.has(pSlug) ? 'attraction' : PORT_NAMES.has(pSlug) ? 'port' : 'city'
      out.push({ kind: 'destinations', name: place, slug: pSlug, scope, parent_slug: slug, country: row.country, aliases: [], source: PLAN_SOURCE_NOTE, mentions: 1, places: 0 })
    }
  }
  return out
}

/** Every planned page, countries first (the one with the most planned places first), then the places country by country in the
 * order of the list. A place that the list names under two countries (a shared port) appears once per country only when its
 * slug differs; the same slug is kept for the first country and the second is dropped. */
export const PLANNED_PLACES: PlannedPlace[] = (() => {
  const seen = new Set<string>()
  return build().filter((p) => {
    if (seen.has(p.slug)) return false
    seen.add(p.slug)
    return true
  })
})()

/** The page scope stored for a planned place. An attraction has no matching scope label, so it stays empty (the page then shows its kind). */
export function guideScopeOf(scope: PlanScope): GuideScope | null {
  return scope === 'attraction' ? null : scope
}

/** The country name behind a country slug, or null. Used to name the parent in the writer's brief when the country has no page yet. */
export function planCountryName(slug: string | null | undefined): string | null {
  if (!slug) return null
  return PLANNED_PLACES.find((p) => p.scope === 'country' && p.slug === slug)?.name ?? null
}

/** True when a destination slug already covers this planned place: the same slug, one of its aliases, or a longer slug that starts with it
 * ("cancun" is covered by "cancun-mexico") or pairs it with its country ("mexico-cancun"). A country is only covered by its own slug or
 * alias: "rome-italy" does not cover "italy". */
export function slugCovers(place: Pick<PlannedPlace, 'slug' | 'parent_slug' | 'aliases' | 'scope'>, existingSlug: string): boolean {
  if (existingSlug === place.slug || place.aliases.includes(existingSlug)) return true
  if (place.scope === 'country') return false
  if (existingSlug.startsWith(`${place.slug}-`)) return true
  return !!place.parent_slug && existingSlug.startsWith(`${place.parent_slug}-`) && existingSlug.endsWith(`-${place.slug}`)
}

/** Rank inside the line: 0 country, 1 city or port whose country already has a page, 2 city or port whose country has none yet,
 * 3 attraction. */
export function planRank(place: PlannedPlace, writtenSlugs: ReadonlySet<string>): number {
  if (place.scope === 'country') return 0
  if (place.scope === 'attraction') return 3
  return place.parent_slug && writtenSlugs.has(place.parent_slug) ? 1 : 2
}

/** The planned places in the order they should be offered: by rank, then in the stable table order (countries by how many places
 * they hold, places country by country). `writtenSlugs` are the destination slugs that already have a guide (drafts count). Pure. */
export function orderPlannedPlaces(writtenSlugs: ReadonlySet<string>, places: PlannedPlace[] = PLANNED_PLACES): PlannedPlace[] {
  return places
    .map((p, i) => ({ p, i, r: planRank(p, writtenSlugs) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.p)
}

/** A planned place as a guide candidate. Origin 'seed': curated names only, no facts. */
export function plannedAsCandidate(place: PlannedPlace): GuideCandidate {
  return { kind: 'destinations', name: place.name, slug: place.slug, parent_slug: place.parent_slug, origin: 'seed', scope: guideScopeOf(place.scope), planned: true }
}

// ---------------------------------------------------------------------------------------------------
// Admin status: published, draft, waiting or excluded, per planned place
// ---------------------------------------------------------------------------------------------------

export type PlanStatus = 'published' | 'draft' | 'waiting' | 'excluded'

export interface PlanStatusRow {
  name: string
  slug: string
  scope: PlanScope
  country: string
  status: PlanStatus
}

/** The status of every planned place, read from the guide rows already stored and the owner's do-not-recreate list ("kind:slug").
 * Published beats draft; an existing guide beats the excluded list. Pure. */
export function planStatusRows(
  guides: { kind: string; slug: string; status: string | null }[],
  excluded: ReadonlySet<string>,
  places: PlannedPlace[] = PLANNED_PLACES,
): PlanStatusRow[] {
  const dest = guides.filter((g) => g.kind === 'destinations')
  return places.map((p) => {
    const hits = dest.filter((g) => slugCovers(p, g.slug))
    let status: PlanStatus
    if (hits.some((g) => g.status === 'published')) status = 'published'
    else if (hits.length > 0) status = 'draft'
    else if (excluded.has(`destinations:${p.slug}`)) status = 'excluded'
    else status = 'waiting'
    return { name: p.name, slug: p.slug, scope: p.scope, country: p.country, status }
  })
}

export interface PlanSummary {
  total: number
  written: number
  waiting: number
  excluded: number
  published: number
  draft: number
}

/** "Planned guides: N written, M waiting": written = published or draft, waiting = not started and not excluded. */
export function summarizePlan(rows: PlanStatusRow[]): PlanSummary {
  const count = (s: PlanStatus) => rows.filter((r) => r.status === s).length
  const published = count('published')
  const draft = count('draft')
  return { total: rows.length, written: published + draft, waiting: count('waiting'), excluded: count('excluded'), published, draft }
}

// ---------------------------------------------------------------------------------------------------
// Companies and hotels from stored package data
// ---------------------------------------------------------------------------------------------------

export interface CompanyRow {
  name: string | null
  supplier: string | null
  destination: string | null
  category: string | null
}

/** Which guide kind a company or property NAME says it is, from its own words only. Null when the name does not say (a tour operator
 * such as a bare brand): nothing is guessed. */
export function kindFromCompanyName(name: string): GuideKind | null {
  const n = name.toLowerCase()
  if (/\byachts?\b|\bclippers?\b/.test(n)) return 'yachts'
  if (/\bresorts?\b/.test(n)) return 'resorts'
  if (/\bhotels?\b|\binn\b|\blodge\b/.test(n)) return 'hotels'
  if (/\briver\b/.test(n) && /\b(cruises?|waterways|boutique)\b/.test(n)) return 'river-cruises'
  if (/\bwaterways\b/.test(n)) return 'river-cruises'
  if (/\b(cruises|cruise line|cruise lines|america line)\b/.test(n)) return 'cruise-lines'
  return null
}

export interface CompanyCandidate {
  kind: GuideKind
  name: string
  slug: string
  /** A hotel or resort sits under the destination of the package it came from. */
  parent_slug: string | null
  /** Where in the stored package data the name was found. */
  from: 'supplier' | 'package name'
}

/** Cruise lines, river cruise lines, hotels and resorts named in the stored `supplier` field of published packages. The name must be
 * exactly what the package data holds (trimmed): it is never reworded. A supplier whose name does not say what it is (a tour operator
 * brand) is returned in `unmapped` for the admin to see and never becomes a candidate. Pure. */
export function companyCandidatesFromSuppliers(rows: CompanyRow[]): { candidates: CompanyCandidate[]; unmapped: string[] } {
  const candidates: CompanyCandidate[] = []
  const seen = new Set<string>()
  const unmapped = new Set<string>()
  for (const r of rows) {
    const name = (r.supplier ?? '').replace(/\s+/g, ' ').trim()
    if (name.length < 3 || name.length > 60 || /\d/.test(name)) continue
    const kind = kindFromCompanyName(name)
    if (!kind) {
      unmapped.add(name)
      continue
    }
    // Same slug rule as the package-name candidates in lib/guides.ts, so a name found both ways is one candidate.
    const slug = generateSlug(name)
    const key = `${kind}:${slug}`
    if (!slug || seen.has(key)) continue
    seen.add(key)
    const dest = r.destination ? generateSlug(r.destination) : ''
    candidates.push({ kind, name, slug, parent_slug: (kind === 'hotels' || kind === 'resorts') && dest ? dest : null, from: 'supplier' })
  }
  return { candidates, unmapped: [...unmapped].sort((a, b) => a.localeCompare(b)) }
}
