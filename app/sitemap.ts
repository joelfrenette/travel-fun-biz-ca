import type { MetadataRoute } from 'next'
import { getPublishedPackageSlugs } from '@/lib/packages'
import { getPublishedPosts } from '@/lib/posts'
import { getDestinationSlugs } from '@/lib/destinations'
import { getBestTimeToVisitSlugs } from '@/lib/best-time-to-visit'
import { getComparePairSlugs } from '@/lib/compare-destinations'
import { getPublishedGuidePaths, guidePath, guideKinds, GUIDE_KINDS } from '@/lib/guides'
import { getPublishedPageCopyPaths, comparePath, bestTimePath } from '@/lib/page-copy'
import { filterByCopy } from '@/lib/page-copy-index'
import { getAllPublishedPackages } from '@/lib/package-grouping'
import { FROM_CITIES, INDEXABLE_FROM_SLUGS, fromPath, upcomingTrips } from '@/lib/from-cities'
import { absoluteUrl } from '@/lib/site'
import { getPublishedAgents } from '@/lib/agents-store'
import { maxIso, lastModOrUndefined, lastModField } from '@/lib/sitemap-dates'
import { loadAdvisorySitemap } from '@/lib/country-advisory-public'

export const revalidate = 3600

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const [packages, posts, destinations, allBestTime, allCompare, guides, copyPaths, publishedRows, agents, advisoryPages] = await Promise.all([
    getPublishedPackageSlugs(),
    getPublishedPosts(),
    getDestinationSlugs(),
    getBestTimeToVisitSlugs(),
    getComparePairSlugs(),
    getPublishedGuidePaths(),
    getPublishedPageCopyPaths().catch(() => null),
    getAllPublishedPackages().catch(() => []),
    getPublishedAgents().catch(() => []),
    // Travel advisory pages: [] unless app_settings.country_advisories_mode is 'on'; only published pages with data.
    loadAdvisorySitemap(),
  ])
  // The /from/<city> pages are listed only while there is an upcoming trip to put on them (otherwise they are noindex).
  const fromCityPages = upcomingTrips(publishedRows).length > 0 ? FROM_CITIES.filter((c) => INDEXABLE_FROM_SLUGS.includes(c.slug)) : []
  // Compare and best-time pages are listed only when published copy exists for the path (one query for all);
  // a failed or empty read gives a null set and everything stays listed.
  const bestTimeToVisit = filterByCopy(allBestTime, (d) => bestTimePath(d.slug), copyPaths)
  const compareDestinations = filterByCopy(allCompare, (c) => comparePath(c.pairSlug), copyPaths)
  // A destination guide for a place no package goes to yet has no /destinations entry above, so it is added here.
  const destinationSlugs = new Set(destinations.map((d) => d.slug))
  const guidePages = guides.filter((g) => !(g.kind === 'destinations' && destinationSlugs.has(g.slug)))
  // An index page is listed once at least one guide of its kind is published (an empty list would be thin).
  const indexKinds = GUIDE_KINDS.filter((k) => k !== 'destinations' && guides.some((g) => g.kind === k))
  // lastModified comes only from stored timestamps; where none exists the field is left out.
  const destGuideDates = new Map<string, string>()
  for (const g of guides) if (g.kind === 'destinations') destGuideDates.set(g.slug, g.updated_at)
  const destGuidesMax = maxIso([...destGuideDates.values()])
  // Pages built from other content take the newest stored change of what they list; a page with no stored date stays without one.
  const packagesMax = maxIso(packages.map((p) => p.updated_at))
  const siteMax = maxIso([packagesMax, ...posts.map((p) => p.updated_at), ...guides.map((g) => g.updated_at)])
  const kindMax = (k: string) => maxIso(guides.filter((g) => g.kind === k).map((g) => g.updated_at))
  return [
    { url: absoluteUrl('/'), ...lastModField(siteMax), changeFrequency: 'weekly' as const, priority: 1 },
    {
      url: absoluteUrl('/packages'),
      ...lastModField(maxIso(packages.map((p) => p.updated_at))),
      changeFrequency: 'weekly' as const,
      priority: 0.8,
    },
    { url: absoluteUrl('/who-we-are'), changeFrequency: 'monthly' as const, priority: 0.4 },
    ...(agents.length > 0 ? [{ url: absoluteUrl('/agents'), ...lastModField(maxIso(agents.map((a) => a.updated_at))), changeFrequency: 'weekly' as const, priority: 0.6 }] : []),
    ...agents.map((a) => ({ url: absoluteUrl('/agents/' + a.slug), ...lastModField(lastModOrUndefined(a.updated_at)), changeFrequency: 'monthly' as const, priority: 0.5 })),
    ...fromCityPages.map((c) => ({
      url: absoluteUrl(fromPath(c)),
      ...lastModField(maxIso(publishedRows.map((p) => p.updated_at))),
      changeFrequency: 'weekly' as const,
      priority: 0.7,
    })),
    ...packages.map((p) => ({
      url: absoluteUrl(`/packages/${p.slug}`),
      ...lastModField(lastModOrUndefined(p.updated_at)),
      changeFrequency: 'weekly' as const,
      priority: 0.8,
    })),
    ...destinations.map((d) => ({
      url: absoluteUrl(`/destinations/${d.slug}`),
      ...lastModField(lastModOrUndefined(destGuideDates.get(d.slug)) ?? packagesMax),
      changeFrequency: 'weekly' as const,
      priority: 0.7,
    })),
    // The destinations index is listed only when it has something on it (a trip destination or a published guide).
    ...(destinations.length > 0 || guides.some((g) => g.kind === 'destinations')
      ? [{ url: absoluteUrl('/destinations'), ...lastModField(destGuidesMax), changeFrequency: 'weekly' as const, priority: 0.7 }]
      : []),
    ...guidePages.map((g) => ({
      url: absoluteUrl(guidePath(g.kind, g.slug)),
      ...lastModField(lastModOrUndefined(g.updated_at)),
      changeFrequency: 'monthly' as const,
      priority: 0.6,
    })),
    ...indexKinds.map((k) => ({
      url: absoluteUrl(guideKinds[k].urlPrefix),
      ...lastModField(kindMax(k)),
      changeFrequency: 'weekly' as const,
      priority: 0.6,
    })),
    ...bestTimeToVisit.map((d) => ({
      url: absoluteUrl(`/best-time-to-visit/${d.slug}`),
      ...lastModField(lastModOrUndefined(destGuideDates.get(d.slug)) ?? packagesMax),
      changeFrequency: 'weekly' as const,
      priority: 0.6,
    })),
    ...compareDestinations.map((c) => ({
      url: absoluteUrl(`/compare/${c.pairSlug}`),
      ...lastModField(maxIso([destGuideDates.get(c.destinationA), destGuideDates.get(c.destinationB)]) ?? packagesMax),
      changeFrequency: 'weekly' as const,
      priority: 0.6,
    })),
    ...advisoryPages.map((e) => ({
      url: absoluteUrl(e.path),
      ...lastModField(lastModOrUndefined(e.lastModified)),
      changeFrequency: 'weekly' as const,
      priority: 0.5,
    })),
    { url: absoluteUrl('/blog'), ...lastModField(maxIso(posts.map((p) => p.updated_at))), changeFrequency: 'weekly' as const, priority: 0.6 },
    ...posts.map((post) => ({
      url: absoluteUrl(`/blog/${post.slug}`),
      ...lastModField(lastModOrUndefined(post.updated_at)),
      changeFrequency: 'monthly' as const,
      priority: 0.5,
    })),
  ]
}
