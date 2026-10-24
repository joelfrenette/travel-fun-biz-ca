// The ONE traffic chart on the dashboard, pure part. Three data sources go in (Google Analytics sessions by channel, Google Search
// clicks and impressions, visits this site recorded itself); one table with a shared time axis and a list of series comes out.
// A source that is not connected, switched off or could not be read is named in `unavailable` with the reason and its series is
// left out. It is never drawn as a zero. No network and no database here, so scripts/check-traffic-series.ts tests it offline.

import type { Ga4RangeReport } from './ga4'
import type { SearchRangeResult, VisitsRangeResult } from './dashboard-data'
import { CHANNEL_COLORS, DASH_CHANNELS, SERIES_COLORS, bucketLabel, type Bucket, type DashChannel } from './dashboard-range'

// The first chart on the dashboard is a STACKED chart: one colour-coded layer per traffic source (Google Analytics channel), with the
// combined total as a line on top. Each row therefore also carries one `ch_*` value per channel (see channelKey). The users, Google
// Search and recorded-visit series are extra lines the person can switch on. The stack and the total come from the same numbers, so the
// layers always add up to the line.

export type ChannelKey = `ch_${string}`
export const channelKey = (c: DashChannel): ChannelKey => `ch_${c.toLowerCase().replace(/\s+/g, '_')}`

/** The total line on top of the stack (the sum of every source). */
export const TOTAL_ID = 'sessions' as const
/** Lines the person can switch on beside the stack. They are off at first so the first picture stays about the sources. */
export const EXTRA_IDS = ['users', 'clicks', 'impressions', 'visits'] as const
export const EXTRA_DEFAULT_HIDDEN: readonly SeriesId[] = [...EXTRA_IDS]

export interface ChannelLayer {
  channel: DashChannel
  key: ChannelKey
  color: string
  /** Sessions over the range. */
  total: number
  /** Share of all sessions, 0 to 100 (one decimal). 0 when there are no sessions. */
  share: number
}

export const SERIES_IDS = ['sessions', 'users', 'organic', 'direct', 'referral', 'social', 'clicks', 'impressions', 'visits'] as const
export type SeriesId = (typeof SERIES_IDS)[number]

export interface SeriesSpec {
  id: SeriesId
  label: string
  color: string
  /** Impressions are far bigger than everything else, so they sit on their own right-hand scale. */
  axis: 'left' | 'right'
  /** Line style, so two series that share a colour (clicks and organic search are both green) can still be told apart without colour. */
  dash: string | undefined
  source: 'Google Analytics' | 'Google Search' | 'this site'
}

export const SERIES_SPECS: Record<SeriesId, SeriesSpec> = {
  sessions: { id: 'sessions', label: 'Total traffic (all sources)', color: '#2563eb', axis: 'left', dash: undefined, source: 'Google Analytics' },
  users: { id: 'users', label: 'Users', color: '#7c3aed', axis: 'left', dash: undefined, source: 'Google Analytics' },
  organic: { id: 'organic', label: 'Organic search sessions', color: CHANNEL_COLORS['Organic Search'], axis: 'left', dash: undefined, source: 'Google Analytics' },
  direct: { id: 'direct', label: 'Direct sessions', color: CHANNEL_COLORS.Direct, axis: 'left', dash: undefined, source: 'Google Analytics' },
  referral: { id: 'referral', label: 'Referral sessions', color: CHANNEL_COLORS.Referral, axis: 'left', dash: undefined, source: 'Google Analytics' },
  social: { id: 'social', label: 'Social sessions', color: CHANNEL_COLORS['Organic Social'], axis: 'left', dash: undefined, source: 'Google Analytics' },
  clicks: { id: 'clicks', label: 'Google Search clicks', color: SERIES_COLORS.clicks, axis: 'left', dash: '6 3', source: 'Google Search' },
  impressions: { id: 'impressions', label: 'Google Search impressions (right scale)', color: SERIES_COLORS.impressions, axis: 'right', dash: '2 3', source: 'Google Search' },
  visits: { id: 'visits', label: 'Visits recorded by this site', color: SERIES_COLORS.visits, axis: 'left', dash: '10 3 2 3', source: 'this site' },
}

/** What each source gave back. `loading` is handled by the card, never passed in here. */
export type GaInput = { status: 'ok'; report: Ga4RangeReport } | { status: 'not_connected' } | { status: 'error'; message?: string }
export type SearchInput = { status: 'ok'; data: SearchRangeResult } | { status: 'error'; message?: string }
export type VisitsInput = { status: 'ok'; data: VisitsRangeResult } | { status: 'error'; message?: string }

export interface TrafficSeries extends SeriesSpec {
  available: boolean
  /** Why it is missing, in plain words. Empty when available. */
  reason: string
  /** Sum over the range (users: the true unique count from Google). null when unavailable. */
  total: number | null
}

export type TrafficRow = { key: string; label: string } & Partial<Record<SeriesId, number>> & Partial<Record<ChannelKey, number>>

export interface TrafficChart {
  bucket: Bucket
  rows: TrafficRow[]
  /** All nine, in a fixed order, available or not. */
  series: TrafficSeries[]
  /** The colour-coded layers of the stack, one per traffic source that brought sessions, biggest first. Empty when Google Analytics could not be read. */
  channels: ChannelLayer[]
  /** Only the ones that are missing, each with the reason. */
  unavailable: { id: SeriesId; label: string; reason: string }[]
  /** True when at least one available series has a point above zero. */
  hasData: boolean
}

const finite = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) ? n : 0)

export function buildTrafficSeries(bucket: Bucket, ga: GaInput, search: SearchInput, visits: VisitsInput): TrafficChart {
  const reasons: Partial<Record<SeriesId, string>> = {}
  const totals: Partial<Record<SeriesId, number>> = {}
  const table = new Map<string, TrafficRow>()
  const rowFor = (key: string): TrafficRow => {
    let r = table.get(key)
    if (!r) {
      r = { key, label: bucketLabel(key, bucket) }
      table.set(key, r)
    }
    return r
  }
  const miss = (ids: SeriesId[], why: string) => ids.forEach((id) => (reasons[id] = why))

  // ---- Google Analytics
  const GA_IDS: SeriesId[] = ['sessions', 'users', 'organic', 'direct', 'referral', 'social']
  if (ga.status === 'not_connected') miss(GA_IDS, 'Google Analytics is not connected')
  else if (ga.status === 'error') miss(GA_IDS, 'Google Analytics could not be read')
  else {
    const rep = ga.report
    let sessionsSum = 0
    let hasUsers = false
    for (const b of rep.buckets) {
      const row = rowFor(b.key)
      const sum = Object.values(b.channels).reduce<number>((a, n) => a + finite(n), 0)
      sessionsSum += sum
      row.sessions = sum
      for (const c of DASH_CHANNELS) row[channelKey(c)] = finite(b.channels[c])
      row.organic = finite(b.channels['Organic Search'])
      row.direct = finite(b.channels.Direct)
      row.referral = finite(b.channels.Referral)
      row.social = finite(b.channels['Organic Social']) + finite(b.channels['Paid Social'])
      if (typeof b.users === 'number' && Number.isFinite(b.users)) {
        row.users = b.users
        hasUsers = true
      }
    }
    totals.sessions = rep.totals.sessions || sessionsSum
    totals.organic = rep.totals.organicSearch
    totals.direct = rep.totals.direct
    totals.referral = rep.totals.referral
    totals.social = rep.totals.social
    // No days at all means there is nothing to be missing a users number for.
    if (hasUsers || rep.buckets.length === 0) totals.users = rep.totals.users
    else reasons.users = 'Users has no daily numbers yet, only a total'
  }

  // ---- Google Search
  if (search.status === 'error') miss(['clicks', 'impressions'], 'Google Search could not be read')
  else if (search.data.source === 'snapshot') miss(['clicks', 'impressions'], 'Google Search could not be read live (only a 28-day total is stored)')
  else if (search.data.source === 'none') miss(['clicks', 'impressions'], 'Google Search could not be read')
  else {
    let clicks = 0
    let impressions = 0
    for (const p of search.data.points) {
      const row = rowFor(p.key)
      row.clicks = finite(p.clicks)
      row.impressions = finite(p.impressions)
      clicks += finite(p.clicks)
      impressions += finite(p.impressions)
    }
    totals.clicks = search.data.totals ? search.data.totals.clicks : clicks
    totals.impressions = search.data.totals ? search.data.totals.impressions : impressions
  }

  // ---- Visits recorded by this site
  if (visits.status === 'error') miss(['visits'], 'Recorded visits could not be read')
  else if (!visits.data.trackingOn) miss(['visits'], 'visit tracking is off')
  else if (visits.data.error) miss(['visits'], 'Recorded visits could not be read')
  else {
    for (const p of visits.data.points) rowFor(p.key).visits = finite(p.total)
    totals.visits = visits.data.total
  }

  const rows = [...table.values()].sort((a, b) => a.key.localeCompare(b.key))
  const series: TrafficSeries[] = SERIES_IDS.map((id) => {
    const reason = reasons[id] ?? ''
    const available = reason === ''
    return { ...SERIES_SPECS[id], available, reason, total: available ? totals[id] ?? 0 : null }
  })
  // A point that one available source did not report is a real zero for it (it was read and had nothing), so fill it.
  const availableIds = series.filter((s) => s.available).map((s) => s.id)
  for (const r of rows) for (const id of availableIds) if (r[id] === undefined) r[id] = 0

  // The stack: only when Google Analytics was read. A channel with no sessions in the range is left out of the picture (the legend
  // under the chart still says how many sources were quiet).
  const channels: ChannelLayer[] = []
  if (ga.status === 'ok') {
    const grand = ga.report.buckets.reduce((a, b) => a + Object.values(b.channels).reduce<number>((x, n) => x + finite(n), 0), 0)
    for (const c of DASH_CHANNELS) {
      const total = ga.report.buckets.reduce((a, b) => a + finite(b.channels[c]), 0)
      if (total > 0) channels.push({ channel: c, key: channelKey(c), color: CHANNEL_COLORS[c], total, share: grand > 0 ? Math.round((total / grand) * 1000) / 10 : 0 })
    }
    channels.sort((a, b) => b.total - a.total)
    for (const r of rows) for (const c of DASH_CHANNELS) if (r[channelKey(c)] === undefined) r[channelKey(c)] = 0
  }

  return {
    bucket,
    rows,
    series,
    channels,
    unavailable: series.filter((s) => !s.available).map((s) => ({ id: s.id, label: s.label, reason: s.reason })),
    hasData: rows.some((r) => availableIds.some((id) => (r[id] ?? 0) > 0)),
  }
}

/** The one-line note under the chart. Groups the missing series by reason so it stays short. Empty when nothing is missing. */
export function unavailableNote(chart: TrafficChart): string {
  if (chart.unavailable.length === 0) return ''
  const byReason = new Map<string, string[]>()
  for (const u of chart.unavailable) byReason.set(u.reason, [...(byReason.get(u.reason) ?? []), u.label.replace(' (right scale)', '')])
  return `Not drawn: ${[...byReason].map(([reason, labels]) => `${labels.join(', ')} (${reason})`).join('; ')}. Nothing here is a zero that was not counted.`
}

export interface TooltipLine {
  label: string
  color: string
  value: number
  /** Share of that point's total, 0 to 100 (whole numbers). */
  share: number
}

/** What the tooltip shows for one point: every source with sessions at that point (value and share of that point), biggest first, and
 * the total. The channel values are the ones in the stack, so the lines always add up to the total. Pure. */
export function tooltipBreakdown(row: TrafficRow, channels: readonly ChannelLayer[]): { total: number; lines: TooltipLine[] } {
  const vals = channels.map((c) => ({ c, v: finite(row[c.key]) }))
  const total = vals.reduce((a, x) => a + x.v, 0)
  const lines = vals
    .filter((x) => x.v > 0)
    .sort((a, b) => b.v - a.v)
    .map((x) => ({ label: x.c.channel, color: x.c.color, value: x.v, share: total > 0 ? Math.round((x.v / total) * 100) : 0 }))
  return { total, lines }
}

/** The extra lines (users, Google Search, recorded visits) that can be drawn beside the stack. Pure. */
export function extraLines(chart: TrafficChart, hidden: readonly SeriesId[]): TrafficSeries[] {
  return visibleSeries(chart, hidden).filter((s) => (EXTRA_IDS as readonly string[]).includes(s.id))
}

/** Which series ids are drawn, given the ones the person switched off. Pure. */
export function visibleSeries(chart: TrafficChart, hidden: readonly SeriesId[]): TrafficSeries[] {
  return chart.series.filter((s) => s.available && !hidden.includes(s.id))
}

/** Toggle one id in the hidden list. Pure. */
export function toggleHidden(hidden: readonly SeriesId[], id: SeriesId): SeriesId[] {
  return hidden.includes(id) ? hidden.filter((h) => h !== id) : [...hidden, id]
}
