import { supabase } from '@/integrations/supabase/client'
import { generateSlug } from '@/lib/utils'
import type { DbPackage } from '@/lib/packages'

// Programmatic SEO: "best time to visit X" pages, grounded ONLY in real travel_packages rows -
// same rule as lib/blog-topics.ts's groundAngleInPackage and the FAQ generator
// (app/api/admin/generate-faqs/route.ts): never invent weather, temperature, rainfall or crowd
// data. The only facts here are the destination name and the real available_from/available_to
// date ranges (plus name/duration/price/highlights) already on published packages. A destination
// with no dated packages gets no page at all - no placeholder, no generic seasonal filler.
async function getDatedPublishedPackages(): Promise<DbPackage[]> {
  const { data, error } = await supabase
    .from('travel_packages')
    .select('*')
    .eq('status', 'published')
    .not('available_from', 'is', null)
    .not('available_to', 'is', null)
    .order('available_from', { ascending: true })
  if (error) {
    console.error('Failed to fetch dated packages for best-time-to-visit:', error.message)
    return []
  }
  // "Best time to visit" promises real, bookable dates - a trip whose available_to has already
  // passed is a past departure, not something a visitor can book. Those belong on the destination
  // page's recap section (see app/destinations/[slug]/page.tsx's own isPastTrip), not here.
  const today = new Date().toISOString().slice(0, 10)
  return (data ?? []).filter((row) => !row.available_to || row.available_to >= today)
}

/** Every destination with at least one published package that has a real date range, for the
 * sitemap. One slug per distinct destination string, same rule as getDestinationSlugs. */
export async function getBestTimeToVisitSlugs(): Promise<{ destination: string; slug: string }[]> {
  const rows = await getDatedPublishedPackages()
  const bySlug = new Map<string, string>()
  for (const row of rows) {
    const slug = generateSlug(row.destination)
    if (slug && !bySlug.has(slug)) bySlug.set(slug, row.destination)
  }
  return Array.from(bySlug, ([slug, destination]) => ({ slug, destination }))
}

export interface BestTimeToVisitPage {
  destination: string
  /** Real published packages for this destination with a real date range, soonest first. */
  packages: DbPackage[]
}

export async function getBestTimeToVisitPage(slug: string): Promise<BestTimeToVisitPage | null> {
  const rows = await getDatedPublishedPackages()
  const matches = rows.filter((row) => generateSlug(row.destination) === slug)
  if (matches.length === 0) return null

  return {
    destination: matches[0].destination,
    packages: matches,
  }
}
