// Offline checks for the near page 1 refresh loop (lib/refresh-loop.ts). No network, no database, no model: the model is a stub and the
// database is scripts/fake-admin.ts. Run: npx --yes tsx --tsconfig tsconfig.json scripts/check-refresh-loop.ts
import { readFileSync } from 'node:fs'
import { revertEdit } from '../lib/content-edits'
import type { RepairLimits } from '../lib/content-repair'
import {
  REFRESH_COOLDOWN_DAYS,
  REFRESH_EVAL_AFTER_DAYS,
  REFRESH_IMPRESSION_FLOOR,
  REFRESH_MAX_LINKS,
  REFRESH_MAX_POSITION,
  REFRESH_MIN_POSITION,
  REFRESH_MODE_KEY,
  REFRESH_PAGES_PER_DAY,
  REFRESH_REVERT_POSITION_DROP,
  addRefreshLinks,
  chooseLinkTargets,
  decideRefresh,
  findNearPageOne,
  isRefreshResting,
  isRefreshablePath,
  missingExtraKeys,
  parseRefreshExperiment,
  parseRefreshMode,
  refreshEvalDayOf,
  runRefreshLoop,
  type RefreshExperiment,
  type RefreshIndex,
  type RefreshTarget,
} from '../lib/refresh-loop'
import { LIVE_ADDITIONS_KEY } from '../lib/live-additions-review'
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
const DAY = 86_400_000

// ---- the constants and the switch ----
check('thresholds are the documented ones', REFRESH_MIN_POSITION === 8 && REFRESH_MAX_POSITION === 20 && REFRESH_PAGES_PER_DAY === 2 && REFRESH_MAX_LINKS === 2 && REFRESH_COOLDOWN_DAYS === 30 && REFRESH_EVAL_AFTER_DAYS === 30 && REFRESH_REVERT_POSITION_DROP === 3 && REFRESH_IMPRESSION_FLOOR === 100)
check('mode: unset, empty, garbage and "enabled" are all OFF', ['', '  ', 'enabled', 'true', '1', 'yes', 'off', 'onn'].every((v) => parseRefreshMode(v) === 'off') && parseRefreshMode(null) === 'off' && parseRefreshMode(undefined) === 'off')
check('mode: only "on" (any case, spaces ignored) is on', parseRefreshMode('on') === 'on' && parseRefreshMode(' ON ') === 'on')

// ---- (a) finding the pages ----
const perf = [
  { path: '/blog/p7', clicks: 9, impressions: 900, position: 7.9 },
  { path: '/blog/p8', clicks: 5, impressions: 300, position: 8 },
  { path: '/blog/p20', clicks: 1, impressions: 800, position: 20 },
  { path: '/blog/p20-1', clicks: 1, impressions: 900, position: 20.1 },
  { path: '/blog/few', clicks: 0, impressions: REFRESH_IMPRESSION_FLOOR - 1, position: 12 },
  { path: '/blog/exactly-floor', clicks: 0, impressions: REFRESH_IMPRESSION_FLOOR, position: 12 },
  { path: '/blog/null-pos', clicks: 1, impressions: 5000, position: null },
  { path: '/blog/null-clicks', clicks: null, impressions: 5000, position: 12 },
  { path: '/blog/p8', clicks: 5, impressions: 300, position: 8 },
]
const near = findNearPageOne(perf)
check('selection: position 8 to 20 inclusive with 100+ impressions', JSON.stringify(near.map((n) => n.path)) === JSON.stringify(['/blog/p20', '/blog/p8', '/blog/exactly-floor']), JSON.stringify(near.map((n) => n.path)))
check('selection: page 1 (7.9), too deep (20.1), too few views and unrecorded numbers are out; one entry per path', !near.some((n) => ['/blog/p7', '/blog/p20-1', '/blog/few', '/blog/null-pos', '/blog/null-clicks'].includes(n.path)) && near.filter((n) => n.path === '/blog/p8').length === 1)
check('selection: most impressions first (the most to gain)', near[0].impressions >= near[1].impressions && near[1].impressions >= near[2].impressions)

check('paths: posts and guides are refreshable', isRefreshablePath('/blog/rome-guide') && isRefreshablePath('/hotels/hotel-x') && isRefreshablePath('/destinations/rome'))
check('paths: news posts, trips, index pages, the home page and deep paths are not', !isRefreshablePath('/blog/news-eu-rules') && !isRefreshablePath('/packages/rome-trip') && !isRefreshablePath('/blog') && !isRefreshablePath('/') && !isRefreshablePath('/hotels') && !isRefreshablePath('/hotels/a/b') && !isRefreshablePath('/admin/blog'))

// ---- the links (pure) ----
const targets: RefreshTarget[] = [
  { path: '/destinations/rome', title: 'Rome', dest: 'rome', rank: 0 },
  { path: '/best-time-to-visit/rome', title: 'the best time to visit Rome', dest: 'rome', rank: 2 },
  { path: '/packages/rome-trip', title: 'Rome Highlights', dest: 'rome', rank: 3 },
  { path: '/destinations/paris', title: 'Paris', dest: 'paris', rank: 0 },
  { path: '/packages/ghost', title: 'Ghost Tour', dest: 'rome', rank: 1 },
]
const existing = new Set(['/', '/blog', '/blog/rome-1', '/destinations/rome', '/best-time-to-visit/rome', '/packages/rome-trip', '/destinations/paris', '/hotels/hotel-x'])
const plainBody = 'Rome is a city of fountains and old streets.\n\nVisitors walk through the Colosseum and the Forum with a guide.\n\nLocal food includes pasta and gelato in small family cafes.'
{
  const chosen = chooseLinkTargets({ selfPath: '/blog/rome-1', text: plainBody, destSlugs: ['rome'], existing, targets })
  check('links: only real pages (a target missing from the site is never chosen)', chosen.every((t) => existing.has(t.path)) && !chosen.some((t) => t.path === '/packages/ghost'), JSON.stringify(chosen.map((t) => t.path)))
  check('links: only the same destination, never more than 2, best rank first', chosen.length === 2 && chosen[0].path === '/destinations/rome' && chosen[1].path === '/best-time-to-visit/rome' && !chosen.some((t) => t.path === '/destinations/paris'))
  const already = chooseLinkTargets({ selfPath: '/blog/rome-1', text: `${plainBody}\n\nSee [Rome](/destinations/rome).`, destSlugs: ['rome'], existing, targets })
  check('links: a page it already links to is not chosen again', !already.some((t) => t.path === '/destinations/rome') && already.length === 2)
  const self = chooseLinkTargets({ selfPath: '/destinations/rome', text: plainBody, destSlugs: ['rome'], existing, targets })
  check('links: a page never links to itself', !self.some((t) => t.path === '/destinations/rome'))
  check('links: no destination match means no link (nothing invented)', chooseLinkTargets({ selfPath: '/blog/x', text: plainBody, destSlugs: ['lisbon'], existing, targets }).length === 0 && chooseLinkTargets({ selfPath: '/blog/x', text: plainBody, destSlugs: [], existing, targets }).length === 0)
  const made = addRefreshLinks(plainBody, chosen)
  check('links: added inside a sentence the page already has, or as one Related reading line', made.added.length === 2 && /\[Rome\]\(\/destinations\/rome\)/.test(made.text) && /Related reading:.*\/best-time-to-visit\/rome/.test(made.text), made.text)
  check('links: the words of the page are untouched apart from the link syntax', made.text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').startsWith(plainBody))
}
check('extras: only an EMPTY faq or takeaways list is filled', JSON.stringify(missingExtraKeys({ faq: [], key_takeaways: [] })) === JSON.stringify(['faq', 'key_takeaways']) && missingExtraKeys({ faq: [{ q: 'a', a: 'b' }], key_takeaways: ['x'] }).length === 0 && JSON.stringify(missingExtraKeys({ faq: [{ q: 'a', a: 'b' }], key_takeaways: [] })) === JSON.stringify(['key_takeaways']))

// ---- the run (stubbed model, fake database) ----
const NOW = new Date('2026-10-17T15:00:00.000Z')
const limits: RepairLimits = { faqMin: 3, faqMax: 5, takeMin: 3, takeMax: 5, metaTitleMax: 60, metaDescMax: 155, ogTitleMax: 60, ogDescMax: 110 }
const faqFilled = [{ q: 'What is Rome?', a: 'Rome is a city of fountains and old streets.' }]
function post(n: number, extra: Record<string, unknown> = {}) {
  return { id: `post-${n}`, slug: `rome-${n}`, status: 'published', title: `Rome notes ${n}`, body: plainBody, meta_title: 'Rome notes', meta_description: '', faq: faqFilled, key_takeaways: ['Rome has fountains'], updated_at: '2026-09-01T10:00:00.000Z', ...extra }
}
function makeIndex(): RefreshIndex {
  return {
    existing: new Set([...existing, ...Array.from({ length: 6 }, (_, i) => `/blog/rome-${i + 1}`)]),
    targets,
    itemFor: (type, row) => {
      const g = type === 'guide'
      return {
        type,
        path: g ? `/hotels/${row.slug}` : `/blog/${row.slug}`,
        label: String(row.title ?? row.name),
        fields: { title: g ? undefined : String(row.title), summary: g ? String(row.summary) : undefined, body: String(row.body), meta_title: '', meta_description: '', og_title: '', og_description: '', faq: (row.faq as { q: string; a: string }[]) ?? [], key_takeaways: (row.key_takeaways as string[]) ?? [] },
        keyword: null,
        limits,
        destSlugs: ['rome'],
        names: [String(row.title ?? row.name)],
      }
    },
  }
}
function baseDb(posts = 1, perfRows?: Record<string, unknown>[], mode: string | null = 'on'): Db {
  return {
    tables: {
      app_settings: mode === null ? [] : [{ key: REFRESH_MODE_KEY, value: mode }],
      content_edits: [],
      posts: Array.from({ length: posts }, (_, i) => post(i + 1)),
      guides: [],
      page_copy: [],
      content_performance: perfRows ?? Array.from({ length: posts }, (_, i) => ({ day: '2026-10-16', path: `/blog/rome-${i + 1}`, clicks: 8, impressions: 1000 - i * 10, position: 10 })),
    },
  }
}
const extrasAnswer = JSON.stringify({
  faq: [
    { q: 'What does Rome have?', a: 'Rome is a city of fountains and old streets.' },
    { q: 'What can visitors see?', a: 'Visitors walk through the Colosseum and the Forum with a guide.' },
    { q: 'What food is there?', a: 'Local food includes pasta and gelato in small family cafes.' },
  ],
  key_takeaways: ['Rome has fountains and old streets', 'Visitors tour the Colosseum and the Forum', 'Pasta and gelato are local food'],
})
function stubModel() {
  const prompts: string[] = []
  return { prompts, model: async (prompt: string) => (prompts.push(prompt), extrasAnswer) }
}
const run = (db: Db, now = NOW, s = stubModel()) => runRefreshLoop(fakeAdmin(db), { now, model: s.model, index: makeIndex() })
const settingsLike = (db: Db, p: string) => db.tables.app_settings.filter((r) => String(r.key).startsWith(p))
const expsOf = (db: Db) => settingsLike(db, 'refresh_exp:').map((r) => JSON.parse(String(r.value)) as RefreshExperiment)
const heal = (db: Db) => settingsLike(db, 'heal_loop_call:').length
const linksIn = (s: string) => [...s.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1])

async function main() {
  // ---- off mode does nothing ----
  for (const mode of [null, 'off', 'enabled', '']) {
    const db = baseDb(2, undefined, mode)
    const before = JSON.stringify(db.tables)
    const s = stubModel()
    const r = await run(db, NOW, s)
    check(`off (${mode === null ? 'unset' : JSON.stringify(mode)}): nothing read, written, called or reported`, JSON.stringify(db.tables) === before && s.prompts.length === 0 && r.started === 0 && r.calls === 0 && r.note === '' && !r.active && r.problems.length === 0, r.note)
  }
  {
    // A test that is running and due is NOT evaluated while the switch is off: off means off.
    const db = baseDb()
    await run(db)
    db.tables.app_settings = db.tables.app_settings.map((x) => (x.key === REFRESH_MODE_KEY ? { ...x, value: 'off' } : x))
    db.tables.content_performance = [{ day: refreshEvalDayOf(NOW.toISOString()), path: '/blog/rome-1', clicks: 1, impressions: 1000, position: 30 }]
    await run(db, new Date(NOW.getTime() + 31 * DAY))
    check('off: even a due comparison waits (the body is not touched while the switch is off)', expsOf(db)[0].status === 'running' && db.tables.posts[0].body !== plainBody)
  }

  // ---- start: links added, logged first, date bumped ----
  {
    const db = baseDb()
    const s = stubModel()
    const r = await run(db, NOW, s)
    const p = db.tables.posts[0]
    check('start: one page refreshed, no model call needed when nothing is missing', r.started === 1 && r.calls === 0 && s.prompts.length === 0 && r.queued === 0, JSON.stringify(r))
    const added = linksIn(String(p.body))
    check('start: exactly 2 links, to real pages of the same destination, none invented', added.length === 2 && added.every((l) => makeIndex().existing.has(l)) && !added.includes('/packages/ghost') && !added.includes('/destinations/paris'), JSON.stringify(added))
    check('start: logged in content_edits with the exact old body (so Undo works)', db.tables.content_edits.length === 1 && db.tables.content_edits[0].before === plainBody && db.tables.content_edits[0].after === p.body && db.tables.content_edits[0].field === 'links' && db.tables.content_edits[0].method === 'links' && db.tables.content_edits[0].published_after === false)
    check('start: the visible updated date moved because something changed', p.updated_at === NOW.toISOString())
    const exp = expsOf(db)[0]
    check('start: the experiment records the baseline position, clicks and impressions', !!exp && exp.path === '/blog/rome-1' && exp.baselinePosition === 10 && exp.baselineClicks === 8 && exp.baselineImpressions === 1000 && exp.status === 'running' && exp.editIds.length === 1 && exp.addedLinks.length === 2)
    check('start: the page is reported as changed (so the heal pings IndexNow) and a note is made', JSON.stringify(r.changedPaths) === JSON.stringify(['/blog/rome-1']) && /refreshed 1 page/.test(r.note) && r.active)
    check('start: the meta text, faq and takeaways are untouched', p.meta_title === 'Rome notes' && p.meta_description === '' && JSON.stringify(p.faq) === JSON.stringify(faqFilled))
    const again = await run(db)
    check('start: the same page is not refreshed twice while its test runs', again.started === 0 && db.tables.content_edits.length === 1)
  }

  // ---- Undo restores the exact previous body ----
  {
    const db = baseDb()
    await run(db)
    const id = String(db.tables.content_edits[0].id)
    const res = await revertEdit(fakeAdmin(db), id)
    check('undo: the Content edits Undo puts back the exact previous body, byte for byte', res.ok && db.tables.posts[0].body === plainBody && !!db.tables.content_edits[0].reverted_at, JSON.stringify(res))
    check('undo: a person pressing Undo ends the test and the page stays as they left it', await (async () => {
      db.tables.content_performance = [{ day: refreshEvalDayOf(NOW.toISOString()), path: '/blog/rome-1', clicks: 1, impressions: 1000, position: 30 }]
      await run(db, new Date(NOW.getTime() + 31 * DAY))
      return expsOf(db)[0].status === 'undone_by_person' && db.tables.posts[0].body === plainBody
    })())
  }

  // ---- a guide works the same way ----
  {
    const db = baseDb(0, [{ day: '2026-10-16', path: '/hotels/hotel-x', clicks: 4, impressions: 400, position: 14 }])
    const summary = 'Hotel X sits near the old centre of Rome.'
    const body = '## Rooms\n\nThe rooms look over Rome and the river.\n\n## Food\n\nBreakfast is served on the roof.'
    db.tables.guides.push({ id: 'guide-1', kind: 'hotels', slug: 'hotel-x', status: 'published', name: 'Hotel X', summary, body, sections: [], faq: faqFilled, key_takeaways: ['Near the centre'], updated_at: '2026-09-01T10:00:00.000Z' })
    const r = await run(db)
    const g = db.tables.guides[0]
    check('guide: links are added to a published guide too', r.started === 1 && linksIn(`${g.summary}\n\n${g.body}`).length === 2, JSON.stringify(r) + String(g.body))
    const before = db.tables.content_edits[0].before
    const res = await revertEdit(fakeAdmin(db), String(db.tables.content_edits[0].id))
    check('guide: Undo restores the exact previous summary and body', res.ok && before === `${summary}\n\n${body}` && g.summary === summary && g.body === body, JSON.stringify(res))
  }

  // ---- nothing to change: the date does not move ----
  {
    const db = baseDb()
    db.tables.posts[0].body = `${plainBody}\n\n[Rome](/destinations/rome) [Best time](/best-time-to-visit/rome) [Trip](/packages/rome-trip)`
    const snapshot = JSON.stringify(db.tables.posts)
    const r = await run(db)
    check('no change: a page that already links to every candidate is left alone, date and body unchanged, nothing logged', r.started === 0 && JSON.stringify(db.tables.posts) === snapshot && db.tables.content_edits.length === 0 && expsOf(db).length === 0)
    const noDest = baseDb()
    const idx = makeIndex()
    const r2 = await runRefreshLoop(fakeAdmin(noDest), { now: NOW, model: stubModel().model, index: { ...idx, targets: targets.filter((t) => t.dest !== 'rome') } })
    check('no change: when no real page about the destination exists nothing is added and the date stays', r2.started === 0 && noDest.tables.posts[0].updated_at === '2026-09-01T10:00:00.000Z' && noDest.tables.posts[0].body === plainBody)
  }

  // ---- selection by position and impressions in the run ----
  {
    const rows = [
      { day: '2026-10-16', path: '/blog/rome-1', clicks: 50, impressions: 1000, position: 5 },
      { day: '2026-10-16', path: '/blog/rome-2', clicks: 8, impressions: 900, position: 12 },
      { day: '2026-10-16', path: '/blog/rome-3', clicks: 1, impressions: 800, position: 33 },
      { day: '2026-10-16', path: '/blog/rome-4', clicks: 0, impressions: 60, position: 12 },
    ]
    const db = baseDb(4, rows)
    const r = await run(db)
    check('run selection: only the page ranked 12 with enough views is refreshed (5 is page 1, 33 is too deep, 60 views is too few)', r.started === 1 && JSON.stringify(r.changedPaths) === JSON.stringify(['/blog/rome-2']) && db.tables.posts[0].body === plainBody && db.tables.posts[2].body === plainBody && db.tables.posts[3].body === plainBody)
  }

  // ---- stale snapshot refused ----
  {
    const stale = baseDb(1, [{ day: '2026-10-01', path: '/blog/rome-1', clicks: 8, impressions: 1000, position: 10 }])
    const r = await run(stale)
    check('stale numbers: a snapshot older than 4 days is refused', r.started === 0 && stale.tables.content_edits.length === 0 && stale.tables.posts[0].body === plainBody)
    const edge = baseDb(1, [{ day: '2026-10-14', path: '/blog/rome-1', clicks: 8, impressions: 1000, position: 10 }])
    check('stale numbers: ... while a 3 day old one (the 17th at 15:00 reads the 14th) is still fine', (await run(edge)).started === 1)
    const none = baseDb(1, [])
    const rn = await run(none)
    check('no numbers yet: quiet, no problem', rn.started === 0 && rn.problems.length === 0)
    // Only the newest day is read: an old day with a great-looking row is not used even if it exists next to the fresh one.
    const mixed = baseDb(1, [{ day: '2026-10-10', path: '/blog/rome-1', clicks: 8, impressions: 1000, position: 10 }, { day: '2026-10-16', path: '/blog/rome-1', clicks: 8, impressions: 1000, position: 3 }])
    check('one day only: the newest snapshot decides (days are never mixed or added)', (await run(mixed)).started === 0)
  }

  // ---- 2 per day cap ----
  {
    const db = baseDb(4)
    const r = await run(db)
    check(`cap: at most ${REFRESH_PAGES_PER_DAY} pages a day`, r.started === REFRESH_PAGES_PER_DAY && settingsLike(db, 'refresh_loop_slot:').length === REFRESH_PAGES_PER_DAY, JSON.stringify({ s: r.started, slots: settingsLike(db, 'refresh_loop_slot:').length }))
    const later = await run(db, new Date(NOW.getTime() + 3_600_000))
    check('cap: running again the same day starts nothing more', later.started === 0 && db.tables.content_edits.length === REFRESH_PAGES_PER_DAY)
  }

  // ---- 30 day cool down ----
  check('cool down (pure): a touched page rests for 30 days; a no-change page for 7', isRefreshResting({ at: NOW.toISOString(), outcome: 'touched' }, NOW.getTime() + 29 * DAY) && !isRefreshResting({ at: NOW.toISOString(), outcome: 'touched' }, NOW.getTime() + 31 * DAY) && isRefreshResting({ at: NOW.toISOString(), outcome: 'nochange' }, NOW.getTime() + 6 * DAY) && !isRefreshResting({ at: NOW.toISOString(), outcome: 'nochange' }, NOW.getTime() + 8 * DAY) && !isRefreshResting(undefined, NOW.getTime()))
  {
    const db = baseDb()
    db.tables.posts[0].body = `${plainBody}\n\n[Trip](/packages/rome-trip)` // leaves two other candidates
    await run(db)
    check('cool down: first touch happened', db.tables.content_edits.length === 1)
    // Remove the running test record so only the rest marker holds the page back; add a new candidate target to prove it WOULD be touched.
    db.tables.app_settings = db.tables.app_settings.filter((x) => !String(x.key).startsWith('refresh_exp:') && !String(x.key).startsWith('refresh_loop_slot:'))
    const at = (days: number) => new Date(NOW.getTime() + days * DAY)
    const fresh = (days: number) => (db.tables.content_performance = [{ day: at(days - 1).toISOString().slice(0, 10), path: '/blog/rome-1', clicks: 8, impressions: 1000, position: 10 }])
    const idx = makeIndex()
    const extra: RefreshTarget = { path: '/hotels/hotel-x', title: 'Hotel X', dest: 'rome', rank: 1 }
    const withNew = { ...idx, targets: [...targets, extra] }
    fresh(10)
    const r10 = await runRefreshLoop(fakeAdmin(db), { now: at(10), model: stubModel().model, index: withNew })
    fresh(29)
    const r29 = await runRefreshLoop(fakeAdmin(db), { now: at(29), model: stubModel().model, index: withNew })
    check('cool down: the same page is not touched again at 10 or 29 days', r10.started === 0 && r29.started === 0 && db.tables.content_edits.length === 1)
    fresh(31)
    const r31 = await runRefreshLoop(fakeAdmin(db), { now: at(31), model: stubModel().model, index: withNew })
    check('cool down: ... and may be touched again after 30 days', r31.started === 1 && db.tables.content_edits.length === 2)
  }

  // ---- news posts and trip pages are skipped ----
  {
    const db = baseDb(1, [
      { day: '2026-10-16', path: '/blog/news-eu-rules', clicks: 5, impressions: 2000, position: 11 },
      { day: '2026-10-16', path: '/packages/rome-trip', clicks: 5, impressions: 1900, position: 11 },
      { day: '2026-10-16', path: '/', clicks: 5, impressions: 1800, position: 11 },
    ])
    db.tables.posts.push(post(9, { slug: 'news-eu-rules', id: 'news-1' }))
    db.tables.travel_packages = [{ id: 'pkg-1', slug: 'rome-trip', status: 'published', full_description: plainBody }]
    const snap = JSON.stringify(db.tables.posts) + JSON.stringify(db.tables.travel_packages)
    const s = stubModel()
    const r = await run(db, NOW, s)
    check('skipped: news posts (news-), trip pages and the home page are never edited, logged or sent to the model', r.started === 0 && r.calls === 0 && s.prompts.length === 0 && db.tables.content_edits.length === 0 && JSON.stringify(db.tables.posts) + JSON.stringify(db.tables.travel_packages) === snap)
    const draft = baseDb()
    draft.tables.posts[0].status = 'draft'
    check('skipped: a draft is never edited', (await run(draft)).started === 0 && draft.tables.content_edits.length === 0)
  }

  // ---- model calls only for a missing FAQ / takeaways, from the heal budget, held for a person ----
  {
    const db = baseDb(1)
    db.tables.posts[0].faq = []
    db.tables.posts[0].key_takeaways = []
    const s = stubModel()
    const r = await run(db, NOW, s)
    check('extras: one call for the missing lists, taken from the heal budget', r.calls === 1 && s.prompts.length === 1 && heal(db) === 1, JSON.stringify({ calls: r.calls, heal: heal(db) }))
    check('extras: the prompt is the heal generator (page text only, no invented facts)', /Never add a fact, name, number/.test(s.prompts[0]) && /key_takeaways/.test(s.prompts[0]))
    const queue = JSON.parse(String(db.tables.app_settings.find((x) => x.key === LIVE_ADDITIONS_KEY)?.value ?? 'null')) as { items: { path: string; status: string; changes: { field: string }[] }[] } | null
    check('extras: written lists are HELD for a person in the live additions review, not applied', r.queued === 1 && !!queue && queue.items.length === 1 && queue.items[0].path === '/blog/rome-1' && queue.items[0].status === 'open' && queue.items[0].changes.some((c) => c.field === 'faq') && JSON.stringify(db.tables.posts[0].faq) === '[]' && JSON.stringify(db.tables.posts[0].key_takeaways) === '[]', JSON.stringify(queue))
    check('extras: the links still went in and were logged on their own edit', r.started === 1 && db.tables.content_edits.length === 1 && db.tables.content_edits[0].field === 'links')
  }
  {
    const db = baseDb(1)
    db.tables.posts[0].faq = []
    const junk = { prompts: [] as string[], model: async (p: string) => (junk.prompts.push(p), JSON.stringify({ faq: [{ q: 'Is it the best and most famous in 2031?', a: 'It was voted number 1 in 2031 for 5 stars.' }, { q: 'Why?', a: 'Because 99 percent say so.' }, { q: 'More?', a: 'Over 40 hotels.' }] })) }
    const r = await run(db, NOW, junk)
    check('extras: a fabricated answer is dropped by the heal filters (nothing queued, nothing applied)', r.queued === 0 && !db.tables.app_settings.some((x) => x.key === LIVE_ADDITIONS_KEY) && JSON.stringify(db.tables.posts[0].faq) === '[]')
  }
  {
    const db = baseDb(1)
    db.tables.posts[0].faq = []
    db.tables.app_settings.push({ key: 'heal_loop_calls_per_day', value: '0' })
    const s = stubModel()
    const r = await run(db, NOW, s)
    check('budget: a heal limit of 0 stops every model call, but the plain-code links still go in', r.calls === 0 && s.prompts.length === 0 && r.queued === 0 && r.started === 1)
    const closed = baseDb(1)
    closed.tables.posts[0].faq = []
    const s2 = stubModel()
    const r2 = await runRefreshLoop(fakeAdmin(closed), { now: NOW, model: s2.model, index: makeIndex(), budget: { cap: 0, used: 0, readable: false, reason: 'unreadable', remaining: () => 0, take: async () => false } })
    check('budget: an unreadable counter fails closed (no call)', r2.calls === 0 && s2.prompts.length === 0)
    const noKey = baseDb(1)
    noKey.tables.posts[0].faq = []
    const r3 = await runRefreshLoop(fakeAdmin(noKey), { now: NOW, index: makeIndex() })
    check('no AI key and no stub: no call, links still go in, nothing fails', r3.calls === 0 && r3.started === 1 && r3.problems.length === 0)
    const late = baseDb(1)
    late.tables.posts[0].faq = []
    const s4 = stubModel()
    const r4 = await runRefreshLoop(fakeAdmin(late), { now: NOW, model: s4.model, index: makeIndex(), deadlineMs: Date.now() + 1000 })
    check('time: with less than a model call of time left, no call is made', r4.calls === 0 && s4.prompts.length === 0)
  }

  // ---- log, then apply ----
  {
    const failLog = baseDb()
    failLog.failWrites = { content_edits: 'boom' }
    const rl = await run(failLog)
    check('log, then apply: when the change log cannot be written the page is not touched', rl.started === 0 && failLog.tables.posts[0].body === plainBody && failLog.tables.posts[0].updated_at === '2026-09-01T10:00:00.000Z' && rl.problems.some((p) => /change log could not be written/.test(p)), JSON.stringify(rl.problems))
    const failPage = baseDb()
    failPage.failWrites = { posts: 'locked' }
    const rp = await run(failPage)
    check('log, then apply: a failed page update takes the log rows back out and reports it', rp.started === 0 && failPage.tables.content_edits.length === 0 && rp.problems.some((p) => /could not update/.test(p)), JSON.stringify(rp.problems))
  }

  // ---- after 30 days: compare, keep, or undo ----
  async function started() {
    const db = baseDb()
    await run(db)
    return db
  }
  const later = new Date(NOW.getTime() + 31 * DAY)
  const dueDay = refreshEvalDayOf(NOW.toISOString())
  async function evaluate(db: Db, row: Record<string, unknown> | null) {
    db.tables.content_performance = row ? [{ day: dueDay, path: '/blog/rome-1', ...row }] : [{ day: dueDay, path: '/blog/other', clicks: 5, impressions: 5, position: 2 }]
    return run(db, later)
  }
  check(`evaluation day is ${REFRESH_EVAL_AFTER_DAYS} days after the start`, dueDay === '2026-11-16', dueDay)
  {
    const db = await started()
    const early = await run(db, new Date(NOW.getTime() + 10 * DAY))
    check('wait: a test that is only 10 days old is left running', expsOf(db)[0].status === 'running' && early.checked === 0)
  }
  {
    const db = await started()
    const linked = String(db.tables.posts[0].body)
    const r = await evaluate(db, { clicks: 3, impressions: 800, position: 13.5 })
    const e = expsOf(db)[0]
    check('auto-revert: position got 3.5 places worse with enough views, so the links are undone by itself', e.status === 'reverted' && r.reverted === 1 && db.tables.posts[0].body === plainBody && linked !== plainBody, `${e.status} ${e.note}`)
    check('auto-revert: the edit rows are stamped reverted and the note says why', db.tables.content_edits.every((x) => !!x.reverted_at) && /worse/.test(String(e.note)), String(e.note))
    check('auto-revert: the result is stored with the after numbers', e.afterPosition === 13.5 && e.afterClicks === 3 && e.afterImpressions === 800)
  }
  {
    const db = await started()
    await evaluate(db, { clicks: 3, impressions: 800, position: 13 })
    check('auto-revert: exactly 3 places worse is the line (undone)', expsOf(db)[0].status === 'reverted')
    const db2 = await started()
    await evaluate(db2, { clicks: 3, impressions: 800, position: 12.9 })
    check('auto-revert: 2.9 places worse is NOT enough, the change is kept', expsOf(db2)[0].status === 'kept' && db2.tables.posts[0].body !== plainBody)
    const db3 = await started()
    await evaluate(db3, { clicks: 20, impressions: 900, position: 6 })
    check('kept: the position improved, the change stays', expsOf(db3)[0].status === 'kept' && /clicks went from 8 to 20/.test(String(expsOf(db3)[0].note)), String(expsOf(db3)[0].note))
    const db4 = await started()
    await evaluate(db4, { clicks: 0, impressions: 10, position: 40 })
    check('too little data: a big drop on 10 impressions is not trusted, the change stays and it says so', expsOf(db4)[0].status === 'inconclusive' && db4.tables.posts[0].body !== plainBody && /too few/.test(String(expsOf(db4)[0].note)))
    const db5 = await started()
    await evaluate(db5, { clicks: 2, impressions: 300, position: 25 })
    check('falling out of the top 20 with enough views still counts as clearly worse (undone)', expsOf(db5)[0].status === 'reverted' && db5.tables.posts[0].body === plainBody)
  }
  {
    const db = await started()
    db.tables.posts[0].body = `${String(db.tables.posts[0].body)}\n\nA person added this sentence later.`
    const r = await evaluate(db, { clicks: 3, impressions: 800, position: 14 })
    check('a person edited the body after the refresh: not undone without a person (no force), says so', expsOf(db)[0].status === 'revert_blocked' && String(db.tables.posts[0].body).includes('A person added this sentence later.') && r.problems.length === 0, expsOf(db)[0].status)
  }
  {
    const db = await started()
    const r = await evaluate(db, null)
    check('no numbers for the page yet: the test keeps waiting', expsOf(db)[0].status === 'running' && r.checked === 0)
    db.tables.content_performance = []
    await run(db, new Date(NOW.getTime() + 70 * DAY))
    check('... and gives up after 60 days, keeping the change', expsOf(db)[0].status === 'inconclusive' && db.tables.posts[0].body !== plainBody)
  }
  check('decide: revert needs 3 places AND enough views; anything else keeps', decideRefresh({ position: 10, clicks: 5, impressions: 500 }, { position: 13, clicks: 1, impressions: 500 }).decision === 'revert' && decideRefresh({ position: 10, clicks: 5, impressions: 500 }, { position: 12.99, clicks: 1, impressions: 500 }).decision === 'keep' && decideRefresh({ position: 10, clicks: 5, impressions: 500 }, { position: 30, clicks: 0, impressions: 49 }).decision === 'inconclusive' && decideRefresh({ position: 10, clicks: 5, impressions: 500 }, { position: null, clicks: 0, impressions: 500 }).decision === 'inconclusive')
  check('parseRefreshExperiment: rejects garbage', parseRefreshExperiment('nope') === null && parseRefreshExperiment('{"path":"/x"}') === null)

  // ---- a running click-rate title test on the same page keeps this loop away ----
  {
    const db = baseDb()
    db.tables.app_settings.push({ key: 'ctr_exp:2026-10-10:/blog/rome-1', value: JSON.stringify({ path: '/blog/rome-1', startedAt: '2026-10-10T00:00:00.000Z', editIds: ['x'], status: 'running' }) })
    check('a page in a running click-rate title test is left alone so the two tests never mix', (await run(db)).started === 0 && db.tables.content_edits.length === 0)
  }

  // ---- wiring ----
  const healSrc = src('lib/content-heal-run.ts')
  const mine = src('lib/refresh-loop.ts')
  check('wired inside the existing daily heal-content step (no new cron)', /runRefreshLoop\(admin, \{/.test(healSrc) && /deadlineMs: opts\.deadlineMs/.test(healSrc) && !/refresh/i.test(src('vercel.json')))
  check('its calls, problems and changed paths flow into the heal totals', /calls \+= refresh\.calls/.test(healSrc) && /problems\.push\(\.\.\.refresh\.problems\)/.test(healSrc) && /changedPaths\.push\(\.\.\.refresh\.changedPaths\)/.test(healSrc) && /refresh\.active/.test(healSrc))
  check('runs after the click-rate loop, inside runHealContent', healSrc.indexOf('runRefreshLoop(admin') > healSrc.indexOf('runCtrLoop(admin'))
  check('uses the heal budget and the heal generator, not its own model path', /openBudget/.test(mine) && /generateExtras/.test(mine) && /enqueueAdditions/.test(mine) && /insertEdits\(admin, \[edit\]\)/.test(mine) && /revertEdit/.test(mine) && !/callAnthropic/.test(mine))
  check('the switch is read first and fails closed', /getRefreshMode\(admin\)\) !== 'on'\) return out/.test(mine) && /r\.error \? 'off'/.test(mine))
  check('reads content_performance for ONE day only (rolling totals are never added)', /readLatestPerformance/.test(mine) && /\.eq\('day', day\)/.test(src('lib/ctr-loop.ts')) && !/\.reduce\([^)]*clicks/.test(mine))
  check('the switch is documented in .env.example', /refresh_loop_mode/.test(src('.env.example')))
  check('no em or en dashes in the new files', !LONG_DASH.test(mine) && !LONG_DASH.test(src('scripts/check-refresh-loop.ts')))

  console.log(failed === 0 ? '\nAll refresh loop checks passed.' : `\n${failed} check(s) FAILED.`)
  process.exit(failed === 0 ? 0 : 1)
}
void main()
