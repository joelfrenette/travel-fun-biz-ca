import { excerptFromMarkdown } from '@/lib/markdown'

// RSS 2.0 builder for the blog feed (hub WP7). Pure: posts in, XML text out, so scripts/check-head-hygiene.ts can test it
// without a database. Used by /feed.xml (latest 20) and /blog/rss.xml (the same feed, every published post).

export interface RssPost {
  slug: string
  title: string
  publish_date: string | null
  updated_at: string
  meta_description: string | null
  body: string
}

export const FEED_LIMIT = 20

/** XML 1.0 forbids most control characters; they would make the whole feed invalid, so they are dropped. */
const INVALID_XML_CHARS = /[^\u0009\u000A\u000D -퟿-�\u{10000}-\u{10FFFF}]/gu

export function escapeXml(s: string): string {
  return String(s ?? '')
    .replace(INVALID_XML_CHARS, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

const when = (p: RssPost): Date | null => {
  const d = new Date(p.publish_date || p.updated_at)
  return Number.isNaN(d.getTime()) ? null : d
}

export interface RssOptions {
  siteName: string
  /** The site root with no trailing slash, e.g. https://travelfunbiz.ca */
  siteUrl: string
  /** Path of the feed itself, e.g. /feed.xml (written as the atom self link). */
  feedPath: string
  posts: readonly RssPost[]
  /** Newest first; omit for every post. */
  limit?: number
  now?: Date
}

/** Valid RSS 2.0: absolute links, escaped text, newest first, nothing dated in the future. */
export function buildRssXml(opts: RssOptions): string {
  const site = opts.siteUrl.replace(/\/+$/, '')
  const now = opts.now ?? new Date()
  const dated = opts.posts
    .map((p) => ({ p, d: when(p) }))
    .filter((x): x is { p: RssPost; d: Date } => x.d !== null && x.d.getTime() <= now.getTime() && !!x.p.slug && !!x.p.title)
    .sort((a, b) => b.d.getTime() - a.d.getTime())
  const chosen = typeof opts.limit === 'number' ? dated.slice(0, opts.limit) : dated
  const items = chosen
    .map(({ p, d }) => {
      const url = `${site}/blog/${p.slug}`
      return `  <item>
    <title>${escapeXml(p.title)}</title>
    <link>${escapeXml(url)}</link>
    <guid isPermaLink="true">${escapeXml(url)}</guid>
    <pubDate>${d.toUTCString()}</pubDate>
    <description>${escapeXml(p.meta_description || excerptFromMarkdown(p.body, 300))}</description>
  </item>`
    })
    .join('\n')
  const last = chosen[0]?.d ?? now
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
  <title>${escapeXml(opts.siteName)} Blog</title>
  <link>${escapeXml(`${site}/blog`)}</link>
  <atom:link href="${escapeXml(`${site}${opts.feedPath}`)}" rel="self" type="application/rss+xml" />
  <description>Trip recaps, travel tips and destination guides from ${escapeXml(opts.siteName)}.</description>
  <language>en</language>
  <lastBuildDate>${last.toUTCString()}</lastBuildDate>
${items}
</channel>
</rss>
`
}

/** Cacheable for an hour in the browser and the CDN. */
export const FEED_HEADERS = { 'Content-Type': 'application/rss+xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600, s-maxage=3600' } as const
