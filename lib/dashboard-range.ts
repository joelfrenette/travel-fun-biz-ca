// Pure helpers for the admin Dashboard range selector (Last 7 days / 30 days / 12 months / All time).
// No network, no database, safe to import from client components and from offline checks.

export type DashRange = '7' | '30' | '365' | 'all'
export const DASH_RANGES: readonly DashRange[] = ['7', '30', '365', 'all']
export const DEFAULT_RANGE: DashRange = '30'
/** Versioned: an older stored choice (for example "all", which used to be the default) lives under the old key and is ignored, so the new 30-day default shows. */
export const RANGE_STORAGE_KEY = 'tfb-dashboard-range-v2'

export const RANGE_LABELS: Record<DashRange, string> = {
  '7': 'Last 7 days',
  '30': 'Last 30 days',
  '365': 'Last 12 months',
  all: 'All time',
}

/** Short phrase used inside card text, e.g. "Sessions (last 30 days)". */
export const RANGE_PHRASE: Record<DashRange, string> = {
  '7': 'last 7 days',
  '30': 'last 30 days',
  '365': 'last 12 months',
  all: 'all time',
}

/** Anything that is not one of the four known values (bad URL, bad localStorage) becomes 30. */
export function parseRange(value: unknown): DashRange {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : typeof value === 'number' ? String(value) : ''
  return (DASH_RANGES as readonly string[]).includes(v) ? (v as DashRange) : DEFAULT_RANGE
}

/** URL wins over localStorage; both fall back to 30. */
export function resolveRange(urlValue: string | null | undefined, storedValue: string | null | undefined): DashRange {
  if (urlValue && (DASH_RANGES as readonly string[]).includes(urlValue.trim().toLowerCase())) return parseRange(urlValue)
  if (storedValue && (DASH_RANGES as readonly string[]).includes(storedValue.trim().toLowerCase())) return parseRange(storedValue)
  return DEFAULT_RANGE
}

/** Number of days in the range, or null for all time. */
export function rangeDays(range: DashRange): number | null {
  return range === 'all' ? null : Number(range)
}

export type Bucket = 'day' | 'week' | 'month'

/** Chart bucket: days for up to 30 days, weeks for 12 months, months for all time (keeps the chart readable). */
export function bucketFor(range: DashRange): Bucket {
  if (range === '7' || range === '30') return 'day'
  if (range === '365') return 'week'
  return 'month'
}

/** GA4 start date for a range. Today counts as the last day, so 7 days = 6daysAgo..today. "All" starts in 2020 and GA4 clips it to the property's start. */
export function ga4DateRange(range: DashRange): { startDate: string; endDate: string } {
  const days = rangeDays(range)
  return { startDate: days === null ? '2020-01-01' : `${days - 1}daysAgo`, endDate: 'today' }
}

/** GA4 dimension that buckets the series for a range. */
export function ga4BucketDimension(range: DashRange): 'date' | 'isoYearIsoWeek' | 'yearMonth' {
  const b = bucketFor(range)
  return b === 'day' ? 'date' : b === 'week' ? 'isoYearIsoWeek' : 'yearMonth'
}

// ---------- channels and colours ----------

/** Every GA4 default channel group the dashboard shows, always, in this order (zero-filled). */
export const DASH_CHANNELS = ['Organic Search', 'Direct', 'Referral', 'Organic Social', 'Email', 'Paid Search', 'Paid Social', 'Unassigned', 'Other'] as const
export type DashChannel = (typeof DASH_CHANNELS)[number]

/** Fixed palette, readable on both the light and the dark card background (mid-tone, not pastel, not near-black). */
export const CHANNEL_COLORS: Record<DashChannel, string> = {
  'Organic Search': '#16a34a',
  Direct: '#2563eb',
  Referral: '#9333ea',
  'Organic Social': '#e11d48',
  Email: '#d97706',
  'Paid Search': '#ea580c',
  'Paid Social': '#be185d',
  Unassigned: '#9ca3af',
  Other: '#64748b',
}

/** Colours for the non-channel series. */
export const SERIES_COLORS = { clicks: '#16a34a', impressions: '#2563eb', visits: '#0d9488' } as const

/** Maps a raw GA4 sessionDefaultChannelGroup value to one of the nine dashboard channels. */
export function dashChannelOf(group: string): DashChannel {
  const g = (group || '').trim()
  if ((DASH_CHANNELS as readonly string[]).includes(g)) return g as DashChannel
  if (g === '(not set)' || g === '') return 'Unassigned'
  return 'Other'
}

export function emptyChannelCounts(): Record<DashChannel, number> {
  return Object.fromEntries(DASH_CHANNELS.map((c) => [c, 0])) as Record<DashChannel, number>
}

/** Legend entries: every channel, always, with a "none yet" flag when its total is zero. */
export function legendEntries(channelTotals: Partial<Record<DashChannel, number>>): { channel: DashChannel; color: string; total: number; none: boolean }[] {
  return DASH_CHANNELS.map((channel) => {
    const total = Number(channelTotals[channel]) || 0
    return { channel, color: CHANNEL_COLORS[channel], total, none: total === 0 }
  })
}

/** site_visits.channel (lib/traffic-source Channel) to a dashboard channel. AI assistants and link-in-bio count as Referral. */
export function visitChannelToDash(channel: string | null | undefined): DashChannel {
  switch ((channel || '').toLowerCase()) {
    case 'search': return 'Organic Search'
    case 'direct': return 'Direct'
    case 'referral':
    case 'ai_assistant':
    case 'bio': return 'Referral'
    case 'social': return 'Organic Social'
    case 'email': return 'Email'
    case 'paid_search': return 'Paid Search'
    case 'paid_social': return 'Paid Social'
    case '': return 'Unassigned'
    default: return 'Other'
  }
}

// ---------- Search Console window ----------

export const GSC_LAG_DAYS = 2
export const GSC_MAX_MONTHS = 16

const iso = (d: Date) => d.toISOString().slice(0, 10)

/** Search Console window for a range: ends 2 days ago (its data lags), never starts earlier than 16 months back. */
export function gscWindow(range: DashRange, now: Date = new Date()): { startDate: string; endDate: string; clamped: boolean } {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - GSC_LAG_DAYS))
  const earliest = new Date(end)
  earliest.setUTCMonth(earliest.getUTCMonth() - GSC_MAX_MONTHS)
  earliest.setUTCDate(earliest.getUTCDate() + 1)
  const days = rangeDays(range)
  if (days === null) return { startDate: iso(earliest), endDate: iso(end), clamped: true }
  const start = new Date(end)
  start.setUTCDate(start.getUTCDate() - (days - 1))
  if (start < earliest) return { startDate: iso(earliest), endDate: iso(end), clamped: true }
  return { startDate: iso(start), endDate: iso(end), clamped: false }
}

// ---------- bucketing ----------

/** ISO week key "YYYY-Www" for a YYYY-MM-DD date. */
export function isoWeekKey(day: string): string {
  const d = new Date(`${day.slice(0, 10)}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return day
  const dow = (d.getUTCDay() + 6) % 7
  d.setUTCDate(d.getUTCDate() - dow + 3)
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4))
  const week = 1 + Math.round(((d.getTime() - firstThursday.getTime()) / 864e5 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7)
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

/** Bucket key for a YYYY-MM-DD day. */
export function bucketKey(day: string, bucket: Bucket): string {
  const d = day.slice(0, 10)
  return bucket === 'day' ? d : bucket === 'month' ? d.slice(0, 7) : isoWeekKey(d)
}

/** GA4 dimension value (date 20261015, isoYearIsoWeek 202642, yearMonth 202610) to the same keys bucketKey produces. */
export function ga4KeyToBucketKey(value: string, bucket: Bucket): string {
  const v = (value || '').trim()
  if (bucket === 'day') return /^\d{8}$/.test(v) ? `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}` : v
  if (bucket === 'week') return /^\d{6}$/.test(v) ? `${v.slice(0, 4)}-W${v.slice(4, 6)}` : v
  return /^\d{6}$/.test(v) ? `${v.slice(0, 4)}-${v.slice(4, 6)}` : v
}

/** Short axis label for a bucket key. */
export function bucketLabel(key: string, bucket: Bucket): string {
  if (bucket === 'day') {
    const d = new Date(`${key}T00:00:00Z`)
    return Number.isNaN(d.getTime()) ? key : d.toLocaleDateString('en-CA', { month: 'short', day: 'numeric', timeZone: 'UTC' })
  }
  if (bucket === 'month') {
    const d = new Date(`${key}-01T00:00:00Z`)
    return Number.isNaN(d.getTime()) ? key : d.toLocaleDateString('en-CA', { month: 'short', year: '2-digit', timeZone: 'UTC' })
  }
  return key.replace('-', ' ')
}

export interface SearchPoint {
  key: string
  clicks: number
  impressions: number
  positionWeighted: number
}

/** Rolls daily Search Console rows into buckets and computes totals (CTR and average position are impression-weighted, never averaged per day). */
export function rollUpSearch(
  rows: { day: string; clicks: number; impressions: number; position: number }[],
  bucket: Bucket,
): { points: { key: string; clicks: number; impressions: number }[]; totals: { clicks: number; impressions: number; ctr: number; position: number } } {
  const map = new Map<string, SearchPoint>()
  let clicks = 0
  let impressions = 0
  let weighted = 0
  for (const r of rows) {
    const key = bucketKey(r.day, bucket)
    const cur = map.get(key) ?? { key, clicks: 0, impressions: 0, positionWeighted: 0 }
    cur.clicks += r.clicks
    cur.impressions += r.impressions
    map.set(key, cur)
    clicks += r.clicks
    impressions += r.impressions
    weighted += r.position * r.impressions
  }
  return {
    points: [...map.values()].sort((a, b) => a.key.localeCompare(b.key)).map(({ key, clicks: c, impressions: i }) => ({ key, clicks: Math.round(c), impressions: Math.round(i) })),
    totals: {
      clicks: Math.round(clicks),
      impressions: Math.round(impressions),
      ctr: impressions ? clicks / impressions : 0,
      position: impressions ? Math.round((weighted / impressions) * 10) / 10 : 0,
    },
  }
}

/** First-party visit rows to buckets, by dashboard channel (zero-filled), plus per-channel totals. */
export function rollUpVisits(
  rows: { created_at: string; channel: string | null }[],
  bucket: Bucket,
): { points: { key: string; total: number }[]; channelTotals: Record<DashChannel, number>; total: number } {
  const map = new Map<string, number>()
  const channelTotals = emptyChannelCounts()
  for (const r of rows) {
    if (!r.created_at) continue
    const key = bucketKey(r.created_at, bucket)
    map.set(key, (map.get(key) ?? 0) + 1)
    channelTotals[visitChannelToDash(r.channel)]++
  }
  return {
    points: [...map].sort((a, b) => a[0].localeCompare(b[0])).map(([key, total]) => ({ key, total })),
    channelTotals,
    total: rows.length,
  }
}
