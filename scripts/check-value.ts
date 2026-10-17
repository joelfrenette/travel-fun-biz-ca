// Offline checks for the AI meter, the admin sign-in log, the Website Value page and the Users page logic.
// No network, no database. Run: pnpm dlx tsx scripts/check-value.ts
import { estimateCostUsd, featureFromStack, meterResponse, recordApiCall, usageFrom } from '../lib/ai-meter'
import { buildAuthEvent, recordAuthEvent, shortUserAgent } from '../lib/auth-log'
import {
  buildValueReport, cleanInputsPatch, computeEstimate, latestDayRows, latestRow, tileStatus, trailingRevenue, channelShares,
  type Adjustment, type ValueData,
} from '../lib/value'
import { buildDataRoomCsv, scrubPersonal } from '../lib/value-export'
import { runValueSnapshotIfDue, snapshotRows } from '../lib/value-snapshot'
import { aiCostByFeatureDay, leadStats, loginStats, visitorStats } from '../lib/users-analytics'
import { fakeAdmin } from './fake-admin'

let failed = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`)
  if (!ok) failed++
}

async function main() {
  const NOW = new Date('2026-10-17T12:00:00Z')

  // ---------- AI meter ----------
  check('cost: sonnet 1M in + 1M out = 18', estimateCostUsd('claude-sonnet-5', 1_000_000, 1_000_000) === 18)
  check('cost: unknown model uses the dearest rate', estimateCostUsd('mystery-1', 1_000_000, 0) === 15)
  check('usage: reads the usage field', JSON.stringify(usageFrom({ usage: { input_tokens: 12, output_tokens: 34 } })) === '{"input":12,"output":34}')
  check('usage: junk becomes zero', JSON.stringify(usageFrom({ usage: { input_tokens: 'x' } })) === '{"input":0,"output":0}' && usageFrom(null).input === 0)
  check('feature: from a lib frame', featureFromStack('Error\n    at callAnthropic (C:\\x\\lib\\ai-verify.ts:1:1)\n    at write (C:\\x\\lib\\blog-composer.ts:109:5)') === 'blog-composer')
  check('feature: route frame names the folder', featureFromStack('Error\n    at x (/app/app/api/admin/guides/route.ts:3:1)') === 'admin-guides', featureFromStack('Error\n    at x (/app/app/api/admin/guides/route.ts:3:1)'))
  check('feature: empty stack is other', featureFromStack(undefined) === 'other')

  const inserted: unknown[] = []
  await recordApiCall({ feature: 'f', model: 'claude-haiku-4-5', input_tokens: 1000, output_tokens: 1000, ok: true }, { from: () => ({ insert: async (r) => (inserted.push(r), { error: null }) }) })
  const ins = inserted[0] as { est_cost_usd: number; feature: string }
  check('meter writes one row with an estimated cost', inserted.length === 1 && ins.feature === 'f' && ins.est_cost_usd === 0.006, JSON.stringify(inserted))
  let threw = false
  try {
    await recordApiCall({ feature: 'f', model: 'm', input_tokens: 1, output_tokens: 1, ok: true }, { from: () => ({ insert: async () => { throw new Error('db down') } }) })
    await recordApiCall({ feature: 'f', model: 'm', input_tokens: 1, output_tokens: 1, ok: true }, { from: () => { throw new Error('no client') } })
    await recordApiCall({ feature: 'f', model: 'm', input_tokens: 1, output_tokens: 1, ok: true }, { from: () => ({ insert: async () => ({ error: { message: 'rls' } }) }) })
  } catch {
    threw = true
  }
  check('meter never throws when the DB write fails', !threw)
  // With no service key configured the default writer throws inside; still must not throw.
  const savedKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  delete process.env.SUPABASE_SERVICE_ROLE_KEY
  try {
    await recordApiCall({ feature: 'f', model: 'm', input_tokens: 1, output_tokens: 1, ok: true })
    meterResponse(new Response(JSON.stringify({ usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 }), 'm', 'f')
    meterResponse(new Response('not json', { status: 200 }), 'm', 'f')
    meterResponse(new Response('boom', { status: 500 }), 'm', 'f')
    check('meter without a database key does not throw', true)
  } catch (e) {
    check('meter without a database key does not throw', false, String(e))
  }
  if (savedKey) process.env.SUPABASE_SERVICE_ROLE_KEY = savedKey
  // The caller must still be able to read the body after metering cloned it.
  const live = new Response(JSON.stringify({ content: [], usage: { input_tokens: 5, output_tokens: 6 } }), { status: 200 })
  meterResponse(live, 'm', 'f')
  const body = (await live.json()) as { usage: { input_tokens: number } }
  check('metering leaves the response body readable for the caller', body.usage.input_tokens === 5)

  // ---------- auth log ----------
  process.env.RATE_LIMIT_SALT = 'test-salt'
  const ev = buildAuthEvent('login_ok', '203.0.113.7', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0 Safari/537.36', NOW)
  check('auth event never holds the raw IP', !JSON.stringify(ev).includes('203.0.113.7') && ev.ip_hash.length === 32)
  check('auth event keeps only a short browser label', ev.ua_short === 'Chrome on Windows', ev.ua_short)
  check('auth event hash is stable and salted', buildAuthEvent('login_fail', '203.0.113.7', null).ip_hash === ev.ip_hash && buildAuthEvent('login_ok', '203.0.113.8', null).ip_hash !== ev.ip_hash)
  check('auth event has no email or password fields', !('email' in ev) && !('password' in ev) && shortUserAgent(undefined) === 'unknown')
  const authRows: unknown[] = []
  await recordAuthEvent('login_ok', new Request('http://x/', { headers: { 'x-forwarded-for': '198.51.100.9' } }), { from: () => ({ insert: async (r) => (authRows.push(r), { error: null }) }) })
  check('recordAuthEvent writes a row', authRows.length === 1 && !JSON.stringify(authRows[0]).includes('198.51.100.9'))
  let authThrew = false
  try {
    await recordAuthEvent('logout', new Request('http://x/'), { from: () => ({ insert: async () => { throw new Error('down') } }) })
  } catch {
    authThrew = true
  }
  check('recordAuthEvent never throws', !authThrew)

  // ---------- value: freshness ----------
  check('tile: not tracked beats everything', tileStatus({ tracked: false, asOf: '2026-10-17', now: NOW }) === 'not_tracked')
  check('tile: manual is amber even when fresh', tileStatus({ tracked: true, manual: true, asOf: '2026-10-17', now: NOW }) === 'amber')
  check('tile: older than 30 days is amber', tileStatus({ tracked: true, asOf: '2026-09-01', now: NOW }) === 'amber')
  check('tile: fresh live is ok', tileStatus({ tracked: true, asOf: '2026-10-10', now: NOW }) === 'ok')

  // ---------- value: rolling totals are never summed ----------
  const rolling = [
    { day: '2026-10-15', clicks: 100, impressions: 1000, top10: 4 },
    { day: '2026-10-16', clicks: 110, impressions: 1100, top10: 5 },
    { day: '2026-10-17', clicks: 120, impressions: 1200, top10: 6 },
  ]
  check('latestRow takes the newest day only', latestRow(rolling)?.clicks === 120)
  check('latestDayRows keeps only the newest day', latestDayRows([{ day: 'a', v: 1 }, { day: 'b', v: 2 }, { day: 'b', v: 3 }]).length === 2)

  const baseData = (over: Partial<ValueData> = {}): ValueData => ({
    inputs: {}, orders: [], aiCost12mUsd: null, aiCost30dUsd: null, aiFirstTs: null, ga4: null, visitsByChannel: null, gscDays: [],
    contentPerfLatest: [], leads12m: null, posts: null, guides: null, packages: null, pipeline: null, autopilotOn: null, ...over,
  })
  const tile = (r: ReturnType<typeof buildValueReport>, key: string) => r.tiles.find((t) => t.key === key)!

  const withGsc = buildValueReport(baseData({ gscDays: rolling }), NOW)
  check('search clicks tile is the latest rolling value, not the sum', tile(withGsc, 'search_clicks').raw === 120 && tile(withGsc, 'search_clicks').asOf === '2026-10-17')
  const perf = buildValueReport(baseData({ contentPerfLatest: [{ day: '2026-10-17', path: '/a', clicks: 30 }, { day: '2026-10-17', path: '/b', clicks: 10 }] }), NOW)
  check('page clicks sum pages on the one latest day', tile(perf, 'page_clicks').raw === 40 && /75%/.test(tile(perf, 'page_clicks').note), tile(perf, 'page_clicks').note)

  // ---------- value: not tracked tiles ----------
  const empty = buildValueReport(baseData({ orders: null }), NOW)
  for (const k of ['revenue_12m', 'ai_cost_12m', 'profit_12m', 'costs_12m', 'traffic_sessions', 'organic_share', 'search_clicks', 'page_clicks', 'automation', 'email_list_size', 'domain_age']) {
    const t = tile(empty, k)
    check(`not tracked, not zero: ${k}`, t.status === 'not_tracked' && t.value === null && t.raw === null, JSON.stringify(t))
  }
  const noOrders = buildValueReport(baseData({ orders: [] }), NOW)
  check('no order rows at all is not tracked, not "0"', tile(noOrders, 'revenue_12m').status === 'not_tracked')

  // ---------- value: revenue and profit ----------
  const mk = (cents: number, paid: string, over: Record<string, unknown> = {}) => ({ amount_cents: cents, currency: 'CAD', status: 'paid' as const, is_test: false, paid_at: paid, created_at: paid, ...over })
  const orders = [
    mk(100_000, '2026-09-10T00:00:00Z'),
    mk(200_000, '2026-04-10T00:00:00Z'),
    mk(500_000, '2026-08-10T00:00:00Z', { is_test: true }),
    mk(300_000, '2026-08-11T00:00:00Z', { status: 'refunded' }),
    mk(900_000, '2025-01-01T00:00:00Z'), // older than 12 months
  ]
  const tr = trailingRevenue(orders, NOW)
  check('trailing revenue: tests, refunds and old orders left out', tr.revenue === 3000 && tr.orderCount === 2, JSON.stringify(tr))
  check('monthly series has 12 entries ending this month', tr.months.length === 12 && tr.months[11].month === '2026-10')

  const profitData = baseData({ orders, aiCost12mUsd: 100, inputs: { cost_hosting_monthly: { value: '50', as_of: '2026-10-01' }, cost_tools_monthly: { value: '25', as_of: '2026-10-01' } } })
  const rep = buildValueReport(profitData, NOW)
  // costs: (50 + 25) * 12 = 900, plus 100 USD * 1.35 = 135 -> 1035. profit = 3000 - 1035 = 1965
  check('profit = revenue - costs - converted AI cost', tile(rep, 'profit_12m').raw === 1965, String(tile(rep, 'profit_12m').raw))
  check('profit tile is amber (typed-in costs)', tile(rep, 'profit_12m').status === 'amber')

  // ---------- value: estimate ----------
  const none: Adjustment[] = []
  const e0 = computeEstimate({ netProfit: 10_000, currency: 'CAD', multipleLow: 2, multipleHigh: 4, adjustments: none })
  check('estimate: 2x / 3x / 4x of profit', e0.status === 'ok' && e0.low === 20_000 && e0.base === 30_000 && e0.high === 40_000, JSON.stringify(e0))
  check('estimate carries the not-an-appraisal label', e0.label === 'Rough estimate, not an appraisal')
  const adjs: Adjustment[] = [
    { key: 'organic', label: 'Organic concentration', value: -0.4, reason: 'r1', source: 'suggested' },
    { key: 'trend', label: 'Revenue trend', value: 0.3, reason: 'r2', source: 'suggested' },
  ]
  const e1 = computeEstimate({ netProfit: 10_000, currency: 'CAD', multipleLow: 2, multipleHigh: 4, adjustments: adjs })
  check('estimate: adjustments move every end by their sum', e1.low === 19_000 && e1.base === 29_000 && e1.high === 39_000, JSON.stringify([e1.low, e1.base, e1.high]))
  check('estimate: swapped multiples are tolerated', computeEstimate({ netProfit: 10_000, currency: 'CAD', multipleLow: 4, multipleHigh: 2, adjustments: none }).low === 20_000)
  check('estimate: levers name the negative adjustment', e1.levers.length === 1 && /Organic concentration/.test(e1.levers[0]))
  check('estimate: every assumption is listed', e1.assumptions.length >= 3 && e1.adjustments.every((a) => a.reason))
  const eNeg = computeEstimate({ netProfit: -500, currency: 'CAD', multipleLow: 2, multipleHigh: 4, adjustments: none })
  check('estimate: a loss gives "not enough data", no number', eNeg.status === 'not_enough_data' && eNeg.low === null && eNeg.base === null && eNeg.high === null)
  const eNull = computeEstimate({ netProfit: null, currency: 'CAD', multipleLow: 2, multipleHigh: 4, adjustments: none })
  check('estimate: no profit history gives "not enough data"', eNull.status === 'not_enough_data' && eNull.low === null)
  check('page: no orders means no estimate number', empty.estimate.status === 'not_enough_data' && empty.estimate.base === null)
  check('page: orders but no costs entered means no estimate number', buildValueReport(baseData({ orders }), NOW).estimate.status === 'not_enough_data')
  check('page: with profit there is an estimate with five adjustments', rep.estimate.status === 'ok' && rep.estimate.adjustments.length === 5 && (rep.estimate.base ?? 0) > 0)
  const edited = buildValueReport(baseData({ ...profitData, inputs: { ...profitData.inputs, adj_legal: { value: '-0.5', as_of: '2026-10-17' }, multiple_low: { value: '3', as_of: '2026-10-17' }, multiple_high: { value: '5', as_of: '2026-10-17' } } }), NOW)
  check('editable multiple and slider override the suggestion', edited.estimate.multipleLow === 3 && edited.estimate.adjustments.find((a) => a.key === 'legal')!.value === -0.5 && edited.estimate.adjustments.find((a) => a.key === 'legal')!.source === 'edited')
  const organicHeavy = buildValueReport(baseData({ ...profitData, ga4: { sessions: 1000, organicSearch: 910, social: 10, windowDays: 28, fetchedAt: NOW.toISOString() } }), NOW)
  check('91% organic share suggests a negative adjustment with a reason', organicHeavy.estimate.adjustments.find((a) => a.key === 'organic')!.value === -0.4 && /91%/.test(organicHeavy.estimate.adjustments[0].reason))
  check('channel shares are biggest first', channelShares({ a: 1, b: 3 })[0].channel === 'b')

  // ---------- value: inputs patch ----------
  const patch = cleanInputsPatch({ inputs: { email_list_size: ' 250 ', evil_key: 'x', risks: '', adj_organic: -0.2 } }, '2026-10-17')
  check('inputs patch: known keys only, blank clears', patch.length === 3 && !patch.some((p) => p.key === 'evil_key') && patch.find((p) => p.key === 'risks')!.value === null && patch.find((p) => p.key === 'email_list_size')!.value === '250')

  // ---------- CSV: no personal data ----------
  const riskyInputs = { risks: { value: 'Depends on Google\nCall Pat on 416-555-0199 or pat@example.com', as_of: '2026-10-17' } }
  const csvReport = buildValueReport(baseData({ ...profitData, inputs: { ...profitData.inputs, ...riskyInputs }, leads12m: 12 }), NOW)
  const csv = buildDataRoomCsv(csvReport)
  check('csv has no email address', !/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(csv))
  check('csv has no phone number', !/416-555-0199/.test(csv))
  check('csv holds aggregates and the estimate label', /Rough estimate, not an appraisal/.test(csv) && /Revenue, last 12 months/.test(csv) && /monthly_revenue/.test(csv))
  check('csv has no lead rows (only the count)', !/leads\.|lead_id|message/i.test(csv.replace(/Leads, last 12 months|Orders per lead/g, '')))
  check('scrub removes emails and phones', !/@/.test(scrubPersonal('a@b.co and 4165550199')) && !/4165550199/.test(scrubPersonal('call 4165550199')))
  check('csv defangs formula cells', /'=SUM/.test(buildDataRoomCsv({ ...csvReport, tiles: [{ ...csvReport.tiles[0], label: '=SUM(A1)' }] })))

  // ---------- monthly snapshot ----------
  const db = { tables: {} as Record<string, Record<string, unknown>[]> }
  const admin = fakeAdmin(db)
  const note1 = await runValueSnapshotIfDue(admin, NOW)
  check('snapshot: written once for the month', /2026-10/.test(note1 ?? '') && db.tables.value_snapshots?.length === 1)
  const note2 = await runValueSnapshotIfDue(admin, NOW)
  check('snapshot: second pass in the same month is a no-op', note2 === null && db.tables.value_snapshots.length === 1)
  const nextMonth = await runValueSnapshotIfDue(admin, new Date('2026-11-02T00:00:00Z'))
  check('snapshot: a new month writes a new one', !!nextMonth && db.tables.value_snapshots.length === 2)
  const failDb = fakeAdmin({ tables: {}, failWrites: { value_snapshots: 'no table' } })
  let snapThrew = false
  try { await runValueSnapshotIfDue(failDb, NOW) } catch { snapThrew = true }
  check('snapshot: a failing write never throws', !snapThrew)
  const sr = snapshotRows(csvReport, '2026-10')
  check('snapshot rows carry no free text or personal data', !/@|416-555/.test(JSON.stringify(sr)))

  // ---------- users page logic ----------
  const calls = [
    { ts: '2026-10-16T10:00:00Z', feature: 'blog-composer', input_tokens: 1000, output_tokens: 2000, est_cost_usd: 0.5, ok: true },
    { ts: '2026-10-16T11:00:00Z', feature: 'blog-composer', input_tokens: 10, output_tokens: 20, est_cost_usd: '0.25', ok: false },
    { ts: '2026-10-17T09:00:00Z', feature: 'guide-composer', input_tokens: 5, output_tokens: 5, est_cost_usd: 1, ok: true },
  ]
  const cost = aiCostByFeatureDay(calls)
  check('AI cost: grouped per feature per day, newest day first', cost.byDay.length === 2 && cost.byDay[0].day === '2026-10-17' && cost.byDay[1].calls === 2 && cost.byDay[1].failed === 1 && cost.byDay[1].costUsd === 0.75)
  check('AI cost: totals per feature', cost.byFeature[0].feature === 'guide-composer' && cost.totalUsd === 1.75)

  const logins = loginStats([
    { ts: '2026-10-16T10:00:00Z', kind: 'login_ok' }, { ts: '2026-10-12T10:00:00Z', kind: 'login_ok' }, { ts: '2026-09-20T10:00:00Z', kind: 'login_ok' },
    { ts: '2026-10-15T10:00:00Z', kind: 'login_fail' }, { ts: '2026-10-16T11:00:00Z', kind: 'logout' },
  ], NOW)
  check('logins: last login, 7 and 30 day counts', logins.lastLogin === '2026-10-16T10:00:00Z' && logins.loginsLast7 === 2 && logins.loginsLast30 === 3 && logins.failedLast30 === 1, JSON.stringify(logins))
  check('logins: 8 weeks and 6 months listed', logins.weeks.length === 8 && logins.months.length === 6 && logins.months[5].logins === 2)

  const secretMsg = 'Hi, I am Marguerite Delacroix at marguerite@example.com. Do you have Caribbean cruises for families? Looking at Caribbean cruises in March.'
  const ls = leadStats([
    { utm_source: 'google', page_path: '/blog/a?utm_content=zzz&email=q@x.com', message: secretMsg },
    { utm_source: 'google', page_path: '/blog/a', message: 'Caribbean cruises with kids? Budget cruises please' },
    { utm_source: null, page_path: null, message: 'cruises' },
    { utm_source: 'facebook', page_path: '/', message: '' },
  ])
  const json = JSON.stringify(ls)
  check('leads: counts by source and page, query strings dropped', ls.total === 4 && ls.bySource[0].source === 'google' && ls.bySource[0].count === 2 && ls.byPage[0].page === '/blog/a' && !json.includes('zzz') && !json.includes('q@x.com'))
  check('leads: question count, no raw message anywhere', ls.questions === 2 && ls.withMessage === 3 && !json.includes('Marguerite') && !json.includes('marguerite@example.com'))
  check('leads: common words need 2+ leads, so names never surface', ls.topWords[0].word === 'cruises' && ls.topWords.some((w) => w.word === 'caribbean') && !ls.topWords.some((w) => /marguerite|delacroix/.test(w.word)), JSON.stringify(ls.topWords))
  check('leads: top words capped at 20', leadStats(Array.from({ length: 60 }, (_, i) => ({ utm_source: null, page_path: null, message: `alpha${'x'.repeat(i % 25)} word${'y'.repeat(i)}` }))).topWords.length <= 20)

  const v0 = visitorStats([])
  check('visitors: empty shows "Needs visit tracking switched on"', !v0.tracked && v0.message === 'Needs visit tracking switched on' && v0.total === 0)
  const v1 = visitorStats([{ channel: 'organic', landing_path: '/a?x=1', created_at: '2026-10-16T01:00:00Z' }, { channel: 'direct', landing_path: '/a', created_at: '2026-10-17T01:00:00Z' }])
  check('visitors: channels and pages when rows exist', v1.tracked && v1.total === 2 && v1.byPage[0].page === '/a' && v1.byPage[0].visits === 2 && v1.byChannel.length === 2)

  console.log(failed ? `\n${failed} FAILED` : '\nAll checks passed')
  if (failed) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
