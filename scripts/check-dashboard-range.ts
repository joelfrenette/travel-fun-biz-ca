// Offline check for the admin Dashboard range selector: range -> dates and buckets, channel zero-fill and colours,
// legend, Search Console window, URL / localStorage parsing, funnel window, no em dashes, routes guarded. No network, no database.
// Run: pnpm dlx tsx scripts/check-dashboard-range.ts
import fs from 'node:fs'
import path from 'node:path'
import {
  DASH_RANGES, DASH_CHANNELS, CHANNEL_COLORS, parseRange, resolveRange, rangeDays, bucketFor, ga4DateRange, ga4BucketDimension,
  dashChannelOf, emptyChannelCounts, legendEntries, visitChannelToDash, gscWindow, isoWeekKey, bucketKey, ga4KeyToBucketKey, rollUpSearch, rollUpVisits,
} from '../lib/dashboard-range'
import { buildRangeReport } from '../lib/ga4'
import { funnelWindowLabel, visitsStage } from '../lib/funnel'

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : detail ? `  (${detail})` : ''}`)
  if (!ok) failures++
}
const src = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8')

// ---------- range parsing ----------
check('DASH_RANGES are 7, 30, 365, all', DASH_RANGES.join(',') === '7,30,365,all')
check('parseRange accepts the four values', (['7', '30', '365', 'all'] as const).every((r) => parseRange(r) === r))
check('parseRange: bad values fall back to all time (the default)', ['', 'abc', '14', '0', '-5', '999', 'ALL ', null, undefined, {}, 12].every((v) => parseRange(v as unknown) === 'all'))
check('parseRange: numbers 7 and 365 work', parseRange(7) === '7' && parseRange(365) === '365')
check('resolveRange: URL wins over storage', resolveRange('7', '365') === '7')
check('resolveRange: bad URL uses storage', resolveRange('nonsense', '365') === '365')
check('resolveRange: both bad = all time (the default)', resolveRange('x', 'y') === 'all' && resolveRange(null, null) === 'all' && resolveRange(undefined, undefined) === 'all')
check('rangeDays: 7/30/365/all', rangeDays('7') === 7 && rangeDays('30') === 30 && rangeDays('365') === 365 && rangeDays('all') === null)

// ---------- GA4 dates and buckets ----------
check('ga4DateRange 7 = 6daysAgo..today', ga4DateRange('7').startDate === '6daysAgo' && ga4DateRange('7').endDate === 'today')
check('ga4DateRange 30 = 29daysAgo', ga4DateRange('30').startDate === '29daysAgo')
check('ga4DateRange 365 = 364daysAgo', ga4DateRange('365').startDate === '364daysAgo')
check('ga4DateRange all = 2020-01-01', ga4DateRange('all').startDate === '2020-01-01')
check('buckets: 7 and 30 daily, 365 weekly, all monthly', bucketFor('7') === 'day' && bucketFor('30') === 'day' && bucketFor('365') === 'week' && bucketFor('all') === 'month')
check('GA4 dimensions: date / isoYearIsoWeek / yearMonth', ga4BucketDimension('30') === 'date' && ga4BucketDimension('365') === 'isoYearIsoWeek' && ga4BucketDimension('all') === 'yearMonth')
check('ga4KeyToBucketKey: date, week, month', ga4KeyToBucketKey('20261015', 'day') === '2026-10-15' && ga4KeyToBucketKey('202642', 'week') === '2026-W42' && ga4KeyToBucketKey('202610', 'month') === '2026-10')
check('isoWeekKey: 2026-10-15 is W42, 2026-01-01 is W01, 2021-01-01 is 2020-W53', isoWeekKey('2026-10-15') === '2026-W42' && isoWeekKey('2026-01-01') === '2026-W01' && isoWeekKey('2021-01-01') === '2020-W53')
check('bucketKey month and day', bucketKey('2026-10-15T10:00:00Z', 'month') === '2026-10' && bucketKey('2026-10-15T10:00:00Z', 'day') === '2026-10-15')

// ---------- channels, zero fill, colours, legend ----------
check('nine channels, fixed order', DASH_CHANNELS.join('|') === 'Organic Search|Direct|Referral|Organic Social|Email|Paid Search|Paid Social|Unassigned|Other')
check('every channel has a colour and all colours are distinct', DASH_CHANNELS.every((c) => /^#[0-9a-f]{6}$/i.test(CHANNEL_COLORS[c])) && new Set(DASH_CHANNELS.map((c) => CHANNEL_COLORS[c])).size === DASH_CHANNELS.length)
check('fixed palette: search green, direct blue, referral purple, social red, email amber, paid search orange, unassigned grey',
  CHANNEL_COLORS['Organic Search'] === '#16a34a' && CHANNEL_COLORS.Direct === '#2563eb' && CHANNEL_COLORS.Referral === '#9333ea' && CHANNEL_COLORS['Organic Social'] === '#e11d48' && CHANNEL_COLORS.Email === '#d97706' && CHANNEL_COLORS['Paid Search'] === '#ea580c' && CHANNEL_COLORS.Unassigned === '#9ca3af')
// Colours must read on a white card and on a near-black card: relative luminance between 0.08 and 0.5.
const lum = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
check('colours are mid-tone (visible in light and dark themes)', DASH_CHANNELS.every((c) => lum(CHANNEL_COLORS[c]) > 0.06 && lum(CHANNEL_COLORS[c]) < 0.5))
check('dashChannelOf: known, (not set), unknown', dashChannelOf('Direct') === 'Direct' && dashChannelOf('(not set)') === 'Unassigned' && dashChannelOf('Unassigned') === 'Unassigned' && dashChannelOf('Organic Video') === 'Other' && dashChannelOf('Cross-network') === 'Other')
check('legend lists all nine channels even with no data', legendEntries({}).length === 9 && legendEntries({}).every((l) => l.none && l.total === 0))
check('legend marks only the empty channels as none', ((l) => l.find((x) => x.channel === 'Organic Social')!.none === false && l.find((x) => x.channel === 'Direct')!.none === true)(legendEntries({ 'Organic Social': 44 })))
check('visit channels map to dashboard channels', visitChannelToDash('search') === 'Organic Search' && visitChannelToDash('direct') === 'Direct' && visitChannelToDash('ai_assistant') === 'Referral' && visitChannelToDash('social') === 'Organic Social' && visitChannelToDash(null) === 'Unassigned' && visitChannelToDash('weird') === 'Other')

// Realistic case from the owner's screenshot: GA4 returned only Organic Social. Every channel must still be present.
const rep = buildRangeReport(
  '30',
  [
    { dimensionValues: [{ value: '20261014' }, { value: 'Organic Social' }], metricValues: [{ value: '20' }] },
    { dimensionValues: [{ value: '20261015' }, { value: 'Organic Social' }], metricValues: [{ value: '24' }] },
  ],
  { metricValues: [{ value: '44' }, { value: '31' }, { value: '30' }] },
  '2026-10-16T00:00:00Z',
)
check('report: two day buckets, keys are YYYY-MM-DD', rep.buckets.length === 2 && rep.buckets[0].key === '2026-10-14' && rep.buckets[1].key === '2026-10-15')
check('report: every bucket carries all nine channels (zero filled)', rep.buckets.every((b) => DASH_CHANNELS.every((c) => typeof b.channels[c] === 'number')))
check('report: channelTotals has all nine, only social non-zero', DASH_CHANNELS.every((c) => (c === 'Organic Social' ? rep.channelTotals[c] === 44 : rep.channelTotals[c] === 0)))
check('report: totals sessions/users/newUsers from the no-dimension row', rep.totals.sessions === 44 && rep.totals.users === 31 && rep.totals.newUsers === 30)
check('report: organicSearch, direct, referral are 0 and social is 44', rep.totals.organicSearch === 0 && rep.totals.direct === 0 && rep.totals.referral === 0 && rep.totals.social === 44)
check('report: empty GA4 answer still returns the full channel list', ((r) => r.buckets.length === 0 && DASH_CHANNELS.every((c) => r.channelTotals[c] === 0) && r.totals.sessions === 0)(buildRangeReport('7', [], undefined)))
check('report: week and month ranges key correctly', buildRangeReport('365', [{ dimensionValues: [{ value: '202642' }, { value: 'Direct' }], metricValues: [{ value: '5' }] }], undefined).buckets[0].key === '2026-W42' && buildRangeReport('all', [{ dimensionValues: [{ value: '202610' }, { value: 'Direct' }], metricValues: [{ value: '5' }] }], undefined).buckets[0].key === '2026-10')
check('emptyChannelCounts is all zero', Object.values(emptyChannelCounts()).every((n) => n === 0) && Object.keys(emptyChannelCounts()).length === 9)

// ---------- Search Console window ----------
const now = new Date('2026-10-23T12:00:00Z')
const w30 = gscWindow('30', now)
check('GSC: ends 2 days before today (data lag)', w30.endDate === '2026-10-21')
check('GSC: 7 days = 2026-10-15..2026-10-21', gscWindow('7', now).startDate === '2026-10-15' && !gscWindow('7', now).clamped)
check('GSC: 30 days starts 2026-09-22', w30.startDate === '2026-09-22' && !w30.clamped)
check('GSC: 12 months is within the limit', gscWindow('365', now).startDate === '2025-10-22' && !gscWindow('365', now).clamped)
const wAll = gscWindow('all', now)
check('GSC: all time is clamped to 16 months', wAll.clamped && wAll.startDate === '2025-06-22' && wAll.endDate === '2026-10-21', JSON.stringify(wAll))
check('GSC: never more than 16 months back for any range', DASH_RANGES.every((r) => gscWindow(r, now).startDate >= '2025-06-22'))
check('GSC: every start is before or equal to its end', DASH_RANGES.every((r) => gscWindow(r, now).startDate <= gscWindow(r, now).endDate))

// ---------- Search and visit roll-ups ----------
const gsc = rollUpSearch(
  [
    { day: '2026-10-19', clicks: 2, impressions: 100, position: 10 },
    { day: '2026-10-20', clicks: 4, impressions: 300, position: 20 },
    { day: '2026-10-27', clicks: 1, impressions: 50, position: 4 },
  ],
  'week',
)
check('GSC roll-up: weekly buckets sum clicks and impressions', gsc.points.length === 2 && gsc.points[0].clicks === 6 && gsc.points[0].impressions === 400)
check('GSC roll-up: ctr and position are impression weighted', gsc.totals.clicks === 7 && gsc.totals.impressions === 450 && Math.abs(gsc.totals.ctr - 7 / 450) < 1e-9 && gsc.totals.position === 16, JSON.stringify(gsc.totals))
check('GSC roll-up: empty is zero, not NaN', ((t) => t.clicks === 0 && t.ctr === 0 && t.position === 0)(rollUpSearch([], 'day').totals))
const vis = rollUpVisits([{ created_at: '2026-10-15T10:00:00Z', channel: 'search' }, { created_at: '2026-10-15T11:00:00Z', channel: 'direct' }, { created_at: '2026-10-16T09:00:00Z', channel: null }], 'day')
check('visits roll-up: per day, per channel, zero filled', vis.points.length === 2 && vis.points[0].total === 2 && vis.total === 3 && vis.channelTotals['Organic Search'] === 1 && vis.channelTotals.Unassigned === 1 && vis.channelTotals.Email === 0 && Object.keys(vis.channelTotals).length === 9)

// ---------- Funnel window ----------
check('funnel window labels', funnelWindowLabel(7) === 'the last 7 days' && funnelWindowLabel(30) === 'the last 30 days' && funnelWindowLabel(365) === 'the last 12 months' && funnelWindowLabel(null) === 'all time' && funnelWindowLabel(28) === 'the last 28 days')
check('visits stage names its window and keeps the not-tracked rule', visitsStage({ trackingOn: true, firstPartyCount: 5, ga4Sessions: 9, windowLabel: 'all time' }).note.includes('over all time') && !visitsStage({ trackingOn: false, firstPartyCount: 0, ga4Sessions: null }).tracked)
const funnelSrc = src('lib/funnel.ts')
check('funnel: leads query excludes test rows and uses the shared since() filter', /since\(admin\.from\('leads'\)\.select\('id', \{ count: 'exact', head: true \}\)\.eq\('is_test', false\)\)/.test(funnelSrc))
check('funnel: all time adds no created_at filter', /sinceIso \? q\.gte\('created_at', sinceIso\) : q/.test(funnelSrc) && /days === null \? null/.test(funnelSrc))
check('funnel: impressions stage says it is always 28 days', /Always the last 28 days/.test(funnelSrc))

// ---------- client wiring: pills, storage, URL ----------
const page = src('app/admin/dashboard/page.tsx')
const pills = src('components/admin/dashboard-range-pills.tsx')
check('pills are buttons with aria-pressed and a labelled group', /aria-pressed=\{active\}/.test(pills) && /role="group"/.test(pills) && /<button/.test(pills))
check('page remembers the range in localStorage inside try/catch and in the URL', /localStorage\.setItem\(RANGE_STORAGE_KEY/.test(page) && /try \{[\s\S]{0,80}localStorage\.getItem\(RANGE_STORAGE_KEY/.test(page) && /searchParams\.set\("range"/.test(page) && /replaceState/.test(page))
check('page passes the range to every card', /FunnelPanel range=\{range\}/.test(page) && /api\/admin\/analytics/.test(page) && /api\/admin\/dashboard-search/.test(page) && /api\/admin\/dashboard-visits/.test(page))
check('page has Direct and Referral tiles', /Direct sessions/.test(page) && /Referral sessions/.test(page))

// ---------- routes guarded, no em dashes ----------
for (const f of ['app/api/admin/analytics/route.ts', 'app/api/admin/dashboard-search/route.ts', 'app/api/admin/dashboard-visits/route.ts', 'app/api/admin/funnel/route.ts']) {
  const s = src(f)
  check(`${f}: isAuthorized is the first thing in GET`, /export async function GET\(request: Request\) \{\s*\n\s*if \(!isAuthorized\(request\)\)/.test(s))
}
for (const f of ['lib/dashboard-range.ts', 'lib/dashboard-data.ts', 'app/admin/page.tsx', 'app/admin/dashboard/page.tsx', 'lib/traffic-series.ts','components/admin/dashboard-cards.tsx', 'components/admin/dashboard-range-pills.tsx', 'components/admin/funnel-panel.tsx', 'app/api/admin/dashboard-search/route.ts', 'app/api/admin/dashboard-visits/route.ts']) {
  check(`${f}: no em dashes`, !src(f).includes('—'))
}

if (failures) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nAll dashboard range checks passed')
