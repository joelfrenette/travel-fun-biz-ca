import { supabase } from '@/integrations/supabase/client'
import { generateSlug } from '@/lib/utils'
import type { DbPackage } from '@/lib/packages'

// Shared by every programmatic SEO generator keyed off destination (lib/destinations.ts,
// lib/best-time-to-visit.ts, lib/compare-destinations.ts) - extracted 2026-10-04 after an
// autonomous review found the same fetch and the same dedup-by-slug loop independently
// hand-rolled in all three, already drifting (slug-collision handling differed slightly between
// copies). One shared implementation so a fix to either applies everywhere at once.

/** Every published travel_packages row, unfiltered by date. */
export async function getAllPublishedPackages(): Promise<DbPackage[]> {
  const { data, error } = await supabase.from('travel_packages').select('*').eq('status', 'published')
  if (error) {
    console.error('Failed to fetch published packages:', error.message)
    return []
  }
  return data ?? []
}

export interface DestinationGroup {
  destination: string
  slug: string
  packages: DbPackage[]
}

/** Groups rows by generateSlug(destination) - one group per distinct destination slug, packages
 * in their original order. A destination string with an empty slug (e.g. only punctuation) is
 * skipped rather than silently grouped under an empty key. */
export function groupPackagesByDestination(rows: DbPackage[]): Map<string, DestinationGroup> {
  const bySlug = new Map<string, DestinationGroup>()
  for (const row of rows) {
    const slug = generateSlug(row.destination)
    if (!slug) continue
    const existing = bySlug.get(slug)
    if (existing) existing.packages.push(row)
    else bySlug.set(slug, { destination: row.destination, slug, packages: [row] })
  }
  return bySlug
}
