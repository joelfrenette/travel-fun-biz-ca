// Offline checks for the IndexNow daily catch-up (hub row 14). No network, no database: the ping is a stub and the
// database is scripts/fake-admin.ts. Run: pnpm dlx tsx scripts/check-indexnow-catchup.ts
import { readFileSync } from 'node:fs'
import { CATCHUP_MAX_URLS, INDEXNOW_LEDGER_KEY, parseLedger, pruneLedger, runIndexNowCatchup, runIndexNowCatchupIfDue, selectCatchupPaths } from '../lib/indexnow-catchup'
import type { IndexNowResult } from '../lib/indexnow'
import { fakeAdmin, type Db } from './fake-admin'

process.env.INDEXNOW_KEY = ''
let failed = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`)
  if (!ok) failed++
}
const LONG_DASH = new RegExp('[' + String.fromCharCode(0x2013, 0x2014) + ']')
const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

const NOW = new Date('2026-10-17T15:00:00.000Z')
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString()

// ---- pure helpers ----
check('parseLedger: empty is an empty ledger', JSON.stringify(parseLedger(null)) === '{}' && JSON.stringify(parseLedger('')) === '{}')
check('parseLedger: garbage is unreadable (null)', parseLedger('{nope') === null)
check('parseLedger: an array is unreadable', parseLedger('[1,2]') === null)
check('parseLedger: a non-date value is unreadable', parseLedger('{"/a":"yesterday-ish"}') === null)
check('parseLedger: a good map is read', parseLedger(`{"/a":"${hoursAgo(1)}"}`)?.['/a'] === hoursAgo(1))

const cands = [
  { path: '/blog/new', updatedAt: hoursAgo(2) },
  { path: '/blog/old', updatedAt: hoursAgo(60) },
  { path: '/blog/done', updatedAt: hoursAgo(10) },
  { path: '/blog/edited-after-ping', updatedAt: hoursAgo(5) },
  { path: '/blog/new', updatedAt: hoursAgo(3) },
  { path: '/blog/bad-date', updatedAt: 'soon' },
]
const ledger = { '/blog/done': hoursAgo(9), '/blog/edited-after-ping': hoursAgo(8) }
const sel = selectCatchupPaths(cands, ledger, NOW.getTime())
check('selection: changed in 48h with no newer ping are due, newest change first', JSON.stringify(sel.paths) === JSON.stringify(['/blog/new', '/blog/edited-after-ping']), JSON.stringify(sel.paths))
check('selection: older than 48 hours is left out', !sel.paths.includes('/blog/old'))
check('selection: a ping newer than the change counts as done', !sel.paths.includes('/blog/done'))
check('selection: a page edited after its ping is due again', sel.paths.includes('/blog/edited-after-ping'))
check('selection: one entry per path and a bad date is skipped', sel.paths.filter((p) => p === '/blog/new').length === 1 && !sel.paths.includes('/blog/bad-date'))
const many = Array.from({ length: 150 }, (_, i) => ({ path: `/blog/p${i}`, updatedAt: hoursAgo(1 + i / 100) }))
const capped = selectCatchupPaths(many, {}, NOW.getTime())
check('selection: capped at 100 URLs, the rest counted as waiting', capped.paths.length === CATCHUP_MAX_URLS && capped.waiting === 50, `${capped.paths.length}/${capped.waiting}`)
check('prune: entries older than 7 days are dropped', JSON.stringify(pruneLedger({ '/a': hoursAgo(24 * 8), '/b': hoursAgo(5) }, NOW.getTime())) === JSON.stringify({ '/b': hoursAgo(5) }))

// ---- the run ----
function dbWith(extra: Partial<Db['tables']> = {}): Db {
  return {
    tables: {
      app_settings: [],
      posts: [
        { id: 'p1', slug: 'fresh-post', status: 'published', updated_at: hoursAgo(3) },
        { id: 'p2', slug: 'draft-post', status: 'draft', updated_at: hoursAgo(3) },
        { id: 'p3', slug: 'stale-post', status: 'published', updated_at: hoursAgo(100) },
      ],
      guides: [{ id: 'g1', kind: 'destinations', slug: 'italy', status: 'published', updated_at: hoursAgo(20) }],
      page_copy: [{ id: 'c1', path: '/best-time-to-visit/italy', status: 'published', updated_at: hoursAgo(30) }],
      travel_packages: [{ id: 't1', slug: 'rome-trip', status: 'published', updated_at: hoursAgo(1) }, { id: 't2', slug: 'hidden-trip', status: 'draft', updated_at: hoursAgo(1) }],
      ...extra,
    },
  }
}
function stub(result: Partial<IndexNowResult> = { ok: true }) {
  const calls: string[][] = []
  const ping = async (paths: string[]): Promise<IndexNowResult> => {
    calls.push(paths)
    return { ok: true, urls: paths, ...result }
  }
  return { calls, ping }
}
const ledgerOf = (db: Db) => JSON.parse(String(db.tables.app_settings.find((r) => r.key === INDEXNOW_LEDGER_KEY)?.value ?? '{}')) as Record<string, string>

async function main() {
  {
    const db = dbWith()
    const s = stub()
    const r = await runIndexNowCatchup(fakeAdmin(db), { now: NOW, ping: s.ping })
    const sent = s.calls[0] ?? []
    check('run: one batch call', s.calls.length === 1)
    check('run: sends the changed published posts, guides, page copy and trips', ['/blog/fresh-post', '/destinations/italy', '/best-time-to-visit/italy', '/packages/rome-trip'].every((p) => sent.includes(p)), JSON.stringify(sent))
    check('run: never sends a draft, a stale page or an unpublished trip', !sent.includes('/blog/draft-post') && !sent.includes('/blog/stale-post') && !sent.includes('/packages/hidden-trip'), JSON.stringify(sent))
    check('run: ok and the note says how many', r.ok && /sent 4 changed pages/.test(r.note), r.note)
    check('run: records each pinged path in the ledger', Object.keys(ledgerOf(db)).length === 4)
    const again = stub()
    const r2 = await runIndexNowCatchup(fakeAdmin(db), { now: NOW, ping: again.ping })
    check('run: a second run the same day sends nothing', again.calls.length === 0 && r2.ok, r2.note)
    const later = stub()
    db.tables.posts[0].updated_at = new Date(NOW.getTime() + 60_000).toISOString()
    await runIndexNowCatchup(fakeAdmin(db), { now: new Date(NOW.getTime() + 120_000), ping: later.ping })
    check('run: a page edited after its ping goes out again', JSON.stringify(later.calls[0]) === JSON.stringify(['/blog/fresh-post']), JSON.stringify(later.calls))
  }
  {
    const db = dbWith()
    const s = stub({ ok: false, status: 429, error: 'IndexNow HTTP 429' })
    const r = await runIndexNowCatchup(fakeAdmin(db), { now: NOW, ping: s.ping })
    check('rejected ping: not ok, says what happened in plain words', !r.ok && /did not take 4 pages/.test(r.note) && /429/.test(r.note), r.note)
    check('rejected ping: nothing is recorded as sent', Object.keys(ledgerOf(db)).length === 0)
  }
  {
    const db = dbWith({ app_settings: [{ key: INDEXNOW_LEDGER_KEY, value: '{broken' }] })
    const s = stub()
    const r = await runIndexNowCatchup(fakeAdmin(db), { now: NOW, ping: s.ping })
    check('fail closed: an unreadable ledger sends nothing', s.calls.length === 0 && !r.ok && /not readable/.test(r.note), r.note)
  }
  {
    const db = dbWith()
    ;(db.tables as Record<string, unknown>).posts = undefined as never
    delete (db.tables as Record<string, unknown>).posts
    const s = stub()
    const r = await runIndexNowCatchup(fakeAdmin(db), { now: NOW, ping: s.ping })
    check('a missing table is read as empty by the fake, still sends the others', s.calls.length === 1 && r.ok)
  }
  {
    const db = dbWith()
    for (let i = 0; i < 130; i++) db.tables.posts.push({ id: `x${i}`, slug: `bulk-${i}`, status: 'published', updated_at: hoursAgo(2) })
    const s = stub()
    const r = await runIndexNowCatchup(fakeAdmin(db), { now: NOW, ping: s.ping })
    check('run: a big day is capped at 100 URLs and says the rest wait', (s.calls[0]?.length ?? 0) === 100 && /more wait for tomorrow/.test(r.note), r.note)
  }
  // ---- once a day, and only when set up ----
  {
    const db = dbWith()
    const s = stub()
    const off = await runIndexNowCatchupIfDue(fakeAdmin(db), { now: NOW, ping: s.ping, configured: () => false })
    check('daily: silent when IndexNow is not set up', off === null && s.calls.length === 0)
    const first = await runIndexNowCatchupIfDue(fakeAdmin(db), { now: NOW, ping: s.ping, configured: () => true })
    const second = await runIndexNowCatchupIfDue(fakeAdmin(db), { now: NOW, ping: s.ping, configured: () => true })
    check('daily: the first pass of the day runs', !!first && first.ok && s.calls.length === 1)
    check('daily: a second pass the same day does nothing', second === null && s.calls.length === 1)
    check('daily: the result is stored for the admin', db.tables.app_settings.some((r) => r.key === 'indexnow_catchup_last'))
  }
  // ---- wiring ----
  check('pipeline runs the catch-up inside housekeeping (no new cron)', /runIndexNowCatchupIfDue\(admin\)/.test(src('lib/pipeline.ts')))
  check('no new cron was added', !/indexnow/i.test(src('vercel.json')))
  check('a failed catch-up has grade-5 steps in Needs attention', /system:step-indexnow/.test(src('lib/plain-steps.ts')))
  check('no em or en dashes in the new module', !LONG_DASH.test(src('lib/indexnow-catchup.ts')))

  console.log(failed === 0 ? '\nAll IndexNow catch-up checks passed.' : `\n${failed} check(s) FAILED.`)
  process.exit(failed === 0 ? 0 : 1)
}
void main()
