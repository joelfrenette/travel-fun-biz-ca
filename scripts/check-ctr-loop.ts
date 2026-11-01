// Offline checks for the title and meta click-rate loop and the cannibalisation detector (hub row 2). No network, no
// database, no model: the model is a stub and the database is scripts/fake-admin.ts. Run: pnpm dlx tsx scripts/check-ctr-loop.ts
import { readFileSync } from 'node:fs'
import {
  CTR_EVAL_AFTER_DAYS,
  CTR_PAGES_PER_DAY,
  CANNIBAL_KEY,
  CTR_TRIP_PROPOSALS_MAX,
  addTripProposal,
  ctrGate,
  tripGate,
  tripsModeOn,
  ctrRatio,
  decideExperiment,
  evalDayOf,
  expectedCtr,
  findCannibalisation,
  findUnderperformers,
  isResting,
  namedWordsIn,
  parseExperiment,
  parseJudge,
  parseProposal,
  readCannibalisation,
  runCtrLoop,
  type Experiment,
  type PageFacts,
} from '../lib/ctr-loop'
import type { HealBudget } from '../lib/heal-loop'
import { fakeAdmin, type Db } from './fake-admin'

process.env.ANTHROPIC_API_KEY = ''
process.env.INDEXNOW_KEY = ''
let failed = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`)
  if (!ok) failed++
}
const LONG_DASH = new RegExp('[' + String.fromCharCode(0x2013, 0x2014) + ']')
const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

// ---- the expected-click-rate table ----
check('expected ctr: position 1 is the highest, 10 is near 2.4 percent', expectedCtr(1) === 0.28 && Math.abs((expectedCtr(10) ?? 0) - 0.024) < 1e-9)
check('expected ctr: falls as position gets worse', [1, 2, 3, 5, 8, 12, 20].every((p, i, a) => i === 0 || (expectedCtr(p) ?? 0) < (expectedCtr(a[i - 1]) ?? 0)))
check('expected ctr: a fractional position is interpolated', Math.abs((expectedCtr(2.5) ?? 0) - 0.13) < 1e-9)
check('expected ctr: outside 1 to 20 is unknown (null)', expectedCtr(0.5) === null && expectedCtr(21) === null && expectedCtr(NaN) === null && expectedCtr(null) === null)
check('ctr ratio: 11 percent at position 3 is exactly as expected', Math.abs((ctrRatio(110, 1000, 3) ?? 0) - 1) < 1e-9)
check('ctr ratio: unknown inputs give null', ctrRatio(null, 1000, 3) === null && ctrRatio(5, 0, 3) === null && ctrRatio(5, 100, 40) === null)

// ---- (a) finding the weak pages ----
const perf = [
  { path: '/blog/weak-big', clicks: 20, impressions: 1000, position: 3 },
  { path: '/blog/weak-small', clicks: 3, impressions: 300, position: 4 },
  { path: '/blog/fine', clicks: 100, impressions: 1000, position: 3 },
  { path: '/blog/too-few-views', clicks: 0, impressions: 150, position: 3 },
  { path: '/blog/too-deep', clicks: 1, impressions: 5000, position: 40 },
  { path: '/blog/null-position', clicks: 1, impressions: 5000, position: null },
  { path: '/blog/null-clicks', clicks: null, impressions: 5000, position: 3 },
  { path: '/blog/weak-big', clicks: 20, impressions: 1000, position: 3 },
]
const weak = findUnderperformers(perf)
check('weak pages: only enough views, ranked within 15, and well under expected', JSON.stringify(weak.map((w) => w.path)) === JSON.stringify(['/blog/weak-big', '/blog/weak-small']), JSON.stringify(weak.map((w) => w.path)))
check('weak pages: biggest lost clicks first, one entry per page', weak[0].lostClicks > weak[1].lostClicks && weak.filter((w) => w.path === '/blog/weak-big').length === 1)
check('weak pages: a page at exactly half of expected is not "well below"', findUnderperformers([{ path: '/blog/half', clicks: 55, impressions: 1000, position: 3 }]).length === 0)

// ---- (b) the gate ----
const facts: PageFacts = {
  oldTitle: 'Rhine cruise',
  oldDescription: '',
  source: 'Plan a Rhine river cruise from Cologne to Basel. The trip passes the Rhine Gorge and stops in Strasbourg over 7 nights.',
  keyword: 'rhine river cruise',
}
const goodTitle = 'Rhine river cruise from Cologne to Basel, day by day'
const goodDesc = 'Learn how a Rhine river cruise from Cologne to Basel works, what you will see on the way, and how our advisors can help you plan it.'
check('gate: a plain, grounded proposal passes', ctrGate({ title: goodTitle, description: goodDesc }, facts).length === 0, ctrGate({ title: goodTitle, description: goodDesc }, facts).join('; '))
const gateCases: [string, string, string, RegExp][] = [
  ['title too short', 'Rhine cruise tips', goodDesc, /title is \d+ characters/],
  ['title too long', `${goodTitle} and then some more words to run over`, goodDesc, /title is \d+ characters/],
  ['description too short', goodTitle, 'A short description of the Rhine river cruise.', /description is \d+ characters/],
  ['description too long', goodTitle, `${goodDesc} ${goodDesc}`, /description is \d+ characters/],
  ['superlative', 'The award-winning Rhine river cruise from Cologne to Basel', goodDesc, /superlative/],
  ['luxury word', 'Luxury Rhine river cruise from Cologne to Basel', goodDesc, /superlative|name not on the page/],
  ['a price', goodTitle, `${goodDesc.slice(0, 100)} from $1,999 per person today with our advisors.`, /price/],
  ['a number not on the page', 'Rhine river cruise from Cologne to Basel, 12 days', goodDesc, /number not on the page: 12/],
  ['a year not on the page', 'Rhine river cruise from Cologne to Basel in 2027', goodDesc, /number not on the page/],
  ['a name not on the page', 'Rhine river cruise from Cologne to Basel via Lucerne', goodDesc, /name not on the page: Lucerne/],
  ['a web address', goodTitle, `${goodDesc.slice(0, 90)} See www.example.com for more of the Rhine river cruise.`, /web address/],
  ['an exclamation mark', 'Rhine river cruise from Cologne to Basel, day by day!', goodDesc, /exclamation/],
  ['urgency', goodTitle, 'Book now: a Rhine river cruise from Cologne to Basel with a last chance to see the Rhine Gorge and Strasbourg.', /urgency/],
  ['first person in the title', 'Our Rhine river cruise from Cologne to Basel today', goodDesc, /first person|name not on the page/],
  ['an experience claim', goodTitle, 'When we visited Strasbourg on a Rhine river cruise from Cologne to Basel we loved every moment of it for sure.', /experience claim/],
  ['a long dash', `Rhine river cruise ${String.fromCharCode(0x2014)} Cologne to Basel, day by day`, goodDesc, /long dash/],
  ['same title and description', goodDesc.slice(0, 60), goodDesc.slice(0, 60), /same|description is/],
  ['nothing changed', 'Rhine cruise', '', /empty|nothing changed/],
]
check('gate refuses: lost the target phrase the old title had', ctrGate({ title: 'Cologne to Basel by river, day by day', description: goodDesc }, { ...facts, oldTitle: 'Rhine river cruise guide' }).some((x) => /dropped the target phrase/.test(x)))
for (const [name, title, description, re] of gateCases) {
  const r = ctrGate({ title, description }, facts)
  check(`gate refuses: ${name}`, r.some((x) => re.test(x)), JSON.stringify(r))
}
check('gate: a "how our advisors can help you plan" offer is allowed in the description', !ctrGate({ title: goodTitle, description: goodDesc }, facts).some((x) => /experience|first person/.test(x)))
check('named words: the first word and a new clause are skipped', JSON.stringify(namedWordsIn('Rhine river cruise from Cologne to Basel: Day by day')) === JSON.stringify(['Cologne', 'Basel']), JSON.stringify(namedWordsIn('Rhine river cruise from Cologne to Basel: Day by day')))
check('parseProposal: reads JSON and strips wrapping quotes', parseProposal('{"meta_title":"\\"Hello there\\"","meta_description":"Desc"}')?.title === 'Hello there')
check('parseProposal: not JSON, or missing a field, is null', parseProposal('sure thing') === null && parseProposal('{"meta_title":"x"}') === null && parseProposal(null) === null)
check('parseJudge: a clean pass is a pass', parseJudge('{"pass":true,"failures":[]}').pass)
check('parseJudge: pass with a failure listed is a fail', !parseJudge('{"pass":true,"failures":[{"quote":"x","reason":"y"}]}').pass)
check('parseJudge: garbage is not a pass and is flagged unanswered', !parseJudge('maybe').pass && !parseJudge('maybe').answered && !parseJudge(null).pass)

// ---- the run (stubbed model, fake database) ----
const NOW = new Date('2026-10-17T15:00:00.000Z')
const goodAnswer = JSON.stringify({ meta_title: goodTitle, meta_description: goodDesc })
const postBody = 'Plan a Rhine river cruise from Cologne to Basel. The trip passes the Rhine Gorge and stops in Strasbourg over 7 nights.'
function post(n: number, extra: Record<string, unknown> = {}) {
  return { id: `post-${n}`, slug: `rhine-${n}`, status: 'published', title: `Rhine cruise ${n}`, body: postBody, meta_title: 'Rhine cruise', meta_description: '', primary_keyword: null, ...extra }
}
function baseDb(posts = 1, perfRows?: Record<string, unknown>[]): Db {
  return {
    tables: {
      app_settings: [],
      content_edits: [],
      posts: Array.from({ length: posts }, (_, i) => post(i + 1)),
      guides: [],
      page_copy: [],
      content_performance: perfRows ?? Array.from({ length: posts }, (_, i) => ({ day: '2026-10-16', path: `/blog/rhine-${i + 1}`, clicks: 20, impressions: 1000 - i * 10, position: 3 })),
    },
  }
}
function stubModel(opts: { suggest?: string | null; judge?: string | null } = {}) {
  const prompts: string[] = []
  const model = async (prompt: string) => {
    prompts.push(prompt)
    if (/independent quality reviewer/.test(prompt)) return opts.judge === undefined ? '{"pass":true,"failures":[]}' : opts.judge
    return opts.suggest === undefined ? goodAnswer : opts.suggest
  }
  return { prompts, model }
}
const slotsOf = (db: Db) => db.tables.app_settings.filter((r) => String(r.key).startsWith('ctr_loop_slot:')).length
const heal = (db: Db) => db.tables.app_settings.filter((r) => String(r.key).startsWith('heal_loop_call:')).length
const expsOf = (db: Db) => db.tables.app_settings.filter((r) => String(r.key).startsWith('ctr_exp:')).map((r) => JSON.parse(String(r.value)) as Experiment)

async function main() {
  {
    const db = baseDb()
    const s = stubModel()
    const r = await runCtrLoop(fakeAdmin(db), { now: NOW, model: s.model, getPairs: async () => [] })
    check('start: one test started, two model calls (suggester then judge)', r.started === 1 && r.calls === 2 && s.prompts.length === 2, JSON.stringify(r))
    check('start: the live page now has the new title and description', db.tables.posts[0].meta_title === goodTitle && db.tables.posts[0].meta_description === goodDesc)
    check('start: logged in content_edits with before and after (so Undo works)', db.tables.content_edits.length === 2 && db.tables.content_edits.some((e) => e.field === 'meta_title' && e.before === 'Rhine cruise' && e.after === goodTitle && e.method === 'generate' && e.published_after === false))
    const exp = expsOf(db)[0]
    check('start: the experiment records page, old, new and the baseline', !!exp && exp.path === '/blog/rhine-1' && exp.oldTitle === 'Rhine cruise' && exp.newTitle === goodTitle && Math.abs(exp.baselineCtr - 0.02) < 1e-9 && exp.baselinePosition === 3 && exp.baselineImpressions === 1000 && exp.status === 'running' && exp.editIds.length === 2)
    check('start: the calls were taken from the heal budget', heal(db) === 2)
    check('start: the suggester is told the facts come only from the page and given the numbers', /THE PAGE \(the ONLY source for any fact\)/.test(s.prompts[0]) && /2\.0 percent/.test(s.prompts[0]))
    check('start: the page is reported as changed (so the heal pings IndexNow)', JSON.stringify(r.changedPaths) === JSON.stringify(['/blog/rhine-1']))
    check('start: a note for the heal summary', /started 1 title test/.test(r.note) && r.active)
    const again = await runCtrLoop(fakeAdmin(db), { now: NOW, model: stubModel().model, getPairs: async () => [] })
    check('start: the same page is not tested twice while its test runs', again.started === 0)
  }
  {
    const db = baseDb(4)
    const s = stubModel()
    const r = await runCtrLoop(fakeAdmin(db), { now: NOW, model: s.model, getPairs: async () => [] })
    check(`cap: at most ${CTR_PAGES_PER_DAY} pages a day`, r.started === CTR_PAGES_PER_DAY && slotsOf(db) === CTR_PAGES_PER_DAY && r.calls === CTR_PAGES_PER_DAY * 2, JSON.stringify({ s: r.started, slots: slotsOf(db), calls: r.calls }))
    const later = await runCtrLoop(fakeAdmin(db), { now: new Date(NOW.getTime() + 3_600_000), model: s.model, getPairs: async () => [] })
    check('cap: pressing Heal now again the same day starts nothing more', later.started === 0)
  }
  {
    const db = baseDb()
    const s = stubModel({ suggest: JSON.stringify({ meta_title: 'The award-winning Rhine river cruise from Cologne to Basel', meta_description: goodDesc }) })
    const r = await runCtrLoop(fakeAdmin(db), { now: NOW, model: s.model, getPairs: async () => [] })
    check('gate: a proposal that fails the checks is never judged or applied', r.started === 0 && s.prompts.length === 1 && db.tables.content_edits.length === 0 && db.tables.posts[0].meta_title === 'Rhine cruise' && /turned down by the checks/.test(r.note), r.note)
    const retry = await runCtrLoop(fakeAdmin(db), { now: new Date(NOW.getTime() + 86_400_000), model: stubModel().model, getPairs: async () => [] })
    check('gate: a turned-down page rests for two weeks', retry.started === 0)
    const much = await runCtrLoop(fakeAdmin(db), { now: new Date(NOW.getTime() + 15 * 86_400_000), model: stubModel().model, getPairs: async () => [] })
    check('gate: ... and can be tried again after that', much.started === 0 || much.started === 1)
  }
  {
    const db = baseDb()
    const s = stubModel({ judge: '{"pass":false,"failures":[{"quote":"Learn how","rule":4,"reason":"makes a claim"}]}' })
    const r = await runCtrLoop(fakeAdmin(db), { now: NOW, model: s.model, getPairs: async () => [] })
    check('judge: a failed QA review stops the change, nothing is written', r.started === 0 && db.tables.content_edits.length === 0 && db.tables.posts[0].meta_title === 'Rhine cruise' && /QA review/.test(r.note), r.note)
    const un = await runCtrLoop(fakeAdmin(baseDb()), { now: NOW, model: stubModel({ judge: 'not json' }).model, getPairs: async () => [] })
    check('judge: an unreadable answer is not a pass', un.started === 0)
  }
  {
    const db = baseDb()
    db.tables.app_settings.push({ key: 'heal_loop_calls_per_day', value: '1' })
    const s = stubModel()
    const r = await runCtrLoop(fakeAdmin(db), { now: NOW, model: s.model, getPairs: async () => [] })
    check('budget: a heal limit of 1 leaves too little for a test (needs 2 calls), nothing is spent', r.started === 0 && r.calls === 0 && s.prompts.length === 0 && /heal limit/.test(r.note), r.note)
    const off = baseDb()
    off.tables.app_settings.push({ key: 'heal_loop_calls_per_day', value: '0' })
    const r0 = await runCtrLoop(fakeAdmin(off), { now: NOW, model: stubModel().model, getPairs: async () => [] })
    check('budget: a heal limit of 0 (loop off) starts nothing', r0.started === 0 && r0.calls === 0)
    const closed: HealBudget = { cap: 0, used: 0, readable: false, reason: 'unreadable', remaining: () => 0, take: async () => false }
    const rc = await runCtrLoop(fakeAdmin(baseDb()), { now: NOW, model: stubModel().model, getPairs: async () => [], budget: closed })
    check('budget: an unreadable counter fails closed (no call)', rc.started === 0 && rc.calls === 0)
    const exact = baseDb(3)
    exact.tables.app_settings.push({ key: 'heal_loop_calls_per_day', value: '3' })
    const s3 = stubModel()
    const r3 = await runCtrLoop(fakeAdmin(exact), { now: NOW, model: s3.model, getPairs: async () => [] })
    check('budget: never more calls than the limit, whatever the pages', heal(exact) <= 3 && r3.calls <= 3 && s3.prompts.length <= 3, `${heal(exact)}/${r3.calls}`)
  }
  {
    const late = await runCtrLoop(fakeAdmin(baseDb()), { now: NOW, model: stubModel().model, getPairs: async () => [], deadlineMs: Date.now() + 1000 })
    check('time: with less than a model call of time left, no call is made', late.calls === 0 && late.started === 0)
    const noKey = await runCtrLoop(fakeAdmin(baseDb()), { now: NOW, getPairs: async () => [] })
    check('no AI key and no stub: nothing starts and nothing fails', noKey.started === 0 && noKey.problems.length === 0)
    const stale = baseDb(1, [{ day: '2026-10-01', path: '/blog/rhine-1', clicks: 1, impressions: 1000, position: 3 }])
    const rs = await runCtrLoop(fakeAdmin(stale), { now: NOW, model: stubModel().model, getPairs: async () => [] })
    check('stale numbers: a snapshot older than 4 days is not used', rs.started === 0 && rs.calls === 0)
    const none = baseDb(1, [])
    const rn = await runCtrLoop(fakeAdmin(none), { now: NOW, model: stubModel().model, getPairs: async () => [] })
    check('no numbers yet: quiet, no problem', rn.started === 0 && rn.problems.length === 0)
    const trip = baseDb(1, [{ day: '2026-10-16', path: '/packages/rome-trip', clicks: 1, impressions: 1000, position: 3 }])
    const rt = await runCtrLoop(fakeAdmin(trip), { now: NOW, model: stubModel().model, getPairs: async () => [] })
    check('trip pages and unknown paths are never edited by this loop', rt.started === 0 && rt.calls === 0)
    const unpublished = baseDb()
    unpublished.tables.posts[0].status = 'draft'
    const ru = await runCtrLoop(fakeAdmin(unpublished), { now: NOW, model: stubModel().model, getPairs: async () => [] })
    check('a draft is never edited', ru.started === 0 && ru.calls === 0)
    const noLog = baseDb()
    delete (noLog.tables as Record<string, unknown>).content_edits
    const failLog: Db = { ...noLog, failWrites: { content_edits: 'boom' } }
    const rl = await runCtrLoop(fakeAdmin(failLog), { now: NOW, model: stubModel().model, getPairs: async () => [] })
    check('log, then apply: when the change log cannot be written the page is not touched', rl.started === 0 && failLog.tables.posts[0].meta_title === 'Rhine cruise' && rl.problems.some((p) => /change log could not be written/.test(p)), JSON.stringify(rl.problems))
    const failPage: Db = baseDb()
    failPage.failWrites = { posts: 'locked' }
    const rp = await runCtrLoop(fakeAdmin(failPage), { now: NOW, model: stubModel().model, getPairs: async () => [] })
    check('log, then apply: a failed page update takes the log rows back out and reports it', rp.started === 0 && failPage.tables.content_edits.length === 0 && rp.problems.some((p) => /could not update/.test(p)), JSON.stringify(rp.problems))
  }

  // ---- after 30 days: compare, keep, or undo ----
  async function started(posts = 1) {
    const db = baseDb(posts)
    await runCtrLoop(fakeAdmin(db), { now: NOW, model: stubModel().model, getPairs: async () => [] })
    return db
  }
  const later = new Date(NOW.getTime() + 31 * 86_400_000)
  const dueDay = evalDayOf(NOW.toISOString())
  async function evaluate(db: Db, row: Record<string, unknown> | null) {
    db.tables.content_performance = row ? [{ day: dueDay, path: '/blog/rhine-1', ...row }] : [{ day: dueDay, path: '/blog/other', clicks: 5, impressions: 5, position: 2 }]
    return runCtrLoop(fakeAdmin(db), { now: later, model: stubModel().model, getPairs: async () => [] })
  }
  check(`evaluation day is ${CTR_EVAL_AFTER_DAYS} days after the start`, dueDay === '2026-11-16', dueDay)
  {
    const db = await started()
    const early = await runCtrLoop(fakeAdmin(db), { now: new Date(NOW.getTime() + 10 * 86_400_000), model: stubModel().model, getPairs: async () => [] })
    check('wait: a test that is only 10 days old is left running', expsOf(db)[0].status === 'running' && early.checked === 0)
  }
  {
    const db = await started()
    const r = await evaluate(db, { clicks: 10, impressions: 1000, position: 3 })
    const e = expsOf(db)[0]
    check('fell: the click rate dropped against its position, so the change is undone by itself', e.status === 'reverted' && r.reverted === 1, `${e.status} ${e.note}`)
    check('fell: the old title and description are back on the page', db.tables.posts[0].meta_title === 'Rhine cruise' && db.tables.posts[0].meta_description === '')
    check('fell: the edit rows are stamped reverted (the Content edits page shows them as undone)', db.tables.content_edits.every((x) => !!x.reverted_at))
    check('fell: the result is stored with the after numbers', Math.abs((e.afterCtr ?? 0) - 0.01) < 1e-9 && e.afterImpressions === 1000)
    const retry = await runCtrLoop(fakeAdmin(db), { now: new Date(later.getTime() + 86_400_000), model: stubModel().model, getPairs: async () => [] })
    check('fell: that page is not tested again for a long while', retry.started === 0)
  }
  {
    // A heal publish of the same page earlier on must survive a click-rate revert: the revert changes text, never the status.
    const db = await started()
    const type = String(db.tables.content_edits[0].content_type)
    db.tables.content_edits.push({ id: 'heal-publish-1', content_type: type, content_id: 'post-1', path: '/blog/rhine-1', field: 'status', before: 'draft', after: 'published', reason: 'heal', method: 'repair', published_after: true, reverted_at: null })
    check('revert keeps status: the click-rate edits are logged as not published by the edit', db.tables.content_edits.filter((x) => x.field !== 'status').every((x) => x.published_after === false))
    for (const x of db.tables.content_edits) if (x.field !== 'status') x.published_after = true // rows written before this fix
    const r = await evaluate(db, { clicks: 10, impressions: 1000, position: 3 })
    const heal = db.tables.content_edits.find((x) => x.id === 'heal-publish-1')!
    check('revert keeps status: a click-rate revert never puts a live page back to draft', r.reverted === 1 && db.tables.posts[0].status === 'published' && db.tables.posts[0].meta_title === 'Rhine cruise', String(db.tables.posts[0].status))
    check('revert keeps status: the earlier heal publish edit is not reverted', !heal.reverted_at)
  }
  {
    const db = await started()
    const r = await evaluate(db, { clicks: 40, impressions: 1000, position: 3 })
    check('rose: the change is kept', expsOf(db)[0].status === 'kept' && r.reverted === 0 && db.tables.posts[0].meta_title === goodTitle)
  }
  {
    const db = await started()
    await evaluate(db, { clicks: 1, impressions: 40, position: 3 })
    check('too little data: kept, and says so', expsOf(db)[0].status === 'inconclusive' && db.tables.posts[0].meta_title === goodTitle && /too few/.test(String(expsOf(db)[0].note)))
  }
  {
    const db2 = await started()
    await evaluate(db2, { clicks: 12, impressions: 1000, position: 6 })
    check('a page that slipped from position 3 to 6 has a lower raw click rate (2.0 to 1.2 percent) but a better one for its position: kept', expsOf(db2)[0].status === 'kept', expsOf(db2)[0].status)
    const db4 = await started()
    await evaluate(db4, { clicks: 19, impressions: 1000, position: 3 })
    check('a fall of only 5 percent (inside the 10 percent allowance) is not undone', expsOf(db4)[0].status === 'kept', expsOf(db4)[0].status)
    const db3 = await started()
    await evaluate(db3, { clicks: 1, impressions: 1000, position: 30 })
    check('a page that fell out of the first 20 results cannot be blamed on the title: kept', expsOf(db3)[0].status === 'inconclusive' && db3.tables.posts[0].meta_title === goodTitle)
  }
  {
    const db = await started()
    for (const e of db.tables.content_edits) e.reverted_at = NOW.toISOString()
    await evaluate(db, { clicks: 40, impressions: 1000, position: 3 })
    check('a person pressed Undo during the test: the test ends and the page is left as they set it', expsOf(db)[0].status === 'undone_by_person')
  }
  {
    const db = await started()
    db.tables.posts[0].meta_title = 'Edited by a person later'
    const r = await evaluate(db, { clicks: 10, impressions: 1000, position: 3 })
    check('page changed again after the test began: not undone without a person (no force), says so', expsOf(db)[0].status === 'revert_blocked' && db.tables.posts[0].meta_title === 'Edited by a person later' && r.problems.length === 0, expsOf(db)[0].status)
  }
  {
    const db = await started()
    const r = await evaluate(db, null)
    check('no numbers for the page yet: the test keeps waiting', expsOf(db)[0].status === 'running' && r.checked === 0)
    const ancient = new Date(NOW.getTime() + 70 * 86_400_000)
    db.tables.content_performance = []
    await runCtrLoop(fakeAdmin(db), { now: ancient, model: stubModel().model, getPairs: async () => [] })
    check('... and gives up after 60 days, keeping the change', expsOf(db)[0].status === 'inconclusive')
  }
  check('parseExperiment: rejects garbage', parseExperiment('nope') === null && parseExperiment('{"path":"/x"}') === null)
  check('decide: revert needs a clear fall (10 percent) against position', decideExperiment({ impressions: 1000, position: 3, ctr: 0.02 }, { clicks: 19, impressions: 1000, position: 3 }).decision === 'keep' && decideExperiment({ impressions: 1000, position: 3, ctr: 0.02 }, { clicks: 17, impressions: 1000, position: 3 }).decision === 'revert')
  check('resting: rejected 14 days, finished 90 days', isResting({ at: NOW.toISOString(), outcome: 'rejected' }, NOW.getTime() + 13 * 86_400_000) && !isResting({ at: NOW.toISOString(), outcome: 'rejected' }, NOW.getTime() + 15 * 86_400_000) && isResting({ at: NOW.toISOString(), outcome: 'finished' }, NOW.getTime() + 80 * 86_400_000))

  // ---- (c) cannibalisation ----
  const pairs = [
    { query: 'rhine river cruise', path: '/blog/rhine-a', clicks: 12, impressions: 300 },
    { query: 'rhine river cruise', path: '/packages/rhine-trip', clicks: 3, impressions: 200 },
    { query: 'rhine river cruise', path: '/blog', clicks: 0, impressions: 400 },
    { query: 'italy in spring', path: '/blog/italy-a', clicks: 1, impressions: 90 },
    { query: 'italy in spring', path: '/blog/italy-b', clicks: 4, impressions: 90 },
    { query: 'tiny phrase', path: '/blog/x', clicks: 0, impressions: 30 },
    { query: 'tiny phrase', path: '/blog/y', clicks: 0, impressions: 20 },
    { query: 'one page only', path: '/blog/solo', clicks: 5, impressions: 900 },
    { query: 'barely seen', path: '/blog/a1', clicks: 0, impressions: 4 },
    { query: 'barely seen', path: '/blog/a2', clicks: 0, impressions: 400 },
  ]
  const items = findCannibalisation(pairs)
  check('cannibalisation: phrases with two of our pages and enough views, busiest first', JSON.stringify(items.map((i) => i.query)) === JSON.stringify(['rhine river cruise', 'italy in spring']), JSON.stringify(items.map((i) => i.query)))
  check('cannibalisation: the stronger page is the one with the clicks', items[0].stronger === '/blog/rhine-a' && items[1].stronger === '/blog/italy-b')
  check('cannibalisation: index pages (/blog) and a page with almost no views are not competition', !items[0].pages.some((p) => p.path === '/blog') && items.every((i) => i.query !== 'barely seen' && i.query !== 'one page only' && i.query !== 'tiny phrase'))
  const many = Array.from({ length: 9 }, (_, i) => [{ query: `q${i}`, path: `/blog/a${i}`, clicks: 1, impressions: 100 + i }, { query: `q${i}`, path: `/blog/b${i}`, clicks: 0, impressions: 100 + i }]).flat()
  check('cannibalisation: only the top 5', findCannibalisation(many).length === 5)
  {
    const db = baseDb(1, [])
    const r = await runCtrLoop(fakeAdmin(db), { now: NOW, model: stubModel().model, getPairs: async () => pairs })
    const rec = await readCannibalisation(fakeAdmin(db))
    check('cannibalisation: stored for the Needs attention item', !!rec && rec.items.length === 2 && rec.at === NOW.toISOString() && db.tables.app_settings.some((x) => x.key === CANNIBAL_KEY))
    check('cannibalisation: mentioned in the heal note', /2 search phrases where two of our pages compete/.test(r.note), r.note)
    const none = baseDb(1, [])
    await runCtrLoop(fakeAdmin(none), { now: NOW, model: stubModel().model, getPairs: async () => [] })
    check('cannibalisation: when Search Console cannot be read the old list is left alone, nothing is overwritten', !none.tables.app_settings.some((x) => x.key === CANNIBAL_KEY))
  }

  // ---- trip pages: log-only proposals ----
  const tripRow = (extra: Record<string, unknown> = {}) => ({ id: 'trip-1', slug: 'rhine-trip', status: 'published', name: 'Rhine river cruise', destination: 'Germany', country: 'Germany', region: null, duration: '7 nights', available_from: '2027-05-03', available_to: '2027-05-10', short_description: postBody, full_description: null, highlights: ['Rhine Gorge'], price_display: '$4,321', price_value: 4321, meta_title: 'Rhine cruise', meta_description: '', keywords: [], ...extra })
  const tripDb = (mode?: string | null, n = 1): Db => {
    const db = baseDb(0, Array.from({ length: n }, (_, i) => ({ day: '2026-10-16', path: i === 0 ? '/packages/rhine-trip' : `/packages/rhine-trip-${i + 1}`, clicks: 20, impressions: 1000 - i * 10, position: 3 })))
    db.tables.travel_packages = Array.from({ length: n }, (_, i) => tripRow(i === 0 ? {} : { id: `trip-${i + 1}`, slug: `rhine-trip-${i + 1}` }))
    if (mode !== undefined && mode !== null) db.tables.app_settings.push({ key: 'ctr_loop_trips_mode', value: mode })
    return db
  }
  // A client that records every write call, so "never writes travel_packages" is proven rather than assumed.
  const recording = (db: Db) => {
    const writes: { table: string; op: string }[] = []
    const inner = fakeAdmin(db) as unknown as { from: (t: string) => Record<string, unknown>; rpc: unknown }
    const wrap = (table: string, q: Record<string, unknown>): Record<string, unknown> =>
      new Proxy(q, {
        get(target, prop) {
          const v = target[prop as string]
          if (typeof v !== 'function') return v
          return (...args: unknown[]) => {
            if (['insert', 'update', 'upsert', 'delete'].includes(String(prop))) writes.push({ table, op: String(prop) })
            const res = (v as (...a: unknown[]) => unknown).apply(target, args)
            return res === target ? wrap(table, target) : res
          }
        },
      })
    const client = { from: (t: string) => wrap(t, inner.from(t)), rpc: inner.rpc } as unknown as Parameters<typeof runCtrLoop>[0]
    return { client, writes }
  }
  const proposalsOf = (db: Db) => JSON.parse(String(db.tables.app_settings.find((r) => r.key === 'ctr_trip_proposals')?.value ?? '[]')) as { path: string; newTitle: string; newDescription: string; status: string }[]
  check('trip mode: only the exact text "log" enables it', tripsModeOn('log') && !tripsModeOn(null) && !tripsModeOn(undefined) && !tripsModeOn('') && !tripsModeOn('on') && !tripsModeOn('apply') && !tripsModeOn('LOG') && !tripsModeOn(' log') && !tripsModeOn('true'))
  for (const mode of [undefined, 'on', 'apply', 'off', 'LOG', '']) {
    const db = tripDb(mode as string | undefined)
    const s = stubModel()
    const rec = recording(db)
    const r = await runCtrLoop(rec.client, { now: NOW, model: s.model, getPairs: async () => [] })
    check(`trip mode off (${mode === undefined ? 'missing' : JSON.stringify(mode)}): no model call, no proposal, no trip write`, r.proposed === 0 && r.calls === 0 && s.prompts.length === 0 && proposalsOf(db).length === 0 && !rec.writes.some((x) => x.table === 'travel_packages') && slotsOf(db) === 0, JSON.stringify({ r: r.proposed, calls: r.calls, writes: rec.writes }))
  }
  {
    const db = tripDb('log')
    const s = stubModel()
    const rec = recording(db)
    const r = await runCtrLoop(rec.client, { now: NOW, model: s.model, getPairs: async () => [] })
    const list = proposalsOf(db)
    check('trip log mode: a proposal is stored for review after the suggester and the judge', r.proposed === 1 && r.calls === 2 && list.length === 1 && list[0].path === '/packages/rhine-trip' && list[0].newTitle === goodTitle && list[0].newDescription === goodDesc && list[0].status === 'proposed', JSON.stringify({ r, list }))
    check('trip log mode: travel_packages is NEVER written (recording client)', !rec.writes.some((x) => x.table === 'travel_packages') && db.tables.travel_packages[0].meta_title === 'Rhine cruise' && db.tables.travel_packages[0].meta_description === '', JSON.stringify(rec.writes))
    check('trip log mode: no content_edits row and no experiment (nothing is applied)', db.tables.content_edits.length === 0 && expsOf(db).length === 0 && r.started === 0 && r.changedPaths.length === 0)
    check('trip log mode: the only writes are app_settings rows', rec.writes.length > 0 && rec.writes.every((x) => x.table === 'app_settings'), JSON.stringify(rec.writes))
    check('trip log mode: the note says nothing changed on the trip pages', /logged 1 trip title proposal/.test(r.note) && r.active, r.note)
    const again = await runCtrLoop(fakeAdmin(db), { now: new Date(NOW.getTime() + 86_400_000), model: stubModel().model, getPairs: async () => [] })
    check('trip log mode: the same trip is not proposed again the next day', again.proposed === 0 && proposalsOf(db).length === 1)
  }
  {
    const db = tripDb('log')
    const rec = recording(db)
    await runCtrLoop(rec.client, { now: NOW, model: stubModel({ suggest: JSON.stringify({ meta_title: 'Rhine river cruise from Cologne to Basel, 12 days', meta_description: goodDesc }) }).model, getPairs: async () => [] })
    check('trip proposal with a number that is not in the trip text is rejected and never stored', proposalsOf(db).length === 0 && !rec.writes.some((x) => x.table === 'travel_packages'))
    const price = tripDb('log')
    await runCtrLoop(fakeAdmin(price), { now: NOW, model: stubModel({ suggest: JSON.stringify({ meta_title: goodTitle, meta_description: 'A Rhine river cruise from Cologne to Basel for 4321 dollars, with our advisors to help you plan the trip.' }) }).model, getPairs: async () => [] })
    check('trip proposal: the price number is not treated as "on the page" (price fields are not a source)', proposalsOf(price).length === 0)
    const sign = tripDb('log')
    await runCtrLoop(fakeAdmin(sign), { now: NOW, model: stubModel({ suggest: JSON.stringify({ meta_title: goodTitle, meta_description: `${goodDesc.slice(0, 100)} from $4,321 per person.` }) }).model, getPairs: async () => [] })
    check('trip proposal: a price sign or price wording is rejected', proposalsOf(sign).length === 0)
    const month = tripDb('log')
    await runCtrLoop(fakeAdmin(month), { now: NOW, model: stubModel({ suggest: JSON.stringify({ meta_title: goodTitle, meta_description: 'See the Rhine river cruise from Cologne to Basel departing in October, and let our advisors help you plan it.' }) }).model, getPairs: async () => [] })
    check('trip proposal: a month that is not in the trip text is rejected', proposalsOf(month).length === 0)
    const okMonth = tripDb('log')
    await runCtrLoop(fakeAdmin(okMonth), { now: NOW, model: stubModel({ suggest: JSON.stringify({ meta_title: goodTitle, meta_description: 'See the Rhine river cruise from Cologne to Basel over 7 nights, and let our advisors help you plan the trip with you.' }) }).model, getPairs: async () => [] })
    check('trip proposal: a number that IS in the trip text (7 nights) is allowed', proposalsOf(okMonth).length === 1, JSON.stringify(proposalsOf(okMonth)))
    check('tripGate: month names must already be in the trip text', tripGate({ title: goodTitle, description: goodDesc }, facts).length === 0 && tripGate({ title: goodTitle, description: `${goodDesc.slice(0, 120)} in March.` }, facts).some((x) => /date not on the page/.test(x)))
    const qa = tripDb('log')
    await runCtrLoop(fakeAdmin(qa), { now: NOW, model: stubModel({ judge: '{"pass":false,"failures":[{"quote":"x","rule":1,"reason":"claim"}]}' }).model, getPairs: async () => [] })
    check('trip proposal: a failed QA review is never stored', proposalsOf(qa).length === 0)
  }
  {
    const past = tripDb('log')
    past.tables.travel_packages[0].available_to = '2026-01-01'
    const sp = stubModel()
    await runCtrLoop(fakeAdmin(past), { now: NOW, model: sp.model, getPairs: async () => [] })
    check('a past trip (frozen recap text) is skipped', sp.prompts.length === 0 && proposalsOf(past).length === 0)
    const draft = tripDb('log')
    draft.tables.travel_packages[0].status = 'draft'
    const sd = stubModel()
    await runCtrLoop(fakeAdmin(draft), { now: NOW, model: sd.model, getPairs: async () => [] })
    check('an unpublished trip is skipped', sd.prompts.length === 0 && proposalsOf(draft).length === 0)
  }
  {
    // The list is newest first and capped: 32 existing entries plus a new one stay at 30.
    const db = tripDb('log')
    const old = Array.from({ length: 35 }, (_, i) => ({ id: `old-${i}`, at: '2026-09-01T00:00:00.000Z', path: `/packages/old-${i}`, slug: `old-${i}`, tripId: `t${i}`, oldTitle: 'a', oldDescription: '', newTitle: `old title ${i}`, newDescription: 'd', position: 3, impressions: 500, clicks: 1, ctr: 0.002, expected: 0.11, status: 'proposed' }))
    db.tables.app_settings.push({ key: 'ctr_trip_proposals', value: JSON.stringify(old) })
    await runCtrLoop(fakeAdmin(db), { now: NOW, model: stubModel().model, getPairs: async () => [] })
    const list = proposalsOf(db)
    check(`trip proposals: capped at ${CTR_TRIP_PROPOSALS_MAX}, newest first`, list.length === CTR_TRIP_PROPOSALS_MAX && list[0].path === '/packages/rhine-trip' && list[1].path === '/packages/old-0', JSON.stringify(list.map((x) => x.path).slice(0, 3)) + list.length)
    const rec = { id: 'x', at: 'x', path: 'p', slug: 's', tripId: 't', oldTitle: '', oldDescription: '', newTitle: 'n', newDescription: 'n', position: 1, impressions: 1, clicks: 0, ctr: 0, expected: 0, status: 'proposed' as const }
    check('addTripProposal: puts the newest first and drops the oldest past the cap', addTripProposal(Array.from({ length: CTR_TRIP_PROPOSALS_MAX }, () => ({ ...rec, id: 'o' })), rec)[0].id === 'x' && addTripProposal(Array.from({ length: CTR_TRIP_PROPOSALS_MAX }, () => ({ ...rec, id: 'o' })), rec).length === CTR_TRIP_PROPOSALS_MAX)
  }
  {
    // Two weak trips: the daily slot cap still applies, and a post still takes the normal (applied) path beside them.
    const db = tripDb('log', 3)
    const rec = recording(db)
    const r = await runCtrLoop(rec.client, { now: NOW, model: stubModel().model, getPairs: async () => [] })
    check(`trip log mode: still at most ${CTR_PAGES_PER_DAY} pages a day`, r.proposed === CTR_PAGES_PER_DAY && slotsOf(db) === CTR_PAGES_PER_DAY && !rec.writes.some((x) => x.table === 'travel_packages'), JSON.stringify({ p: r.proposed, slots: slotsOf(db) }))
    const posts = baseDb(1)
    posts.tables.app_settings.push({ key: 'ctr_loop_trips_mode', value: 'log' })
    const rp = await runCtrLoop(fakeAdmin(posts), { now: NOW, model: stubModel().model, getPairs: async () => [] })
    check('trip log mode does not change how posts are handled', rp.started === 1 && rp.proposed === 0 && posts.tables.posts[0].meta_title === goodTitle)
  }
  {
    const route = src('app/api/admin/ctr-trip-proposals/route.ts')
    check('admin read endpoint checks isAuthorized first and only reads', /export async function GET[\s\S]{0,120}isAuthorized\(request\)/.test(route) && !/export async function (POST|PUT|PATCH|DELETE)/.test(route) && !/setSetting|\.insert\(|\.update\(|\.upsert\(|\.delete\(/.test(route))
    const loop = src('lib/ctr-loop.ts')
    check('the loop source never updates travel_packages and has no apply path for trips', !/from\('travel_packages'\)\s*\.update/.test(loop) && !/from\(['"]travel_packages['"]\)[\s\S]{0,40}\.(update|insert|upsert|delete)\(/.test(loop))
    check('the switch is documented in .env.example', /ctr_loop_trips_mode/.test(src('.env.example')))
    check('no em or en dashes in the route', !LONG_DASH.test(route))
  }

  // ---- wiring ----
  const healSrc = src('lib/content-heal-run.ts')
  const issues = src('lib/issues.ts')
  const steps = src('lib/plain-steps.ts')
  const pipeline = src('lib/pipeline.ts')
  check('wired inside the existing daily heal-content step (no new cron)', /runCtrLoop\(admin, \{ deadlineMs: opts\.deadlineMs \}\)/.test(healSrc) && !/ctr/i.test(src('vercel.json')))
  check('its calls and problems flow into the heal totals', /calls \+= ctr\.calls/.test(healSrc) && /problems\.push\(\.\.\.ctr\.problems\)/.test(healSrc) && /changedPaths\.push\(\.\.\.ctr\.changedPaths\)/.test(healSrc))
  check('uses the heal budget and the heal loop judge, not its own', /openBudget/.test(src('lib/ctr-loop.ts')) && /judgePrompt/.test(src('lib/ctr-loop.ts')) && /export function judgePrompt/.test(src('lib/heal-loop.ts')))
  check('applies through content_edits (log, then apply) so Undo works', /insertEdits\(admin, edits\)/.test(src('lib/ctr-loop.ts')) && /revertEdit/.test(src('lib/ctr-loop.ts')))
  check('one informational Needs attention item, left out of the alert email', /CANNIBALISATION_ISSUE_ID/.test(issues) && /i\.id !== CANNIBALISATION_ISSUE_ID/.test(pipeline) && /For your information/.test(issues))
  check('its steps are in plain words', /CANNIBALISATION_ISSUE_ID\) \{/.test(steps) && /click-rate test/.test(steps))
  check('the expected click rate table is documented as an approximation', /APPROXIMATION/.test(src('lib/ctr-loop.ts')))
  check('reads content_performance for ONE day only (rolling totals are never added)', /\.eq\('day', day\)/.test(src('lib/ctr-loop.ts')) && !/\.reduce\([^)]*clicks/.test(src('lib/ctr-loop.ts')))
  check('no em or en dashes in the new files', !LONG_DASH.test(src('lib/ctr-loop.ts')) && !LONG_DASH.test(src('scripts/check-ctr-loop.ts')))

  console.log(failed === 0 ? '\nAll click-rate loop checks passed.' : `\n${failed} check(s) FAILED.`)
  process.exit(failed === 0 ? 0 : 1)
}
void main()
