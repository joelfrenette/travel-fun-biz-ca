import { supabase } from '@/integrations/supabase/client'
import { generateSlug } from '@/lib/utils'
import { dbPackageToTravelPackage, type DbPackage } from '@/lib/packages'
import type { TravelPackage } from '@/types/travel'

// SEO backlog (e3/f3-4): a page per destination that lists both upcoming trips and past-trip
// recaps for it, so a search for "Italy trips" or "Tahiti vacation" has a real landing page
// instead of only the individual package pages. "Upcoming" vs "recap" uses the exact same rule
// as app/packages/[slug]/page.tsx's isPastTrip, so a trip never disagrees with itself across pages.
async function getAllPublishedPackages(): Promise<DbPackage[]> {
  const { data, error } = await supabase.from('travel_packages').select('*').eq('status', 'published')
  if (error) {
    console.error('Failed to fetch packages for destinations:', error.message)
    return []
  }
  return data ?? []
}

/** Every destination with at least one published package, for the sitemap. One slug per distinct
 * destination string - two packages with the exact same destination text share a page. */
export async function getDestinationSlugs(): Promise<{ destination: string; slug: string }[]> {
  const rows = await getAllPublishedPackages()
  const bySlug = new Map<string, string>()
  for (const row of rows) {
    const slug = generateSlug(row.destination)
    if (slug && !bySlug.has(slug)) bySlug.set(slug, row.destination)
  }
  return Array.from(bySlug, ([slug, destination]) => ({ slug, destination }))
}

export interface DestinationPage {
  destination: string
  upcoming: TravelPackage[]
  recaps: DbPackage[]
}

export async function getDestinationPage(slug: string): Promise<DestinationPage | null> {
  const rows = await getAllPublishedPackages()
  const matches = rows.filter((row) => generateSlug(row.destination) === slug)
  if (matches.length === 0) return null

  const today = new Date().toISOString().slice(0, 10)
  const isPastTrip = (row: DbPackage) => !!row.available_to && row.available_to < today

  return {
    destination: matches[0].destination,
    upcoming: matches.filter((row) => !isPastTrip(row)).map(dbPackageToTravelPackage),
    recaps: matches.filter(isPastTrip),
  }
}
