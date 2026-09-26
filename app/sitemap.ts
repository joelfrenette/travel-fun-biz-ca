import type { MetadataRoute } from 'next'
import { getPublishedPackageSlugs } from '@/lib/packages'
import { getPublishedPosts } from '@/lib/posts'
import { absoluteUrl } from '@/lib/site'

export const revalidate = 3600

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const [packages, posts] = await Promise.all([getPublishedPackageSlugs(), getPublishedPosts()])
  return [
    { url: absoluteUrl('/'), lastModified: new Date(), changeFrequency: 'weekly', priority: 1 },
    ...packages.map((p) => ({
      url: absoluteUrl(`/packages/${p.slug}`),
      lastModified: new Date(p.updated_at),
      changeFrequency: 'weekly' as const,
      priority: 0.8,
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
