import { getGoogleAccessToken, isGoogleServiceAccountConfigured } from '@/lib/google-auth'
import {
  bucketFor, dashChannelOf, emptyChannelCounts, ga4BucketDimension, ga4DateRange, ga4KeyToBucketKey,
  type Bucket, type DashChannel, type DashRange,
} from '@/lib/dashboard-range'

// GA4 Data API, read through the shared service account. One runReport call, cached in
// memory for an hour so the dashboard never hammers the quota.
const SCOPE = 'https://www.googleapis.com/auth/analytics.readonly'
const CACHE_MS = 60 * 60 * 1000

export const GA4_CHANNELS = [
  'Organic Search',
  'Direct',
  'Organic Social',
  'Paid Social',
  'Paid Search',
  'Email',
  'Referral',
  'Organic Video',
  'Other',
] as const
export type Ga4Channel = (typeof GA4_CHANNELS)[number]

export interface Ga4Day {
  date: string
  channels: Record<Ga4Channel, number>
}

export interface Ga4Report {
  days: Ga4Day[]
  totals: { sessions: number; users: number; organicSearch: number; social: number }
  fetchedAt: string
}

let cache: { report: Ga4Report; at: number; days: number } | null = null

export function isGa4Configured(): boolean {
  return !!process.env.GA4_PROPERTY_ID && isGoogleServiceAccountConfigured()
}

function channelOf(group: string): Ga4Channel {
  return (GA4_CHANNELS as readonly string[]).includes(group) ? (group as Ga4Channel) : 'Other'
}

/** Pure: GA4 landing page rows to sessions per site path. The query string and trailing slash are dropped, a page
 * seen under two spellings counts once, and the admin and API areas are left out. GA4's "(not set)" is ignored. */
export function sessionsByPath(rows: { landingPage: string; sessions: number }[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const r of rows) {
    let p = (r.landingPage || '').trim()
    if (!p || p === '(not set)') continue
    try {
      if (/^https?:\/\//i.test(p)) p = new URL(p).pathname
    } catch {
      continue
    }
    p = p.split(/[?#]/)[0].replace(/\/+$/, '')
    p = p === '' ? '/' : p.startsWith('/') ? p : `/${p}`
    if (p.startsWith('/admin') || p.startsWith('/api')) continue
    if (!Number.isFinite(r.sessions) || r.sessions < 0) continue
    out.set(p, (out.get(p) ?? 0) + Math.round(r.sessions))
  }
  return out
}

/** Sessions per landing page over the last `days` days (default 28), from ONE read-only GA4 Data API request. Used by
 * the daily performance snapshot to fill content_performance.visits. Throws on an error so the caller can say so and
 * leave visits null (never invented). Not cached: it runs once a day. */
export async function getGa4LandingPageSessions(days = 28): Promise<Map<string, number>> {
  const propertyId = process.env.GA4_PROPERTY_ID
  if (!propertyId) throw new Error('GA4_PROPERTY_ID is not set')
  const token = await getGoogleAccessToken(SCOPE)
  const res = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${encodeURIComponent(propertyId)}:runReport`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      dateRanges: [{ startDate: `${days - 1}daysAgo`, endDate: 'today' }],
      dimensions: [{ name: 'landingPage' }],
      metrics: [{ name: 'sessions' }],
      orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
      limit: 10000,
    }),
    cache: 'no-store',
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`GA4 landing page report failed: ${body.error?.message || res.status}`)
  return sessionsByPath(
    ((body.rows || []) as { dimensionValues?: { value?: string }[]; metricValues?: { value?: string }[] }[]).map((row) => ({
      landingPage: String(row.dimensionValues?.[0]?.value || ''),
      sessions: Number(row.metricValues?.[0]?.value) || 0,
    })),
  )
}

export async function getGa4Report(days = 14): Promise<Ga4Report> {
  if (cache && cache.days === days && Date.now() - cache.at < CACHE_MS) return cache.report

  const propertyId = process.env.GA4_PROPERTY_ID
  if (!propertyId) throw new Error('GA4_PROPERTY_ID is not set')
  const token = await getGoogleAccessToken(SCOPE)

  const res = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${encodeURIComponent(propertyId)}:runReport`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      dateRanges: [{ startDate: `${days - 1}daysAgo`, endDate: 'today' }],
      dimensions: [{ name: 'date' }, { name: 'sessionDefaultChannelGroup' }],
      metrics: [{ name: 'sessions' }, { name: 'totalUsers' }],
      orderBys: [{ dimension: { dimensionName: 'date' } }],
      limit: 10000,
    }),
    cache: 'no-store',
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`GA4 report failed: ${body.error?.message || res.status}`)

  const byDate = new Map<string, Ga4Day>()
  const totals = { sessions: 0, users: 0, organicSearch: 0, social: 0 }
  for (const row of body.rows || []) {
    const date = String(row.dimensionValues?.[0]?.value || '')
    const channel = channelOf(String(row.dimensionValues?.[1]?.value || ''))
    const sessions = Number(row.metricValues?.[0]?.value) || 0
    const users = Number(row.metricValues?.[1]?.value) || 0
    if (!byDate.has(date)) {
      byDate.set(date, { date, channels: Object.fromEntries(GA4_CHANNELS.map((c) => [c, 0])) as Record<Ga4Channel, number> })
    }
    byDate.get(date)!.channels[channel] += sessions
    totals.sessions += sessions
    totals.users += users
    if (channel === 'Organic Search') totals.organicSearch += sessions
    if (channel === 'Organic Social' || channel === 'Paid Social') totals.social += sessions
  }

  const report: Ga4Report = {
    days: Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date)),
    totals,
    fetchedAt: new Date().toISOString(),
  }
  cache = { report, at: Date.now(), days }
  return report
}

// ---------- Dashboard range report (7 / 30 / 365 days / all time) ----------

const RANGE_CACHE_MS = 10 * 60 * 1000

export interface Ga4RangeReport {
  range: DashRange
  bucket: Bucket
  /** Actual dates GA4 was asked for (relative for the fixed ranges, 2020-01-01 for all time). */
  startDate: string
  endDate: string
  /** One entry per day/week/month, oldest first, every channel present (zero-filled). */
  buckets: { key: string; channels: Record<DashChannel, number>; /** Unique users in that day/week/month (its own Google request, so not a sum of channels). Absent when that request failed. */ users?: number }[]
  /** Sessions per channel over the whole range; every channel is present, zero when none. */
  channelTotals: Record<DashChannel, number>
  /** users and newUsers come from a separate no-dimension request, so they are true unique counts, not sums of daily counts. */
  totals: { sessions: number; users: number; newUsers: number; organicSearch: number; direct: number; referral: number; social: number }
  fetchedAt: string
}

const rangeCache = new Map<DashRange, { report: Ga4RangeReport; at: number }>()

/** Pure: GA4 rows to the report shape. Offline-testable. */
export function buildRangeReport(
  range: DashRange,
  seriesRows: { dimensionValues?: { value?: string }[]; metricValues?: { value?: string }[] }[],
  totalsRow: { metricValues?: { value?: string }[] } | undefined,
  fetchedAt = new Date().toISOString(),
  usersRows?: { dimensionValues?: { value?: string }[]; metricValues?: { value?: string }[] }[],
): Ga4RangeReport {
  const bucket = bucketFor(range)
  const usersByKey = new Map<string, number>()
  for (const row of usersRows ?? []) usersByKey.set(ga4KeyToBucketKey(String(row.dimensionValues?.[0]?.value || ''), bucket), Number(row.metricValues?.[0]?.value) || 0)
  const byKey = new Map<string, Record<DashChannel, number>>()
  const channelTotals = emptyChannelCounts()
  let sessions = 0
  for (const row of seriesRows) {
    const key = ga4KeyToBucketKey(String(row.dimensionValues?.[0]?.value || ''), bucket)
    const channel = dashChannelOf(String(row.dimensionValues?.[1]?.value || ''))
    const n = Number(row.metricValues?.[0]?.value) || 0
    if (!byKey.has(key)) byKey.set(key, emptyChannelCounts())
    byKey.get(key)![channel] += n
    channelTotals[channel] += n
    sessions += n
  }
  const { startDate, endDate } = ga4DateRange(range)
  return {
    range,
    bucket,
    startDate,
    endDate,
    buckets: [...byKey].sort((a, b) => a[0].localeCompare(b[0])).map(([key, channels]) => ({ key, channels, ...(usersRows ? { users: usersByKey.get(key) ?? 0 } : {}) })),
    channelTotals,
    totals: {
      sessions: totalsRow ? Number(totalsRow.metricValues?.[0]?.value) || 0 : sessions,
      users: Number(totalsRow?.metricValues?.[1]?.value) || 0,
      newUsers: Number(totalsRow?.metricValues?.[2]?.value) || 0,
      organicSearch: channelTotals['Organic Search'],
      direct: channelTotals.Direct,
      referral: channelTotals.Referral,
      social: channelTotals['Organic Social'] + channelTotals['Paid Social'],
    },
    fetchedAt,
  }
}

async function runReport(propertyId: string, token: string, body: Record<string, unknown>) {
  const res = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${encodeURIComponent(propertyId)}:runReport`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`GA4 report failed: ${json.error?.message || res.status}`)
  return json as { rows?: { dimensionValues?: { value?: string }[]; metricValues?: { value?: string }[] }[] }
}

/** Sessions by channel for a dashboard range, cached 10 minutes per range. Throws "GA4 report failed: <reason>" on a Google error. */
export async function getGa4RangeReport(range: DashRange): Promise<Ga4RangeReport> {
  const hit = rangeCache.get(range)
  if (hit && Date.now() - hit.at < RANGE_CACHE_MS) return hit.report

  const propertyId = process.env.GA4_PROPERTY_ID
  if (!propertyId) throw new Error('GA4_PROPERTY_ID is not set')
  const token = await getGoogleAccessToken(SCOPE)
  const dateRanges = [ga4DateRange(range)]
  const bucketDim = ga4BucketDimension(range)

  const [series, totals, usersSeries] = await Promise.all([
    runReport(propertyId, token, {
      dateRanges,
      dimensions: [{ name: bucketDim }, { name: 'sessionDefaultChannelGroup' }],
      metrics: [{ name: 'sessions' }],
      orderBys: [{ dimension: { dimensionName: bucketDim } }],
      limit: 10000,
    }),
    runReport(propertyId, token, { dateRanges, metrics: [{ name: 'sessions' }, { name: 'totalUsers' }, { name: 'newUsers' }] }),
    // Unique users per day/week/month for the combined traffic chart. If this one fails the rest still shows, without a Users line.
    runReport(propertyId, token, { dateRanges, dimensions: [{ name: bucketDim }], metrics: [{ name: 'totalUsers' }], orderBys: [{ dimension: { dimensionName: bucketDim } }], limit: 10000 }).catch(() => null),
  ])
  const report = buildRangeReport(range, series.rows || [], totals.rows?.[0], undefined, usersSeries ? usersSeries.rows || [] : undefined)
  rangeCache.set(range, { report, at: Date.now() })
  return report
}

// ---------- Dashboard top pages (page views per path for a range) ----------

export interface Ga4PageViewRow {
  pagePath: string
  views: number
  sessions: number
}

const pageCache = new Map<DashRange, { rows: Ga4PageViewRow[]; at: number }>()

/** Page views and sessions per page path for a dashboard range, one read-only request, cached 10 minutes per range.
 * Throws "GA4 report failed: <reason>" on a Google error so the caller can say "could not be read" (never a zero). */
export async function getGa4PageViews(range: DashRange): Promise<Ga4PageViewRow[]> {
  const hit = pageCache.get(range)
  if (hit && Date.now() - hit.at < RANGE_CACHE_MS) return hit.rows
  const propertyId = process.env.GA4_PROPERTY_ID
  if (!propertyId) throw new Error('GA4_PROPERTY_ID is not set')
  const token = await getGoogleAccessToken(SCOPE)
  const json = await runReport(propertyId, token, {
    dateRanges: [ga4DateRange(range)],
    dimensions: [{ name: 'pagePath' }],
    metrics: [{ name: 'screenPageViews' }, { name: 'sessions' }],
    orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
    limit: 10000,
  })
  const rows = (json.rows || []).map((r) => ({
    pagePath: String(r.dimensionValues?.[0]?.value || ''),
    views: Number(r.metricValues?.[0]?.value) || 0,
    sessions: Number(r.metricValues?.[1]?.value) || 0,
  }))
  pageCache.set(range, { rows, at: Date.now() })
  return rows
}
