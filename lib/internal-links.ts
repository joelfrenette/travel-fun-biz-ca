import { generateSlug } from '@/lib/utils'

// Cross-links between the destination hub (/destinations/[slug]), the comparison pages (/compare/[pair]) and the
// country advisory pages (/travel-advisories/[country]). Pure helpers: every link is built from a slug that was read
// from a real row elsewhere, and a link is returned only on an exact slug match, so none can point at a 404.

/** Compare pages that include this destination, as links. `pairs` is the real list from getComparePairSlugs(). */
export function compareLinksForDestination(
  slug: string,
  destinationName: string,
  pairs: { pairSlug: string; destinationA: string; destinationB: string }[],
  limit = 6,
): { label: string; path: string }[] {
  const out: { label: string; path: string }[] = []
  for (const p of pairs) {
    if (out.length >= limit) break
    const aSlug = generateSlug(p.destinationA)
    const bSlug = generateSlug(p.destinationB)
    if (aSlug !== slug && bSlug !== slug) continue
    // The pair slug is "<a>-vs-<b>"; check it really is this pair so a stray string can never make a link.
    if (p.pairSlug !== `${aSlug}-vs-${bSlug}`) continue
    const other = aSlug === slug ? p.destinationB : p.destinationA
    out.push({ label: `${destinationName} vs ${other}`, path: `/compare/${p.pairSlug}` })
  }
  return out
}

/** The destination hub for a country advisory page: only when a published trip's destination slugs to exactly the country slug. */
export function destinationHubForCountry(packages: { destination?: string | null }[], countrySlug: string): { name: string; path: string } | null {
  for (const p of packages) {
    if (!p.destination) continue
    if (generateSlug(p.destination) === countrySlug) return { name: p.destination, path: `/destinations/${countrySlug}` }
  }
  return null
}
