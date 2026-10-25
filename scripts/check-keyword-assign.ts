// Offline check for WP9, keyword target-page auto-assignment (lib/flywheel/steps/keyword-assign.ts): picking, linking a keyword to an
// existing page, queueing a PENDING suggestion with a 60-character title, the duplicate checks, the daily cap, the kill switch, the step
// switch, dry run, error isolation, Undo, and that no vendor/AI call is made. In-memory fake database only.
// Run: pnpm dlx tsx scripts/check-keyword-assign.ts   (exits 1 on any failed expectation)
import type { SupabaseClient } from '@supabase/supabase-js'
import { AUTOMATION_PAUSED_KEY } from '../lib/automation-kill-switch'
import { DECISIONS_KEY, POLICY_CAPS, parseDecisions, policyKey } from '../lib/auto-decisions'
import { runFlywheelSteps, undoFlywheel } from '../lib/flywheel/registry'
import { DONE_KEY, MIN_VOLUME, OPEN_QUEUE_LIMIT, keywordAssignStep, matchExistingPage, suggestionTitle } from '../lib/flywheel/steps/keyword-assign'
import type { FlywheelContext } from '../lib/flywheel/types'
import { TITLE_FIT_MAX } from '../lib/title-fit'

let failed = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` (${detail})` : ''}`)
}

type Row = Record<string, unknown>
interface Db {
  keyword_research: Row[]
  travel_packages: Row[]
  guides: Row[]
  posts: Row[]
  blog_topic_queue: Row[]
  app_settings: Row[]
}

let idSeq = 0
/** A small fake of the tables this step touches. `failQueueInsert` makes the topic insert error. `calls` counts every table touched. */
function fake(db: Db, opts: { failQueueInsert?: boolean; failKeywordRead?: boolean } = {}): SupabaseClient {
  return {
    from(table: keyof Db) {
      const rows = db[table]
      if (!rows) throw new Error(`unexpected table ${String(table)}`)
      const filters: Array<(r: Row) => boolean> = []
      let lim = Infinity
      let patch: Row | null = null
      let upsertRow: Row | null = null
      let insertRow: Row | null = null
      let del = false
      const result = (): { data: Row[]; error: { message: string } | null } => {
        if (table === 'keyword_research' && opts.failKeywordRead && !patch) return { data: [], error: { message: 'keywords unavailable' } }
        if (insertRow) {
          if (table === 'blog_topic_queue' && opts.failQueueInsert) return { data: [], error: { message: 'insert failed' } }
          const r = { id: `t${++idSeq}`, ...insertRow }
          rows.push(r)
          return { data: [{ ...r }], error: null }
        }
        if (patch) {
          for (const r of rows.filter((x) => filters.every((f) => f(x)))) Object.assign(r, patch)
          return { data: [], error: null }
        }
        if (del) {
          for (const r of rows.filter((x) => filters.every((f) => f(x)))) rows.splice(rows.indexOf(r), 1)
          return { data: [], error: null }
        }
        if (upsertRow) {
          const i = rows.findIndex((r) => r.key === upsertRow!.key)
          if (i >= 0) rows[i] = { ...rows[i], ...upsertRow }
          else rows.push({ ...upsertRow })
          return { data: [], error: null }
        }
        return { data: rows.filter((x) => filters.every((f) => f(x))).slice(0, lim).map((r) => ({ ...r })), error: null }
      }
      const b: Record<string, unknown> = {
        select: () => b,
        eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), b),
        is: (c: string, v: unknown) => (filters.push((r) => (r[c] ?? null) === v), b),
        in: (c: string, v: unknown[]) => (filters.push((r) => v.includes(r[c])), b),
        limit: (n: number) => ((lim = n), b),
        order: () => b,
        insert: (r: Row) => ((insertRow = r), b),
        update: (p: Row) => ((patch = p), b),
        delete: () => ((del = true), b),
        upsert: (r: Row) => ((upsertRow = r), Promise.resolve(result())),
        maybeSingle: () => {
          const r = result()
          return Promise.resolve({ data: r.data[0] ?? null, error: r.error })
        },
        single: () => {
          const r = result()
          return Promise.resolve({ data: r.data[0] ?? null, error: r.error })
        },
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(result()).then(res, rej),
      }
      return b
    },
  } as unknown as SupabaseClient
}

const NOW = new Date('2026-10-24T15:00:00.000Z')
const iso = (daysAgo: number): string => new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString()
const setting = (db: Db, key: string): string | null => (db.app_settings.find((r) => r.key === key)?.value as string | undefined) ?? null
const kwOf = (db: Db, id: string): Row => db.keyword_research.find((k) => k.id === id) as Row
const pkg = (slug: string, name: string, destination: string): Row => ({ slug, name, destination, category: 'cruise', short_description: name, status: 'published', available_from: null, available_to: null })
const kw = (id: string, keyword: string, volume: number | null, over: Row = {}): Row => ({ id, keyword, country: 'ca', volume, cpc: 1, competition: 20, gsc_impressions: null, gsc_position: null, target_path: null, note: null, ...over })
const mkdb = (over: Partial<Db> = {}): Db => ({ keyword_research: [], travel_packages: [pkg('greek-isles-cruise', 'Greek Isles Cruise', 'Greece'), pkg('alaska-glacier-cruise', 'Alaska Glacier Cruise', 'Alaska')], guides: [], posts: [], blog_topic_queue: [], app_settings: [], ...over })

function ctx(admin: SupabaseClient, over: Partial<FlywheelContext> = {}): FlywheelContext {
  return { admin, now: NOW, startedAt: 0, budgetMs: 200_000, dryRun: false, remainingMs: () => 100_000, room: POLICY_CAPS.keyword_assign, ...over }
}

async function main(): Promise<void> {
  // Any vendor call would hit fetch: make that a loud failure.
  const realFetch = globalThis.fetch
  let fetchCalls = 0
  globalThis.fetch = (async () => {
    fetchCalls++
    throw new Error('network is not allowed in this check')
  }) as typeof fetch

  // ---- pure helpers ------------------------------------------------------------------------------------------------
  check('title: a very long phrase is fitted to 60 characters', suggestionTitle({ primary: 'what is the best time of year to take a greek isles cruise from canada with a group of friends' }).length <= TITLE_FIT_MAX)
  check('title: a short phrase is title-cased', suggestionTitle({ primary: 'greek isles cruise tips' }) === 'Greek Isles Cruise Tips')
  check('match: the same words match a page', matchExistingPage('greek isles cruise', [{ path: '/packages/greek-isles-cruise', title: 'Greek Isles Cruise' }])?.path === '/packages/greek-isles-cruise')
  check('match: a different topic does not', matchExistingPage('greek isles cruise packing list', [{ path: '/blog/alaska-weather', title: 'Alaska weather by month' }]) === null)
  check('match: no pages, no match', matchExistingPage('anything', []) === null)

  // ---- suggestion path -----------------------------------------------------------------------------------------------
  {
    const db = mkdb({ keyword_research: [kw('k1', 'greek isles cruise for singles', 900)] })
    const r = await keywordAssignStep.run(ctx(fake(db)))
    check('suggest: the step ran and acted once', r.ran === true && r.acted === 1, JSON.stringify(r))
    const q = db.blog_topic_queue[0]
    check('suggest: one PENDING topic, source keyword_assign, never approved', db.blog_topic_queue.length === 1 && q.status === 'suggested' && q.source === 'keyword_assign', JSON.stringify(q))
    check('suggest: title idea is within 60 characters and has no dash', String(q.title_idea).length > 0 && String(q.title_idea).length <= TITLE_FIT_MAX && !/[–—]/.test(String(q.angle) + String(q.title_idea)))
    check('suggest: keyword, keyword set and cluster come from the research row', q.keyword === 'greek isles cruise for singles' && Array.isArray(q.keywords) && (q.keywords as string[])[0] === q.keyword && typeof q.cluster_id === 'string')
    check('suggest: the reason quotes the real volume, nothing invented', String(q.why).includes('900'))
    check('suggest: the keyword row itself is untouched', kwOf(db, 'k1').target_path === null)
    const log = parseDecisions(setting(db, DECISIONS_KEY))
    check('suggest: one decision line with an fw:keyword_assign undo', log.length === 1 && log[0].policy === 'keyword_assign' && log[0].undo?.kind === 'fw:keyword_assign' && log[0].undo.ref === 'k1', JSON.stringify(log))
    const again = await keywordAssignStep.run(ctx(fake(db)))
    check('suggest: handled once, a second pass does nothing', again.ran === false && db.blog_topic_queue.length === 1, JSON.stringify(again))

    // undo
    const admin = fake(db)
    const u = await undoFlywheel(admin, 'keyword_assign', 'k1')
    check('undo: the suggested topic is removed', u.ok === true && db.blog_topic_queue.length === 0, u.message)
    check('undo: a second undo is refused', (await undoFlywheel(admin, 'keyword_assign', 'k1')).ok === false)
    const after = await keywordAssignStep.run(ctx(admin))
    check('undo: the keyword is not suggested again', after.ran === false && db.blog_topic_queue.length === 0, JSON.stringify(after))
    check('undo: unknown ref is refused', (await undoFlywheel(admin, 'keyword_assign', 'nope')).ok === false)
  }
  {
    const db = mkdb({ keyword_research: [kw('k1', 'greek isles cruise for singles', 900)] })
    const admin = fake(db)
    await keywordAssignStep.run(ctx(admin))
    db.blog_topic_queue[0].status = 'approved'
    const u = await undoFlywheel(admin, 'keyword_assign', 'k1')
    check('undo: a topic a person approved since is left alone', u.ok === false && db.blog_topic_queue.length === 1, u.message)
  }

  // ---- assign path ---------------------------------------------------------------------------------------------------
  {
    const db = mkdb({
      posts: [{ slug: 'how-to-pick-a-greek-isles-cruise', title: 'How to Pick a Greek Isles Cruise', status: 'published' }],
      keyword_research: [kw('k1', 'how to pick a greek isles cruise', 700)],
    })
    const r = await keywordAssignStep.run(ctx(fake(db)))
    check('assign: ran and linked the keyword to the post that says the same thing', r.ran === true && kwOf(db, 'k1').target_path === '/blog/how-to-pick-a-greek-isles-cruise', JSON.stringify([r, kwOf(db, 'k1')]))
    check('assign: no topic was queued for it', db.blog_topic_queue.length === 0)
    const log = parseDecisions(setting(db, DECISIONS_KEY))
    check('assign: logged with an undo', log.length === 1 && log[0].undo?.kind === 'fw:keyword_assign' && log[0].undo.ref === 'k1')
    const admin = fake(db)
    const u = await undoFlywheel(admin, 'keyword_assign', 'k1')
    check('assign undo: target page cleared', u.ok === true && kwOf(db, 'k1').target_path === null, u.message)
    const r2 = await keywordAssignStep.run(ctx(admin))
    check('assign undo: not assigned again', r2.ran === false && kwOf(db, 'k1').target_path === null, JSON.stringify(r2))
  }
  {
    const db = mkdb({ posts: [{ slug: 'how-to-pick-a-greek-isles-cruise', title: 'How to Pick a Greek Isles Cruise', status: 'published' }], keyword_research: [kw('k1', 'how to pick a greek isles cruise', 700)] })
    const admin = fake(db)
    await keywordAssignStep.run(ctx(admin))
    kwOf(db, 'k1').target_path = '/packages/greek-isles-cruise'
    const u = await undoFlywheel(admin, 'keyword_assign', 'k1')
    check('assign undo: a page a person set since is left alone', u.ok === false && kwOf(db, 'k1').target_path === '/packages/greek-isles-cruise', u.message)
  }

  // ---- what is NOT touched --------------------------------------------------------------------------------------------
  {
    const db = mkdb({
      posts: [{ slug: 'greek-isles-cruise-for-singles', title: 'Greek Isles Cruise for Singles', status: 'published' }],
      blog_topic_queue: [{ id: 'q1', keyword: 'greek isles cruise packing list', angle: 'Packing list', status: 'rejected', why: '', created_at: iso(3) }],
      keyword_research: [
        kw('low', 'greek isles cruise couples', MIN_VOLUME - 1),
        kw('nov', 'greek isles cruise seniors', null),
        kw('has', 'alaska glacier cruise deals', 800, { target_path: '/packages/alaska-glacier-cruise' }),
        kw('rank', 'greek isles cruise reviews', 800, { gsc_position: 4, gsc_impressions: 100 }),
        kw('skip', 'alaska glacier cruise kids', 800, { note: 'skipped: not wanted' }),
        kw('off', 'bitcoin mining rigs for sale', 900),
        kw('dupe', 'greek isles cruise packing list', 900),
        kw('us', 'alaska glacier cruise tips', 900, { country: 'us' }),
      ],
    })
    const r = await keywordAssignStep.run(ctx(fake(db)))
    const untouched = ['low', 'nov', 'rank', 'skip', 'off', 'us'].every((id) => kwOf(db, id).target_path === null)
    check('skip: low demand, no volume, already ranking, skipped, off-topic, other country and rejected-topic keywords queue nothing', db.blog_topic_queue.length === 1 && untouched && kwOf(db, 'has').target_path === '/packages/alaska-glacier-cruise', JSON.stringify([r, db.blog_topic_queue]))
    check('skip: a keyword that already has a page keeps exactly that page', kwOf(db, 'has').target_path === '/packages/alaska-glacier-cruise')
  }
  {
    // already queued / near-duplicate of a queued topic is not queued twice
    const db = mkdb({
      blog_topic_queue: [{ id: 'q1', keyword: 'greek isles cruise for singles', angle: 'Greek isles cruise for singles', status: 'suggested', why: '', created_at: iso(1) }],
      keyword_research: [kw('k1', 'greek isles cruise for singles', 900)],
    })
    const r = await keywordAssignStep.run(ctx(fake(db)))
    check('dup: a keyword already in the queue is not queued again', db.blog_topic_queue.length === 1 && r.ran === false, JSON.stringify(r))
  }
  {
    const db = mkdb({
      blog_topic_queue: [{ id: 'q1', keyword: 'cruise to the greek isles for singles', angle: 'Singles cruise to the Greek Isles', status: 'suggested', why: '', created_at: iso(1) }],
      keyword_research: [kw('k1', 'greek isles cruise for singles', 900)],
    })
    await keywordAssignStep.run(ctx(fake(db)))
    check('dup: a same-meaning queued topic blocks it (lib/topic-meaning.ts)', db.blog_topic_queue.length === 1, JSON.stringify(db.blog_topic_queue.map((q) => q.keyword)))
  }

  // ---- queue limit ---------------------------------------------------------------------------------------------------
  {
    const full = Array.from({ length: OPEN_QUEUE_LIMIT }, (_v, i) => ({ id: `f${i}`, keyword: `unrelated topic ${i} zebra ${i * 7}`, angle: `Something else ${i}`, status: 'suggested', why: '', created_at: iso(1) }))
    const db = mkdb({ blog_topic_queue: full, keyword_research: [kw('k1', 'greek isles cruise for singles', 900)] })
    const r = await keywordAssignStep.run(ctx(fake(db)))
    check('queue full: nothing is added and the keyword is picked up again later', r.ran === false && db.blog_topic_queue.length === OPEN_QUEUE_LIMIT && setting(db, DONE_KEY) === null, JSON.stringify(r))
  }

  // ---- cap -----------------------------------------------------------------------------------------------------------
  {
    const names = ['greek isles cruise for singles', 'alaska glacier cruise for seniors', 'greek isles cruise weather in october', 'alaska glacier cruise cost per person', 'greek isles cruise packing list', 'alaska glacier cruise wildlife excursions']
    const mk = (): Db => mkdb({ keyword_research: names.map((n, i) => kw(`k${i}`, n, 900 - i * 10)) })
    const db = mk()
    const r = await keywordAssignStep.run(ctx(fake(db), { room: 2 }))
    check('cap: stops at the room it is given', r.acted === 2 && db.blog_topic_queue.length === 2, JSON.stringify(r))
    const r0 = await keywordAssignStep.run(ctx(fake(db), { room: 0 }))
    check('cap: no room means no work', r0.ran === false && db.blog_topic_queue.length === 2)
    const full = mk()
    const fullLog = Array.from({ length: POLICY_CAPS.keyword_assign }, (_v, i) => ({ at: NOW.toISOString(), policy: 'keyword_assign', subject: `s${i}`, action: 'x', reason: 'y', undo: null }))
    full.app_settings.push({ key: DECISIONS_KEY, value: JSON.stringify(fullLog) })
    const out = await runFlywheelSteps({ admin: fake(full), startedAt: 0, budgetMs: 200_000, now: NOW, clock: () => 1_000 }, [keywordAssignStep])
    check('cap via runner: a full day skips the step', out.outcomes[0]?.status === 'skipped' && full.blog_topic_queue.length === 0, JSON.stringify(out.outcomes))
    const big = mk()
    const many = await keywordAssignStep.run(ctx(fake(big), { room: 99 }))
    check('cap: the step never exceeds its own room even if every keyword qualifies', (many.acted ?? 0) <= 99 && big.blog_topic_queue.length <= names.length)
  }

  // ---- kill switch, own switch, dry run ------------------------------------------------------------------------------
  {
    const mk = (): Db => mkdb({ keyword_research: [kw('k1', 'greek isles cruise for singles', 900)] })
    const run = (db: Db, extra: { dryRun?: boolean } = {}) => runFlywheelSteps({ admin: fake(db), startedAt: 0, budgetMs: 200_000, now: NOW, clock: () => 1_000, ...extra }, [keywordAssignStep])

    const dbOn = mk()
    const on = await run(dbOn)
    check('runner: works by default (switch unset)', on.outcomes[0]?.status === 'ran' && dbOn.blog_topic_queue.length === 1, JSON.stringify(on.outcomes))
    const dbOff = mk()
    dbOff.app_settings.push({ key: policyKey('keyword_assign'), value: 'off' })
    const off = await run(dbOff)
    check('own switch off: nothing happens', off.outcomes[0]?.status === 'skipped' && dbOff.blog_topic_queue.length === 0, JSON.stringify(off.outcomes))
    const dbKill = mk()
    dbKill.app_settings.push({ key: AUTOMATION_PAUSED_KEY, value: 'true' })
    const kill = await run(dbKill)
    check('kill switch (pause all): nothing happens', kill.outcomes[0]?.status === 'skipped' && dbKill.blog_topic_queue.length === 0, JSON.stringify(kill.outcomes))
    const dbDry = mk()
    const dry = await run(dbDry, { dryRun: true })
    check('dry run via runner: nothing happens', dry.outcomes[0]?.status === 'skipped' && dbDry.blog_topic_queue.length === 0 && setting(dbDry, DONE_KEY) === null)
    const dbDry2 = mk()
    const direct = await keywordAssignStep.run(ctx(fake(dbDry2), { dryRun: true }))
    check('dry run direct call: no write, no log', direct.ran === false && dbDry2.blog_topic_queue.length === 0 && setting(dbDry2, DONE_KEY) === null && setting(dbDry2, DECISIONS_KEY) === null)
  }

  // ---- error isolation -----------------------------------------------------------------------------------------------
  {
    const db = mkdb({ keyword_research: [kw('k1', 'greek isles cruise for singles', 900)] })
    const out = await runFlywheelSteps({ admin: fake(db, { failKeywordRead: true }), startedAt: 0, budgetMs: 200_000, now: NOW, clock: () => 1_000 }, [keywordAssignStep, { ...keywordAssignStep, id: 'recap_auto', policy: 'recap_auto', order: 100, run: async () => ({ ran: true, note: 'second step still ran', acted: 1 }) }])
    check('error: a failed keyword read is an error for this step only', out.outcomes[0]?.status === 'error' && out.outcomes[1]?.status === 'ran', JSON.stringify(out.outcomes))
    const db2 = mkdb({ keyword_research: [kw('k1', 'greek isles cruise for singles', 900)] })
    const r = await keywordAssignStep.run(ctx(fake(db2, { failQueueInsert: true })))
    check('error: a failed topic insert acts on nothing and logs nothing', r.ran === false && db2.blog_topic_queue.length === 0 && setting(db2, DECISIONS_KEY) === null && setting(db2, DONE_KEY) === null, JSON.stringify(r))
  }

  check('no outside call: nothing used the network (no volume lookup, no AI)', fetchCalls === 0, String(fetchCalls))
  globalThis.fetch = realFetch

  console.log(failed === 0 ? '\n0 failed' : `\n${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
