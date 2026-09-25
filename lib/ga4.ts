import { getGoogleAccessToken, isGoogleServiceAccountConfigured } from '@/lib/google-auth'

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

let cache: { report: Ga4Report; at: number } | null = null

export function isGa4Configured(): boolean {
  return !!process.env.GA4_PROPERTY_ID && isGoogleServiceAccountConfigured()
}

function channelOf(group: string): Ga4Channel {
  return (GA4_CHANNELS as readonly string[]).includes(group) ? (group as Ga4Channel) : 'Other'
}

export async function getGa4Report(days = 14): Promise<Ga4Report> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.report

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
  cache = { report, at: Date.now() }
  return report
}
