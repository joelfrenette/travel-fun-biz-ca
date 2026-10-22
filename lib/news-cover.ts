// Cover picture for a travel news post (images loop). Pure: no database, no network, no React.
//
// A news post is about an event (a storm, an advisory), so a stock photo of a beach is the WRONG picture and can be the
// wrong place. Every news post instead gets a branded 1200x630 news card: teal, the headline, a source line. The card is
// drawn by the share-image route (app/og/[...path]/route.tsx) at /og/news/<slug>; this file decides what it says and
// which address a post stores as its cover. The address is the same card the post's social share image uses.
import { absoluteUrl } from '@/lib/site'
import { NEWS_TAG, displaySourceName } from '@/lib/news-post'

export type NewsCardKind = 'storm' | 'advisory' | 'news'

export interface NewsCard {
  kind: NewsCardKind
  /** The pill at the top of the card. */
  kindLabel: string
  /** The headline, without the "News: " prefix the stored title carries. */
  title: string
  /** One line under the headline: who reported it. */
  sourceLine: string
}

const KIND_LABEL: Record<NewsCardKind, string> = {
  storm: 'Storm update',
  advisory: 'Travel advisory',
  news: 'Travel news',
}

/** storm and advisory come from the post's category tag; anything else is plain travel news. */
export function newsCardKind(tags: unknown): NewsCardKind {
  const list = Array.isArray(tags) ? tags.filter((t): t is string => typeof t === 'string').map((t) => t.toLowerCase()) : []
  if (list.includes('storm')) return 'storm'
  if (list.includes('advisory')) return 'advisory'
  return 'news'
}

/** The headline of a stored news title: "News: Hurricane X nears Cuba" becomes "Hurricane X nears Cuba". */
export const newsHeadlineOf = (title: string): string => title.replace(/^\s*news:\s*/i, '').replace(/\s+/g, ' ').trim()

/** What the card says. `sourceName` is the feed's name ("the US National Hurricane Center"), when known. */
export function buildNewsCard(i: { title: string; tags?: unknown; sourceName?: string | null }): NewsCard {
  const kind = newsCardKind(i.tags)
  const source = (i.sourceName ?? '').trim()
  return {
    kind,
    kindLabel: KIND_LABEL[kind],
    title: newsHeadlineOf(i.title),
    sourceLine: source ? `Source: ${displaySourceName(source)}` : 'A short brief for travellers',
  }
}

/** The address of a news post's card. Absolute, so the structured data and social sites can use it as it is. */
export const newsCoverUrl = (slug: string): string => absoluteUrl(`/og/news/${slug}`)

/** Alt text for the card: the headline itself (the picture's words are the headline). */
export const newsCoverAlt = (headline: string): string => newsHeadlineOf(headline)

/** True for a news-tagged post. Kept here so callers of the cover code need one import. */
export const hasNewsTag = (tags: unknown): boolean => Array.isArray(tags) && tags.some((t) => typeof t === 'string' && t.toLowerCase() === NEWS_TAG)
