// Past trip mode of the Trip Page Kit (pure: no database, no network, no React). A trip whose last date has passed keeps its
// page, URL and place in the sitemap, and becomes a recap that earns leads: it says the trip happened, shows what is really
// known, and sends the reader to "plan a trip like this". Everything the page and the tests agree on lives here.
//
// Rules, in plain words:
//  * No price, no "book now", no link to the supplier page, ever, on a past trip page.
//  * Words that only mean "the supplier page is dead now" (cancelled, sold out, no longer available ...) are never page
//    facts for a past trip: the trip happened.
//  * "What the trip included" comes only from stored facts, never from a supplier page.
//  * Structured data names the dates but carries NO offer and NO availability.

import { splitSentencesSafe } from '@/lib/sentence-safe'
import { fold, isPriceText, type TripKit, type KitFact } from '@/lib/trip-kit-facts'
import { isPastTrip, happenedLabel } from '@/lib/past-trip'
import { buildBreadcrumbJsonLd } from '@/lib/jsonld'

// ─── Supplier-page words ────────────────────────────────────────────────────────────

/** Wording that describes a supplier page or a booking state, not the trip. After the date it is noise at best, a false claim
 * at worst ("Tour Cancelled" on a tour that ran). */
export const SUPPLIER_STATUS_RE =
  /\bcancel+ed\b|\bcancel+ation of (?:this|the) (?:tour|trip|sailing|departure)\b|\bno longer (?:available|operating|offered|active|running|bookable|on sale)\b|\bsold[- ]?out\b|\bwait ?list(?:ed)?\b|\bnot (?:currently )?available\b|\bcurrently unavailable\b|\b(?:book|reserve|register)(?: it)?(?: now| today| online| your (?:spot|place|cabin|space))\b|\b(?:spots?|seats?|cabins?|rooms?|spaces?) (?:left|remaining|available)\b|\blimited (?:space|spaces|spots|availability)\b|\bavailability\b|\bdeposit\b|\bfinal payment\b|\bpage (?:not found|no longer|has expired)\b|\b404\b|\bexpired\b|\bsign up now\b|\bcontact for pricing\b|\bjoin the next trip\b/i

export const hasSupplierWords = (text: string): boolean => SUPPLIER_STATUS_RE.test(text)

/** The text without any sentence that holds supplier-page words or money. Pure; only removes, never adds. */
export function stripSupplierSentences(text: string): string {
  return splitSentencesSafe(text)
    .filter((s) => !SUPPLIER_STATUS_RE.test(s) && !isPriceText(s))
    .join(' ')
}

/** Text safe to show on a past trip page: supplier words and money removed, '' when nothing is left. */
export const pastSafeText = (text: string | null | undefined): string => (text ? stripSupplierSentences(text).trim() : '')

interface FieldLike {
  id: string
  key: string
  format: string
  value: string
}

/** The trip text fields (lib/affiliate-text-sources.ts tripFieldSet) cleaned for a past trip. A field with nothing left is
 * dropped. Generic over the field-set shape so the page can feed the result straight to the affiliate linker. */
export function pastSafeFieldSet<T extends { fields: FieldLike[]; recap: FieldLike[]; recapHighlights: FieldLike[]; journal: FieldLike[]; description: FieldLike[]; highlights: FieldLike[]; included: FieldLike[]; notIncluded: FieldLike[]; itinerary: { day: number | null; title: string; description: string; field: FieldLike | null }[]; faqs: { question: string; answer: string; field: FieldLike }[] }>(fs: T): T {
  const clean = (f: FieldLike): FieldLike | null => {
    const value = pastSafeText(f.value)
    return value ? { ...f, value } : null
  }
  const list = (a: FieldLike[]) => a.map(clean).filter((f): f is FieldLike => !!f)
  const recap = fs.recap // the recap is written by the agency after the trip: kept as written
  const description = list(fs.description)
  const highlights = list(fs.highlights)
  const included = list(fs.included)
  const notIncluded = list(fs.notIncluded)
  const itinerary = fs.itinerary.map((d) => {
    const f = d.field ? clean(d.field) : null
    return { ...d, description: f ? f.value : '', field: f }
  })
  const faqs = fs.faqs
    .filter((f) => !SUPPLIER_STATUS_RE.test(`${f.question} ${f.answer}`) && !isPriceText(`${f.question} ${f.answer}`))
    .map((f) => ({ ...f, field: { ...f.field, value: f.answer } }))
  const fields = [
    ...recap,
    ...fs.recapHighlights,
    ...fs.journal,
    ...description,
    ...highlights,
    ...itinerary.flatMap((d) => (d.field ? [d.field] : [])),
    ...included,
    ...notIncluded,
    ...faqs.map((f) => f.field),
  ]
  return { ...fs, fields, description, highlights, included, notIncluded, itinerary, faqs }
}

/** The stored kit made safe for a past trip page: no supplier-sourced facts, no supplier words anywhere. */
export function cleanKitForPast(kit: TripKit | null): TripKit | null {
  if (!kit) return null
  const okFact = (f: KitFact) => f.source.label !== 'Supplier page' && !SUPPLIER_STATUS_RE.test(`${f.label} ${f.text}`) && !isPriceText(f.text)
  return {
    ...kit,
    promise: kit.promise && !SUPPLIER_STATUS_RE.test(kit.promise) ? kit.promise : null,
    stops: kit.stops.map((s) => ({ ...s, things: s.things.filter((t) => !SUPPLIER_STATUS_RE.test(t.text)) })),
    included: kit.included.filter(okFact),
    notIncluded: kit.notIncluded.filter(okFact),
    goodToKnow: kit.goodToKnow.filter(okFact),
    toConfirm: [],
  }
}

// ─── Title, description, FAQ ────────────────────────────────────────────────────────

const TITLE_MAX = 60
const TITLE_MIN = 30

/** "<Trip> recap | May 2026", within 30 to 60 characters. The host part of a name ("w/ Amy & Liz") goes first when it is
 * too long; the destination is added when the title would be too short. Pure. */
export function pastTripTitle(input: { name: string; destination?: string | null; from?: string | null; to?: string | null }): string {
  const when = happenedLabel(input.from, input.to)
  const full = input.name.replace(/\s+/g, ' ').trim()
  const noHost = full.split(/\s+(?:w\/|with)\s+/i)[0].trim() || full
  const build = (n: string, tail: string | null) => (tail ? `${n} recap | ${tail}` : `${n} recap`)
  for (const n of [full, noHost]) {
    const t = build(n, when)
    if (t.length <= TITLE_MAX) return grow(t, input.destination, n)
  }
  const bare = build(noHost, null)
  if (bare.length <= TITLE_MAX) return grow(bare, input.destination, noHost)
  // Last resort: cut the name at a word boundary so "recap" always survives.
  const room = TITLE_MAX - ' recap'.length - 1
  return `${noHost.slice(0, room).replace(/\s+\S*$/, '').trim()}… recap`.slice(0, TITLE_MAX)
}

function grow(title: string, destination: string | null | undefined, name: string): string {
  if (title.length >= TITLE_MIN || !destination?.trim() || fold(name).includes(fold(destination))) return title
  const t = `${title} | ${destination.trim()}`
  return t.length <= TITLE_MAX ? t : title
}

/** Meta description for a past trip: the stored text with supplier words removed, else a plain honest line. 70 to 155 characters when possible. */
export function pastTripDescription(input: { name: string; destination: string; metaDescription?: string | null; shortDescription?: string | null; from?: string | null; to?: string | null }): string {
  const when = happenedLabel(input.from, input.to)
  const stored = pastSafeText(input.metaDescription) || pastSafeText(input.shortDescription)
  const fallback = `See how ${input.name} went in ${input.destination}${when ? ` in ${when}` : ''}. Ask a travel specialist about planning a trip like this one.`
  const text = stored.length >= 70 ? stored : stored ? `${stored} ${fallback}` : fallback
  return text.length <= 155 ? text : `${text.slice(0, 152).replace(/\s+\S*$/, '')}…`
}

export interface PastFaq {
  question: string
  answer: string
}

/** FAQ of a past trip: the stored ones that are safe, then the three every visitor asks. "Can I still travel this route?" is always there. */
export function pastTripFaqs(input: { name: string; destination: string; stored: PastFaq[]; from?: string | null; to?: string | null; phone?: string | null }): PastFaq[] {
  const when = happenedLabel(input.from, input.to)
  const out: PastFaq[] = input.stored.filter((f) => !SUPPLIER_STATUS_RE.test(`${f.question} ${f.answer}`) && !isPriceText(`${f.question} ${f.answer}`))
  const add = (question: string, answer: string) => {
    if (!out.some((f) => fold(f.question) === fold(question))) out.push({ question, answer })
  }
  if (when) add('When did this trip happen?', `${input.name} ran in ${when}.`)
  add('Can I still travel this route?', `This departure has finished, but a travel specialist can help you plan a similar trip to ${input.destination}. Use the form on this page${input.phone ? ` or call or text ${input.phone}` : ''}, and tell us what you have in mind.`)
  add('Will there be another trip like this?', 'Join the waitlist on this page and we will email you when the next one opens. A travel specialist can also tell you what is coming up.')
  return out
}

// ─── Similar trips ──────────────────────────────────────────────────────────────────

export interface SimilarCandidate {
  slug: string
  name: string
  destination: string
  country?: string | null
  region?: string | null
  available_from: string | null
  available_to: string | null
  recap_mode?: string | null
  short_description?: string | null
  image_url?: string | null
}

export type SimilarBasis = 'destination' | 'region' | 'nearest' | 'none'

const dateKey = (c: { available_from: string | null }) => c.available_from ?? '9999-99-99'

/** "Similar trips coming up": upcoming published trips for the same destination, else the same country or region, else the
 * nearest upcoming ones. Never a past trip, never the trip itself. Pure. */
export function pickSimilarTrips<T extends SimilarCandidate>(
  past: Pick<SimilarCandidate, 'slug' | 'destination' | 'country' | 'region'>,
  candidates: T[],
  today: string,
  limit = 3,
): { trips: T[]; basis: SimilarBasis } {
  const upcoming = candidates
    .filter((c) => c.slug && c.name && c.slug !== past.slug && !isPastTrip(c, today))
    .map((c, i) => ({ c, i }))
    .sort((a, b) => (dateKey(a.c) === dateKey(b.c) ? a.i - b.i : dateKey(a.c) < dateKey(b.c) ? -1 : 1))
    .map((x) => x.c)
  const same = (a?: string | null, b?: string | null) => !!a && !!b && fold(a) === fold(b)
  const overlaps = (a?: string | null, b?: string | null) => !!a && !!b && (fold(a).includes(fold(b)) || fold(b).includes(fold(a)))
  const dest = upcoming.filter((c) => overlaps(c.destination, past.destination))
  if (dest.length) return { trips: dest.slice(0, limit), basis: 'destination' }
  const region = upcoming.filter((c) => same(c.country, past.country) || same(c.region, past.region) || overlaps(c.country, past.destination) || overlaps(past.country, c.destination))
  if (region.length) return { trips: region.slice(0, limit), basis: 'region' }
  if (upcoming.length) return { trips: upcoming.slice(0, limit), basis: 'nearest' }
  return { trips: [], basis: 'none' }
}

// ─── Photos ─────────────────────────────────────────────────────────────────────────

const safeName = (slug: string) => `${slug}-recap`.replace(/[^a-z0-9-]/gi, '_').toLowerCase()

/** Photos the Recap Studio put into the gallery are stored under "<slug>-recap-<time>-...". Those are real trip photos; every
 * other gallery picture is a stock picture of a place. Pure. */
export function splitGallery(urls: string[] | null | undefined, slug: string): { real: string[]; stock: string[] } {
  const key = `${safeName(slug)}-`
  const real: string[] = []
  const stock: string[] = []
  for (const u of urls ?? []) {
    if (!u) continue
    const file = u.split('?')[0].split('/').pop()?.toLowerCase() ?? ''
    if (file.startsWith(key) && /-recap-\d{8,}/.test(file)) real.push(u)
    else stock.push(u)
  }
  return { real, stock }
}

// ─── Structured data ────────────────────────────────────────────────────────────────

export interface PastJsonLdInput {
  name: string
  description: string
  url: string
  image: string
  category: string
  destination: string
  startDate: string | null
  endDate: string | null
  stops: string[]
  faqs: PastFaq[]
  siteName: string
  siteUrl: string
  breadcrumbs: { name: string; url: string }[]
}

/** TouristTrip with its real dates and NO offer and NO availability, plus FAQPage and BreadcrumbList. Pure. */
export function buildPastTripJsonLd(i: PastJsonLdInput): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [
    {
      '@context': 'https://schema.org',
      '@type': 'TouristTrip',
      name: i.name,
      description: i.description,
      url: i.url,
      image: i.image,
      touristType: i.category,
      itinerary: i.stops.length
        ? { '@type': 'ItemList', itemListElement: i.stops.map((s, n) => ({ '@type': 'ListItem', position: n + 1, name: s })) }
        : { '@type': 'Place', name: i.destination },
      ...(i.startDate ? { startDate: i.startDate } : {}),
      ...(i.endDate ? { endDate: i.endDate } : {}),
      provider: { '@type': 'TravelAgency', name: i.siteName, url: i.siteUrl },
    },
  ]
  if (i.faqs.length) {
    out.push({
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: i.faqs.map((f) => ({ '@type': 'Question', name: f.question, acceptedAnswer: { '@type': 'Answer', text: f.answer } })),
    })
  }
  if (i.breadcrumbs.length >= 2) out.push(buildBreadcrumbJsonLd(i.breadcrumbs))
  return out
}

// ─── Upcoming lists ─────────────────────────────────────────────────────────────────

/** The rows that are NOT past trips: for every "upcoming" list (home, trips index, links, blog cards). The sitemap and the
 * trip's own page keep past trips. Pure. */
export function excludePast<T extends { available_to: string | null; recap_mode?: string | null }>(rows: T[], today?: string): T[] {
  return rows.filter((r) => !isPastTrip(r, today))
}

// ─── Recap status (admin) ───────────────────────────────────────────────────────────

export interface RecapStatus {
  past: boolean
  photos: number
  quotes: number
  hasRecapText: boolean
  todo: string[]
}

/** The "Recap status" line of a past trip in the admin: real photos, approved quotes, and what is still to do. Pure. */
export function recapStatusOf(input: { slug: string; available_to: string | null; recap_mode?: string | null; gallery_urls?: string[] | null; recap_summary?: string | null; quotes: number }, today?: string): RecapStatus {
  const past = isPastTrip(input, today)
  const photos = splitGallery(input.gallery_urls, input.slug).real.length
  const hasRecapText = !!input.recap_summary && input.recap_summary.trim().length > 0
  const todo: string[] = []
  if (past) {
    if (photos < 3) todo.push(photos === 0 ? 'Add real trip photos (Recap Studio)' : `Add more real trip photos (${photos} so far, 3 or more is better)`)
    if (input.quotes === 0) todo.push('Ask travellers for a quote (needs their permission)')
    if (!hasRecapText) todo.push('Write and publish the recap')
  }
  return { past, photos, quotes: input.quotes, hasRecapText, todo }
}
