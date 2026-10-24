// The dashboard's "Top keywords" table, pure part: Search Console query rows (and, when they could be read, the query + page rows) go in;
// the top searches come out, each with the page Google shows for it and the page we chose for it in Keyword Research (if any).
// No network and no database here, so scripts/check-dashboard-keywords.ts tests it offline. A number that was not read is null
// ("could not be read"), never a zero.

import type { DashRange } from './dashboard-range'

export const TOP_KEYWORDS_LIMIT = 15

export interface QueryRow {
  query: string
  clicks: number
  impressions: number
  position: number
}

export interface QueryPageRow {
  query: string
  /** Site path, like /blog/alaska-cruise. */
  path: string
  clicks: number
  impressions: number
}

export interface TargetRow {
  keyword: string
  target_path: string | null
}

export type KeywordsStatus = 'ok' | 'not_connected' | 'error'

export interface TopKeywordRow {
  query: string
  clicks: number
  impressions: number
  /** clicks / impressions, 0 to 1. */
  ctr: number
  /** Average position, one decimal. null when Search Console gave none. */
  position: number | null
  /** The page Google shows most for this search. null when the query + page report could not be read, or had no page for it. */
  page: string | null
  /** The page chosen for this phrase in Keyword Research. null when none was chosen. */
  target: string | null
}

export interface TopKeywordsResponse {
  range: DashRange
  status: KeywordsStatus
  error: string | null
  startDate: string | null
  endDate: string | null
  clamped: boolean
  /** Whether the "page Google shows" column could be filled. */
  pagesRead: boolean
  rows: TopKeywordRow[]
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ')

/** The top searches by clicks (then impressions), with the page Google shows and our target page. Pure. */
export function buildTopKeywords(input: { queries: readonly QueryRow[]; pairs: readonly QueryPageRow[] | null; targets: readonly TargetRow[] | null }, limit = TOP_KEYWORDS_LIMIT): TopKeywordRow[] {
  const bestPage = new Map<string, QueryPageRow>()
  for (const p of input.pairs ?? []) {
    const k = norm(p.query)
    const cur = bestPage.get(k)
    if (!cur || p.impressions > cur.impressions || (p.impressions === cur.impressions && p.clicks > cur.clicks)) bestPage.set(k, p)
  }
  const target = new Map<string, string>()
  for (const t of input.targets ?? []) if (t.target_path) target.set(norm(t.keyword), t.target_path)
  return input.queries
    .filter((q) => q.query.trim() !== '' && (q.clicks > 0 || q.impressions > 0))
    .map((q) => {
      const k = norm(q.query)
      return {
        query: q.query.trim(),
        clicks: q.clicks,
        impressions: q.impressions,
        ctr: q.impressions > 0 ? q.clicks / q.impressions : 0,
        position: q.position > 0 ? Math.round(q.position * 10) / 10 : null,
        page: bestPage.get(k)?.path ?? null,
        target: target.get(k) ?? null,
      }
    })
    .sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions || a.query.localeCompare(b.query))
    .slice(0, limit)
}
