import { isDefaultAssetUrl, isOgCardUrl, isSvgUrl } from '@/lib/image-quality'
import { escapeXml } from '@/lib/rss'

// Image sitemap (hub WP8): /sitemap-images.xml lists the real pictures of blog posts, guides and trips so Google Images can find
// them. A separate file, so the existing /sitemap.xml and its tests are untouched. Pure builder: pages in, XML out. The database
// half is lib/image-sitemap-data.ts. Rules: only absolute https addresses, no SVG, no site default or rendered share card, at most
// MAX_IMAGES_PER_PAGE pictures per page (Google allows 1000), at most 50000 pages, everything XML-escaped, a title only where we
// have honest text for it. An empty list gives a valid empty file.

export const MAX_IMAGES_PER_PAGE = 10
export const GOOGLE_MAX_IMAGES_PER_PAGE = 1000
export const MAX_SITEMAP_URLS = 50_000

export interface SitemapImage {
  url: string | null | undefined
  title?: string | null
}

export interface ImageSitemapPage {
  /** Site path, such as /blog/some-post. */
  path: string
  images: SitemapImage[]
}

/** The picture's absolute https address, or null when it is not usable (blank, not https, SVG, a default or a rendered share card). */
export function normalizeImageUrl(raw: string | null | undefined, siteUrl: string): string | null {
  const s = (raw ?? '').trim()
  if (!s) return null
  if (isSvgUrl(s) || isDefaultAssetUrl(s) || isOgCardUrl(s)) return null
  // Only a root-relative path or a full https address; an http address, a protocol-relative one or anything else is dropped.
  if (!(s.startsWith('/') && !s.startsWith('//')) && !/^https:\/\//i.test(s)) return null
  let u: URL
  try {
    u = new URL(s, siteUrl)
  } catch {
    return null
  }
  if (u.protocol !== 'https:' || u.username || u.password) return null
  return u.toString()
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()

export function buildImageSitemapXml(pages: readonly ImageSitemapPage[], siteUrl: string): string {
  const site = siteUrl.replace(/\/+$/, '')
  const blocks: string[] = []
  for (const page of pages) {
    if (blocks.length >= MAX_SITEMAP_URLS) break
    if (!page.path || !page.path.startsWith('/')) continue
    const seen = new Set<string>()
    const images: string[] = []
    for (const img of page.images) {
      if (images.length >= Math.min(MAX_IMAGES_PER_PAGE, GOOGLE_MAX_IMAGES_PER_PAGE)) break
      const url = normalizeImageUrl(img.url, site)
      if (!url || seen.has(url)) continue
      seen.add(url)
      const title = img.title ? oneLine(img.title) : ''
      images.push(`    <image:image>\n      <image:loc>${escapeXml(url)}</image:loc>${title ? `\n      <image:title>${escapeXml(title)}</image:title>` : ''}\n    </image:image>`)
    }
    if (images.length === 0) continue
    blocks.push(`  <url>\n    <loc>${escapeXml(`${site}${page.path}`)}</loc>\n${images.join('\n')}\n  </url>`)
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n${blocks.join('\n')}${blocks.length ? '\n' : ''}</urlset>\n`
}
