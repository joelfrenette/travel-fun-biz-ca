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

  const token = await getGoogleAccessToken(SCOPE)
  // Search Console data lags about two days, so end the window there.
  const end = new Date(Date.now() - 2 * 864e5)
  const start = new Date(end.getTime() - (days - 1) * 864e5)
  const iso = (d: Date) => d.toISOString().slice(0, 10)

  const res = await fetch(`https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(searchConsoleSiteUrl())}/searchAnalytics/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ startDate: iso(start), endDate: iso(end), dimensions: ['query'], rowLimit: 1000 }),
    cache: 'no-store',
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`Search Console query failed: ${body.error?.message || res.status}`)

  const rows: SearchConsoleRow[] = (body.rows || []).map((r: any) => ({
    query: String(r.keys?.[0] || '').toLowerCase(),
    clicks: Number(r.clicks) || 0,
    impressions: Number(r.impressions) || 0,
    ctr: Number(r.ctr) || 0,
    position: Number(r.position) || 0,
  }))
  cache = { rows, at: Date.now(), days }
  return rows
}
