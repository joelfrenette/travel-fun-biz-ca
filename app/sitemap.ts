import type { MetadataRoute } from 'next'
import { getPublishedPackageSlugs } from '@/lib/packages'
import { absoluteUrl } from '@/lib/site'

export const revalidate = 3600

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const packages = await getPublishedPackageSlugs()
  return [
    { url: absoluteUrl('/'), lastModified: new Date(), changeFrequency: 'weekly', priority: 1 },
    ...packages.map((p) => ({
      url: absoluteUrl(`/packages/${p.slug}`),
      lastModified: new Date(p.updated_at),
      changeFrequency: 'weekly' as const,
      priority: 0.8,
    })),
  ]
}
