import type { SupabaseClient } from '@supabase/supabase-js'
import { getGoogleAccessToken } from '@/lib/google-auth'
import { isSearchConsoleConfigured, searchConsoleSiteUrl } from '@/lib/search-console'
import { isVisitTrackingOn, VISIT_RETENTION_MONTHS } from '@/lib/visit-tracking'
import { bucketFor, gscWindow, rangeDays, rollUpSearch, rollUpVisits, type Bucket, type DashChannel, type DashRange } from '@/lib/dashboard-range'

// Server-side data for the dashboard's Search Console and first-party visit cards. Both honour the dashboard range.

const SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly'
const CACHE_MS = 10 * 60 * 1000

export interface SearchRangeResult {
  range: DashRange
  bucket: Bucket
  /** live = the range was read from Search Console. snapshot = could not be read, showing the stored 28-day total. none = nothing at all. */
  source: 'live' | 'snapshot' | 'none'
  startDate: string | null
  endDate: string | null
  /** True when the window was shortened to Search Console's 16-month limit. */
  clamped: boolean
  points: { key: string; clicks: number; impressions: number }[]
  totals: { clicks: number; impressions: number; ctr: number; position: number } | null
  /** Why the live read failed, when it did. */
  error: string | null
  /** Day of the stored snapshot, when source is snapshot. */
  snapshotDay: string | null
}

const searchCache = new Map<DashRange, { at: number; rows: { day: string; clicks: number; impressions: number; position: number }[] }>()

async function readDailyGsc(range: DashRange): Promise<{ day: string; clicks: number; impressions: number; position: number }[]> {
  const hit = searchCache.get(range)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.rows
  const { startDate, endDate } = gscWindow(range)
  const token = await getGoogleAccessToken(SCOPE)
  const res = await fetch(`https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(searchConsoleSiteUrl())}/searchAnalytics/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ startDate, endDate, dimensions: ['date'], rowLimit: 1000 }),
    cache: 'no-store',
    signal: AbortSignal.timeout(20_000),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`Search Console query failed: ${body.error?.message || res.status}`)
  const rows = ((body.rows || []) as { keys?: string[]; clicks?: number; impressions?: number; position?: number }[]).map((r) => ({
    day: String(r.keys?.[0] || ''),
    clicks: Number(r.clicks) || 0,
    impressions: Number(r.impressions) || 0,
    position: Number(r.position) || 0,
  }))
  searchCache.set(range, { at: Date.now(), rows })
  return rows
}

/** Clicks, impressions, CTR and average position for the range. On any failure or missing credentials, falls back to the stored 28-day snapshot (labelled as such by the caller). */
export async function getSearchRange(admin: SupabaseClient, range: DashRange): Promise<SearchRangeResult> {
  const bucket = bucketFor(range)
  const win = gscWindow(range)
  let error: string | null = null
  if (!isSearchConsoleConfigured()) {
    error = 'Google credentials are not set'
  } else {
    try {
      const rolled = rollUpSearch(await readDailyGsc(range), bucket)
      return { range, bucket, source: 'live', startDate: win.startDate, endDate: win.endDate, clamped: win.clamped, points: rolled.points, totals: rolled.totals, error: null, snapshotDay: null }
    } catch (e) {
      error = e instanceof Error ? e.message : 'Search Console request failed'
    }
  }
  // Fallback: the latest stored snapshot, which is always a rolling 28-day total (never summed across days).
  try {
    const { data } = await admin.from('gsc_ranking_days').select('day, clicks, impressions').order('day', { ascending: false }).limit(1)
    const row = (data ?? [])[0] as { day: string; clicks: number | null; impressions: number | null } | undefined
    if (row) {
      const clicks = row.clicks ?? 0
      const impressions = row.impressions ?? 0
      return { range, bucket, source: 'snapshot', startDate: null, endDate: null, clamped: false, points: [], totals: { clicks, impressions, ctr: impressions ? clicks / impressions : 0, position: 0 }, error, snapshotDay: row.day }
    }
  } catch {
    // fall through to none
  }
  return { range, bucket, source: 'none', startDate: null, endDate: null, clamped: false, points: [], totals: null, error, snapshotDay: null }
}

export interface VisitsRangeResult {
  range: DashRange
  bucket: Bucket
  trackingOn: boolean
  points: { key: string; total: number }[]
  channelTotals: Record<DashChannel, number> | null
  total: number
  /** True when more rows exist than were read (the chart shows the newest rows only). */
  capped: boolean
  /** Rows older than this are deleted by the retention job, so "all time" cannot reach back further. */
  retentionMonths: number
  error: string | null
}

const PAGE = 1000
const MAX_PAGES = 20

/** First-party visits (site_visits) for the range, bucketed. Reads nothing while tracking is off. */
export async function getVisitsRange(admin: SupabaseClient, range: DashRange): Promise<VisitsRangeResult> {
  const bucket = bucketFor(range)
  const base = { range, bucket, retentionMonths: VISIT_RETENTION_MONTHS }
  const trackingOn = await isVisitTrackingOn(admin)
  if (!trackingOn) return { ...base, trackingOn, points: [], channelTotals: null, total: 0, capped: false, error: null }
  const days = rangeDays(range)
  const sinceIso = days === null ? null : new Date(Date.now() - days * 86400000).toISOString()
  const rows: { created_at: string; channel: string | null }[] = []
  let capped = false
  for (let page = 0; page < MAX_PAGES; page++) {
    let q = admin.from('site_visits').select('created_at, channel')
    if (sinceIso) q = q.gte('created_at', sinceIso)
    const { data, error } = await q.order('created_at', { ascending: false }).range(page * PAGE, page * PAGE + PAGE - 1)
    if (error) return { ...base, trackingOn, points: [], channelTotals: null, total: 0, capped: false, error: error.message }
    const got = (data ?? []) as { created_at: string; channel: string | null }[]
    rows.push(...got)
    if (got.length < PAGE) break
    if (page === MAX_PAGES - 1) capped = true
  }
  const rolled = rollUpVisits(rows, bucket)
  return { ...base, trackingOn, points: rolled.points, channelTotals: rolled.channelTotals, total: rolled.total, capped, error: null }
}
