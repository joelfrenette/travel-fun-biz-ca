// Offline check for the post-publish verify (lib/publish-verify.ts, hub WP1). No network, no database: the web is a fake fetch and the
// database is the in-memory fake (scripts/fake-admin.ts).
// Run: pnpm dlx tsx scripts/check-publish-verify.ts   (exit 1 on a failure)
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

process.env.ANTHROPIC_API_KEY = ''
process.env.INDEXNOW_KEY = ''
delete process.env.PUBLISH_VERIFY

import { fakeAdmin, type Db } from './fake-admin'
import type { FetchLike } from '../lib/site-crawl'
import {
  SITEMAP_GRACE_MS,
  VERIFY_FAIL_TRIES,
  VERIFY_MAX_URLS_PER_PASS,
  VERIFY_MIN_AGE_MS,
  VERIFY_STATE_KEY,
  VERIFY_UNKNOWN_TRIES,
  applyResults,
  candidatesFromLedger,
  emptyVerifyState,
  failingSummary,
  newCandidates,
  parseVerifyState,
  planPass,
  readVerifyState,
  runPublishVerifyIfDue,
  verifyPage,
  type FetchedPage,
  type VerifyState,
} from '../lib/publish-verify'
import { CADENCE_LOG_KEY } from '../lib/publish-cadence'
import { collectIssues } from '../lib/issues'
import { PUBLISH_VERIFY_ISSUE_ID, plainAction } from '../lib/plain-steps'

let failures = 0
function expect(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`)
  if (!ok) failures++
}
const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8')

const SITE = 'https://www.travelfunbiz.ca'
const NOW = Date.parse('2026-10-24T15:00:00Z')
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString()
const MIN = 60_000
const LD = JSON.stringify({ '@context': 'https://schema.org', '@type': 'BlogPosting', headline: 'x' })

interface PageOpts {
  canonical?: string | null
  h1?: number
  ld?: string[] | null
  robots?: string
}
function html(url: string, o: PageOpts = {}): string {
  const canonical = o.canonical === undefined ? url : o.canonical
  const ld = o.ld === undefined ? [LD] : o.ld ?? []
  return `<!doctype html><html><head><title>A page title that is long enough</title>${canonical ? `<link rel="canonical" href="${canonical}"/>` : ''}${o.robots ? `<meta name="robots" content="${o.robots}"/>` : ''}${ld.map((t) => `<script type="application/ld+json">${t}</script>`).join('')}</head><body>${'<h1>Heading</h1>'.repeat(o.h1 ?? 1)}<p>text</p><script>var x="<h1>not a heading</h1>"</script></body></html>`
}
const fetched = (url: string, o: PageOpts = {}, over: Partial<FetchedPage> = {}): FetchedPage => ({ status: 200, finalUrl: url, hops: 0, body: html(url, o), ...over })

const URL1 = `${SITE}/blog/new-post`
const SM = new Set([URL1, `${SITE}/blog`])
const OLD = SITEMAP_GRACE_MS + MIN

// ---- verifyPage: each failure, and the clean case ----
const clean = verifyPage({ url: URL1, fetched: fetched(URL1), sitemap: SM, ageMs: OLD })
expect('a clean page passes', clean.verdict === 'pass' && clean.failures.length === 0, JSON.stringify(clean))
expect('an HTML "<h1" inside a script string is not counted as a heading', clean.verdict === 'pass')
const f500 = verifyPage({ url: URL1, fetched: fetched(URL1, {}, { status: 500, body: '' }), sitemap: SM, ageMs: OLD })
expect('HTTP 500 is a failure that names the status', f500.verdict === 'fail' && /HTTP 500/.test(f500.failures[0]), JSON.stringify(f500))
expect('HTTP 404 fails too', verifyPage({ url: URL1, fetched: fetched(URL1, {}, { status: 404, body: '' }), sitemap: SM, ageMs: OLD }).verdict === 'fail')
const noCanon = verifyPage({ url: URL1, fetched: fetched(URL1, { canonical: null }), sitemap: SM, ageMs: OLD })
expect('a missing canonical fails', noCanon.verdict === 'fail' && noCanon.failures.some((f) => /no canonical/.test(f)), JSON.stringify(noCanon))
const otherCanon = verifyPage({ url: URL1, fetched: fetched(URL1, { canonical: `${SITE}/blog/other` }), sitemap: SM, ageMs: OLD })
expect('a canonical that points at another page fails', otherCanon.verdict === 'fail' && otherCanon.failures.some((f) => /not at the page itself/.test(f)))
expect('a canonical with a trailing slash or #fragment still counts as self', verifyPage({ url: URL1, fetched: fetched(URL1, { canonical: `${URL1}/#top` }), sitemap: SM, ageMs: OLD }).verdict === 'pass')
const twoH1 = verifyPage({ url: URL1, fetched: fetched(URL1, { h1: 2 }), sitemap: SM, ageMs: OLD })
expect('two H1s fail', twoH1.verdict === 'fail' && twoH1.failures.some((f) => /2 H1/.test(f)))
expect('no H1 fails', verifyPage({ url: URL1, fetched: fetched(URL1, { h1: 0 }), sitemap: SM, ageMs: OLD }).failures.some((f) => /no H1/.test(f)))
const badLd = verifyPage({ url: URL1, fetched: fetched(URL1, { ld: ['{"@type": "BlogPosting", '] }), sitemap: SM, ageMs: OLD })
expect('JSON-LD that does not parse fails', badLd.verdict === 'fail' && badLd.failures.some((f) => /do not parse/.test(f)))
expect('no JSON-LD at all fails', verifyPage({ url: URL1, fetched: fetched(URL1, { ld: null }), sitemap: SM, ageMs: OLD }).failures.some((f) => /no JSON-LD/.test(f)))
const redirected = verifyPage({ url: URL1, fetched: fetched(URL1, {}, { hops: 1, finalUrl: `${SITE}/elsewhere` }), sitemap: SM, ageMs: OLD })
expect('a page that redirects fails', redirected.verdict === 'fail' && redirected.failures.some((f) => /redirects/.test(f)))

// the sitemap check and its grace
const notInSm = verifyPage({ url: URL1, fetched: fetched(URL1), sitemap: new Set([`${SITE}/blog`]), ageMs: OLD })
expect('missing from the sitemap after the grace period is a failure', notInSm.verdict === 'fail' && notInSm.failures.includes('not in the sitemap'))
const young = verifyPage({ url: URL1, fetched: fetched(URL1), sitemap: new Set([`${SITE}/blog`]), ageMs: 20 * MIN })
expect('missing from the sitemap inside the hourly rebuild window is pending, not a failure', young.verdict === 'pending' && young.failures.length === 0)
expect('a hard failure beats a pending sitemap', verifyPage({ url: URL1, fetched: fetched(URL1, { h1: 0 }), sitemap: new Set(), ageMs: 20 * MIN }).verdict === 'fail')
const noSm = verifyPage({ url: URL1, fetched: fetched(URL1), sitemap: null, ageMs: OLD })
expect('an unreadable sitemap is unknown, never pass', noSm.verdict === 'unknown', JSON.stringify(noSm))
const noindex = verifyPage({ url: URL1, fetched: fetched(URL1, { robots: 'noindex, follow', canonical: null }), sitemap: new Set(), ageMs: OLD })
expect('a noindex page (a safe-page guide) needs no canonical and no sitemap entry', noindex.verdict === 'pass', JSON.stringify(noindex))
expect('noindex through the X-Robots-Tag header counts too', verifyPage({ url: URL1, fetched: fetched(URL1, { canonical: null }, { xRobots: 'noindex' }), sitemap: new Set(), ageMs: OLD }).verdict === 'pass')

// "cannot read" is unknown, never pass
expect('a fetch error is unknown', verifyPage({ url: URL1, fetched: { status: 0, finalUrl: URL1, hops: 0, body: '', error: 'no answer after 6s' }, sitemap: SM, ageMs: OLD }).verdict === 'unknown')
expect('no fetch at all is unknown', verifyPage({ url: URL1, fetched: null, sitemap: SM, ageMs: OLD }).verdict === 'unknown')

// ---- discovery from the publish ledger ----
const ledger = JSON.stringify([
  { t: 'post', k: 'post:new-post', at: iso(30 * MIN) },
  { t: 'guide', k: 'guide:destinations:aruba', at: iso(40 * MIN) },
  { t: 'guide', k: 'guide:river-cruises:rhine', at: iso(2 * MIN) },
  { t: 'post', k: 'post:ancient', at: iso(10 * 3_600_000) },
  { t: 'guide', k: 'guide:not-a-kind:x', at: iso(30 * MIN) },
  { t: 'post', k: 'post:', at: iso(30 * MIN) },
  { t: 'post', k: 'post:future', at: new Date(NOW + 3_600_000).toISOString() },
  { nonsense: true },
])
const cands = candidatesFromLedger(ledger, NOW)
expect('the ledger yields the posts and guides of the last 6 hours with their public paths', cands.map((c) => c.path).sort().join() === '/blog/new-post,/destinations/aruba,/river-cruises/rhine', cands.map((c) => c.path).join())
expect('malformed, unknown-kind, ancient and future ledger rows are dropped', cands.length === 3)
expect('damaged ledger JSON gives no candidates', candidatesFromLedger('{not json', NOW).length === 0 && candidatesFromLedger(null, NOW).length === 0)
const st0 = emptyVerifyState()
const fresh = newCandidates(cands, st0, NOW)
expect('a page younger than 6 minutes is not looked at yet (the cache mirror needs up to 5)', fresh.every((c) => c.path !== '/river-cruises/rhine') && fresh.length === 2, fresh.map((c) => c.path).join())
expect('the oldest page is checked first', fresh[0].path === '/destinations/aruba')
const stDone: VerifyState = { ...st0, checked: [{ path: '/blog/new-post', at: iso(5 * MIN), verdict: 'pass' }] }
expect('a page already checked since it went live is not checked again', newCandidates(cands, stDone, NOW).every((c) => c.path !== '/blog/new-post'))
const republished = [{ path: '/blog/new-post', kind: 'post' as const, at: iso(1 * 3_600_000 - 30 * MIN) }]
expect('a page republished AFTER its last check is checked again', newCandidates(republished, { ...st0, checked: [{ path: '/blog/new-post', at: iso(3 * 3_600_000), verdict: 'pass' }] }, NOW).length === 1)

// ---- planning: the cap of 6 and the order ----
const many = Array.from({ length: 12 }, (_, i) => ({ path: `/blog/p${i}`, kind: 'post' as const, at: iso((60 + i) * MIN) }))
const failingEntry = (p: string) => ({ path: p, kind: 'post' as const, at: iso(2 * 86_400_000), tries: 2, reasons: ['HTTP 500'], since: iso(86_400_000) })
const stBusy: VerifyState = { ...st0, failing: [failingEntry('/blog/f1'), failingEntry('/blog/f2'), failingEntry('/blog/f3')], pending: [{ path: '/blog/pend', kind: 'post', at: iso(2 * 3_600_000), tries: 1 }] }
const plan = planPass(stBusy, newCandidates(many, stBusy, NOW), NOW)
expect(`a pass never plans more than ${VERIFY_MAX_URLS_PER_PASS} pages`, plan.length === VERIFY_MAX_URLS_PER_PASS && VERIFY_MAX_URLS_PER_PASS === 6, String(plan.length))
expect('reported failures are re-checked first (at most 2), then the unresolved, then new pages', plan.slice(0, 2).every((p) => p.path.startsWith('/blog/f')) && plan[2].path === '/blog/pend' && !plan.some((p) => p.path === '/blog/f3'))

// ---- applying results: retry before reporting, fix detection ----
const R = (url: string, verdict: 'pass' | 'fail' | 'pending' | 'unknown', failures: string[] = []) => ({ url, verdict, failures, notes: [] as string[] })
const entry = (p: string, tries = 0) => ({ path: p, kind: 'post' as const, at: iso(30 * MIN), tries })
let a = applyResults(st0, [entry('/blog/a')], new Map([['/blog/a', R('x', 'fail', ['HTTP 500'])]]), NOW)
expect(`a first failure is retried on the next pass, not reported yet (${VERIFY_FAIL_TRIES} looks needed)`, a.state.pending.length === 1 && a.state.pending[0].tries === 1 && a.state.failing.length === 0 && a.newlyFailing.length === 0)
a = applyResults(a.state, planPass(a.state, [], NOW + 20 * MIN), new Map([['/blog/a', R('x', 'fail', ['HTTP 500'])]]), NOW + 20 * MIN)
expect('the second failure is reported with its reasons', a.state.failing.length === 1 && a.state.failing[0].reasons?.[0] === 'HTTP 500' && a.newlyFailing[0] === '/blog/a' && a.state.pending.length === 0, JSON.stringify(a))
const again = applyResults(a.state, planPass(a.state, [], NOW + 40 * MIN), new Map([['/blog/a', R('x', 'fail', ['HTTP 500'])]]), NOW + 40 * MIN)
expect('a still-failing page is not "newly" reported again', again.newlyFailing.length === 0 && again.state.failing.length === 1)
const fixedRun = applyResults(a.state, planPass(a.state, [], NOW + 60 * MIN), new Map([['/blog/a', R('x', 'pass')]]), NOW + 60 * MIN)
expect('a later pass clears a reported page and says it was fixed', fixedRun.state.failing.length === 0 && fixedRun.fixed[0] === '/blog/a' && fixedRun.state.checked.some((c) => c.path === '/blog/a' && c.verdict === 'pass'))
const unk = applyResults(st0, [entry('/blog/u', VERIFY_UNKNOWN_TRIES - 1)], new Map([['/blog/u', R('x', 'unknown')]]), NOW)
expect('a page that cannot be read several times is dropped quietly: no failure is raised', unk.state.failing.length === 0 && unk.state.pending.length === 0 && unk.state.checked[0].verdict === 'unknown' && unk.newlyFailing.length === 0)
const unk1 = applyResults(st0, [entry('/blog/u')], new Map([['/blog/u', R('x', 'unknown')]]), NOW)
expect('one unreadable look keeps the page for another try', unk1.state.pending.length === 1 && unk1.state.pending[0].tries === 1)
const pend = applyResults(st0, [entry('/blog/s')], new Map([['/blog/s', R('x', 'pending')]]), NOW)
expect('a page only waiting for the hourly sitemap keeps waiting without using up a try', pend.state.pending[0].tries === 0)
const notReached = applyResults(st0, [entry('/blog/n')], new Map(), NOW)
expect('a page that was not reached (out of time) stays exactly where it was', notReached.state.pending.length === 1)
const old = parseVerifyState(JSON.stringify({ ...a.state, failing: [{ ...a.state.failing[0], since: iso(8 * 86_400_000), at: iso(9 * 86_400_000) }] }))
expect('reported failures older than 7 days are dropped', applyResults(old, [], new Map(), NOW).state.failing.length === 0)
expect('failingSummary lists path and reasons', failingSummary(a.state)[0].path === '/blog/a' && failingSummary(a.state)[0].reasons[0] === 'HTTP 500')
expect('a damaged state value is an empty state, not a crash', parseVerifyState('{bad').pending.length === 0 && parseVerifyState(null).failing.length === 0 && parseVerifyState(JSON.stringify({ v: 2 })).checked.length === 0)

// ---- the runner, end to end with a fake fetch and the fake database ----
const requested: { url: string; headers: Record<string, string> }[] = []
const mkFetch = (pages: Record<string, { status?: number; body?: string }>, sitemapXml: string | null, throwOn: string[] = []): FetchLike => async (url, init) => {
  requested.push({ url, headers: init.headers })
  if (throwOn.some((t) => url.endsWith(t))) throw new Error('boom')
  if (url.endsWith('/sitemap.xml')) {
    if (sitemapXml === null) return { status: 503, headers: { get: () => null }, text: async () => '' }
    return { status: 200, headers: { get: (n) => (n.toLowerCase() === 'content-type' ? 'application/xml' : null) }, text: async () => sitemapXml }
  }
  const p = pages[url]
  if (!p) return { status: 404, headers: { get: () => null }, text: async () => '' }
  return { status: p.status ?? 200, headers: { get: (n) => (n.toLowerCase() === 'content-type' ? 'text/html' : null) }, text: async () => p.body ?? '' }
}
const smXml = (urls: string[]) => `<urlset>${urls.map((u) => `<url><loc>${u}</loc></url>`).join('')}</urlset>`

async function main() {
  const good1 = `${SITE}/blog/good-one`
  const bad1 = `${SITE}/blog/broken-one`
  const ledgerRows = JSON.stringify([
    { t: 'post', k: 'post:good-one', at: iso(20 * MIN) },
    { t: 'post', k: 'post:broken-one', at: iso(20 * MIN) },
  ])
  const db: Db = { tables: { app_settings: [{ key: CADENCE_LOG_KEY, value: ledgerRows }], travel_packages: [] } }
  const admin = fakeAdmin(db)
  const pages = { [good1]: { body: html(good1) }, [bad1]: { status: 500, body: '' } }
  const run1 = await runPublishVerifyIfDue(admin, { now: NOW, fetchFn: mkFetch(pages, smXml([good1, bad1])), siteUrl: SITE })
  expect('the runner checks both new pages and says what it found', !!run1 && /checked 2 new pages/.test(run1.note) && /1 fine/.test(run1.note), run1?.note)
  const pageRequests = requested.filter((r) => !r.url.endsWith('/sitemap.xml'))
  expect('exactly one fetch per page plus ONE sitemap read', pageRequests.length === 2 && requested.filter((r) => r.url.endsWith('/sitemap.xml')).length === 1, requested.map((r) => r.url).join())
  expect('NO cookie (and no authorization) header is ever sent, like a search engine', requested.every((r) => !Object.keys(r.headers).some((h) => /^(cookie|authorization)$/i.test(h))), JSON.stringify(requested[0]?.headers))
  const s1 = parseVerifyState(String(db.tables.app_settings.find((r) => r.key === VERIFY_STATE_KEY)?.value))
  expect('after one failing look the broken page is waiting for a second look, not yet reported', s1.failing.length === 0 && s1.pending.some((e) => e.path === '/blog/broken-one') && s1.checked.some((c) => c.path === '/blog/good-one' && c.verdict === 'pass'))
  const run2 = await runPublishVerifyIfDue(admin, { now: NOW + 20 * MIN, fetchFn: mkFetch(pages, smXml([good1, bad1])), siteUrl: SITE })
  const s2 = parseVerifyState(String(db.tables.app_settings.find((r) => r.key === VERIFY_STATE_KEY)?.value))
  expect('the second failing look reports it', s2.failing.length === 1 && s2.failing[0].path === '/blog/broken-one' && /FAILED/.test(run2?.note ?? ''), run2?.note)
  const before3 = requested.length
  await runPublishVerifyIfDue(admin, { now: NOW + 25 * MIN, fetchFn: mkFetch(pages, smXml([good1, bad1])), siteUrl: SITE })
  expect('a good page is not looked at twice (only the reported failure is re-checked)', !requested.slice(before3).some((r) => r.url === good1))

  // the Needs attention item
  const issues = await collectIssues(admin)
  const item = issues.find((i) => i.id === PUBLISH_VERIFY_ISSUE_ID)
  expect('a reported failure becomes ONE Needs attention item that names the page and the reason', !!item && item.area === 'system' && /\/blog\/broken-one/.test(item.detail) && /HTTP 500/.test(item.detail), JSON.stringify(item))
  expect('the item has plain steps and says nothing is deleted', !!item && plainAction(item).steps.length >= 3 && /Nothing here does that|Nothing was changed/.test(plainAction(item).why + plainAction(item).steps.join(' ')))

  // it clears itself when the page is fixed
  const fixedPages = { [good1]: pages[good1], [bad1]: { body: html(bad1) } }
  const run4 = await runPublishVerifyIfDue(admin, { now: NOW + 45 * MIN, fetchFn: mkFetch(fixedPages, smXml([good1, bad1])), siteUrl: SITE })
  expect('a later look finds it fixed and says so', /1 fixed since the last look/.test(run4?.note ?? ''), run4?.note)
  expect('the item disappears once the page passes', !(await collectIssues(admin)).some((i) => i.id === PUBLISH_VERIFY_ISSUE_ID))

  // nothing to do: silent
  const quiet = await runPublishVerifyIfDue(fakeAdmin({ tables: { app_settings: [] } }), { now: NOW, fetchFn: mkFetch({}, smXml([])), siteUrl: SITE, extraCandidates: [] })
  expect('with nothing newly published the step is silent (null)', quiet === null)

  // fail closed / fail soft
  const unreadable = fakeAdmin({ tables: { app_settings: [] }, failWrites: {} })
  const brokenRead = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: 'down' } }) }) }) }) } as unknown as Parameters<typeof runPublishVerifyIfDue>[0]
  const rUnread = await runPublishVerifyIfDue(brokenRead, { now: NOW, fetchFn: mkFetch({}, null), siteUrl: SITE })
  expect('an unreadable state means nothing is checked and no failure is invented', !!rUnread && /could not read the verify state/.test(rUnread.note) && rUnread.ok === true)
  void unreadable
  expect('readVerifyState returns null (not an empty state) when the read fails', (await readVerifyState(brokenRead)) === null)

  // sitemap unreadable on the day: unknown, not failing
  const db5: Db = { tables: { app_settings: [{ key: CADENCE_LOG_KEY, value: ledgerRows }] } }
  await runPublishVerifyIfDue(fakeAdmin(db5), { now: NOW, fetchFn: mkFetch(pages, null), siteUrl: SITE })
  const s5 = parseVerifyState(String(db5.tables.app_settings.find((r) => r.key === VERIFY_STATE_KEY)?.value))
  expect('a sitemap that cannot be read never turns a good page into a failure', s5.failing.length === 0 && !s5.checked.some((c) => c.path === '/blog/good-one' && c.verdict === 'pass'))

  // a network error on the page
  const db6: Db = { tables: { app_settings: [{ key: CADENCE_LOG_KEY, value: ledgerRows }] } }
  await runPublishVerifyIfDue(fakeAdmin(db6), { now: NOW, fetchFn: mkFetch(pages, smXml([good1, bad1]), ['/blog/good-one']), siteUrl: SITE })
  const s6 = parseVerifyState(String(db6.tables.app_settings.find((r) => r.key === VERIFY_STATE_KEY)?.value))
  expect('a page that throws is "could not read": kept for another try, not failing, not passing', s6.failing.length === 0 && s6.pending.some((e) => e.path === '/blog/good-one'))

  // trips
  const db7: Db = { tables: { app_settings: [], travel_packages: [{ slug: 'rhine-explorer', status: 'published', updated_at: iso(30 * MIN) }, { slug: 'old-trip', status: 'published', updated_at: iso(5 * 3_600_000) }, { slug: 'draft-trip', status: 'draft', updated_at: iso(30 * MIN) }] } }
  const tripUrl = `${SITE}/packages/rhine-explorer`
  const r7 = await runPublishVerifyIfDue(fakeAdmin(db7), { now: NOW, fetchFn: mkFetch({ [tripUrl]: { body: html(tripUrl) } }, smXml([tripUrl])), siteUrl: SITE })
  expect('a trip published or edited in the last 2 hours is checked; an old trip and a draft are not', !!r7 && /checked 1 new page/.test(r7.note), r7?.note)

  // kill switch
  process.env.PUBLISH_VERIFY = 'off'
  expect('PUBLISH_VERIFY=off turns the step off', (await runPublishVerifyIfDue(fakeAdmin(db), { now: NOW, fetchFn: mkFetch({}, null), siteUrl: SITE })) === null)
  delete process.env.PUBLISH_VERIFY

  // ---- wiring, by source ----
  const pipeline = read('lib/pipeline.ts')
  expect('the pipeline runs the verify in housekeeping, after the time guard, and never lets it fail the pass', /runPublishVerifyIfDue\(admin\)/.test(pipeline) && /Date\.now\(\) - startedAt < VERIFY_START_BY_MS/.test(pipeline) && /step: 'verify'/.test(pipeline))
  const src = read('lib/publish-verify.ts')
  expect('the verify module never writes to a content table, never deletes and never unpublishes', !/\.(delete|insert)\(|from\('(posts|guides|travel_packages)'\)\s*\.(update|upsert)/.test(src) && !/status: 'draft'/.test(src))
  expect('the verify module sets no cookie or authorization header', !/headers\s*:\s*\{[^}]*(cookie|authorization)|['"](cookie|authorization)['"]\s*:/i.test(src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')))
  expect('the sweep script exists, is read only and never sends a cookie unless asked', /sitemap/i.test(read('scripts/sweep-cookieless.ts')) && !/\.(update|upsert|insert|delete)\(/.test(read('scripts/sweep-cookieless.ts')))
  expect('PUBLISH_VERIFY is documented in .env.example', /PUBLISH_VERIFY/.test(read('.env.example')))
  expect('the Needs attention item is never in the email-exempt informational list (a failed page deserves the alert)', !/PUBLISH_VERIFY_ISSUE_ID/.test(pipeline))

  if (failures) {
    console.error(`\n${failures} check(s) FAILED`)
    process.exit(1)
  }
  console.log('\nAll publish-verify checks passed.')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
