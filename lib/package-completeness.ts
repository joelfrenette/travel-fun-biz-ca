// How complete a trip page is, as a 0-100 score with plain reasons (growth loop WP11). Pure: no database, no
// network, so the admin list, the Needs attention items, the 7 am brief and the check script all agree.
//
// Weights: full description of 400+ words (30), 4+ highlights (15), what is included (10), what is not
// included (5), an itinerary of 3+ days or a dated outline (15), 3+ FAQs (10), 3+ gallery images (10),
// departure dates or a start/end window (5). Under 60 is "thin".

export const THIN_BELOW = 60
export const FULL_DESCRIPTION_MIN_WORDS = 400

/** The fields the score reads. A DbPackage satisfies this; a test can pass a few fields. */
export interface CompletenessInput {
  full_description?: string | null
  highlights?: string[] | null
  price_includes?: string | string[] | null
  not_included?: string | string[] | null
  itinerary?: unknown
  ai_faqs?: unknown
  gallery_urls?: string[] | null
  departure_dates?: string[] | null
  available_from?: string | null
  available_to?: string | null
}

export interface Completeness {
  score: number
  /** One line per missing or weak part, in plain words. */
  reasons: string[]
  thin: boolean
}

function wordCount(text: string | null | undefined): number {
  return (text ?? '').trim().split(/\s+/).filter(Boolean).length
}

function hasText(v: string | string[] | null | undefined): boolean {
  if (Array.isArray(v)) return v.some((x) => typeof x === 'string' && x.trim().length > 0)
  return typeof v === 'string' && v.trim().length > 0
}

/** Stops in an itinerary that the trip page can show. */
function itineraryDays(itinerary: unknown): number {
  // Only what the trip page actually shows counts: an array of stops that each have a title.
  if (!Array.isArray(itinerary)) return 0
  return itinerary.filter((d) => d && typeof d === 'object' && typeof (d as { title?: unknown }).title === 'string' && (d as { title: string }).title.trim()).length
}

function faqCount(faqs: unknown): number {
  if (!Array.isArray(faqs)) return 0
  return faqs.filter((f) => {
    const o = f as { question?: unknown; q?: unknown; answer?: unknown; a?: unknown }
    return (typeof o?.question === 'string' || typeof o?.q === 'string') && (typeof o?.answer === 'string' || typeof o?.a === 'string')
  }).length
}

export function completenessScore(pkg: CompletenessInput): Completeness {
  let score = 0
  const reasons: string[] = []

  const words = wordCount(pkg.full_description)
  if (words >= FULL_DESCRIPTION_MIN_WORDS) score += 30
  else reasons.push(words === 0 ? 'no full description' : `the full description is only ${words} words (needs ${FULL_DESCRIPTION_MIN_WORDS}+)`)

  const highlights = (pkg.highlights ?? []).filter((h) => typeof h === 'string' && h.trim()).length
  if (highlights >= 4) score += 15
  else reasons.push(highlights === 0 ? 'no highlights' : `only ${highlights} highlight${highlights === 1 ? '' : 's'} (needs 4+)`)

  if (hasText(pkg.price_includes)) score += 10
  else reasons.push('no list of what is included')

  if (hasText(pkg.not_included)) score += 5
  else reasons.push('no list of what is not included')

  const days = itineraryDays(pkg.itinerary)
  if (days >= 3) score += 15
  else reasons.push(days === 0 ? 'no itinerary' : `the itinerary has only ${days} day${days === 1 ? '' : 's'} (needs 3+)`)

  const faqs = faqCount(pkg.ai_faqs)
  if (faqs >= 3) score += 10
  else reasons.push(faqs === 0 ? 'no FAQs' : `only ${faqs} FAQ${faqs === 1 ? '' : 's'} (needs 3+)`)

  const gallery = (pkg.gallery_urls ?? []).filter((u) => typeof u === 'string' && u.trim()).length
  if (gallery >= 3) score += 10
  else reasons.push(gallery === 0 ? 'no gallery photos' : `only ${gallery} gallery photo${gallery === 1 ? '' : 's'} (needs 3+)`)

  const hasDates = (pkg.departure_dates ?? []).some((d) => typeof d === 'string' && d.trim()) || !!(pkg.available_from || pkg.available_to)
  if (hasDates) score += 5
  else reasons.push('no departure dates')

  return { score, reasons, thin: score < THIN_BELOW }
}
