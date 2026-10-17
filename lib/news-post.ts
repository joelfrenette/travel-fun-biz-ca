import { generateSlug } from '@/lib/utils'
import type { NewsBrief } from '@/lib/news-brief'

// Growth loop WP20: how a travel news post looks. A news post is an ordinary blog post (posts table, /blog/<slug>), tagged
// "travel-news", with a slug that starts "news-". Everything here is pure so the blog page, the writer and the checks all
// read it the same way. No new page type and no new route.

export const NEWS_TAG = 'travel-news'
export const NEWS_SLUG_PREFIX = 'news-'
/** After this many days a news post stays up but its heading says it is archived news. It is never unpublished. */
export const NEWS_ARCHIVE_AFTER_DAYS = 30
export const SOURCE_LINK_LABEL = 'Check the official source'

export const isNewsSlug = (slug: string | null | undefined): boolean => typeof slug === 'string' && slug.startsWith(NEWS_SLUG_PREFIX)

export function isNewsPost(post: { tags?: unknown; slug?: string | null }): boolean {
  return Array.isArray(post.tags) && post.tags.some((t) => typeof t === 'string' && t.toLowerCase() === NEWS_TAG)
}

/** news-<headline words>-<6 characters of the item id>. The id keeps two similar headlines from sharing a slug. */
export function newsSlug(headline: string, itemId: string): string {
  const base = generateSlug(headline).slice(0, 60).replace(/-+$/, '')
  const id = itemId.replace(/[^a-z0-9]/gi, '').slice(0, 6).toLowerCase() || 'item'
  return `${NEWS_SLUG_PREFIX}${base || 'travel-news'}-${id}`
}

export const newsTitle = (headline: string): string => `News: ${headline.trim()}`

/** The date as Canadians read it, in the site's time zone: "October 12, 2026". */
export function formatNewsDate(iso: string | Date, timeZone = 'America/Toronto'): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso
  if (Number.isNaN(d.getTime())) return ''
  return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: 'long', day: 'numeric', timeZone }).format(d)
}

/** "the US National Hurricane Center" becomes "US National Hurricane Center" (for link text). */
export const displaySourceName = (sourceName: string): string => sourceName.replace(/^the\s+/i, '')

const safeMarkdownUrl = (url: string): string => url.replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/\s/g, '%20')

export interface NewsBodyInput {
  brief: NewsBrief
  sourceName: string
  url: string
  /** When the source reported it (the feed's date, else the day we read it). */
  reportedAt: string
  /** site.phone, or '' to leave the phone line out. */
  phone: string
}

/** The saved body: our own brief, a link to the original, who reported it and when, and the call to action. All fixed text
 * is ours; the model text is the brief only. */
export function buildNewsBody(i: NewsBodyInput): string {
  const lines = [
    `**What happened:** ${i.brief.happened}`,
    '',
    '## What it means for travellers',
    '',
    i.brief.means.join(' '),
    '',
    `[${SOURCE_LINK_LABEL}: ${displaySourceName(i.sourceName)}](${safeMarkdownUrl(i.url)})`,
    '',
    `*Reported ${formatNewsDate(i.reportedAt)} by ${i.sourceName}.*`,
    '',
    'This is our own short summary, written from the notice\'s short description only. The official source is the one to rely on.',
  ]
  if (i.phone.trim()) lines.push('', `Planning a trip, or already booked? Call or text our AI agent: ${i.phone.trim()}.`)
  return lines.join('\n')
}

/** Reads a saved news body back into its brief parts. Null when it is not in the shape buildNewsBody writes. */
export function parseNewsBody(body: string): { happened: string; means: string[]; sourceName: string; url: string } | null {
  const happened = /^\*\*What happened:\*\*\s+(.+)$/m.exec(body)?.[1]?.trim()
  const link = new RegExp(`\\[${SOURCE_LINK_LABEL}: ([^\\]]+)\\]\\((https:\\/\\/[^)\\s]+)\\)`).exec(body)
  const meansBlock = /##\s+What it means for travellers\s*\n+([\s\S]*?)\n\s*\n\[/.exec(body)?.[1]?.trim()
  if (!happened || !link || !meansBlock) return null
  const means = meansBlock.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean)
  if (means.length === 0) return null
  return { happened, means, sourceName: link[1], url: link[2].replace(/%28/g, '(').replace(/%29/g, ')') }
}

/** The original source of a news post, for the citation in the page markup. Null when the body has no source line. */
export function newsSourceFromBody(body: string): { name: string; url: string } | null {
  const m = new RegExp(`\\[${SOURCE_LINK_LABEL}: ([^\\]]+)\\]\\((https:\\/\\/[^)\\s]+)\\)`).exec(body)
  return m ? { name: m[1], url: m[2].replace(/%28/g, '(').replace(/%29/g, ')') } : null
}

/** True once a news post is more than NEWS_ARCHIVE_AFTER_DAYS old (by its publish date). */
export function newsArchived(post: { tags?: unknown; slug?: string | null; publish_date?: string | null }, now: Date = new Date()): boolean {
  if (!isNewsPost(post) || !post.publish_date) return false
  const t = Date.parse(post.publish_date)
  return Number.isFinite(t) && now.getTime() - t > NEWS_ARCHIVE_AFTER_DAYS * 86_400_000
}

/** The heading line the reader sees: archived news gets a visible prefix; the stored title is never changed. */
export function newsHeading(post: { title: string; tags?: unknown; slug?: string | null; publish_date?: string | null }, now: Date = new Date()): string {
  return newsArchived(post, now) ? `Archived news: ${post.title}` : post.title
}
