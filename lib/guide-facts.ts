import { SCOPE_LABEL, type GuideScope } from '@/lib/guide-scope'

// The facts block of a guide page (growth loop WP16, part 5): a key-facts table, a bullet list of the trips, a route
// diagram and a trip-length chart. FACTS ONLY. Every row is built from something stored: the guide row itself, a
// published trip on the site, or the existence of a site page. Nothing is generated and nothing is looked up. A row
// whose source is empty is not drawn; a diagram or chart whose data is missing is left out entirely (no empty
// frame, no placeholder). Pure code, so the offline check can prove each rule.

/** The stored trip fields the facts use. All come straight from a published travel_packages row. */
export interface TripFact {
  id: string
  slug: string
  name: string
  category: string | null
  destination: string | null
  duration_days: number | null
  available_from: string | null
  available_to: string | null
  /** travel_packages.itinerary: an array of { day, title, description } when the source gave one. */
  itinerary: unknown
}

export interface FactRow {
  label: string
  value: string
  href?: string
  /** Where the value comes from. 'page' = the guide row, 'trip' = a published trip, 'site' = another page on this site. */
  source: 'page' | 'trip' | 'site'
}

export interface FactsInput {
  kindLabel: string
  scope: GuideScope | null
  parent: { name: string; path: string } | null
  trips: TripFact[]
  bestTime: { destination: string; path: string } | null
  childCount: number
  now?: Date
}

const parseDay = (s: string | null): Date | null => {
  if (!s) return null
  const d = new Date(`${s}T00:00:00`)
  return Number.isNaN(d.getTime()) ? null : d
}

const fmt = (d: Date, withYear: boolean) => d.toLocaleDateString('en-CA', withYear ? { month: 'short', day: 'numeric', year: 'numeric' } : { month: 'short', day: 'numeric' })

/** "Mar 3 to Mar 10, 2027" from two stored dates, or null when neither is a date. No dash characters. */
export function dateRangeText(from: string | null, to: string | null): string | null {
  const a = parseDay(from)
  const b = parseDay(to)
  if (!a && !b) return null
  if (a && b) return a.getFullYear() === b.getFullYear() ? `${fmt(a, false)} to ${fmt(b, true)}` : `${fmt(a, true)} to ${fmt(b, true)}`
  return fmt((a ?? b) as Date, true)
}

/** Stops of a stored itinerary: the day number and title of each item that has a title. Anything else in the field is ignored. */
export function itineraryStops(itinerary: unknown): { day: number | null; title: string }[] {
  if (!Array.isArray(itinerary)) return []
  const out: { day: number | null; title: string }[] = []
  for (const item of itinerary) {
    if (!item || typeof item !== 'object') continue
    const title = typeof (item as { title?: unknown }).title === 'string' ? (item as { title: string }).title.replace(/\s+/g, ' ').trim() : ''
    if (!title || title.length > 90) continue
    const day = (item as { day?: unknown }).day
    out.push({ day: typeof day === 'number' && Number.isFinite(day) && day > 0 ? Math.floor(day) : null, title })
  }
  return out
}

/** The upcoming trips (a stored end or start date today or later). A trip with no stored date is not "upcoming". */
function upcoming(trips: TripFact[], now: Date): TripFact[] {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  return trips.filter((t) => {
    const end = parseDay(t.available_to) ?? parseDay(t.available_from)
    return !!end && end.getTime() >= today.getTime()
  })
}

/** The rows of the key-facts table. A row appears only when its stored source has something to say. Pure. */
export function buildKeyFacts(input: FactsInput): FactRow[] {
  const rows: FactRow[] = []
  rows.push({ label: 'Page type', value: input.scope ? `${SCOPE_LABEL[input.scope]} guide` : `${input.kindLabel} guide`, source: 'page' })
  if (input.parent) rows.push({ label: 'Sits under', value: input.parent.name, href: input.parent.path, source: 'site' })
  if (input.trips.length > 0) {
    rows.push({ label: 'Trips on our site', value: `${input.trips.length} ${input.trips.length === 1 ? 'trip' : 'trips'}`, source: 'trip' })
    const categories = [...new Set(input.trips.map((t) => (t.category ?? '').trim()).filter(Boolean))]
    if (categories.length > 0) rows.push({ label: 'Trip types', value: categories.join(', '), source: 'trip' })
    const next = upcoming(input.trips, input.now ?? new Date())
      .map((t) => ({ t, start: parseDay(t.available_from) ?? parseDay(t.available_to) }))
      .filter((x): x is { t: TripFact; start: Date } => !!x.start)
      .sort((a, b) => a.start.getTime() - b.start.getTime())[0]
    const range = next ? dateRangeText(next.t.available_from, next.t.available_to) : null
    if (next && range) rows.push({ label: 'Next trip', value: `${next.t.name}, ${range}`, href: `/packages/${next.t.slug}`, source: 'trip' })
  }
  if (input.bestTime) rows.push({ label: 'Best time to visit', value: `See when to visit ${input.bestTime.destination}`, href: input.bestTime.path, source: 'site' })
  if (input.childCount > 0) rows.push({ label: 'More pages under this one', value: String(input.childCount), source: 'site' })
  return rows
}

/** One bullet per trip: its name, its stored dates and its stored type, linking to the trip. Pure. */
export function tripBullets(trips: TripFact[]): { text: string; href: string }[] {
  return trips.map((t) => {
    const range = dateRangeText(t.available_from, t.available_to)
    const parts = [t.name, range, (t.category ?? '').trim() || null].filter((x): x is string => !!x)
    return { text: parts.join(' | '), href: `/packages/${t.slug}` }
  })
}

export interface RouteDiagram {
  tripName: string
  tripSlug: string
  stops: { day: number | null; title: string }[]
}

/** The route to draw: the trip with the most stored itinerary stops, if it has at least three. Null otherwise, and then
 * no diagram is drawn. Ties go to the trip listed first. Pure. */
export function pickRoute(trips: TripFact[], minStops = 3, maxStops = 12): RouteDiagram | null {
  let best: RouteDiagram | null = null
  for (const t of trips) {
    const stops = itineraryStops(t.itinerary)
    if (stops.length >= minStops && (!best || stops.length > best.stops.length)) best = { tripName: t.name, tripSlug: t.slug, stops: stops.slice(0, maxStops) }
  }
  return best
}

export interface LengthBar {
  name: string
  slug: string
  days: number
}

/** Trip lengths for a bar chart: needs at least two trips with a stored length in days. Null otherwise (no chart). Pure. */
export function tripLengthBars(trips: TripFact[]): LengthBar[] | null {
  const bars = trips
    .filter((t) => typeof t.duration_days === 'number' && Number.isFinite(t.duration_days) && (t.duration_days as number) > 0)
    .map((t) => ({ name: t.name, slug: t.slug, days: Math.floor(t.duration_days as number) }))
  return bars.length >= 2 ? bars.slice(0, 8) : null
}

/** `tel:` address for a phone number shown on the site, or null when the digits are not a North American number. */
export function telHref(phone: string | null | undefined): string | null {
  const digits = (phone ?? '').replace(/\D/g, '')
  if (digits.length === 10) return `tel:+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `tel:+${digits}`
  return null
}

/** Enquiry link for a call to action: the contact form with the trip pre-chosen. The query string goes BEFORE the
 * hash (a query after the hash is never read). No named trip falls back to "Custom Package". */
export function enquiryHref(packageName?: string | null): string {
  const name = (packageName ?? '').replace(/\s+/g, ' ').trim()
  return `/?package=${encodeURIComponent(name || 'Custom Package')}#contact`
}
