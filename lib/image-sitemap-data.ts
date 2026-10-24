import { supabase } from '@/integrations/supabase/client'
import { getPublishedPosts } from '@/lib/posts'
import { getAllPublishedPackages } from '@/lib/package-grouping'
import { guidePath, isGuideKind, withoutThinPages, type GuideKind } from '@/lib/guides'
import { heroAlt, isGenericAlt } from '@/lib/image-quality'
import type { ImageSitemapPage } from '@/lib/image-sitemap'

// The database half of the image sitemap (hub WP8). Public reads only (anon client, RLS lets published rows through), the same
// pages the main sitemap lists: published blog posts, published guides that are not "safe pages", published trips.
// Read-only. Each read fails soft: a failed read leaves that group out and the file is still valid.

async function guideImagePages(): Promise<ImageSitemapPage[]> {
  const { data, error } = await supabase.from('guides').select('kind, slug, name, hero_image_url, hero_alt, quality_notes').eq('status', 'published')
  if (error) {
    console.error('[image-sitemap] guides read failed:', error.message)
    return []
  }
  const rows = withoutThinPages((data ?? []) as { kind: string; slug: string; name: string; hero_image_url: string | null; hero_alt: string | null; quality_notes: string | null }[])
  return rows
    .filter((g) => isGuideKind(g.kind) && g.hero_image_url)
    .map((g) => ({ path: guidePath(g.kind as GuideKind, g.slug), images: [{ url: g.hero_image_url, title: heroAlt(g.hero_alt, g.name) }] }))
}

export async function loadImageSitemapPages(): Promise<ImageSitemapPage[]> {
  const [posts, trips, guides] = await Promise.all([getPublishedPosts(), getAllPublishedPackages().catch(() => []), guideImagePages().catch(() => [])])
  return [
    // Blog covers: the real cover only (a post with no cover has nothing to list). The title is the stored alt text, or the post title when the alt is generic.
    ...posts
      .filter((p) => p.cover_image_url)
      .map((p) => ({ path: `/blog/${p.slug}`, images: [{ url: p.cover_image_url, title: isGenericAlt(p.alt_text) ? p.title : p.alt_text }] })),
    ...guides,
    // Trip hero images: the trip name is the title.
    ...trips.filter((t) => t.slug && t.image_url).map((t) => ({ path: `/packages/${t.slug}`, images: [{ url: t.image_url, title: t.name }] })),
  ]
}
