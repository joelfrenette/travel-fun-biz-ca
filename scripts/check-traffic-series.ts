// Offline check for the ONE combined traffic chart (lib/traffic-series.ts). Run: pnpm dlx tsx scripts/check-traffic-series.ts  (exit 1 on a failure)
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildRangeReport } from '../lib/ga4'
import { SERIES_IDS, SERIES_SPECS, buildTrafficSeries, toggleHidden, unavailableNote, visibleSeries, type GaInput, type SearchInput, type VisitsInput } from '../lib/traffic-series'
import { CHANNEL_COLORS, SERIES_COLORS, emptyChannelCounts } from '../lib/dashboard-range'
import type { SearchRangeResult, VisitsRangeResult } from '../lib/dashboard-data'

let failures = 0
function expect(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`)
  if (!ok) failures++
}
const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

// ---- fixtures (days, so keys are YYYY-MM-DD)
const ga4 = (rows: [string, string, number][], users?: [string, number][]) =>
  buildRangeReport(
    '7',
    rows.map(([d, ch, n]) => ({ dimensionValues: [{ value: d }, { value: ch }], metricValues: [{ value: String(n) }] })),
    { metricValues: [{ value: String(rows.reduce((a, r) => a + r[2], 0)) }, { value: '40' }, { value: '30' }] },
    '2026-10-24T00:00:00Z',
    users?.map(([d, n]) => ({ dimensionValues: [{ value: d }], metricValues: [{ value: String(n) }] })),
  )
const GA_ROWS: [string, string, number][] = [
  ['20261020', 'Organic Search', 10], ['20261020', 'Direct', 5], ['20261020', 'Organic Social', 2], ['20261020', 'Paid Social', 1],
  ['20261021', 'Organic Search', 20], ['20261021', 'Referral', 4],
]
const report = ga4(GA_ROWS, [['20261020', 15], ['20261021', 22]])
const searchOk: SearchRangeResult = {
  range: '7', bucket: 'day', source: 'live', startDate: '2026-10-18', endDate: '2026-10-22', clamped: false,
  points: [{ key: '2026-10-20', clicks: 3, impressions: 900 }, { key: '2026-10-22', clicks: 5, impressions: 1200 }],
  totals: { clicks: 8, impressions: 2100, ctr: 0.004, position: 12 }, error: null, snapshotDay: null,
}
const visitsOk: VisitsRangeResult = { range: '7', bucket: 'day', trackingOn: true, points: [{ key: '2026-10-21', total: 6 }], channelTotals: null, total: 6, capped: false, retentionMonths: 13, error: null }

const gaOk: GaInput = { status: 'ok', report }
const seOk: SearchInput = { status: 'ok', data: searchOk }
const viOk: VisitsInput = { status: 'ok', data: visitsOk }

// ---- 1. everything available
const all = buildTrafficSeries('day', gaOk, seOk, viOk)
expect('nine series, in a fixed order, all available when every source is read', all.series.map((s) => s.id).join(',') === SERIES_IDS.join(',') && all.series.every((s) => s.available) && all.unavailable.length === 0)
expect('one shared time axis: the union of every source\'s days, oldest first', all.rows.map((r) => r.key).join(',') === '2026-10-20,2026-10-21,2026-10-22', all.rows.map((r) => r.key).join(','))
const d20 = all.rows[0]
expect('GA4 values land on the right day: sessions is the sum of channels, social joins organic and paid social', d20.sessions === 18 && d20.organic === 10 && d20.direct === 5 && d20.social === 3 && d20.referral === 0 && d20.users === 15)
expect('Google Search and visits share the same table, a day one source skipped is a real zero for it', d20.clicks === 3 && d20.impressions === 900 && all.rows[1].clicks === 0 && all.rows[1].visits === 6 && d20.visits === 0 && all.rows[2].sessions === 0)
expect('totals: users is the true unique count from Google, the rest are the range totals', all.series.find((s) => s.id === 'users')!.total === 40 && all.series.find((s) => s.id === 'clicks')!.total === 8 && all.series.find((s) => s.id === 'impressions')!.total === 2100 && all.series.find((s) => s.id === 'visits')!.total === 6 && all.series.find((s) => s.id === 'organic')!.total === 30)
expect('it has data', all.hasData)

// ---- 2. colours and scales
expect('channel series use the colours already defined for the channels', SERIES_SPECS.organic.color === CHANNEL_COLORS['Organic Search'] && SERIES_SPECS.direct.color === CHANNEL_COLORS.Direct && SERIES_SPECS.referral.color === CHANNEL_COLORS.Referral && SERIES_SPECS.social.color === CHANNEL_COLORS['Organic Social'] && SERIES_SPECS.clicks.color === SERIES_COLORS.clicks && SERIES_SPECS.impressions.color === SERIES_COLORS.impressions && SERIES_SPECS.visits.color === SERIES_COLORS.visits)
expect('only impressions use the right-hand scale, so they cannot flatten the clicks', SERIES_IDS.filter((id) => SERIES_SPECS[id].axis === 'right').join(',') === 'impressions')
const dashes = SERIES_IDS.filter((id) => SERIES_SPECS[id].dash).length
expect('series that share a colour are told apart by line style too (not colour alone)', SERIES_SPECS.clicks.dash !== SERIES_SPECS.organic.dash && SERIES_SPECS.impressions.dash !== SERIES_SPECS.sessions.dash && dashes >= 3)

// ---- 3. a missing source is named, never a zero
const gaOff = buildTrafficSeries('day', { status: 'not_connected' }, seOk, viOk)
expect('Google Analytics not connected: its six series are unavailable with the reason, the rest still draw', gaOff.unavailable.length === 6 && gaOff.unavailable.every((u) => u.reason === 'Google Analytics is not connected') && gaOff.series.filter((s) => s.available).map((s) => s.id).join(',') === 'clicks,impressions,visits')
expect('an unavailable series has no value in any row and no total (never a zero)', gaOff.rows.every((r) => r.sessions === undefined && r.organic === undefined) && gaOff.series.find((s) => s.id === 'sessions')!.total === null)
expect('rows come only from the sources that were read', gaOff.rows.map((r) => r.key).join(',') === '2026-10-20,2026-10-21,2026-10-22')
const seSnap = buildTrafficSeries('day', gaOk, { status: 'ok', data: { ...searchOk, source: 'snapshot', points: [] } }, viOk)
expect('a Search Console snapshot has no daily numbers, so clicks and impressions are unavailable', seSnap.unavailable.map((u) => u.id).join(',') === 'clicks,impressions' && /could not be read live/.test(seSnap.unavailable[0].reason))
const seErr = buildTrafficSeries('day', gaOk, { status: 'error', message: 'x' }, viOk)
const viOff = buildTrafficSeries('day', gaOk, seOk, { status: 'ok', data: { ...visitsOk, trackingOn: false, points: [] } })
const viErr = buildTrafficSeries('day', gaOk, seOk, { status: 'ok', data: { ...visitsOk, error: 'boom' } })
expect('search error, visit tracking off and a visits read error each name their series', seErr.unavailable.map((u) => u.id).join(',') === 'clicks,impressions' && viOff.unavailable[0].reason === 'visit tracking is off' && viErr.unavailable[0].reason === 'Recorded visits could not be read')
const noUsers = buildTrafficSeries('day', { status: 'ok', report: ga4(GA_ROWS) }, seOk, viOk)
expect('when the per-day users request failed, only Users is named missing and the other lines stay', noUsers.unavailable.map((u) => u.id).join(',') === 'users' && /no daily numbers/.test(noUsers.unavailable[0].reason))
const none = buildTrafficSeries('day', { status: 'error' }, { status: 'error' }, { status: 'error' })
expect('nothing readable: no rows, no data, nine named gaps', none.rows.length === 0 && !none.hasData && none.unavailable.length === 9)
const empty = buildTrafficSeries('day', { status: 'ok', report: ga4([], []) }, { status: 'ok', data: { ...searchOk, points: [], totals: { clicks: 0, impressions: 0, ctr: 0, position: 0 } } }, { status: 'ok', data: { ...visitsOk, points: [], total: 0 } })
expect('everything read but nothing counted: no data (a real zero), nothing named missing', !empty.hasData && empty.unavailable.length === 0)

// ---- 4. the note
expect('the note is empty when nothing is missing', unavailableNote(all) === '')
const note = unavailableNote(gaOff)
expect('the note groups series by reason, says which are not drawn, and uses plain words', /^Not drawn: Sessions, Users, Organic search sessions, Direct sessions, Referral sessions, Social sessions \(Google Analytics is not connected\)\./.test(note) && /not a zero|is a zero that was not counted/.test(note) && !/[—–]/.test(note), note)
expect('the note does not carry the "(right scale)" tag', !/right scale/.test(unavailableNote(seErr)) && /Google Search impressions/.test(unavailableNote(seErr)))

// ---- 5. toggles
expect('all lines are on by default', visibleSeries(all, []).length === 9)
const hid = toggleHidden([], 'impressions')
expect('toggling hides one line and toggling again brings it back, without touching the others', visibleSeries(all, hid).length === 8 && !visibleSeries(all, hid).some((s) => s.id === 'impressions') && toggleHidden(hid, 'impressions').length === 0 && toggleHidden(hid, 'clicks').join(',') === 'impressions,clicks')
expect('an unavailable series is never drawn even when not toggled off', visibleSeries(gaOff, []).length === 3)

// ---- 6. the report builder keeps the old shape when no users request is given
const plain = ga4(GA_ROWS)
expect('buildRangeReport without per-day users leaves users off each bucket (older callers unchanged)', plain.buckets.every((b) => b.users === undefined) && plain.totals.sessions === 42)
expect('buildRangeReport with per-day users attaches them per bucket and zero for a day Google did not list', ga4(GA_ROWS, [['20261020', 15]]).buckets.map((b) => b.users).join(',') === '15,0')
expect('the channel counts helper is unchanged', Object.keys(emptyChannelCounts()).length === 9)

// ---- 7. wiring
const cards = read('components/admin/dashboard-cards.tsx')
expect('the dashboard has ONE traffic chart: no separate Google Analytics, Search or Visits chart cards', /export function TrafficChartCard/.test(cards) && !/export function (TrafficCard|SearchCard|VisitsCard)/.test(cards) && (cards.match(/<LineChart/g) ?? []).length === 1 && !/<AreaChart/.test(cards))
expect('the legend is a set of toggle buttons with aria-pressed, impressions get a right-hand YAxis', /aria-pressed/.test(cards) && /yAxisId="right"/.test(cards) && /toggleHidden/.test(cards))
expect('the chart fits a phone: responsive container, wrapping grid legend, 36px+ tap targets', /ResponsiveContainer/.test(cards) && /min-h-9/.test(cards) && /grid-cols-1/.test(cards))
expect('the GA4 setup help text survives for the not-connected case', /Google Analytics is not connected/.test(cards) && /Open the Setup steps/.test(cards))

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed.')
process.exit(failures ? 1 : 0)
