// Ported from Nomad Escape Plan's modules/marketing/rankings.ts (Factory Phase 5: SEO/indexing),
// verbatim - genuinely subject-agnostic ("the pure part", per its own header). A lower position
// number is better, so a page "moves up" when its number falls.
export interface RankDayRow {
  day: string
  top10: number
  top50: number
  top100: number
  queries: number
  clicks: number
  impressions: number
}

export interface RankRow {
  day: string
  key: string
  position: number
  clicks: number
  impressions: number
}

/** How many keywords sit in the top 10, 50 and 100 (cumulative: a top-10 keyword counts in all three). */
export function bucketCounts(positions: number[]): { top10: number; top50: number; top100: number } {
  let top10 = 0
  let top50 = 0
  let top100 = 0
  for (const p of positions) {
    if (!(p >= 1)) continue
    if (p <= 10) top10++
    if (p <= 50) top50++
    if (p <= 100) top100++
  }
  return { top10, top50, top100 }
}

/** "/blog/some-post" from a full page URL, or null for anything that isn't a blog post. Also
 * matches this site's /packages/[slug] pages, since those are worth tracking rankings for too. */
export function trackedPathOf(pageUrl: string): string | null {
  let path: string
  try {
    path = new URL(pageUrl).pathname
  } catch {
    path = pageUrl.startsWith('/') ? pageUrl : ''
  }
  path = path.replace(/\/+$/, '')
  return /^\/(blog|packages)\/[^/]+$/.test(path) ? path : null
}
