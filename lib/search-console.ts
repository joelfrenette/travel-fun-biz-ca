import { getGoogleAccessToken, isGoogleServiceAccountConfigured } from '@/lib/google-auth'

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
