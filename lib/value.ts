import { summarizeOrders } from '@/lib/orders-summary'
import { CHANNELS, CHANNEL_LABELS, type Channel } from '@/lib/traffic-source'

// Website Value page, pure logic (no database, no network). lib/value-data.ts reads the sources and
// hands a ValueData bundle to buildValueReport; scripts/check-value.ts proves the rules offline.
//
// Rules this file enforces:
//   - A number without a real source is a "Not tracked" tile, never a zero.
//   - A tile is amber when it is typed in by hand or older than 30 days.
//   - Search Console and content_performance numbers are rolling 28-day totals: only the LATEST
//     day is ever read, never a sum across days.
//   - The estimate is a rough range from trailing-12-month net profit, not an appraisal.

export const STALE_DAYS = 30
export const ESTIMATE_LABEL = 'Rough estimate, not an appraisal'

export type TileStatus = 'ok' | 'amber' | 'not_tracked'
export type TileGroup = 'money' | 'traffic' | 'search' | 'leads' | 'content' | 'ops' | 'manual'

export interface ValueTile {
  key: string
  group: TileGroup
  label: string
  /** Display text; null when the tile is "Not tracked". */
  value: string | null
  /** The number behind the display, when there is one. */
  raw: number | null
  source: string
  /** YYYY-MM-DD the number is as of; null when unknown. */
  asOf: string | null
  status: TileStatus
  note: string
}

export interface InputRow {
  value: string | null
  as_of: string | null
  note?: string | null
}
export type Inputs = Record<string, InputRow>

export interface OrderLite {
  amount_cents: number
  currency: string
  status: 'paid' | 'refunded'
  is_test: boolean
  paid_at: string | null
  created_at: string
}

export interface ContentCount {
  count: number
  oldest: string | null
  newest: string | null
}

export interface ValueData {
  inputs: Inputs
  /** null = the orders table could not be read. */
  orders: OrderLite[] | null
  /** Total AI cost in US dollars over the last 12 months, from api_calls; null when no calls are recorded. */
  aiCost12mUsd: number | null
  aiCost30dUsd: number | null
  aiFirstTs: string | null
  /** GA4 over its window, when connected. */
  ga4: { sessions: number; organicSearch: number; social: number; windowDays: number; fetchedAt: string } | null
  /** site_visits rows by channel over the last 28 days, when no GA4. null when the table has no rows. */
  visitsByChannel: Record<string, number> | null
  /** gsc_ranking_days rows (each a rolling 28-day total). */
  gscDays: { day: string; clicks: number | null; impressions: number | null; top10: number | null }[]
  /** content_performance rows from the latest day only (each a rolling 28-day total per page). */
  contentPerfLatest: { day: string; path: string; clicks: number | null }[]
  /** Real (non-test) leads in the last 12 months; null when the table could not be read. */
  leads12m: number | null
  posts: ContentCount | null
  guides: ContentCount | null
  packages: ContentCount | null
  /** Last pipeline pass, from the heartbeat. */
  pipeline: { at: string; stepsOk: number; stepsTotal: number } | null
  autopilotOn: boolean | null
  /** Partner search clicks from the affiliate click ledger (WP21). Clicks only, never money. null/undefined = not tracked. */
  affiliateClicks?: { total: number; last30: number } | null
}

export interface Adjustment {
  key: string
  label: string
  /** Turns of the multiple added (positive) or taken off (negative). */
  value: number
  reason: string
  source: 'suggested' | 'edited'
}

export interface Estimate {
  status: 'ok' | 'not_enough_data'
  label: string
  reason: string
  netProfit: number | null
  currency: string
  multipleLow: number
  multipleHigh: number
  multipleBase: number
  adjustments: Adjustment[]
  adjustmentTotal: number
  low: number | null
  base: number | null
  high: number | null
  assumptions: string[]
  levers: string[]
}

export interface ValueReport {
  generatedAt: string
  tiles: ValueTile[]
  estimate: Estimate
  monthlyRevenue: { month: string; amount: number }[]
}

// ---------- small pure helpers ----------

const DAY = 86_400_000
const isoDay = (d: Date) => d.toISOString().slice(0, 10)
const money = (n: number, currency: string) => {
  try {
    return new Intl.NumberFormat('en-CA', { style: 'currency', currency, maximumFractionDigits: 0 }).format(n)
  } catch {
    return `$${Math.round(n)}`
  }
}
const usd = (n: number) => `US$${n.toFixed(2)}`
const pct = (x: number) => `${Math.round(x * 100)}%`

/** Tile colour rule. Pure. */
export function tileStatus(o: { tracked: boolean; manual?: boolean; asOf: string | null; now: Date }): TileStatus {
  if (!o.tracked) return 'not_tracked'
  if (o.manual) return 'amber'
  if (!o.asOf) return 'amber'
  const age = (o.now.getTime() - Date.parse(o.asOf)) / DAY
  return age <= STALE_DAYS ? 'ok' : 'amber'
}

/** The row with the newest `day`. Rolling 28-day totals must be read this way, never summed. Pure. */
export function latestRow<T extends { day: string }>(rows: T[]): T | null {
  if (!rows.length) return null
  return rows.reduce((a, b) => (b.day > a.day ? b : a))
}

/** Every row from the newest `day` only (per-page rolling totals: sum across pages that day is fine, across days is not). Pure. */
export function latestDayRows<T extends { day: string }>(rows: T[]): T[] {
  const top = latestRow(rows)
  return top ? rows.filter((r) => r.day === top.day) : []
}

/** Share (0..1) of visits from organic search in a site_visits channel count, or null when it cannot be told.
 * The visit log's channel for Google and other search engines is exactly "search" (paid search is its own channel
 * and is NOT organic). With visits recorded but no "search" row the share is a real 0, unless some channel name is
 * not one this site writes: then the log is not understood and the answer is null, never a made-up 0. Pure. */
export function organicShareOfVisits(by: Record<string, number>): number | null {
  const shares = channelShares(by)
  if (!shares.length) return null
  const search = shares.find((x) => x.channel === 'search')
  if (search) return search.share
  return shares.every((x) => (CHANNELS as readonly string[]).includes(x.channel)) ? 0 : null
}

/** Plain-English channel name for a site_visits channel key; GA4 names and unknown keys pass through. Pure. */
export function channelLabel(channel: string): string {
  return CHANNEL_LABELS[channel as Channel] ?? channel
}

/** Shares (0..1) per channel, biggest first. Pure. */
export function channelShares(by: Record<string, number>): { channel: string; sessions: number; share: number }[] {
  const total = Object.values(by).reduce((s, n) => s + n, 0)
  if (total <= 0) return []
  return Object.entries(by)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([channel, sessions]) => ({ channel, sessions, share: sessions / total }))
}

function num(inputs: Inputs, key: string): number | null {
  const v = inputs[key]?.value
  if (v == null || String(v).trim() === '') return null
  const n = Number(String(v).replace(/[, $]/g, ''))
  return Number.isFinite(n) ? n : null
}
function asOfOf(inputs: Inputs, key: string): string | null {
  return inputs[key]?.as_of ?? null
}

/** Real paid orders in the 365 days before `now`, with a revenue-by-month series (oldest first, 12 entries). Pure. */
export function trailingRevenue(orders: OrderLite[], now: Date) {
  const start = now.getTime() - 365 * DAY
  const dateOf = (o: OrderLite) => Date.parse(o.paid_at ?? o.created_at)
  const inWindow = orders.filter((o) => {
    const t = dateOf(o)
    return Number.isFinite(t) && t > start && t <= now.getTime()
  })
  const summary = summarizeOrders(inWindow)
  const months: { month: string; amount: number }[] = []
  for (let i = 11; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))
    months.push({ month: d.toISOString().slice(0, 7), amount: 0 })
  }
  for (const o of inWindow) {
    if (o.is_test || o.status !== 'paid') continue
    const m = new Date(dateOf(o)).toISOString().slice(0, 7)
    const slot = months.find((x) => x.month === m)
    if (slot) slot.amount += o.amount_cents / 100
  }
  return { revenue: summary.totalCents / 100, orderCount: summary.orderCount, currency: summary.currency, months }
}

// ---------- the estimate ----------

// UNVERIFIED PLACEHOLDER: small content and lead-gen sites are often quoted at roughly 2 to 4 times
// a year of net profit, but these numbers come from general knowledge, not from a checked source.
// Compare them with current marketplace listings and broker figures before relying on them. The
// owner can edit both ends on the page.
export const DEFAULT_MULTIPLE_LOW = 2
export const DEFAULT_MULTIPLE_HIGH = 4

export const ADJUSTMENT_KEYS = ['organic', 'trend', 'owner_hours', 'automation', 'legal'] as const
export type AdjustmentKey = (typeof ADJUSTMENT_KEYS)[number]
export const adjustmentInputKey = (k: string) => `adj_${k}`

/** The adjustment the data suggests for each slider, with its reason. Pure. */
export function suggestAdjustments(s: {
  organicShare: number | null
  trendGrowth: number | null
  ownerHours: number | null
  pipelineOk: boolean | null
}): Record<AdjustmentKey, { value: number; reason: string }> {
  const organic =
    s.organicShare == null
      ? { value: 0, reason: 'Traffic by channel is not tracked, so no change. Connect GA4 to let this move.' }
      : s.organicShare >= 0.8
        ? { value: -0.4, reason: `${pct(s.organicShare)} of visits come from Google search. Relying on one source worries buyers.` }
        : s.organicShare >= 0.6
          ? { value: -0.2, reason: `${pct(s.organicShare)} of visits come from Google search, which leans on one source.` }
          : s.organicShare < 0.4
            ? { value: 0.2, reason: `Only ${pct(s.organicShare)} of visits come from Google search, so traffic is spread out.` }
            : { value: 0, reason: `${pct(s.organicShare)} of visits come from Google search, a normal mix.` }
  const trend =
    s.trendGrowth == null
      ? { value: 0, reason: 'Not enough order history in both halves of the year to see a trend.' }
      : s.trendGrowth > 0.2
        ? { value: 0.3, reason: `Revenue grew ${pct(s.trendGrowth)} in the last 6 months against the 6 before.` }
        : s.trendGrowth < -0.2
          ? { value: -0.3, reason: `Revenue fell ${pct(-s.trendGrowth)} in the last 6 months against the 6 before.` }
          : { value: 0, reason: 'Revenue is roughly flat across the last 12 months.' }
  const owner =
    s.ownerHours == null
      ? { value: 0, reason: 'Owner hours per week not entered, so no change.' }
      : s.ownerHours <= 5
        ? { value: 0.3, reason: `${s.ownerHours} hours a week of owner time: a buyer can run it part-time.` }
        : s.ownerHours > 15
          ? { value: -0.3, reason: `${s.ownerHours} hours a week of owner time: a buyer has to replace a job.` }
          : { value: 0, reason: `${s.ownerHours} hours a week of owner time is a normal load.` }
  const automation =
    s.pipelineOk == null
      ? { value: 0, reason: 'No pipeline heartbeat found, so no change.' }
      : s.pipelineOk
        ? { value: 0.2, reason: 'The automatic pipeline ran recently and its steps passed.' }
        : { value: -0.1, reason: 'The automatic pipeline has gone quiet or reported failed steps.' }
  const legal = { value: 0, reason: 'No data source. Set this yourself after checking the privacy policy, terms and consent wording.' }
  return { organic, trend, owner_hours: owner, automation, legal }
}

const ADJ_LABELS: Record<AdjustmentKey, string> = {
  organic: 'Organic concentration',
  trend: 'Revenue trend',
  owner_hours: 'Owner hours',
  automation: 'Automation',
  legal: 'Legal cleanliness',
}

/** Low / base / high from net profit and a multiple range plus the adjustments. Pure. */
export function computeEstimate(o: {
  netProfit: number | null
  currency: string
  multipleLow: number
  multipleHigh: number
  adjustments: Adjustment[]
  notEnoughReason?: string
}): Estimate {
  const adjTotal = round2(o.adjustments.reduce((s, a) => s + a.value, 0))
  const lo = Math.min(o.multipleLow, o.multipleHigh)
  const hi = Math.max(o.multipleLow, o.multipleHigh)
  const base = (lo + hi) / 2
  const assumptions = [
    `Multiple range ${lo}x to ${hi}x of one year of net profit (base ${base}x). This is an unverified placeholder: check it against current marketplace listings.`,
    `Adjustments add ${adjTotal >= 0 ? '+' : ''}${adjTotal}x to every end of the range.`,
    'Net profit is the last 12 months of paid orders minus the costs you entered plus the metered AI cost.',
  ]
  const empty = (reason: string): Estimate => ({
    status: 'not_enough_data',
    label: ESTIMATE_LABEL,
    reason,
    netProfit: o.netProfit,
    currency: o.currency,
    multipleLow: lo,
    multipleHigh: hi,
    multipleBase: base,
    adjustments: o.adjustments,
    adjustmentTotal: adjTotal,
    low: null,
    base: null,
    high: null,
    assumptions,
    levers: [],
  })
  if (o.netProfit == null) return empty(o.notEnoughReason ?? 'Not enough data: there is no net profit history yet.')
  if (o.netProfit <= 0) return empty('Not enough data: the last 12 months show no profit, so a profit multiple gives nothing meaningful.')
  const at = (m: number) => Math.round(o.netProfit! * Math.max(0, m + adjTotal))
  // The three biggest levers: the negative adjustments, worth up to their size in multiple turns.
  const levers = o.adjustments
    .filter((a) => a.value < 0)
    .sort((a, b) => a.value - b.value)
    .slice(0, 3)
    .map((a) => `${a.label}: fixing it is worth up to +${Math.abs(a.value)}x (about ${money(Math.abs(a.value) * o.netProfit!, o.currency)}). ${a.reason}`)
  return {
    status: 'ok',
    label: ESTIMATE_LABEL,
    reason: `Net profit ${money(o.netProfit, o.currency)} times a multiple of ${Math.max(0, lo + adjTotal)}x to ${Math.max(0, hi + adjTotal)}x.`,
    netProfit: o.netProfit,
    currency: o.currency,
    multipleLow: lo,
    multipleHigh: hi,
    multipleBase: base,
    adjustments: o.adjustments,
    adjustmentTotal: adjTotal,
    low: at(lo),
    base: at(base),
    high: at(hi),
    assumptions,
    levers,
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100

// ---------- the report ----------

export function buildValueReport(d: ValueData, now: Date = new Date()): ValueReport {
  const today = isoDay(now)
  const tiles: ValueTile[] = []
  const add = (t: Omit<ValueTile, 'status'> & { tracked: boolean; manual?: boolean }) => {
    const { tracked, manual, ...rest } = t
    tiles.push({ ...rest, value: tracked ? rest.value : null, raw: tracked ? rest.raw : null, status: tileStatus({ tracked, manual, asOf: rest.asOf, now }) })
  }

  // ----- money -----
  const rev = d.orders ? trailingRevenue(d.orders, now) : null
  const hasOrderRows = !!d.orders && d.orders.length > 0
  const currency = rev?.currency ?? 'CAD'
  add({
    key: 'revenue_12m', group: 'money', label: 'Revenue, last 12 months',
    tracked: hasOrderRows, value: rev ? money(rev.revenue, currency) : null, raw: rev ? rev.revenue : null,
    source: 'Orders ledger (test orders and refunds left out)', asOf: today,
    note: hasOrderRows ? `${rev!.orderCount} real paid orders.` : 'No orders recorded yet. Connect the GoHighLevel purchase webhook, or there have been no sales.',
  })

  const fx = currency === 'USD' ? 1 : (num(d.inputs, 'fx_usd_to_order_currency') ?? 1.35)
  const aiTracked = d.aiCost12mUsd != null
  add({
    key: 'ai_cost_12m', group: 'money', label: 'AI spend, last 12 months',
    tracked: aiTracked, value: aiTracked ? usd(d.aiCost12mUsd!) : null, raw: aiTracked ? d.aiCost12mUsd : null,
    source: 'AI usage meter (api_calls), estimated rates', asOf: today,
    note: aiTracked ? `Estimated from token counts. Calls before ${d.aiFirstTs?.slice(0, 10) ?? 'the meter started'} were not recorded.` : 'No AI calls recorded yet. Apply migration 0044 and run the pipeline.',
  })

  const monthly = ['cost_hosting_monthly', 'cost_tools_monthly', 'cost_other_monthly'].map((k) => num(d.inputs, k))
  const costsEntered = monthly.some((v) => v != null)
  const manualCosts12m = monthly.reduce<number>((s, v) => s + (v ?? 0), 0) * 12
  const costsAsOf = ['cost_hosting_monthly', 'cost_tools_monthly', 'cost_other_monthly']
    .map((k) => asOfOf(d.inputs, k)).filter((x): x is string => !!x).sort()[0] ?? null
  const totalCosts = costsEntered ? manualCosts12m + (d.aiCost12mUsd ?? 0) * fx : null
  add({
    key: 'costs_12m', group: 'money', label: 'Running costs, last 12 months',
    tracked: costsEntered, manual: true, value: totalCosts != null ? money(totalCosts, currency) : null, raw: totalCosts,
    source: 'Monthly costs you entered times 12, plus metered AI cost', asOf: costsAsOf,
    note: costsEntered ? `AI cost converted at ${fx} to ${currency} (edit it in the form).` : 'Enter your monthly hosting, tools and other costs below. Profit needs them.',
  })

  const netProfit = rev && hasOrderRows && totalCosts != null ? round2(rev.revenue - totalCosts) : null
  add({
    key: 'profit_12m', group: 'money', label: 'Net profit, last 12 months',
    tracked: netProfit != null, manual: true, value: netProfit != null ? money(netProfit, currency) : null, raw: netProfit,
    source: 'Revenue minus running costs', asOf: costsAsOf,
    note: netProfit != null ? 'Only as complete as the costs you entered.' : 'Needs both order history and the costs form below.',
  })

  // ----- traffic -----
  let channels: Record<string, number> | null = null
  let trafficSource = ''
  let trafficAsOf: string | null = null
  let trafficWindow = 28
  if (d.ga4) {
    channels = { 'Organic Search': d.ga4.organicSearch, Social: d.ga4.social, Other: Math.max(0, d.ga4.sessions - d.ga4.organicSearch - d.ga4.social) }
    trafficSource = 'Google Analytics 4'
    trafficAsOf = d.ga4.fetchedAt.slice(0, 10)
    trafficWindow = d.ga4.windowDays
  } else if (d.visitsByChannel) {
    channels = d.visitsByChannel
    trafficSource = 'Site visit log (site_visits)'
    trafficAsOf = today
  }
  const shares = channels ? channelShares(channels) : []
  const sessions = d.ga4 ? d.ga4.sessions : channels ? Object.values(channels).reduce((s, n) => s + n, 0) : 0
  add({
    key: 'traffic_sessions', group: 'traffic', label: `Visits, last ${trafficWindow} days`,
    tracked: shares.length > 0, value: String(sessions), raw: sessions, source: trafficSource || 'GA4 or the visit log', asOf: trafficAsOf,
    note: shares.length ? '' : 'Not tracked: connect GA4 (GA4_PROPERTY_ID) or switch on visit tracking.',
  })
  add({
    key: 'traffic_channels', group: 'traffic', label: 'Visits by channel',
    tracked: shares.length > 0, value: shares.slice(0, 4).map((s) => `${channelLabel(s.channel)} ${pct(s.share)}`).join(', '), raw: null,
    source: trafficSource || 'GA4 or the visit log', asOf: trafficAsOf, note: '',
  })
  const organic = d.ga4 ? (d.ga4.sessions > 0 ? d.ga4.organicSearch / d.ga4.sessions : null) : (channels ? organicShareOfVisits(channels) : null)
  add({
    key: 'organic_share', group: 'traffic', label: 'Organic share of visits',
    tracked: organic != null, value: organic != null ? pct(organic) : null, raw: organic, source: trafficSource || 'GA4 or the visit log', asOf: trafficAsOf,
    note: 'A high share means the site leans on Google.',
  })

  // Affiliate activity: clicks on the partner search buttons, as a count. Never converted to money; revenue is a manual input.
  add({
    key: 'affiliate_clicks', group: 'traffic', label: 'Affiliate activity (partner clicks, last 30 days)',
    tracked: d.affiliateClicks != null, value: d.affiliateClicks ? String(d.affiliateClicks.last30) : null, raw: d.affiliateClicks?.last30 ?? null,
    source: 'Affiliate click ledger (affiliate_clicks)', asOf: today,
    note: d.affiliateClicks ? `${d.affiliateClicks.total} partner clicks in total. Clicks only: commissions are in each partner's dashboard.` : 'Not tracked yet: needs migration 0048 and at least one active partner.',
  })

  // ----- search -----
  const gsc = latestRow(d.gscDays)
  add({
    key: 'search_clicks', group: 'search', label: 'Google clicks (28-day total)',
    tracked: !!gsc && gsc.clicks != null, value: gsc?.clicks != null ? String(gsc.clicks) : null, raw: gsc?.clicks ?? null,
    source: 'Search Console snapshot, latest day only', asOf: gsc?.day ?? null, note: 'A rolling 28-day total, so only the latest day is read.',
  })
  add({
    key: 'search_impressions', group: 'search', label: 'Google impressions (28-day total)',
    tracked: !!gsc && gsc.impressions != null, value: gsc?.impressions != null ? String(gsc.impressions) : null, raw: gsc?.impressions ?? null,
    source: 'Search Console snapshot, latest day only', asOf: gsc?.day ?? null, note: '',
  })
  add({
    key: 'search_top10', group: 'search', label: 'Keywords in the top 10',
    tracked: !!gsc && gsc.top10 != null, value: gsc?.top10 != null ? String(gsc.top10) : null, raw: gsc?.top10 ?? null,
    source: 'Search Console snapshot, latest day only', asOf: gsc?.day ?? null, note: '',
  })
  const perf = d.contentPerfLatest
  const perfClicks = perf.reduce((s, r) => s + (r.clicks ?? 0), 0)
  const topPage = perf.reduce<{ path: string; clicks: number } | null>((a, r) => ((r.clicks ?? 0) > (a?.clicks ?? -1) ? { path: r.path, clicks: r.clicks ?? 0 } : a), null)
  add({
    key: 'page_clicks', group: 'search', label: 'Clicks across pages (28-day)',
    tracked: perf.length > 0, value: String(perfClicks), raw: perfClicks,
    source: 'Daily page performance, latest day only', asOf: perf[0]?.day ?? null,
    note: topPage && perfClicks > 0 ? `Top page ${topPage.path} has ${pct(topPage.clicks / perfClicks)} of clicks.` : '',
  })

  // ----- leads -----
  add({
    key: 'leads_12m', group: 'leads', label: 'Leads, last 12 months',
    tracked: d.leads12m != null, value: d.leads12m != null ? String(d.leads12m) : null, raw: d.leads12m,
    source: 'Leads table (test leads left out)', asOf: today, note: '',
  })
  const l2o = rev && d.leads12m && d.leads12m > 0 ? rev.orderCount / d.leads12m : null
  add({
    key: 'lead_to_order', group: 'leads', label: 'Orders per lead',
    tracked: l2o != null, value: l2o != null ? pct(l2o) : null, raw: l2o,
    source: 'Real paid orders divided by real leads', asOf: today, note: 'Rough: an order does not have to come from a form lead.',
  })

  // ----- content -----
  const part = (c: ContentCount | null, n: string) => (c ? `${c.count} ${n}` : null)
  const parts = [part(d.posts, 'posts'), part(d.guides, 'guides'), part(d.packages, 'packages')].filter(Boolean)
  add({
    key: 'content_volume', group: 'content', label: 'Published content',
    tracked: parts.length > 0, value: parts.join(', '), raw: (d.posts?.count ?? 0) + (d.guides?.count ?? 0) + (d.packages?.count ?? 0),
    source: 'Posts, guides and packages tables (published only)', asOf: today, note: '',
  })
  const oldest = [d.posts?.oldest, d.guides?.oldest, d.packages?.oldest].filter((x): x is string => !!x).sort()[0] ?? null
  const newest = [d.posts?.newest, d.guides?.newest, d.packages?.newest].filter((x): x is string => !!x).sort().reverse()[0] ?? null
  add({
    key: 'content_age', group: 'content', label: 'Content age',
    tracked: !!oldest, value: oldest ? `Oldest ${oldest.slice(0, 10)}, newest ${newest?.slice(0, 10) ?? 'unknown'}` : null, raw: oldest ? Math.floor((now.getTime() - Date.parse(oldest)) / DAY) : null,
    source: 'Created dates of published content', asOf: today, note: '',
  })

  // ----- operations -----
  const pipelineAgeH = d.pipeline ? (now.getTime() - Date.parse(d.pipeline.at)) / 3_600_000 : null
  const pipelineOk = d.pipeline && pipelineAgeH != null ? pipelineAgeH <= 48 && d.pipeline.stepsOk >= d.pipeline.stepsTotal * 0.8 : null
  add({
    key: 'automation', group: 'ops', label: 'Automation level',
    tracked: !!d.pipeline, value: d.pipeline ? `Last pass ${Math.round(pipelineAgeH!)}h ago, ${d.pipeline.stepsOk} of ${d.pipeline.stepsTotal} steps ok${d.autopilotOn === false ? ', Autopilot off' : ''}` : null, raw: pipelineAgeH,
    source: 'Pipeline heartbeat', asOf: d.pipeline?.at.slice(0, 10) ?? null, note: '',
  })

  // ----- manual inputs -----
  const manualTile = (key: string, label: string, fmt: (n: number) => string) => {
    const n = num(d.inputs, key)
    add({
      key, group: 'manual', label, tracked: n != null, manual: true, value: n != null ? fmt(n) : null, raw: n,
      source: 'Entered by you', asOf: asOfOf(d.inputs, key), note: n == null ? 'Not tracked: enter it in the form below.' : 'Typed in by hand, so shown amber until it is checked.',
    })
  }
  const reg = d.inputs.domain_registered?.value
  const regT = reg ? Date.parse(reg) : NaN
  add({
    key: 'domain_age', group: 'manual', label: 'Domain age', tracked: Number.isFinite(regT), manual: true,
    value: Number.isFinite(regT) ? `${round2((now.getTime() - regT) / (365.25 * DAY))} years` : null, raw: Number.isFinite(regT) ? (now.getTime() - regT) / (365.25 * DAY) : null,
    source: 'Entered by you', asOf: asOfOf(d.inputs, 'domain_registered'), note: Number.isFinite(regT) ? 'Typed in by hand.' : 'Not tracked: enter the registration date below.',
  })
  manualTile('email_list_size', 'Email list size', (n) => String(Math.round(n)))
  manualTile('social_followers', 'Social followers', (n) => String(Math.round(n)))
  manualTile('owner_hours_week', 'Owner hours per week', (n) => `${n} h`)
  manualTile('recurring_revenue_share', 'Recurring revenue share', (n) => `${n}%`)
  const risks = splitRisks(d.inputs.risks?.value)
  add({
    key: 'risks', group: 'manual', label: 'Known risks', tracked: risks.length > 0, manual: true,
    value: risks.length ? `${risks.length} listed` : null, raw: risks.length || null, source: 'Entered by you', asOf: asOfOf(d.inputs, 'risks'),
    note: risks.length ? risks.join('; ') : 'Not tracked: list them below, one per line.',
  })

  // ----- estimate -----
  const trend = rev ? halfYearGrowth(rev.months) : null
  const sug = suggestAdjustments({
    organicShare: organic ?? null,
    trendGrowth: trend,
    ownerHours: num(d.inputs, 'owner_hours_week'),
    pipelineOk,
  })
  const adjustments: Adjustment[] = ADJUSTMENT_KEYS.map((k) => {
    const edited = num(d.inputs, adjustmentInputKey(k))
    return {
      key: k,
      label: ADJ_LABELS[k],
      value: edited != null ? clamp(edited, -1, 1) : sug[k].value,
      reason: edited != null ? `Set by you. Data suggests: ${sug[k].reason}` : sug[k].reason,
      source: edited != null ? 'edited' : 'suggested',
    }
  })
  const estimate = computeEstimate({
    netProfit,
    currency,
    multipleLow: num(d.inputs, 'multiple_low') ?? DEFAULT_MULTIPLE_LOW,
    multipleHigh: num(d.inputs, 'multiple_high') ?? DEFAULT_MULTIPLE_HIGH,
    adjustments,
    notEnoughReason: !hasOrderRows ? 'Not enough data: there are no orders yet, so there is no profit history.' : 'Not enough data: enter your running costs so net profit can be worked out.',
  })

  return { generatedAt: now.toISOString(), tiles, estimate, monthlyRevenue: rev?.months ?? [] }
}

/** The only keys the inputs form may write to value_inputs. */
export const VALUE_INPUT_KEYS = [
  'domain_registered', 'email_list_size', 'social_followers', 'owner_hours_week', 'recurring_revenue_share', 'risks',
  'cost_hosting_monthly', 'cost_tools_monthly', 'cost_other_monthly', 'fx_usd_to_order_currency',
  'multiple_low', 'multiple_high', ...ADJUSTMENT_KEYS.map(adjustmentInputKey),
] as const

/** Validate a posted inputs object into rows to upsert. Unknown keys and oversize values are dropped. Pure. */
export function cleanInputsPatch(body: unknown, today: string): { key: string; value: string | null; as_of: string; updated_at: string }[] {
  const raw = (body as { inputs?: Record<string, unknown> } | null)?.inputs
  if (!raw || typeof raw !== 'object') return []
  const out: { key: string; value: string | null; as_of: string; updated_at: string }[] = []
  for (const key of VALUE_INPUT_KEYS) {
    if (!(key in raw)) continue
    const v = raw[key]
    const text = v == null ? '' : String(v).trim().slice(0, 2000)
    out.push({ key, value: text === '' ? null : text, as_of: today, updated_at: new Date().toISOString() })
  }
  return out
}

export function splitRisks(raw: string | null | undefined): string[] {
  return (raw ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean).slice(0, 30)
}
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

/** (newest 6 months - older 6 months) / older 6 months; null when either half has no revenue. Pure. */
export function halfYearGrowth(months: { amount: number }[]): number | null {
  if (months.length < 12) return null
  const older = months.slice(0, 6).reduce((s, m) => s + m.amount, 0)
  const newer = months.slice(6).reduce((s, m) => s + m.amount, 0)
  if (older <= 0 || newer <= 0) return null
  return (newer - older) / older
}
