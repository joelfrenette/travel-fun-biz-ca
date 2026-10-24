// Trip Page Kit: the pure half (no database, no network, no AI). Everything the trip page and the fill engine need to
// agree on lives here, so the page, the admin and scripts/check-trip-kit.ts all read the same rules.
//
// The rules, in plain words:
//  * A fact is shown only when it has a source: a field of the trip row, a stored source text, or a cited reference page
//    (Wikivoyage / Wikipedia, CC BY-SA, shown with an attribution line).
//  * A PRICE is never shown unless an agent confirmed it (settings key trip_price_confirmed:<id>). The fill engine never
//    writes that key.
//  * Arrival and departure hours, schedules, ship, hotel and supplier inclusions that are not in the row or its sources
//    are never guessed: they go on a "to confirm" list that only the admin sees.

export const TRIP_KIT_VERSION = 1

export const tripKitKey = (packageId: string) => `trip_kit:${packageId}`
export const tripKitPrevKey = (packageId: string) => `trip_kit_prev:${packageId}`
export const tripKitFactsKey = (packageId: string) => `trip_kit_facts:${packageId}`
export const tripPriceConfirmedKey = (packageId: string) => `trip_price_confirmed:${packageId}`

// ─── Shapes stored in app_settings (JSON) ───────────────────────────────────────────

export interface KitSource {
  /** "Wikivoyage", "Wikipedia", "Trip details" (the row), "Supplier page". */
  label: string
  url: string | null
}

export interface KitThing {
  text: string
  source: KitSource
}

export interface KitPhoto {
  url: string
  /** Honest alt text: the place name only. */
  alt: string
  credit: string
  creditUrl: string | null
}

export type KitStopKind = 'port' | 'city' | 'stay' | 'stop' | 'start' | 'end'

export interface KitStop {
  name: string
  kind: KitStopKind
  /** Country or region as stored next to the name ("Dominican Republic"). */
  region: string | null
  /** YYYY-MM-DD, only when the stored itinerary gave a day number and the trip has a start date. */
  date: string | null
  /** Only when the stored text states them. */
  arrive: string | null
  depart: string | null
  /** "4 days at the resort", only from the stored length. */
  days: string | null
  photo: KitPhoto | null
  things: KitThing[]
  source: KitSource
}

export interface KitFact {
  label: string
  text: string
  source: KitSource
}

export interface TripKit {
  v: number
  generatedAt: string
  /** One line promise for the hero. */
  promise: string | null
  /** True when the route comes from the trip's own itinerary or a list in its text. False: the places are only named in the
   * trip's name or destination, so the page says "Where you are headed" and never "Your route". */
  routeKnown: boolean
  stops: KitStop[]
  /** Names that are on the route but could not be matched to a reference page. Shown as a plain "Also on the route" line. */
  otherStops: string[]
  included: KitFact[]
  notIncluded: KitFact[]
  goodToKnow: KitFact[]
  attributions: KitSource[]
  /** Admin only. Never rendered on the public page. */
  toConfirm: string[]
}

export interface PriceConfirmed {
  /** Who in the office confirmed it. */
  by: string
  /** ISO date-time. */
  at: string
  /** The exact words to show, for example "From $1,999 per person". */
  text: string
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown, max = 600): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '')
const strOrNull = (v: unknown, max = 600): string | null => str(v, max) || null

function srcOf(v: unknown): KitSource {
  if (!isObj(v)) return { label: 'Trip details', url: null }
  const url = strOrNull(v.url, 500)
  return { label: str(v.label, 60) || 'Trip details', url: url && /^https:\/\//i.test(url) ? url : null }
}

function factsOf(v: unknown, max: number): KitFact[] {
  if (!Array.isArray(v)) return []
  const out: KitFact[] = []
  for (const f of v) {
    if (!isObj(f)) continue
    const text = str(f.text, 500)
    if (!text) continue
    out.push({ label: str(f.label, 60), text, source: srcOf(f.source) })
    if (out.length >= max) break
  }
  return out
}

function photoOf(v: unknown): KitPhoto | null {
  if (!isObj(v)) return null
  const url = str(v.url, 600)
  if (!/^https:\/\//i.test(url)) return null
  return { url, alt: str(v.alt, 120), credit: str(v.credit, 120), creditUrl: strOrNull(v.creditUrl, 500) }
}

/** Reads the stored JSON defensively. Anything that is not the right shape is dropped, never thrown at the page. */
export function parseTripKit(raw: string | null | undefined): TripKit | null {
  if (!raw) return null
  let j: unknown
  try {
    j = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isObj(j) || j.v !== TRIP_KIT_VERSION) return null
  const stops: KitStop[] = []
  if (Array.isArray(j.stops)) {
    for (const s of j.stops) {
      if (!isObj(s)) continue
      const name = str(s.name, 100)
      if (!name) continue
      const things: KitThing[] = []
      if (Array.isArray(s.things)) {
        for (const t of s.things) {
          if (!isObj(t)) continue
          const text = str(t.text, 300)
          if (text) things.push({ text, source: srcOf(t.source) })
          if (things.length >= 4) break
        }
      }
      const kind = (['port', 'city', 'stay', 'stop', 'start', 'end'] as const).find((k) => k === s.kind) ?? 'stop'
      stops.push({
        name,
        kind,
        region: strOrNull(s.region, 80),
        date: /^\d{4}-\d{2}-\d{2}$/.test(str(s.date, 10)) ? str(s.date, 10) : null,
        arrive: strOrNull(s.arrive, 20),
        depart: strOrNull(s.depart, 20),
        days: strOrNull(s.days, 60),
        photo: photoOf(s.photo),
        things,
        source: srcOf(s.source),
      })
      if (stops.length >= 16) break
    }
  }
  const attributions: KitSource[] = []
  if (Array.isArray(j.attributions)) for (const a of j.attributions) { const s = srcOf(a); if (s.url) attributions.push(s); if (attributions.length >= 6) break }
  return {
    v: TRIP_KIT_VERSION,
    generatedAt: str(j.generatedAt, 40),
    promise: strOrNull(j.promise, 200),
    routeKnown: j.routeKnown === true,
    stops,
    otherStops: Array.isArray(j.otherStops) ? j.otherStops.map((x) => str(x, 80)).filter(Boolean).slice(0, 20) : [],
    included: factsOf(j.included, 14),
    notIncluded: factsOf(j.notIncluded, 14),
    goodToKnow: factsOf(j.goodToKnow, 10),
    attributions,
    toConfirm: Array.isArray(j.toConfirm) ? j.toConfirm.map((x) => str(x, 300)).filter(Boolean).slice(0, 30) : [],
  }
}

/** The agent-confirmed price record, or null. All three parts must be there; a half-filled record shows nothing. */
export function parsePriceConfirmed(raw: string | null | undefined): PriceConfirmed | null {
  if (!raw) return null
  try {
    const j = JSON.parse(raw) as unknown
    if (!isObj(j)) return null
    const by = str(j.by, 80)
    const at = str(j.at, 40)
    const text = str(j.text, 120)
    if (!by || !text || Number.isNaN(Date.parse(at))) return null
    return { by, at, text }
  } catch {
    return null
  }
}

/** "From $1,999 per person, confirmed by your agent on October 3, 2026, subject to availability." Pure. */
export function priceConfirmedLine(p: PriceConfirmed): { headline: string; note: string } {
  const d = new Date(p.at)
  const date = d.toLocaleDateString('en-CA', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' })
  return { headline: p.text, note: `Confirmed by your agent on ${date}, subject to availability.` }
}

// ─── Text helpers ───────────────────────────────────────────────────────────────────

/** Lowercase, accents and curly quotes folded away, whitespace collapsed. For "is this phrase in that text". */
export function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

export const containsPhrase = (hay: string, needle: string): boolean => {
  const n = fold(needle)
  return n.length > 0 && fold(hay).includes(n)
}

// A price, a deposit amount, a per person figure or a discount. Anything matching is kept off the public page.
const PRICE_RE = new RegExp(
  [
    '[$\\u20ac\\u00a3]\\s?\\d',
    '\\b\\d[\\d,.]*\\s?(?:usd|cad|aud|eur|dollars?|bucks)\\b',
    '\\b\\d+\\s?pp\\b',
    '\\bper[- ]person\\b',
    '\\bfrom\\s+\\$',
    '\\b(?:discount|save up to|% off|percent off|early[- ]bird)\\b',
    '\\bfinancing\\b|\\binstal+ments?\\b',
  ].join('|'),
  'i',
)

export const isPriceText = (s: string): boolean => PRICE_RE.test(s)

export function splitSentences(text: string): string[] {
  return text
    .replace(/\r/g, '')
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/** The text with every sentence that talks about money removed. Pure. */
export function withoutPriceSentences(text: string): string {
  return splitSentences(text).filter((s) => !isPriceText(s)).join(' ')
}

const HOURS_RE = /\b\d{1,2}[:.]\d{2}\b|\b\d{1,2}\s?(?:am|pm)\b|\bopen(?:s|ing)?\b|\bdaily\b|\bhours?\b/i
const CONTACT_RE = /\+\d|\b\d{3}[-. ]\d{3,4}[-. ]\d{3,4}\b|@|https?:|www\./i

/** Reference sentences safe to hand to the writer: no digits, money, hours, phone numbers or addresses. Pure. */
export function scrubReferenceText(text: string, maxSentences = 6): string {
  const keep: string[] = []
  for (const s of splitSentences(text)) {
    if (/\d/.test(s) || isPriceText(s) || HOURS_RE.test(s) || CONTACT_RE.test(s) || /[€$£]/.test(s)) continue
    if (s.length < 25 || s.length > 400) continue
    keep.push(s)
    if (keep.length >= maxSentences) break
  }
  return keep.join(' ')
}

// ─── Places named in the stored text ────────────────────────────────────────────────

export interface PlaceMention {
  name: string
  region: string | null
  kind: KitStopKind
}

const LEAD_IN = /^(?:.*?\b(?:featuring|including|visiting|stops? (?:at|in)|ports? of call:?|via)\s+)/i
const TRAIL = /[,;]?\s*(?:and more|etc\.?|and others|and beyond)\.?\s*$/i

function cleanPlace(raw: string): string {
  return raw
    .replace(/^(?:and|the|to|a|an)\s+/i, '')
    .replace(/^(?:and|the)\s+/i, '')
    .replace(/[.;:]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

const looksLikePlace = (s: string): boolean => {
  if (s.length < 3 || s.length > 48) return false
  if (s.split(/\s+/).length > 6) return false
  if (!/^[A-ZÀ-Ý]/.test(s)) return false
  if (/\b(?:with|your|you|our|will|are|is|the best|enjoy|join|think)\b/i.test(s)) return false
  if (/[!?]/.test(s)) return false
  return true
}

/** Place names from a LIST-LIKE line ("A * B, Country * C", "A, B, C and D", "A to B"). Not for prose: prose goes to the
 * model, whose answers are then checked against the text. Pure. */
export function placesFromList(text: string): PlaceMention[] {
  const t = text.replace(/\s+/g, ' ').trim()
  if (!t || t.length > 600) return []
  const out: PlaceMention[] = []
  const push = (name: string, region: string | null, kind: KitStopKind) => {
    const n = cleanPlace(name)
    if (!looksLikePlace(n)) return
    if (out.some((p) => fold(p.name) === fold(n))) return
    out.push({ name: n, region: region ? cleanPlace(region) || null : null, kind })
  }
  if (t.includes('*')) {
    for (const part of t.split('*')) {
      const [name, ...rest] = part.split(',')
      push(name, rest.join(',') || null, 'port')
    }
    return out
  }
  const range = /^([A-Z][^,]{2,40}),\s*([A-Z][^,]{2,40})\s+to\s+([A-Z][^,]{2,40}),\s*([A-Z][^,]{2,40})$/.exec(t)
  if (range) {
    push(range[1], range[2], 'start')
    push(range[3], range[4], 'end')
    return out
  }
  if (/[.!?]\s+[A-Z]/.test(t) || (t.match(/,/g) ?? []).length < 2) return []
  const body = t.replace(LEAD_IN, '').replace(TRAIL, '')
  for (const part of body.split(/,\s*(?:and\s+)?|\s+and\s+/)) push(part, null, 'city')
  return out
}

/** Places that are only named in the trip's name, for example "RHINE RIVER & SWISS ALPS w/ Amy & Liz". The route between
 * them is NOT known, so the page shows them as "Where you are headed". Pure. */
export function placesFromName(name: string): PlaceMention[] {
  const head = name.split(/\s+(?:w\/|with)\s+/i)[0]
  const title = (s: string) => s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()).trim()
  const out: PlaceMention[] = []
  for (const part of head.split(/\s+(?:&|and)\s+/i)) {
    const n = title(part.replace(/\b(?:trip|tour|cruise|getaway|escape|2\d{3}|girls|women's|new years)\b/gi, '')).replace(/\s+/g, ' ')
    if (n.length >= 4 && n.split(' ').length <= 4 && /^[A-Z]/.test(n)) out.push({ name: n, region: null, kind: 'city' })
  }
  return out
}

/** Hosts named in a trip name ("... w/ Amy & Liz" -> "Amy & Liz"). Only what the stored name says. */
export function hostFromName(name: string): string | null {
  const m = /\s(?:w\/|with)\s+(.+)$/i.exec(name.trim())
  return m ? m[1].trim().slice(0, 60) : null
}

/** A model-found place counts only when its name really appears in the stored text (accent and case blind). */
export function placeIsStated(place: { name: string }, hay: string): boolean {
  return containsPhrase(hay, place.name)
}

// ─── The dates and hours a stored itinerary may state ───────────────────────────────

const addDays = (ymd: string, n: number): string | null => {
  const d = new Date(`${ymd}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return null
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/** Day N of a trip that starts on `start`. Null when either is missing. */
export function dateOfDay(start: string | null | undefined, day: number | null | undefined): string | null {
  if (!start || !day || day < 1 || day > 60 || !/^\d{4}-\d{2}-\d{2}$/.test(start)) return null
  return addDays(start, day - 1)
}

const TIME = String.raw`(\d{1,2}(?::\d{2})?\s?(?:am|pm|a\.m\.|p\.m\.)|\d{1,2}:\d{2})`

/** "Arrive 8:00 am, depart 5:00 pm" ONLY when the stored text says it. Null parts when it does not. Pure. */
export function timesFromText(text: string): { arrive: string | null; depart: string | null } {
  const grab = (verbs: string) => new RegExp(`\\b(?:${verbs})\\w*\\b[^.\\n]{0,20}?\\b(?:at|by|around)?\\s*${TIME}`, 'i').exec(text)?.[1]?.replace(/\s+/g, ' ').trim() ?? null
  return { arrive: grab('arriv|dock|berth'), depart: grab('depart|sail|leav') }
}

// ─── Rendering decisions the page and the tests share ───────────────────────────────

export interface KitRowInput {
  name: string
  destination: string
  duration: string
  available_from: string | null
  available_to: string | null
  departure_dates: string[] | null
  price_includes: string | null
  not_included: string | null
  itinerary: unknown
  supplier?: string | null
}

export interface KeyFact {
  label: string
  value: string
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
function niceDate(ymd: string, withYear: boolean): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd)
  if (!m) return ymd
  return `${MONTHS[Number(m[2]) - 1] ?? ''} ${Number(m[3])}${withYear ? `, ${m[1]}` : ''}`
}

/** "Sep 4 to 8, 2026", "Jan 23 to Feb 14, 2027". No dashes anywhere. */
export function dateRangeText(from: string | null, to: string | null): string | null {
  if (from && to && from !== to) {
    const a = /^(\d{4})-(\d{2})/.exec(from)
    const b = /^(\d{4})-(\d{2})/.exec(to)
    if (a && b && a[1] === b[1] && a[2] === b[2]) return `${niceDate(from, false)} to ${Number(to.slice(8, 10))}, ${b[1]}`
    if (a && b && a[1] === b[1]) return `${niceDate(from, false)} to ${niceDate(to, true)}`
    return `${niceDate(from, true)} to ${niceDate(to, true)}`
  }
  const one = from || to
  return one ? niceDate(one, true) : null
}

/** The key facts strip: only values that are stored. A fact with no value is not drawn. Pure. */
export function buildKeyFacts(pkg: KitRowInput, kit: TripKit | null): KeyFact[] {
  const facts: KeyFact[] = []
  const dates = dateRangeText(pkg.available_from, pkg.available_to)
  if (dates) facts.push({ label: 'Dates', value: dates })
  else if ((pkg.departure_dates ?? []).filter(Boolean).length) facts.push({ label: 'Departures', value: (pkg.departure_dates ?? []).filter(Boolean).map((d) => niceDate(d, true)).join(' and ') })
  if (pkg.duration?.trim()) facts.push({ label: 'Length', value: pkg.duration.trim() })
  if (pkg.destination?.trim()) facts.push({ label: 'Where', value: pkg.destination.trim() })
  const stay = kit?.stops.find((s) => s.kind === 'stay')
  if (stay) facts.push({ label: 'Stay', value: stay.name })
  const start = kit?.stops.find((s) => s.kind === 'start')
  if (start) facts.push({ label: 'Starts in', value: start.name })
  const host = hostFromName(pkg.name)
  if (host) facts.push({ label: 'Hosted with', value: host })
  return facts.slice(0, 6)
}

function listOf(v: string | null | undefined): string[] {
  return (v ?? '').split('\n').map((x) => x.trim()).filter(Boolean)
}

/** What's included / not included, from the row's own lists first, then the kit's sourced items. Flights are stated only when
 * a stored source says so. No price text ever. Pure. */
export function inclusionBlocks(pkg: Pick<KitRowInput, 'price_includes' | 'not_included'>, kit: TripKit | null): { included: KitFact[]; notIncluded: KitFact[] } {
  const own = (items: string[]): KitFact[] => items.filter((t) => !isPriceText(t)).map((text) => ({ label: '', text, source: { label: 'Trip details', url: null } }))
  const merge = (a: KitFact[], b: KitFact[]): KitFact[] => {
    const out = [...a]
    for (const f of b) if (!isPriceText(f.text) && !out.some((x) => fold(x.text) === fold(f.text))) out.push(f)
    return out.slice(0, 14)
  }
  return { included: merge(own(listOf(pkg.price_includes)), kit?.included ?? []), notIncluded: merge(own(listOf(pkg.not_included)), kit?.notIncluded ?? []) }
}

/** True when the page may show a price: only with a complete agent confirmation. */
export const mayShowPrice = (confirmed: PriceConfirmed | null): boolean => !!confirmed

/** Wikipedia/Wikivoyage attribution lines for the kit, de-duplicated by url. Pure. */
export function attributionList(stops: KitStop[]): KitSource[] {
  const seen = new Set<string>()
  const out: KitSource[] = []
  for (const s of stops) {
    for (const src of [s.source, ...s.things.map((t) => t.source)]) {
      if (!src.url || !/wiki(voyage|pedia)/i.test(src.label) || seen.has(src.url)) continue
      seen.add(src.url)
      out.push(src)
    }
  }
  return out.slice(0, 6)
}

// ─── The "to confirm with an agent" list ────────────────────────────────────────────

/** What the stored data does NOT say, so an agent can fill it in. Admin only. Pure. */
export function buildToConfirm(input: {
  pkg: KitRowInput
  kit: Pick<TripKit, 'stops' | 'included' | 'notIncluded' | 'goodToKnow' | 'routeKnown' | 'otherStops'>
  sourceText: string
  priceMentions: string[]
  extra?: string[]
}): string[] {
  const out: string[] = [...(input.extra ?? [])]
  const text = input.sourceText
  const hasFlightsFact = /\b(?:flights?|air ?fare)\b[^.]{0,40}\b(?:included|excluded)|\b(?:includes?|including)\b[^.]{0,30}\b(?:flights?|air ?fare)/i.test(text) ||[...input.kit.included, ...input.kit.notIncluded, ...input.kit.goodToKnow].some((f) => /flight|air ?fare/i.test(`${f.label} ${f.text}`)) || /flights?|air ?fare/i.test(`${input.pkg.price_includes ?? ''} ${input.pkg.not_included ?? ''}`)
  if (!hasFlightsFact) out.push('Are flights included? No stored source says. The page says nothing about flights until this is known.')
  if (!/deposit/i.test(text)) out.push('Deposit amount and the date it is due: not in any stored source.')
  if (!/final payment|balance/i.test(text)) out.push('Final payment date: not in any stored source.')
  if (!/cancel|refund/i.test(text)) out.push('Cancellation terms: not in any stored source (the page says to ask your agent).')
  if (!/passport|visa/i.test(text)) out.push('Passport and visa notes: not in any stored source (the page says to ask your agent).')
  if (input.kit.routeKnown === false && input.kit.stops.length > 0) out.push('The day by day route is not stored. Add the itinerary (Add details) to replace "Where you are headed" with a full route.')
  if (!/\b(arriv|depart|dock|berth)\w*[^.\n]{0,30}\d{1,2}[:.]\d{2}/i.test(text) && input.kit.stops.length > 0) out.push('Hours in port (arrival and departure times) for each stop: not stored, so the page shows none.')
  if (/all[- ]inclusive/i.test(text) && !input.kit.included.some((f) => /all[- ]inclusive|drinks|meals|food/i.test(f.text))) out.push('What "all inclusive" covers at this resort (drinks, restaurants, activities): confirm with the supplier.')
  for (const p of input.priceMentions) out.push(`Price wording found in a stored text and kept OFF the page: "${p.slice(0, 120)}". Confirm it, then tick "Price confirmed by an agent".`)
  for (const o of input.kit.otherStops) out.push(`"${o}" is on the route but has no card (no reference page matched, or the card limit was reached). Check the spelling if it matters.`)
  return [...new Set(out)].slice(0, 30)
}

// ─── Reference pages (Wikivoyage / Wikipedia, CC BY-SA) ─────────────────────────────

export interface RefItem {
  name: string
  blurb: string
}

export interface Reference {
  /** The place as the trip names it. */
  place: string
  /** The reference page title that was matched. */
  title: string
  label: 'Wikivoyage' | 'Wikipedia'
  url: string
  /** Up to three sentences, with every sentence that holds a digit, money or hours removed. */
  intro: string
  see: RefItem[]
  doItems: RefItem[]
  /** The first 600 characters of the page, unfiltered. Only used to check the page is about the right place. */
  context: string
}

const SECTION_RE = /^==\s*([^=][^=]*?)\s*==\s*$/gm

function sectionBody(extract: string, name: string): string {
  const heads = [...extract.matchAll(SECTION_RE)]
  const i = heads.findIndex((h) => h[1].trim().toLowerCase() === name.toLowerCase())
  if (i < 0) return ''
  const start = (heads[i].index ?? 0) + heads[i][0].length
  const end = heads[i + 1]?.index ?? extract.length
  return extract.slice(start, end)
}

/** The named things in a "See" or "Do" section: list lines, each reduced to a name and one clean sentence. No hours, prices,
 * phone numbers or addresses are kept. Pure. */
export function itemsOfSection(body: string, max = 14): RefItem[] {
  const out: RefItem[] = []
  for (const raw of body.split('\n')) {
    const line = raw.trim()
    if (!line || /^=+/.test(line) || line.length > 700) continue
    // Only list lines count: a numbered line ("5 Sponza Palace ...") or an indented one. Plain paragraphs are prose.
    if (!/^\d+\s/.test(line) && !/^\s/.test(raw)) continue
    const m = /^(?:\d+\s+)?([A-ZÀ-Ý][^(,.;:@—]{2,52}?)(?:\s*[(,.;:]|$)(.*)$/.exec(line)
    if (!m) continue
    const name = m[1].trim()
    if (/\d/.test(name) || name.split(/\s+/).length > 7 || /\b(?:is|are|was|were|has|have)\b/.test(name) || /^(?:see|note|the following|for more|there (?:is|are))\b/i.test(name)) continue
    if (out.some((x) => fold(x.name) === fold(name))) continue
    out.push({ name, blurb: scrubReferenceText(m[2].replace(/^[\s).,;:]+/, ''), 1) })
    if (out.length >= max) break
  }
  return out
}

/** Reads a Wikivoyage plain-text extract. Null when the page is missing, tiny or a disambiguation page. Pure. */
export function parseWikivoyageExtract(place: string, title: string, extract: string, url: string): Reference | null {
  const x = extract.replace(/\r/g, '')
  if (x.length < 300 || /may refer to|disambiguation/i.test(x.slice(0, 400))) return null
  const intro = scrubReferenceText(x.split(/\n==/)[0] ?? '', 3)
  const see = itemsOfSection(sectionBody(x, 'See'))
  const doItems = itemsOfSection(sectionBody(x, 'Do'))
  return { place, title, label: 'Wikivoyage', url, intro, see, doItems, context: x.slice(0, 600) }
}

/** Reads a Wikipedia REST summary object. Null for a missing page or a disambiguation page. Pure. */
export function parseWikipediaSummary(place: string, j: unknown): Reference | null {
  if (!isObj(j) || j.type === 'disambiguation' || typeof j.extract !== 'string') return null
  const title = str(j.title, 100)
  const urls = isObj(j.content_urls) && isObj(j.content_urls.desktop) ? str(j.content_urls.desktop.page, 400) : ''
  if (!title || !/^https:\/\//.test(urls)) return null
  const intro = scrubReferenceText(j.extract as string, 3)
  if (!intro) return null
  return { place, title, label: 'Wikipedia', url: urls, intro, see: [], doItems: [], context: (j.extract as string).slice(0, 600) }
}

/** Words that tie a reference page to THIS trip: its destination, country, region and the place's own region. A page that
 * mentions none of them is probably a different place with the same name and is thrown away. Pure. */
export function contextTokens(parts: (string | null | undefined)[]): string[] {
  const stop = new Set(['trip', 'tour', 'cruise', 'group', 'getaway', 'escape', 'river', 'island', 'islands', 'coast', 'resort', 'with', 'the', 'and', 'for', 'new', 'years', 'fun', 'people'])
  const out = new Set<string>()
  for (const p of parts) for (const w of fold(p ?? '').split(/[^a-z]+/)) if (w.length >= 4 && !stop.has(w)) out.add(w)
  return [...out]
}

export function referenceIsRelevant(ref: Reference, tokens: string[]): boolean {
  if (tokens.length === 0) return true
  const hay = fold(`${ref.title} ${ref.context}`)
  return tokens.some((t) => hay.includes(t))
}
