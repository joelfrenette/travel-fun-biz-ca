// What the right-hand side of a guide page header shows (UAT finding on /destinations/croatia: the single trip sat
// below the header, left-aligned). ONE pure rule for every guide kind, so the pages cannot disagree:
//   1. an upcoming published trip: the nearest one is the feature card; the rest (if any) go in a section below.
//      With exactly one trip the section below is empty, so the trip is never shown twice.
//   2. else the most recent published PAST trip, as a "Past trip" card linking to its recap. A past trip is never
//      bookable here, and nothing in this file ever suggests unpublishing one.
//   3. else the guide's own hero photo and up to five quick facts taken ONLY from its stored key takeaways.
//   4. else nothing: the header stays one column.
// No imports from the app and no network, so scripts/check-guide-header.ts runs offline.

import { telHref, enquiryHref } from './guide-facts'
import { heroAlt } from './image-quality'

export interface HeaderGuide {
  name: string
  hero_image_url?: string | null
  hero_alt?: string | null
  key_takeaways?: string[] | null
}

/** An upcoming trip plus the one stored date used to find the nearest (available_from; null sorts last). */
export interface DatedUpcoming<T> {
  item: T
  from: string | null
}

/** What the past-trip card needs. A published trip row satisfies this as it is. */
export interface HeaderPastTrip {
  id: string
  slug?: string | null
  name: string
  destination?: string | null
  image_url?: string | null
  available_from?: string | null
  available_to?: string | null
}

export type HeaderFeature<T, P extends HeaderPastTrip = HeaderPastTrip> =
  | { kind: 'upcoming'; trip: T; rest: T[]; bookable: true }
  | { kind: 'past'; trip: P; rest: T[]; bookable: false }
  | { kind: 'facts'; image: { url: string; alt: string } | null; facts: string[]; rest: T[]; bookable: false }
  | { kind: 'none'; rest: T[]; bookable: false }

export const MAX_QUICK_FACTS = 5
const MAX_FACT_CHARS = 220

/** The first sentence of a stored line, or null when it is empty or too long to be a quick fact. Never rewrites words. */
export function firstSentence(text: string | null | undefined): string | null {
  const clean = (text ?? '').replace(/\s+/g, ' ').trim()
  if (!clean) return null
  const m = /^.+?[.!?](?=\s|$)/.exec(clean)
  const sentence = (m ? m[0] : clean).trim()
  return sentence.length > 0 && sentence.length <= MAX_FACT_CHARS ? sentence : null
}

/** Up to five quick facts from the stored takeaways (first sentence of each, in stored order, no duplicates). */
export function quickFacts(takeaways: string[] | null | undefined): string[] {
  const out: string[] = []
  for (const line of takeaways ?? []) {
    const s = firstSentence(line)
    if (s && !out.includes(s)) out.push(s)
    if (out.length >= MAX_QUICK_FACTS) break
  }
  return out
}

/** Most quick facts the LEFT column shows next to a trip card (the photo card on the right can hold five). */
export const MAX_LEFT_FACTS = 4

/** Quick facts for the LEFT column of the header. Shown whenever the stored takeaways give any, also beside a trip
 * card. The one exception: the photo-and-facts card on the right already lists them, so they are not repeated. */
export function leftQuickFacts(guide: HeaderGuide | null, feature: { kind: string }): string[] {
  if (feature.kind === 'facts') return []
  return quickFacts(guide?.key_takeaways).slice(0, MAX_LEFT_FACTS)
}

/** The call-to-action panel in the header. Claims come ONLY from site.tagline (hosted group trips, river and ocean
 * cruises, singles getaways, real travel advisors). `title` is a template with {name}; `callHref` is null when the
 * site has no usable number (the panel then shows the enquiry button only). */
export interface HeaderCta {
  titleTemplate: string
  name: string
  phone: string
  callHref: string | null
  enquiryHref: string
}

export function headerCta(name: string, packageName: string | null | undefined, phone: string | null | undefined): HeaderCta {
  const p = (phone ?? '').trim()
  return {
    titleTemplate: 'Plan your {name} trip with a real travel advisor',
    name,
    phone: p,
    callHref: p ? telHref(p) : null,
    enquiryHref: enquiryHref(packageName),
  }
}

const byDateAsc =(a: string | null, b: string | null): number => {
  if (a && b) return a < b ? -1 : a > b ? 1 : 0
  if (a) return -1
  if (b) return 1
  return 0
}

export function pickHeaderFeature<T, P extends HeaderPastTrip = HeaderPastTrip>(
  guide: HeaderGuide | null,
  upcoming: DatedUpcoming<T>[],
  pastTrips: P[],
): HeaderFeature<T, P> {
  // Array.prototype.sort is stable, so trips with equal or missing dates keep the order they came in.
  const sorted = [...upcoming].sort((a, b) => byDateAsc(a.from, b.from))
  if (sorted.length > 0) {
    return { kind: 'upcoming', trip: sorted[0].item, rest: sorted.slice(1).map((x) => x.item), bookable: true }
  }

  const recaps = pastTrips
    .filter((p) => !!p.slug)
    .sort((a, b) => byDateAsc(b.available_to ?? b.available_from ?? null, a.available_to ?? a.available_from ?? null))
  if (recaps.length > 0) return { kind: 'past', trip: recaps[0], rest: [], bookable: false }

  const url = guide?.hero_image_url?.trim() || ''
  // Alt text names the place and what the picture is, never "image" (lib/image-quality.ts).
  const image = url ? { url, alt: heroAlt(guide?.hero_alt, guide?.name ?? '') } : null
  const facts = quickFacts(guide?.key_takeaways)
  if (image || facts.length > 0) return { kind: 'facts', image, facts, rest: [], bookable: false }
  return { kind: 'none', rest: [], bookable: false }
}
