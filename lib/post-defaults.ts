// Default thumbnails for posts, shared by the admin lists and the public blog. Pure: no database, no React.
// A post shows its own picture when it has one; otherwise a small on-brand default for its kind, so a
// row or card is never a blank box. The four SVGs live in public/assets/defaults/ (4:3, centred so a
// 1:1 crop keeps everything that matters).

import { derivePostType, type AdminPostInput, type PostType } from '@/lib/blog-admin-filters'

export const THUMB_TYPES = ['blog', 'news', 'guide', 'trip'] as const
export type ThumbType = (typeof THUMB_TYPES)[number]

export const DEFAULT_THUMBS: Record<ThumbType, string> = {
  blog: '/assets/defaults/blog.svg',
  news: '/assets/defaults/news.svg',
  guide: '/assets/defaults/guide.svg',
  trip: '/assets/defaults/trip.svg',
}

export interface ThumbSource {
  cover_image_url?: string | null
  hero_image_url?: string | null
  image_url?: string | null
}

/** The thumbnail kind for a post type. A trip recap looks like a trip; anything unknown looks like a blog post. */
export function thumbTypeFor(type: PostType | ThumbType | string | null | undefined): ThumbType {
  if (type === 'news' || type === 'guide' || type === 'trip') return type
  if (type === 'recap') return 'trip'
  return 'blog'
}

export function defaultThumb(type: PostType | ThumbType | string | null | undefined): string {
  return DEFAULT_THUMBS[thumbTypeFor(type)]
}

/** A usable image address: an http(s) URL or a site path. Anything else (blank, a bare word, javascript:) is ignored. */
export function usableImageUrl(v: string | null | undefined): string | null {
  const s = (v ?? '').trim()
  if (!s) return null
  if (/^https:\/\//i.test(s) || /^http:\/\//i.test(s) || (s.startsWith('/') && !s.startsWith('//'))) return s
  return null
}

/** The post's own image, first match of cover, hero, then image; null when it has none. */
export function ownImage(src: ThumbSource | null | undefined): string | null {
  if (!src) return null
  return usableImageUrl(src.cover_image_url) ?? usableImageUrl(src.hero_image_url) ?? usableImageUrl(src.image_url)
}

/** What to show: the post's own image if it has one, else the default for its kind. */
export function resolveThumb(src: ThumbSource | null | undefined, type: PostType | ThumbType | string | null | undefined): { src: string; isDefault: boolean } {
  const own = ownImage(src)
  return own ? { src: own, isDefault: false } : { src: defaultThumb(type), isDefault: true }
}

/** Public site: the card or hero image for a post, by its slug, tags and linked trip. Never empty. */
export function publicPostImage(post: ThumbSource & Pick<AdminPostInput, 'slug' | 'tags' | 'related_package_id'>): string {
  return resolveThumb(post, derivePostType(post)).src
}
