import { supabase } from '@/integrations/supabase/client'
import { generateSlug } from '@/lib/utils'
import type { DbPackage } from '@/lib/packages'

// Programmatic SEO: destination-vs-destination comparison pages, second slice of the
// programmatic SEO backlog item (roadmap_usecases 121829c8) after /best-time-to-visit. Same
// grounding rule as lib/best-time-to-visit.ts and lib/blog-topics.ts's groundAngleInPackage:
// every fact shown is a real column on a published travel_packages row for one of the two
// destinations (duration, price, price_includes, highlights, dates, category, tags). Never an
// invented climate/safety/"which is better" comparison. A pairing with no real comparable data
// on one side (zero published packages) never gets a page.
async function getAllPublishedPackages(): Promise<DbPackage[]> {
  const { data, error } = await supabase.from('travel_packages').select('*').eq('status', 'published')
  if (error) {
    console.error('Failed to fetch packages for compare-destinations:', error.message)
    return []
  }
  return data ?? []
}

interface DestinationGroup {
  destination: string
  slug: string
  packages: DbPackage[]
}

/** One group per distinct destination string with at least one published package - same
 * dedup rule as getDestinationSlugs/getBestTimeToVisitSlugs. */
function groupByDestination(rows: DbPackage[]): DestinationGroup[] {
  const bySlug = new Map<string, DestinationGroup>()
  for (const row of rows) {
    const slug = generateSlug(row.destination)
    if (!slug) continue
    const existing = bySlug.get(slug)
    if (existing) existing.packages.push(row)
    else bySlug.set(slug, { destination: row.destination, slug, packages: [row] })
  }
  return Array.from(bySlug.values())
}

/**
 * Every unordered pair of destinations that each have at least one published package.
 *
 * Scope: as of this writing there are 9 distinct destinations with published packages (well
 * under the ~15-destination threshold where pairwise comparison pages risk thin/duplicate
 * content), so every pair is generated rather than restricting to same-category pairs. If the
 * destination count grows past ~15, revisit this and consider capping to pairs that share a
 * `category` (Cruise/Beach & Resort/Cultural/etc.) before it ships more pages.
 */
function buildPairs(groups: DestinationGroup[]): { a: DestinationGroup; b: DestinationGroup; pairSlug: string }[] {
  const sorted = [...groups].sort((x, y) => x.slug.localeCompare(y.slug))
  const pairs: { a: DestinationGroup; b: DestinationGroup; pairSlug: string }[] = []
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      // Alphabetical slug order so there's exactly one canonical URL per pair, never both
      // a-vs-b and b-vs-a.
      const a = sorted[i]
      const b = sorted[j]
      pairs.push({ a, b, pairSlug: `${a.slug}-vs-${b.slug}` })
    }
  }
  return pairs
}

/** Every comparison pair slug, for the sitemap. */
export async function getComparePairSlugs(): Promise<{ pairSlug: string; destinationA: string; destinationB: string }[]> {
  const rows = await getAllPublishedPackages()
  const groups = groupByDestination(rows)
  return buildPairs(groups).map(({ a, b, pairSlug }) => ({
    pairSlug,
    destinationA: a.destination,
    destinationB: b.destination,
  }))
}

export interface ComparePageSide {
  destination: string
  slug: string
  packages: DbPackage[]
}

export interface ComparePage {
  a: ComparePageSide
  b: ComparePageSide
  pairSlug: string
}

/** Looks up a pair by its canonical pairSlug (e.g. "italy-vs-tahiti"). Matches against the real
 * set of valid pairs rather than splitting the string on "-vs-", since a destination slug could
 * in principle contain that substring. Returns null for an unknown or non-canonical (reversed)
 * pairing - the page then 404s rather than serving a duplicate URL. */
export async function getComparePage(pairSlug: string): Promise<ComparePage | null> {
  const rows = await getAllPublishedPackages()
  const groups = groupByDestination(rows)
  const match = buildPairs(groups).find((p) => p.pairSlug === pairSlug)
  if (!match) return null

  return {
    pairSlug: match.pairSlug,
    a: { destination: match.a.destination, slug: match.a.slug, packages: match.a.packages },
    b: { destination: match.b.destination, slug: match.b.slug, packages: match.b.packages },
  }
}
