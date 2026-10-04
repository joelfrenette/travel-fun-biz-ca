import { dbPackageToTravelPackage, type DbPackage } from '@/lib/packages'
import { getAllPublishedPackages, groupPackagesByDestination } from '@/lib/package-grouping'
import type { TravelPackage } from '@/types/travel'

// SEO backlog (e3/f3-4): a page per destination that lists both upcoming trips and past-trip
// recaps for it, so a search for "Italy trips" or "Tahiti vacation" has a real landing page
// instead of only the individual package pages. "Upcoming" vs "recap" uses the exact same rule
// as app/packages/[slug]/page.tsx's isPastTrip, so a trip never disagrees with itself across pages.

/** Every destination with at least one published package, for the sitemap. One slug per distinct
 * destination string - two packages with the exact same destination text share a page. */
export async function getDestinationSlugs(): Promise<{ destination: string; slug: string }[]> {
  const rows = await getAllPublishedPackages()
  return Array.from(groupPackagesByDestination(rows).values(), ({ slug, destination }) => ({ slug, destination }))
}

export interface DestinationPage {
  destination: string
  upcoming: TravelPackage[]
  recaps: DbPackage[]
}

export async function getDestinationPage(slug: string): Promise<DestinationPage | null> {
  const rows = await getAllPublishedPackages()
  const group = groupPackagesByDestination(rows).get(slug)
  if (!group) return null

  const today = new Date().toISOString().slice(0, 10)
  const isPastTrip = (row: DbPackage) => !!row.available_to && row.available_to < today

  return {
    destination: group.destination,
    upcoming: group.packages.filter((row) => !isPastTrip(row)).map(dbPackageToTravelPackage),
    recaps: group.packages.filter(isPastTrip),
  }
}
