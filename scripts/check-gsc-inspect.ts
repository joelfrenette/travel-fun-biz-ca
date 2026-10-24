// Offline check for the Google URL Inspection feedback (lib/gsc-inspect.ts, hub WP2). No network, no database, no Google: the Google call is a
// fake and the database is the in-memory fake (scripts/fake-admin.ts).
// Run: pnpm dlx tsx scripts/check-gsc-inspect.ts   (exit 1 on a failure)
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

process.env.ANTHROPIC_API_KEY = ''
process.env.INDEXNOW_KEY = ''

import { fakeAdmin, type Db } from './fake-admin'
import {
  INSPECT_MAX_PER_DAY,
  INSPECT_STATE_KEY,
  MIN_RATIO_SAMPLE,
  STUCK_AFTER_MS,
  applyInspections,
  classifyInspection,
  describeInspection,
  emptyInspectState,
  indexRatio,
  parseInspectState,
  pickBatch,
  readInspectionState,
  runUrlInspection,
  stuckNotIndexed,
  type InspectApiResponse,
  type InspectCall,
  type InspectState,
} from '../lib/gsc-inspect'
import { collectIssues } from '../lib/issues'
import { INSPECT_PERMISSION_ISSUE_ID, NOT_INDEXED_ISSUE_ID, plainAction } from '../lib/plain-steps'

let failures = 0
function expect(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`)
  if (!ok) failures++
}
const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8')

const SITE = 'https://www.travelfunbiz.ca'
const DAY = 86_400_000
const NOW = Date.parse('2026-10-24T14:00:00Z')
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString()
const resp = (verdict: string, coverageState: string, more: Record<string, string> = {}): InspectApiResponse => ({ inspectionResult: { indexStatusResult: { verdict, coverageState, ...more } } })

// ---- reading Google's answer ----
expect('"Submitted and indexed" is indexed', classifyInspection(resp('PASS', 'Submitted and indexed')).verdict === 'indexed')
expect('"Indexed, not submitted in sitemap" is indexed', classifyInspection(resp('PASS', 'Indexed, not submitted in sitemap')).verdict === 'indexed')
const crawled = classifyInspection(resp('NEUTRAL', 'Crawled - currently not indexed'))
expect('"Crawled - currently not indexed" is not indexed, with Google\'s exact words as the reason', crawled.verdict === 'not_indexed' && crawled.reason === 'Crawled - currently not indexed', JSON.stringify(crawled))
expect('"Discovered - currently not indexed" is not indexed', classifyInspection(resp('NEUTRAL', 'Discovered - currently not indexed')).verdict === 'not_indexed')
expect('"URL is unknown to Google" is not indexed', classifyInspection(resp('NEUTRAL', 'URL is unknown to Google')).verdict === 'not_indexed')
const dup = classifyInspection(resp('FAIL', 'Duplicate, Google chose different canonical than user', { googleCanonical: `${SITE}/other`, pageFetchState: 'SUCCESSFUL' }), `${SITE}/blog/x`)
expect('a different Google-chosen canonical is named in the reason', dup.verdict === 'not_indexed' && /different canonical: .*\/other/.test(dup.reason), dup.reason)
const blocked = classifyInspection(resp('FAIL', 'Blocked by robots.txt', { robotsTxtState: 'DISALLOWED', indexingState: 'BLOCKED_BY_META_TAG', pageFetchState: 'BLOCKED_ROBOTS_TXT' }))
expect('robots, indexing and fetch faults are all in the reason', blocked.verdict === 'not_indexed' && /blocked by robots\.txt/.test(blocked.reason) && /indexing: blocked by meta tag/.test(blocked.reason) && /page fetch: blocked robots txt/.test(blocked.reason), blocked.reason)
expect('the same canonical as the page is not reported as a difference', !/canonical/.test(classifyInspection(resp('PASS', 'Submitted and indexed', { googleCanonical: `${SITE}/blog/x/` }), `${SITE}/blog/x`).reason))
expect('an empty answer is unknown, never indexed', classifyInspection({}).verdict === 'unknown' && classifyInspection(null).verdict === 'unknown' && classifyInspection({ inspectionResult: {} }).verdict === 'unknown')
expect('an answer with no clear words and no verdict is unknown', classifyInspection(resp('VERDICT_UNSPECIFIED', 'Something new Google invented')).verdict === 'unknown')

// ---- choosing the batch: oldest first ----
const paths = ['/a', '/b', '/c', '/d', '/e']
const ent = (path: string, msAgo: number, verdict: 'indexed' | 'not_indexed' | 'unknown' = 'indexed') => ({ path, checkedAt: iso(msAgo), verdict, reason: '' })
const entries = { '/a': ent('/a', 1 * DAY), '/b': ent('/b', 5 * DAY), '/d': ent('/d', 3 * DAY) }
expect('pages never asked about come first (in path order), then the longest ago', pickBatch(paths, entries, 5).join() === '/c,/e,/b,/d,/a', pickBatch(paths, entries, 5).join())
expect('the batch is cut at the number asked for', pickBatch(paths, entries, 2).join() === '/c,/e' && pickBatch(paths, entries, 0).length === 0)
expect('duplicates in the sitemap list count once', pickBatch(['/x', '/x', '/y'], {}, 5).join() === '/x,/y')

// ---- folding answers into the state ----
let st = applyInspections(emptyInspectState(), [{ path: '/a', verdict: 'not_indexed', reason: 'Crawled - currently not indexed' }, { path: '/b', verdict: 'indexed', reason: 'Submitted and indexed' }], ['/a', '/b'], { status: 'ok', note: 'read' }, NOW - 8 * DAY)
expect('a not-indexed answer starts a streak (since = first check); an indexed one has none', st.entries['/a'].since === iso(8 * DAY) && st.entries['/b'].since === undefined)
st = applyInspections(st, [{ path: '/a', verdict: 'not_indexed', reason: 'Crawled - currently not indexed' }], ['/a', '/b'], { status: 'ok', note: 'read' }, NOW)
expect('the streak start survives a second not-indexed answer', st.entries['/a'].since === iso(8 * DAY) && st.entries['/a'].checkedAt === iso(0))
expect('the daily counter adds up within a day and starts over on a new day', st.usedToday === 1 && applyInspections(st, [{ path: '/b', verdict: 'indexed', reason: '' }], null, { status: 'ok', note: '' }, NOW + DAY).usedToday === 1 && applyInspections(st, [{ path: '/b', verdict: 'indexed', reason: '' }], null, { status: 'ok', note: '' }, NOW + 1000).usedToday === 2)
const cleared = applyInspections(st, [{ path: '/a', verdict: 'indexed', reason: 'Submitted and indexed' }], null, { status: 'ok', note: '' }, NOW + DAY)
expect('when the page gets indexed the streak is cleared', cleared.entries['/a'].since === undefined && cleared.entries['/a'].verdict === 'indexed')
const dropped = applyInspections(st, [], ['/b'], { status: 'ok', note: '' }, NOW)
expect('pages no longer in the sitemap are forgotten', Object.keys(dropped.entries).join() === '/b')

// ---- the stuck rule ----
const stuckState: InspectState = {
  ...emptyInspectState(),
  entries: {
    '/old': { path: '/old', checkedAt: iso(0), verdict: 'not_indexed', reason: 'Crawled - currently not indexed', since: iso(STUCK_AFTER_MS + 1000) },
    '/young': { path: '/young', checkedAt: iso(0), verdict: 'not_indexed', reason: 'Discovered - currently not indexed', since: iso(3 * DAY) },
    '/once': { path: '/once', checkedAt: iso(0), verdict: 'not_indexed', reason: 'x', since: iso(0) },
    '/fine': { path: '/fine', checkedAt: iso(0), verdict: 'indexed', reason: 'Submitted and indexed' },
    '/unclear': { path: '/unclear', checkedAt: iso(0), verdict: 'unknown', reason: '', since: iso(20 * DAY) },
  },
}
const stuck = stuckNotIndexed(stuckState, NOW)
expect('only a page still not indexed on a check 7+ days after the first one is stuck', stuck.length === 1 && stuck[0].path === '/old' && stuck[0].reason === 'Crawled - currently not indexed', JSON.stringify(stuck))
expect('a page seen once, or younger than 7 days, or unclear, or indexed is never stuck', !stuck.some((s) => s.path !== '/old'))

// ---- the index ratio ----
const manyEntries: Record<string, ReturnType<typeof ent>> = {}
const allPaths: string[] = []
for (let i = 0; i < 12; i++) {
  const p = `/p${i}`
  allPaths.push(p)
  manyEntries[p] = ent(p, DAY, i < 9 ? 'indexed' : 'not_indexed')
}
allPaths.push('/never')
const ratio = indexRatio({ ...emptyInspectState(), entries: manyEntries }, allPaths)
expect('ratio = indexed / (indexed + not indexed), with the pages never asked counted apart', ratio.indexed === 9 && ratio.notIndexed === 3 && ratio.notChecked === 1 && ratio.ratio === 0.75, JSON.stringify(ratio))
expect(`the ratio is null (unknown, never zero) below ${MIN_RATIO_SAMPLE} clear answers`, indexRatio({ ...emptyInspectState(), entries: { '/a': ent('/a', DAY), '/b': ent('/b', DAY, 'not_indexed') } }, ['/a', '/b']).ratio === null && indexRatio(emptyInspectState(), ['/a']).ratio === null)
expect('unclear answers do not count in the ratio', indexRatio({ ...emptyInspectState(), entries: { ...manyEntries, '/p0': ent('/p0', DAY, 'unknown') } }, allPaths).indexed === 8)
expect('the sentence says "not asked about yet" and the percent only when it is known', /not asked about yet; 75 percent/.test(describeInspection({ ...emptyInspectState(), entries: manyEntries }, allPaths)) && /too few clear answers/.test(describeInspection({ ...emptyInspectState(), entries: { '/a': ent('/a', DAY) } }, ['/a'])))
expect('a state that could not be read says so instead of giving numbers', /could not be read/.test(describeInspection({ ...emptyInspectState(), read: { status: 'no_permission', note: 'Google refused', at: iso(0) }, entries: manyEntries }, allPaths)))
expect('a damaged stored state is an empty state', parseInspectState('{nope').lastRun === null && Object.keys(parseInspectState(null).entries).length === 0 && Object.keys(parseInspectState(JSON.stringify({ v: 1, entries: { x: { path: 'x', checkedAt: 'not a date', verdict: 'indexed' } } })).entries).length === 0)

// ---- the runner with a fake Google ----
const smUrls = (n: number) => Array.from({ length: n }, (_, i) => `${SITE}/blog/p${String(i).padStart(3, '0')}`)
const answers = (map: (url: string) => InspectApiResponse): { call: InspectCall; asked: string[]; timeouts: number[] } => {
  const asked: string[] = []
  const timeouts: number[] = []
  return {
    asked,
    timeouts,
    call: async (url, t) => {
      asked.push(url)
      timeouts.push(t)
      return { ok: true, body: map(url) }
    },
  }
}
const stateOf = (db: Db): InspectState => parseInspectState(String(db.tables.app_settings.find((r) => r.key === INSPECT_STATE_KEY)?.value))

async function main() {
  // cap and order
  const db: Db = { tables: { app_settings: [] } }
  const g1 = answers((u) => (/p00[0-4]/.test(u) ? resp('PASS', 'Submitted and indexed') : resp('NEUTRAL', 'Discovered - currently not indexed')))
  const r1 = await runUrlInspection(fakeAdmin(db), { deadlineMs: Date.now() + 60_000, call: g1.call, sitemapUrls: smUrls(45), now: NOW })
  expect(`day 1 asks Google about at most ${INSPECT_MAX_PER_DAY} pages`, g1.asked.length === INSPECT_MAX_PER_DAY && INSPECT_MAX_PER_DAY === 20, String(g1.asked.length))
  expect('day 1 starts with the pages never asked about, in order', [...g1.asked].sort().join() === smUrls(20).join(), g1.asked.slice(0, 3).join())
  const s1 = stateOf(db)
  expect('the answers and the reasons are stored per page', Object.keys(s1.entries).length === 20 && s1.entries['/blog/p000'].verdict === 'indexed' && s1.entries['/blog/p010'].reason === 'Discovered - currently not indexed' && s1.entries['/blog/p010'].since === iso(0))
  expect('the daily counter is stored', s1.usedToday === 20 && s1.read?.status === 'ok')
  expect('the note gives the numbers and says how many were never asked about', /5 indexed, 15 not indexed/.test(r1.note) && /25 not asked about yet/.test(r1.note), r1.note)
  // same day again: nothing more
  const gSame = answers(() => resp('PASS', 'Submitted and indexed'))
  const rSame = await runUrlInspection(fakeAdmin(db), { deadlineMs: Date.now() + 60_000, call: gSame.call, sitemapUrls: smUrls(45), now: NOW + 3_600_000 })
  expect('a second run on the same day asks nothing (the 20 are used) and says so', gSame.asked.length === 0 && /today's 20 are used/.test(rSame.note), rSame.note)
  // next day: the next 20, oldest first
  const g2 = answers(() => resp('PASS', 'Submitted and indexed'))
  await runUrlInspection(fakeAdmin(db), { deadlineMs: Date.now() + 60_000, call: g2.call, sitemapUrls: smUrls(45), now: NOW + DAY })
  expect('day 2 asks the next 20 never-asked pages, not the same ones again', [...g2.asked].sort().join() === smUrls(40).slice(20).join())
  // day 3: 5 left never asked, then the oldest answered
  const g3 = answers(() => resp('NEUTRAL', 'Discovered - currently not indexed'))
  await runUrlInspection(fakeAdmin(db), { deadlineMs: Date.now() + 60_000, call: g3.call, sitemapUrls: smUrls(45), now: NOW + 2 * DAY })
  expect('day 3 asks the last 5 never-asked pages first, then the oldest answered ones', g3.asked.slice(0, 5).sort().join() === smUrls(45).slice(40).join() && g3.asked.slice(5).every((u) => Number(u.slice(-3)) < 20), g3.asked.join())
  // stuck after 7 days: the not-indexed page is asked again later and is still not indexed
  const gLate = answers(() => resp('NEUTRAL', 'Discovered - currently not indexed'))
  await runUrlInspection(fakeAdmin(db), { deadlineMs: Date.now() + 60_000, call: gLate.call, sitemapUrls: smUrls(45), now: NOW + 8 * DAY, maxPerDay: 45 })
  const sLate = stateOf(db)
  expect('a page that stayed not indexed for 8 days is stuck, with Google\'s exact reason', stuckNotIndexed(sLate, NOW + 8 * DAY).some((s) => s.path === '/blog/p010' && s.reason === 'Discovered - currently not indexed'))

  // missing permission: honest, no failure, stops early
  const db2: Db = { tables: { app_settings: [] } }
  let calls403 = 0
  const call403: InspectCall = async () => {
    calls403++
    return { ok: false, status: 403, message: 'User does not have sufficient permission for site' }
  }
  const r403 = await runUrlInspection(fakeAdmin(db2), { deadlineMs: Date.now() + 60_000, call: call403, sitemapUrls: smUrls(30), now: NOW })
  const s403 = stateOf(db2)
  expect('a 403 is stored as "no permission" with a plain note, and the step does not fail', s403.read?.status === 'no_permission' && /service account/.test(s403.read?.note ?? '') && r403.ok === true && /could not be read/.test(r403.note), r403.note)
  expect('after a 403 no more calls are started (only the ones already in flight finish)', calls403 <= 3, String(calls403))
  expect('a 403 does not invent any page answer or use up the day\'s count', Object.keys(s403.entries).length === 0 && s403.usedToday === 0)
  const issues2 = await collectIssues(fakeAdmin(db2))
  const permIssue = issues2.find((i) => i.id === INSPECT_PERMISSION_ISSUE_ID)
  expect('the missing permission is a gentle setup item with plain steps', !!permIssue && permIssue.area === 'setup' && plainAction(permIssue).steps.length >= 4 && /Users and permissions/.test(plainAction(permIssue).steps.join(' ')), JSON.stringify(permIssue))

  // quota, network fault
  const db3: Db = { tables: { app_settings: [] } }
  const r429 = await runUrlInspection(fakeAdmin(db3), { deadlineMs: Date.now() + 60_000, call: async () => ({ ok: false, status: 429, message: 'quota' }), sitemapUrls: smUrls(10), now: NOW })
  expect('a 429 is stored as "quota", not as a failure', stateOf(db3).read?.status === 'quota' && r429.ok === true)
  const db4: Db = { tables: { app_settings: [] } }
  const flaky: InspectCall = async (u) => (u.endsWith('p001') ? { ok: false, status: 0, message: 'network error' } : { ok: true, body: resp('PASS', 'Submitted and indexed') })
  await runUrlInspection(fakeAdmin(db4), { deadlineMs: Date.now() + 60_000, call: flaky, sitemapUrls: smUrls(4), now: NOW })
  const s4 = stateOf(db4)
  expect('one network fault does not stop the others, and the page it hit stays unasked', Object.keys(s4.entries).length === 3 && !s4.entries['/blog/p001'] && s4.read?.status === 'ok' && /partly read/.test(s4.read?.note ?? ''))

  // the deadline
  const db5: Db = { tables: { app_settings: [] } }
  const g5 = answers(() => resp('PASS', 'Submitted and indexed'))
  await runUrlInspection(fakeAdmin(db5), { deadlineMs: Date.now() - 1, call: g5.call, sitemapUrls: smUrls(10), now: NOW })
  expect('with no time left no call is started', g5.asked.length === 0)
  const g5b = answers(() => resp('PASS', 'Submitted and indexed'))
  await runUrlInspection(fakeAdmin({ tables: { app_settings: [] } }), { deadlineMs: Date.now() + 3_000, call: g5b.call, sitemapUrls: smUrls(3), now: NOW })
  expect('each call is given a timeout no longer than what is left of the run (at least 1.5 s, at most 8 s)', g5b.timeouts.every((t) => t >= 1_500 && t <= 8_000), g5b.timeouts.join())

  // fail closed: an unreadable state
  const g6 = answers(() => resp('PASS', 'Submitted and indexed'))
  const broken = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: 'down' } }) }) }) }) } as unknown as Parameters<typeof runUrlInspection>[0]
  const r6 = await runUrlInspection(broken, { deadlineMs: Date.now() + 60_000, call: g6.call, sitemapUrls: smUrls(5), now: NOW })
  expect('an unreadable state means nothing is asked (the daily count is unknown)', g6.asked.length === 0 && /could not read its state/.test(r6.note))
  expect('readInspectionState returns null, not an empty state, when the read fails', (await readInspectionState(broken)) === null)

  // not configured: dormant, honest
  const prevKey = process.env.GOOGLE_SERVICE_ACCOUNT_KEY
  delete process.env.GOOGLE_SERVICE_ACCOUNT_KEY
  const r7 = await runUrlInspection(fakeAdmin({ tables: { app_settings: [] } }), { deadlineMs: Date.now() + 60_000, sitemapUrls: smUrls(5), now: NOW })
  expect('without the Google service account the step is off and says so', /off until the Google service account/.test(r7.note))
  if (prevKey !== undefined) process.env.GOOGLE_SERVICE_ACCOUNT_KEY = prevKey

  // the sitemap cannot be read
  const db8: Db = { tables: { app_settings: [] } }
  const r8 = await runUrlInspection(fakeAdmin(db8), {
    deadlineMs: Date.now() + 60_000,
    call: answers(() => resp('PASS', 'x')).call,
    siteUrl: SITE,
    now: NOW,
    fetchFn: async () => ({ status: 503, headers: { get: () => null }, text: async () => '' }),
  })
  expect('an unreadable sitemap is stored as such and asks nothing', stateOf(db8).read?.status === 'no_sitemap' && /sitemap could not be read/.test(r8.note))

  // the Needs attention item for a stuck page
  const db9: Db = { tables: { app_settings: [{ key: INSPECT_STATE_KEY, value: JSON.stringify({ ...stuckState, read: { status: 'ok', note: 'read', at: iso(0) } }) }] } }
  const issues9 = await collectIssues(fakeAdmin(db9))
  const item = issues9.find((i) => i.id === NOT_INDEXED_ISSUE_ID)
  expect('a stuck page becomes ONE informational item that names it and Google\'s exact reason', !!item && /\/old: Crawled - currently not indexed/.test(item.detail) && item.area === 'system', JSON.stringify(item))
  expect('the item says nothing is broken and gives plain steps', !!item && plainAction(item).steps.length >= 3 && /not indexed/.test(plainAction(item).why))
  expect('no item appears when nothing is stuck', !(await collectIssues(fakeAdmin({ tables: { app_settings: [{ key: INSPECT_STATE_KEY, value: JSON.stringify({ ...stuckState, entries: { '/young': stuckState.entries['/young'] } }) }] } }))).some((i) => i.id === NOT_INDEXED_ISSUE_ID))

  // measure only, wiring by source
  const src = read('lib/gsc-inspect.ts')
  expect('the inspection never blocks or changes publishing (it imports no publish, cadence or content module)', !/publish-cadence|autoblog|guide-run|from\('(posts|guides|travel_packages)'\)/.test(src))
  const cron = read('app/api/cron/gsc-snapshot/route.ts')
  expect('the daily cron runs it under its own time budget and skips it when time is short, like the other steps', /runUrlInspection\(getSupabaseAdmin\(\)/.test(cron) && /URL inspection skipped \(time budget already used\)/.test(cron) && /INSPECT_BUDGET_MS/.test(cron) && /57_000 - \(Date\.now\(\) - startedAt\) - 5_000/.test(cron))
  expect('the cron result string includes the inspection note', /\$\{playbook\}\$\{inspect\}\$\{sysCheck\}/.test(cron))
  expect('the not-indexed item is left out of the alert email (informational)', /i\.id !== NOT_INDEXED_ISSUE_ID/.test(read('lib/pipeline.ts')))

  if (failures) {
    console.error(`\n${failures} check(s) FAILED`)
    process.exit(1)
  }
  console.log('\nAll gsc-inspect checks passed.')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
