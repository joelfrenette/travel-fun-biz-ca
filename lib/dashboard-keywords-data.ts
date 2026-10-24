import type { SupabaseClient } from '@supabase/supabase-js'
import { getGoogleAccessToken } from '@/lib/google-auth'
import { isSearchConsoleConfigured, searchConsoleSiteUrl } from '@/lib/search-console'
import { gscWindow, type DashRange } from '@/lib/dashboard-range'
import { buildTopKeywords, type QueryPageRow, type QueryRow, type TargetRow, type TopKeywordsResponse } from '@/lib/dashboard-keywords'

// Server side of the dashboard "Top keywords" table. Read only: two Search Console reads for the dashboard range (the searches, and the
// searches with their pages), cached for 10 minutes per range, plus the pages chosen in Keyword Research. Every source fails on its own:
// an unreadable page report only empties that column. No AI call and no credits.

const SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly'
const CACHE_MS = 10 * 60 * 1000
const cache = new Map<string, { at: number; queries: QueryRow[]; pairs: QueryPageRow[] | null }>()

async function gscQuery(dimensions: string[], range: DashRange, rowLimit: number, timeoutMs: number): Promise<{ keys?: string[]; clicks?: number; impressions?: number; position?: number }[]> {
  const { startDate, endDate } = gscWindow(range)
  const token = await getGoogleAccessToken(SCOPE)
  const res = await fetch(`https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(searchConsoleSiteUrl())}/searchAnalytics/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ startDate, endDate, dimensions, rowLimit }),
    cache: 'no-store',
    signal: AbortSignal.timeout(timeoutMs),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`Search Console query failed: ${body.error?.message || res.status}`)
  return body.rows || []
}

async function readTargets(admin: SupabaseClient): Promise<TargetRow[] | null> {
  try {
    const { data, error } = await admin.from('keyword_research').select('keyword, target_path').not('target_path', 'is', null).limit(2000)
    if (error) return null
    return (data ?? []) as TargetRow[]
  } catch {
    return null
  }
}

export async function getTopKeywords(admin: SupabaseClient, range: DashRange): Promise<TopKeywordsResponse> {
  const win = gscWindow(range)
  const base = { range, startDate: win.startDate, endDate: win.endDate, clamped: win.clamped }
  if (!isSearchConsoleConfigured()) return { ...base, startDate: null, endDate: null, clamped: false, status: 'not_connected', error: null, pagesRead: false, rows: [] }
  try {
    let hit = cache.get(range)
    if (!hit || Date.now() - hit.at >= CACHE_MS) {
      const qRows = await gscQuery(['query'], range, 100, 15_000)
      const queries: QueryRow[] = qRows.map((r) => ({ query: String(r.keys?.[0] ?? ''), clicks: Number(r.clicks) || 0, impressions: Number(r.impressions) || 0, position: Number(r.position) || 0 }))
      let pairs: QueryPageRow[] | null = null
      try {
        const pRows = await gscQuery(['query', 'page'], range, 2000, 15_000)
        pairs = pRows.map((r) => {
          let path = ''
          try {
            path = new URL(String(r.keys?.[1] ?? '')).pathname.replace(/\/+$/, '') || '/'
          } catch {
            path = ''
          }
          return { query: String(r.keys?.[0] ?? ''), path, clicks: Number(r.clicks) || 0, impressions: Number(r.impressions) || 0 }
        }).filter((p) => p.query && p.path)
      } catch {
        pairs = null
      }
      hit = { at: Date.now(), queries, pairs }
      cache.set(range, hit)
    }
    const targets = await readTargets(admin)
    return { ...base, status: 'ok', error: null, pagesRead: hit.pairs !== null, rows: buildTopKeywords({ queries: hit.queries, pairs: hit.pairs, targets }) }
  } catch (e) {
    return { ...base, startDate: null, endDate: null, clamped: false, status: 'error', error: e instanceof Error ? e.message : 'Search Console request failed', pagesRead: false, rows: [] }
  }
}
