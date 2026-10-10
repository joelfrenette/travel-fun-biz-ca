import { getGoogleAccessToken, isGoogleServiceAccountConfigured } from '@/lib/google-auth'
import type { QueryPagePair } from '@/lib/rankings'

// Google Search Console query report: the phrases Google already shows this site for.
// Same service account as GA4; it must be added as a user on the Search Console property.
const SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly'
const CACHE_MS = 60 * 60 * 1000

export interface SearchConsoleRow {
  query: string
  clicks: number
  impressions: number
  ctr: number
  position: number
}

let cache: { rows: SearchConsoleRow[]; at: number; days: number } | null = null

export function searchConsoleSiteUrl(): string {
  return process.env.SEARCH_CONSOLE_SITE_URL || 'sc-domain:travelfunbiz.ca'
}

export function isSearchConsoleConfigured(): boolean {
  return isGoogleServiceAccountConfigured()
}

export async function getSearchConsoleQueries(days = 28): Promise<SearchConsoleRow[]> {
  if (cache && cache.days === days && Date.now() - cache.at < CACHE_MS) return cache.rows

  const rows = await dimensionReport('query', days)
  const mapped: SearchConsoleRow[] = rows.map((r) => ({ query: r.key.toLowerCase(), clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position }))
  cache = { rows: mapped, at: Date.now(), days }
  return mapped
}

interface DimensionRow {
  key: string
  clicks: number
  impressions: number
  ctr: number
  position: number
}

/** One Search Console query report for a single dimension (query or page), the last `days` days
 * ending 2 days ago (Search Console data lags). Shared by getSearchConsoleQueries above and the
 * ranking-snapshot cron (factory Phase 5) below - one auth path, one HTTP call shape. */
async function dimensionReport(dimension: 'query' | 'page', days: number): Promise<DimensionRow[]> {
  const token = await getGoogleAccessToken(SCOPE)
  const end = new Date(Date.now() - 2 * 864e5)
  const start = new Date(end.getTime() - (days - 1) * 864e5)
  const iso = (d: Date) => d.toISOString().slice(0, 10)

  const res = await fetch(`https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(searchConsoleSiteUrl())}/searchAnalytics/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ startDate: iso(start), endDate: iso(end), dimensions: [dimension], rowLimit: 1000 }),
    cache: 'no-store',
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`Search Console query failed: ${body.error?.message || res.status}`)

  return (body.rows || []).map((r: any) => ({
    key: String(r.keys?.[0] || ''),
    clicks: Number(r.clicks) || 0,
    impressions: Number(r.impressions) || 0,
    ctr: Number(r.ctr) || 0,
    position: Number(r.position) || 0,
  }))
}

/** Queries already ranking 5-20 (Nomad's own threshold: page 1-2, not yet a top-4 result) sorted
 * by impressions descending — the fastest realistic SEO wins, since Google already shows this
 * site for them and a focused post just needs to nudge position rather than rank from scratch.
 * Pure and pre-filtered so it's covered by a real assertion, not just a type check. */
export function nearMissQueries(rows: SearchConsoleRow[], limit = 10): SearchConsoleRow[] {
  return rows
    .filter((r) => r.position >= 5 && r.position <= 20)
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, limit)
}

/** Fetches the cached query report and returns its near-miss queries — the actual call
 * lib/blog-topics.ts's topic suggester makes. Returns [] (never throws) when Search Console isn't
 * configured or the request fails, same "never blocks the caller" pattern as every other
 * optional-integration read in this project. */
export async function getNearMissKeywords(days = 28, limit = 10): Promise<SearchConsoleRow[]> {
  if (!isSearchConsoleConfigured()) return []
  try {
    return nearMissQueries(await getSearchConsoleQueries(days), limit)
  } catch (err) {
    console.error('[search-console] near-miss lookup failed:', err instanceof Error ? err.message : err)
    return []
  }
}

let pairCache: { rows: QueryPagePair[]; at: number } | null = null

/** Which pages Google shows for which keywords (Search Console's query + page report), for the last
 * 28 days ending 2 days ago. Cached for an hour. Returns [] (never throws) when Search Console is not
 * configured or the call fails: the Rankings page then just shows a dash in its keyword/page column. */
export async function getQueryPagePairs(days = 28): Promise<QueryPagePair[]> {
  if (!isSearchConsoleConfigured()) return []
  if (pairCache && Date.now() - pairCache.at < CACHE_MS) return pairCache.rows
  try {
    const token = await getGoogleAccessToken(SCOPE)
    const end = new Date(Date.now() - 2 * 864e5)
    const start = new Date(end.getTime() - (days - 1) * 864e5)
    const iso = (d: Date) => d.toISOString().slice(0, 10)
    const res = await fetch(`https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(searchConsoleSiteUrl())}/searchAnalytics/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ startDate: iso(start), endDate: iso(end), dimensions: ['query', 'page'], rowLimit: 5000 }),
      cache: 'no-store',
      signal: AbortSignal.timeout(20_000),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) return []
    const rows: QueryPagePair[] = ((body.rows || []) as { keys?: string[]; clicks?: number; impressions?: number }[])
      .map((r) => {
        let path = ''
        try {
          path = new URL(String(r.keys?.[1] ?? '')).pathname.replace(/\/+$/, '') || '/'
        } catch {
          path = ''
        }
        return { query: String(r.keys?.[0] ?? '').toLowerCase(), path, clicks: Number(r.clicks) || 0, impressions: Number(r.impressions) || 0 }
      })
      .filter((r) => r.query && r.path)
    pairCache = { rows, at: Date.now() }
    return rows
  } catch {
    return []
  }
}

export interface PageMetrics {
  path: string
  /** Impression-weighted average position over the last 28 days (lower is better). */
  position: number
  clicks: number
  impressions: number
}

let pageCache: { rows: PageMetrics[]; at: number } | null = null

/** Every page Google reports for this site (any page type) with its real 28-day numbers, grouped by
 * path so a page seen under two address spellings counts once. Cached an hour; [] when Search Console is
 * not configured or the call fails. */
export async function getPageMetrics(days = 28): Promise<PageMetrics[]> {
  if (!isSearchConsoleConfigured()) return []
  if (pageCache && Date.now() - pageCache.at < CACHE_MS) return pageCache.rows
  try {
    const rows = await dimensionReport('page', days)
    const byPath = new Map<string, { clicks: number; impressions: number; weighted: number }>()
    for (const r of rows) {
      let path = ''
      try {
        path = new URL(r.key).pathname.replace(/\/+$/, '') || '/'
      } catch {
        continue
      }
      const cur = byPath.get(path) ?? { clicks: 0, impressions: 0, weighted: 0 }
      cur.clicks += r.clicks
      cur.impressions += r.impressions
      cur.weighted += r.position * r.impressions
      byPath.set(path, cur)
    }
    const out = [...byPath].map(([path, v]) => ({ path, position: v.impressions ? Math.round((v.weighted / v.impressions) * 10) / 10 : 0, clicks: Math.round(v.clicks), impressions: Math.round(v.impressions) }))
    pageCache = { rows: out, at: Date.now() }
    return out
  } catch {
    return []
  }
}

export interface RankingSnapshotData {
  queries: DimensionRow[]
  pages: DimensionRow[]
  totals: { clicks: number; impressions: number }
}

/** Every query and page Google reports for the last 28 days ending 2 days ago - deeper than
 * getSearchConsoleQueries's cached top-1000, fetched fresh for the daily ranking-snapshot cron
 * (factory Phase 5). Returns null when Search Console isn't configured, same "dormant until
 * configured" convention as every other integration in this project. */
export async function getSearchConsoleRankingSnapshot(days = 28): Promise<RankingSnapshotData | null> {
  if (!isSearchConsoleConfigured()) return null
  const [queries, pages] = await Promise.all([dimensionReport('query', days), dimensionReport('page', days)])
  const totals = queries.reduce((acc, r) => ({ clicks: acc.clicks + r.clicks, impressions: acc.impressions + r.impressions }), { clicks: 0, impressions: 0 })
  return { queries, pages, totals }
}
