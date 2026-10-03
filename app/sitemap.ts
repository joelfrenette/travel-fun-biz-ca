import type { MetadataRoute } from 'next'
import { getPublishedPackageSlugs } from '@/lib/packages'
import { getPublishedPosts } from '@/lib/posts'
import { getDestinationSlugs } from '@/lib/destinations'
import { getBestTimeToVisitSlugs } from '@/lib/best-time-to-visit'
import { getComparePairSlugs } from '@/lib/compare-destinations'
import { absoluteUrl } from '@/lib/site'

export const revalidate = 3600

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const [packages, posts, destinations, bestTimeToVisit, compareDestinations] = await Promise.all([
    getPublishedPackageSlugs(),
    getPublishedPosts(),
    getDestinationSlugs(),
    getBestTimeToVisitSlugs(),
    getComparePairSlugs(),
  ])
  return [
    { url: absoluteUrl('/'), lastModified: new Date(), changeFrequency: 'weekly', priority: 1 },
    { url: absoluteUrl('/who-we-are'), lastModified: new Date(), changeFrequency: 'monthly' as const, priority: 0.4 },
    ...packages.map((p) => ({
      url: absoluteUrl(`/packages/${p.slug}`),
      lastModified: new Date(p.updated_at),
      changeFrequency: 'weekly' as const,
      priority: 0.8,
    })),
    ...destinations.map((d) => ({
      url: absoluteUrl(`/destinations/${d.slug}`),
      lastModified: new Date(),
      changeFrequency: 'weekly' as const,
      priority: 0.7,
    })),
    ...bestTimeToVisit.map((d) => ({
      url: absoluteUrl(`/best-time-to-visit/${d.slug}`),
      lastModified: new Date(),
      changeFrequency: 'weekly' as const,
      priority: 0.6,
    })),
    ...compareDestinations.map((c) => ({
      url: absoluteUrl(`/compare/${c.pairSlug}`),
      lastModified: new Date(),
      changeFrequency: 'weekly' as const,
      priority: 0.6,
    })),
    { url: absoluteUrl('/blog'), lastModified: new Date(), changeFrequency: 'weekly' as const, priority: 0.6 },
    ...posts.map((post) => ({
      url: absoluteUrl(`/blog/${post.slug}`),
      lastModified: new Date(post.updated_at),
      changeFrequency: 'monthly' as const,
      priority: 0.5,
    })),
  ]
}
