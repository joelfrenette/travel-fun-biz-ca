// "From your city" landing pages (/from/toronto ...). Config-driven: to add a city, add one entry to FROM_CITIES.
// Everything on a page comes from stored data (the published trips) plus plain, true facts kept here (the city's main
// airport). No price, date, flight fact or claim about what the agency arranges is ever written in this file.
// Pure: no database, no React, no imports from the app other than the past-trip rule. Testable offline.
import { isPastTrip } from '@/lib/past-trip'

export interface FromCity {
  slug: string
  city: string
  province: string
  /** IATA code of the city's main airport. */
  airportCode: string
  airportName: string
}

export const FROM_CITIES: FromCity[] = [
  { slug: 'toronto', city: 'Toronto', province: 'ON', airportCode: 'YYZ', airportName: 'Toronto Pearson International Airport' },
  { slug: 'vancouver', city: 'Vancouver', province: 'BC', airportCode: 'YVR', airportName: 'Vancouver International Airport' },
  { slug: 'calgary', city: 'Calgary', province: 'AB', airportCode: 'YYC', airportName: 'Calgary International Airport' },
  { slug: 'montreal', city: 'Montreal', province: 'QC', airportCode: 'YUL', airportName: 'Montréal-Trudeau International Airport' },
  { slug: 'ottawa', city: 'Ottawa', province: 'ON', airportCode: 'YOW', airportName: 'Ottawa Macdonald-Cartier International Airport' },
  { slug: 'edmonton', city: 'Edmonton', province: 'AB', airportCode: 'YEG', airportName: 'Edmonton International Airport' },
  { slug: 'winnipeg', city: 'Winnipeg', province: 'MB', airportCode: 'YWG', airportName: 'Winnipeg James Armstrong Richardson International Airport' },
  { slug: 'halifax', city: 'Halifax', province: 'NS', airportCode: 'YHZ', airportName: 'Halifax Stanfield International Airport' },
]

export function fromCityBySlug(slug: string): FromCity | null {
  return FROM_CITIES.find((c) => c.slug === slug) ?? null
}

export const fromPath = (c: Pick<FromCity, 'slug'>): string => `/from/${c.slug}`

export function fromTitle(c: Pick<FromCity, 'city'>, siteName: string): string {
  return `Group Tours and Cruises from ${c.city} | ${siteName}`
}

export function fromHeading(c: Pick<FromCity, 'city'>): string {
  return `Group tours and cruises from ${c.city}`
}

/** Meta description: only what is true of every page here (the count is the real number of listed trips). */
export function fromDescription(c: Pick<FromCity, 'city'>, tripCount: number): string {
  const trips = tripCount > 0 ? `See ${tripCount} hosted group ${tripCount === 1 ? 'trip' : 'trips'} and cruises` : 'Hosted group trips and cruises'
  return `${trips} you can plan from ${c.city}. Ask our travel advisors about getting there from ${c.city}.`
}

export interface TripLite {
  id?: string
  name: string
  slug: string
  destination: string
  duration: string | null
  available_from: string | null
  available_to: string | null
  recap_mode?: string | null
  short_description?: string | null
}

/** The trips a city page lists: published rows that are not past trips, soonest dated first, undated last (stable). */
export function upcomingTrips<T extends Pick<TripLite, 'slug' | 'name' | 'available_from' | 'available_to' | 'recap_mode'>>(rows: T[], today?: string): T[] {
  const live = rows.filter((r) => r.slug && r.name && !isPastTrip(r, today))
  return live
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      const da = a.r.available_from ?? '9999-99-99'
      const db = b.r.available_from ?? '9999-99-99'
      return da === db ? a.i - b.i : da < db ? -1 : 1
    })
    .map((x) => x.r)
}

/** A city page is indexable only while it has at least one trip to list. */
export const isFromPageIndexable = (tripCount: number): boolean => tripCount > 0

/** Generic questions, each answerable from site data. No price, date or flight claim; the answers send people to us. */
export function fromFaq(c: FromCity, trips: Pick<TripLite, 'name'>[], phone: string): { q: string; a: string }[] {
  const faq: { q: string; a: string }[] = [
    {
      q: `Which airport is the main one in ${c.city}?`,
      a: `The main airport for ${c.city} is ${c.airportName} (${c.airportCode}).`,
    },
  ]
  if (trips.length > 0) {
    const names = trips.slice(0, 5).map((t) => t.name).join(', ')
    faq.push({
      q: `Which group trips can I look at from ${c.city}?`,
      a: `The trips on this page are ${names}${trips.length > 5 ? ' and more' : ''}. Each trip page lists its stored details.`,
    })
  }
  faq.push({
    q: `How do I get a price for a trip from ${c.city}?`,
    a: phone
      ? `Prices change, so we do not list one here. Call or text ${phone}, or send us a note through the contact form, and we can talk through your options.`
      : 'Prices change, so we do not list one here. Send us a note through the contact form and we can talk through your options.',
  })
  return faq
}

/** Other cities to link to (everything but this one), in config order. */
export const otherCities = (c: Pick<FromCity, 'slug'>): FromCity[] => FROM_CITIES.filter((x) => x.slug !== c.slug)

/** Plain-text list for llms.txt: path and title per city. */
export function fromLlmsLinks(): { title: string; path: string; summary: string }[] {
  return FROM_CITIES.map((c) => ({
    title: fromHeading(c),
    path: fromPath(c),
    summary: `Hosted group trips and cruises you can plan from ${c.city} (${c.airportCode}).`,
  }))
}
