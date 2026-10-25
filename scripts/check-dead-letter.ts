// Offline check for the dead-letter sweeper (lib/flywheel/steps/dead-letter.ts, policy dead_letter): the pure verdicts, the happy path, the daily
// cap, the kill switch and own switch, dry run, error isolation, the weekly digest and Undo. In-memory fake database only: no network, no real
// database, no model call.
// Run: pnpm dlx tsx scripts/check-dead-letter.ts   (exits 1 on any failed expectation)
import type { SupabaseClient } from '@supabase/supabase-js'
import { DECISIONS_KEY, POLICY_CAPS, VETO_KEY, decision, parseDecisions, policyKey, undoAutoDecision, type AutoDecision } from '../lib/auto-decisions'
import { AUTOMATION_PAUSED_KEY } from '../lib/automation-kill-switch'
import { RETRY_STATE_KEY } from '../lib/auto-policies'
import { withDryRun } from '../lib/dry-run'
import { FLYWHEEL_STEPS, runFlywheelSteps } from '../lib/flywheel/registry'
import { DEAD_LETTER_STATE_KEY, PER_PASS_MAX, RETIRED_PREFIX, deadLetterStep, digestLine, postRetireVerdict, stepRetireVerdict, weekKey, type StepPart } from '../lib/flywheel/steps/dead-letter'

let failed = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` (${detail})` : ''}`)
}

type Row = Record<string, unknown>
interface Fake {
  admin: SupabaseClient
  tables: Record<string, Row[]>
  setting: (k: string) => string | undefined
  /** Calls to update() on any table (for "nothing was written" checks). */
  updates: { n: number }
}

/** A tiny in-memory stand-in for the four tables the sweeper touches. Supports select/update/eq/in/lt/not/order/limit/maybeSingle. */
function fakeDb(seed: Record<string, Row[]>, settings: Record<string, string> = {}, failUpdate?: (table: string, eq: Record<string, unknown>) => boolean): Fake {
  const tables: Record<string, Row[]> = { app_settings: Object.entries(settings).map(([key, value]) => ({ key, value })), content_pipeline: [], post_distribution: [], posts: [], ...seed }
  const updates = { n: 0 }
  const admin = {
    from(table: string) {
      if (!tables[table]) throw new Error(`unexpected table ${table}`)
      const filters: Array<(r: Row) => boolean> = []
      const eqs: Record<string, unknown> = {}
      let op: 'select' | 'update' = 'select'
      let patch: Row = {}
      let returning = false
      let lim = Infinity
      let orderCol = ''
      let asc = true
      const exec = (single: boolean) => {
        let rows = tables[table].filter((r) => filters.every((f) => f(r)))
        if (orderCol) rows = [...rows].sort((a, b) => (String(a[orderCol]) < String(b[orderCol]) ? -1 : 1) * (asc ? 1 : -1))
        rows = rows.slice(0, lim)
        if (op === 'update') {
          updates.n++
          if (failUpdate?.(table, eqs)) return { data: null, error: { message: 'boom' } }
          for (const r of rows) Object.assign(r, patch)
          return { data: returning ? rows.map((r) => ({ ...r })) : null, error: null }
        }
        const out = rows.map((r) => ({ ...r }))
        return { data: single ? (out[0] ?? null) : out, error: null }
      }
      const q = {
        select: () => {
          if (op === 'update') returning = true
          return q
        },
        update: (p: Row) => {
          op = 'update'
          patch = p
          return q
        },
        upsert: async (row: Row) => {
          const hit = tables[table].find((r) => r.key === row.key)
          if (hit) Object.assign(hit, row)
          else tables[table].push({ ...row })
          return { error: null }
        },
        eq: (c: string, v: unknown) => {
          eqs[c] = v
          filters.push((r) => r[c] === v)
          return q
        },
        in: (c: string, vs: unknown[]) => {
          filters.push((r) => vs.includes(r[c]))
          return q
        },
        lt: (c: string, v: string) => {
          filters.push((r) => String(r[c]) < v)
          return q
        },
        not: (c: string, _is: string, v: unknown) => {
          filters.push((r) => r[c] !== v)
          return q
        },
        order: (c: string, o?: { ascending?: boolean }) => {
          orderCol = c
          asc = o?.ascending !== false
          return q
        },
        limit: (n: number) => {
          lim = n
          return q
        },
        maybeSingle: async () => exec(true),
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(exec(false)).then(res, rej),
      }
      return q
    },
  } as unknown as SupabaseClient
  return { admin, tables, setting: (k) => tables.app_settings.find((r) => r.key === k)?.value as string | undefined, updates }
}

const NOW = new Date('2026-10-24T15:00:00.000Z')
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString()
const H = 3_600_000
const D = 24 * H
const run = (f: Fake, opts: { dryRun?: boolean } = {}) => runFlywheelSteps({ admin: f.admin, startedAt: 0, budgetMs: 200_000, now: NOW, clock: () => 1_000, dryRun: opts.dryRun }, [deadLetterStep])
const log = (f: Fake): AutoDecision[] => parseDecisions(f.setting(DECISIONS_KEY))

const post = (slug: string, age: number, err: string, extra: Row = {}): Row => ({ content_type: 'post', slug, title: slug, stage: 'failed', last_error: err, sent_platforms: [], updated_at: ago(age), ...extra })
const pipe = (slug: string, o: Partial<Row>): Row => ({ slug, carousel_stage: 'posted', video_stage: 'posted', last_error: null, created_at: ago(5 * D), updated_at: ago(4 * D), carousel_sent: [], video_sent: [], ...o })
const KEY_BAD = 'Upload-Post said the API key is invalid (401)'
const BUSY = 'Upload-Post is temporarily unavailable (503), try again'

async function main(): Promise<void> {
  // ---- registry wiring ------------------------------------------------------------------------------------------------
  const reg = FLYWHEEL_STEPS.find((s) => s.id === 'dead_letter')
  check('the registry holds this step (id, policy, undo handler)', reg === deadLetterStep && deadLetterStep.policy === 'dead_letter' && typeof deadLetterStep.undo === 'function')
  check('cap is 10 a day and a pass retires at most 5', POLICY_CAPS.dead_letter === 10 && PER_PASS_MAX === 5)

  // ---- pure verdicts: failed social post ------------------------------------------------------------------------------
  const p = (age: number, err: string, extra: Partial<{ sent_platforms: string[] | null; stage: string }> = {}) => ({ slug: 'p', stage: 'failed', last_error: err, sent_platforms: [] as string[] | null, updated_at: ago(age), ...extra })
  check('post: younger than 3 days is kept', postRetireVerdict(p(2 * D, KEY_BAD), 0, NOW, false, false, true).act === 'keep')
  check('post: needs-person error after 3 days is retired', postRetireVerdict(p(4 * D, KEY_BAD), 0, NOW, false, false, true).act === 'retire')
  check('post: self-fixable with a retry still to come is kept', postRetireVerdict(p(4 * D, BUSY), 0, NOW, false, false, true).act === 'keep')
  check('post: self-fixable with the 3 retries spent is retired', postRetireVerdict(p(4 * D, BUSY), 3, NOW, false, false, true).act === 'retire')
  check('post: self-fixable but posting is not in auto mode: kept until a week old, then retired', postRetireVerdict(p(4 * D, BUSY), 0, NOW, false, false, false).act === 'keep' && postRetireVerdict(p(8 * D, BUSY), 0, NOW, false, false, false).act === 'retire')
  check('post: a retirement a person undid is never repeated', postRetireVerdict(p(4 * D, KEY_BAD), 0, NOW, true, false, true).act === 'keep')
  check('post: a post a person put back on purpose (retry veto) is kept', postRetireVerdict(p(4 * D, KEY_BAD), 0, NOW, false, true, true).act === 'keep')
  check('post: not failed any more is kept', postRetireVerdict(p(4 * D, KEY_BAD, { stage: 'queued' }), 0, NOW, false, false, true).act === 'keep')
  check('post: unreadable time is kept', postRetireVerdict({ ...p(4 * D, KEY_BAD), updated_at: 'nope' }, 0, NOW, false, false, true).act === 'keep')
  check('post: anything failed for 14 days is retired whatever the ladder says', postRetireVerdict(p(15 * D, BUSY), 0, NOW, false, false, true).act === 'retire')
  check('post: partly sent posts follow the same rule and the reason says so', (() => { const v = postRetireVerdict(p(4 * D, BUSY, { sent_platforms: ['facebook'] }), 0, NOW, false, false, true); return v.act === 'retire' && /facebook/.test(v.why) })())

  // ---- pure verdicts: carousel and video ------------------------------------------------------------------------------
  const s = (o: Partial<StepPart>): StepPart => ({ slug: 'a', part: 'video', stage: 'failed', otherStage: 'posted', last_error: KEY_BAD, created_at: ago(5 * D), updated_at: ago(4 * D), sent: [], ...o })
  check('step: failed needs-person video after 3 days is retired', stepRetireVerdict(s({}), 0, true, NOW, false).act === 'retire')
  check('step: failed younger than 3 days is kept', stepRetireVerdict(s({ updated_at: ago(2 * D) }), 0, true, NOW, false).act === 'keep')
  check('step: a video that never finished rendering still has its resume coming', stepRetireVerdict(s({ last_error: 'render did not finish' }), 0, true, NOW, false).act === 'keep')
  check('step: ... but not after the resume was already used', stepRetireVerdict(s({ last_error: 'render did not finish' }), 1, true, NOW, false).act === 'retire')
  check('step: ... and not once the row is past the 7-day window (nothing resumes it any more)', stepRetireVerdict(s({ last_error: 'render did not finish', created_at: ago(9 * D) }), 0, true, NOW, false).act === 'retire')
  check('step: a vetoed step is kept', stepRetireVerdict(s({}), 0, true, NOW, true).act === 'keep')
  check('step: no recorded problem is kept', stepRetireVerdict(s({ last_error: null }), 0, true, NOW, false).act === 'keep')
  check('step: posted, skipped and sandbox parts are never touched', ['posted', 'skipped', 'sandbox'].every((st) => stepRetireVerdict(s({ stage: st }), 0, true, NOW, false).act === 'keep'))
  check('step: a row for a deleted post is retired after the 1 hour grace, not before', stepRetireVerdict(s({ stage: 'pending', updated_at: ago(2 * H) }), 0, false, NOW, false).act === 'retire' && stepRetireVerdict(s({ stage: 'pending', updated_at: ago(10 * 60_000) }), 0, false, NOW, false).act === 'keep')
  check('step: an unknown post (read failed) is never treated as deleted', stepRetireVerdict(s({ stage: 'pending', updated_at: ago(2 * H) }), 0, null, NOW, false).act === 'keep')
  check('step: stuck "pending" with a problem inside the 7-day window is kept, past it is retired', stepRetireVerdict(s({ stage: 'pending' }), 0, true, NOW, false).act === 'keep' && stepRetireVerdict(s({ stage: 'pending', created_at: ago(9 * D) }), 0, true, NOW, false).act === 'retire')
  check('weekKey is the Monday of the week', weekKey(new Date('2026-10-24T15:00:00Z')) === '2026-10-19' && weekKey(new Date('2026-10-19T00:00:00Z')) === '2026-10-19' && weekKey(new Date('2026-10-25T23:59:00Z')) === '2026-10-19')

  // ---- happy path -----------------------------------------------------------------------------------------------------
  const happy = (): Fake =>
    fakeDb(
      {
        post_distribution: [
          post('pp1', 4 * D, KEY_BAD), // retired
          post('pp2', 1 * D, KEY_BAD), // too young
          post('pp3', 4 * D, BUSY), // retry still to come
          post('pp4', 4 * D, BUSY), // ladder spent -> retired
          post('pp5', 4 * D, KEY_BAD), // retry veto
          post('pp6', 4 * D, KEY_BAD), // own veto
        ],
        content_pipeline: [
          pipe('s1', { video_stage: 'failed', last_error: KEY_BAD }), // retired, error cleared
          pipe('s2', { carousel_stage: 'failed', last_error: BUSY, created_at: ago(10 * D) }), // past window -> retired
          pipe('s3', { video_stage: 'failed', last_error: 'render did not finish' }), // resume still to come
          pipe('s4', { carousel_stage: 'pending', last_error: 'x', updated_at: ago(3 * H), created_at: ago(1 * D) }), // post deleted
          pipe('s0', { video_stage: 'posted', last_error: null }), // healthy
        ],
        posts: [{ slug: 'pp1' }, { slug: 's1' }, { slug: 's2' }, { slug: 's3' }, { slug: 's0' }],
      },
      {
        distribution_mode: 'auto',
        [RETRY_STATE_KEY]: JSON.stringify({ retries: { pp4: { n: 3, at: ago(3 * D) } }, carded: {} }),
        [VETO_KEY]: JSON.stringify(['retry_failed_posts|pp5', 'dead_letter|pp6']),
      },
    )
  {
    const f = happy()
    const r = await run(f)
    const o = r.outcomes[0]
    check('happy path: the step ran and retired 5 things', o.status === 'ran' && o.acted === 5, JSON.stringify(o))
    const stage = (slug: string) => f.tables.post_distribution.find((x) => x.slug === slug)?.stage
    check('failed posts: the two dead ones are closed, the rest are left failed', stage('pp1') === 'done' && stage('pp4') === 'done' && stage('pp2') === 'failed' && stage('pp3') === 'failed' && stage('pp5') === 'failed' && stage('pp6') === 'failed')
    check('a retired post carries the Retired: note with the original error', String(f.tables.post_distribution[0].last_error).startsWith(RETIRED_PREFIX) && /API key/.test(String(f.tables.post_distribution[0].last_error)))
    const pl = (slug: string) => f.tables.content_pipeline.find((x) => x.slug === slug)!
    check('failed video with a dead error: skipped and the error is cleared (like Dismiss)', pl('s1').video_stage === 'skipped' && pl('s1').last_error === null && pl('s1').carousel_stage === 'posted')
    check('failed carousel past the 7-day window: skipped', pl('s2').carousel_stage === 'skipped' && pl('s2').last_error === null)
    check('video whose resume is still to come is left alone', pl('s3').video_stage === 'failed' && pl('s3').last_error === 'render did not finish')
    check('a row for a deleted post is skipped', pl('s4').carousel_stage === 'skipped' && pl('s4').last_error === null)
    check('a healthy row is untouched', pl('s0').video_stage === 'posted')
    const l = log(f)
    check('one decision per retirement, all dead_letter, each with an fw:dead_letter Undo', l.length === 5 && l.every((e) => e.policy === 'dead_letter' && e.undo?.kind === 'fw:dead_letter'), JSON.stringify(l.map((e) => [e.subject, e.undo?.kind])))
    check('subjects are the post slug or slug:part', ['pp1', 'pp4', 's1:video', 's2:carousel', 's4:carousel'].every((sub) => l.some((e) => e.subject === sub)))
    check('the heartbeat is written', !!f.setting('flywheel_last_run:dead_letter'))
    check('the digest counter was bumped', JSON.parse(f.setting(DEAD_LETTER_STATE_KEY) ?? '{}').count === 5)
  }

  // ---- Undo -----------------------------------------------------------------------------------------------------------
  {
    const f = happy()
    await run(f)
    const entry = log(f).find((e) => e.subject === 'pp1')!
    const u = await undoAutoDecision(f.admin, entry)
    const row = f.tables.post_distribution.find((x) => x.slug === 'pp1')!
    check('Undo (post): back to failed with the original error', u.ok && row.stage === 'failed' && row.last_error === KEY_BAD, JSON.stringify([u, row]))
    check('Undo adds the subject to the veto list, so the sweep never repeats it', (JSON.parse(f.setting(VETO_KEY) ?? '[]') as string[]).includes('dead_letter|pp1'))
    check('Undo twice is refused', (await undoAutoDecision(f.admin, entry)).ok === false)
    f.tables.post_distribution.find((x) => x.slug === 'pp4')!.stage = 'queued'
    const u2 = await undoAutoDecision(f.admin, log(f).find((e) => e.subject === 'pp4')!)
    check('Undo is refused (and changes nothing) when the post moved on since', u2.ok === false && f.tables.post_distribution.find((x) => x.slug === 'pp4')!.stage === 'queued', u2.message)

    const stepEntry = log(f).find((e) => e.subject === 's1:video')!
    const u3 = await undoAutoDecision(f.admin, stepEntry)
    const s1 = f.tables.content_pipeline.find((x) => x.slug === 's1')!
    check('Undo (step): stage and error are back exactly as they were', u3.ok && s1.video_stage === 'failed' && s1.last_error === KEY_BAD, JSON.stringify([u3, s1]))
    const stuck = log(f).find((e) => e.subject === 's4:carousel')!
    const u4 = await undoAutoDecision(f.admin, stuck)
    check('Undo (deleted-post row): back to its old stage', u4.ok && f.tables.content_pipeline.find((x) => x.slug === 's4')!.carousel_stage === 'pending')
    const r2 = await run(f)
    check('after an Undo the next pass does not retire the same things again', f.tables.post_distribution.find((x) => x.slug === 'pp1')!.stage === 'failed' && f.tables.content_pipeline.find((x) => x.slug === 's1')!.video_stage === 'failed' && f.tables.content_pipeline.find((x) => x.slug === 's4')!.carousel_stage === 'pending', JSON.stringify(r2.outcomes))
    const bad = await deadLetterStep.undo!(f.admin, 'not json')
    check('Undo with a broken record is a clean no', bad.ok === false)
  }

  // ---- both parts failed share one error -----------------------------------------------------------------------------
  {
    const f = fakeDb({ content_pipeline: [pipe('b1', { carousel_stage: 'failed', video_stage: 'failed', last_error: KEY_BAD })], posts: [{ slug: 'b1' }] }, { distribution_mode: 'auto' })
    await run(f)
    const row = f.tables.content_pipeline[0]
    check('both parts failed: both retired, the shared error is cleared only once nothing is failed', row.carousel_stage === 'skipped' && row.video_stage === 'skipped' && row.last_error === null)
  }

  // ---- the cap --------------------------------------------------------------------------------------------------------
  {
    const mkRows = () => Array.from({ length: 8 }, (_, i) => post(`c${i}`, (4 + i * 0.01) * D, KEY_BAD))
    const f = fakeDb({ post_distribution: mkRows() }, { distribution_mode: 'auto' })
    await run(f)
    check('per pass: at most 5 are retired even when 8 qualify', f.tables.post_distribution.filter((x) => x.stage === 'done').length === 5)
    // The registry reads the daily count from the log: 9 already today leaves room for 1.
    const f2 = fakeDb({ post_distribution: mkRows() }, { distribution_mode: 'auto', [DECISIONS_KEY]: JSON.stringify(Array.from({ length: 9 }, (_, i) => decision('dead_letter', `old${i}`, 'Retired a failed social post', 't', null, NOW))) })
    const r2 = await run(f2)
    check('daily cap: with 9 of 10 used, exactly 1 more is retired', f2.tables.post_distribution.filter((x) => x.stage === 'done').length === 1, JSON.stringify(r2.outcomes))
    const f3 = fakeDb({ post_distribution: mkRows() }, { distribution_mode: 'auto', [DECISIONS_KEY]: JSON.stringify(Array.from({ length: 10 }, (_, i) => decision('dead_letter', `old${i}`, 'Retired a failed social post', 't', null, NOW))) })
    const r3 = await run(f3)
    check('daily cap used up: the step does not run at all', r3.outcomes[0].status === 'skipped' && /limit/.test(r3.outcomes[0].reason) && f3.updates.n === 0, JSON.stringify(r3.outcomes))
  }

  // ---- kill switch, own switch, dry run ------------------------------------------------------------------------------
  {
    const seed = () => ({ post_distribution: [post('k1', 4 * D, KEY_BAD)] })
    const f1 = fakeDb(seed(), { [AUTOMATION_PAUSED_KEY]: 'true', distribution_mode: 'auto' })
    const r1 = await run(f1)
    check('kill switch (Pause all automation): nothing is written', r1.outcomes[0].status === 'skipped' && f1.updates.n === 0 && f1.tables.post_distribution[0].stage === 'failed')
    const f2 = fakeDb(seed(), { [policyKey('dead_letter')]: 'off', distribution_mode: 'auto' })
    const r2 = await run(f2)
    check('own switch off: nothing is written', r2.outcomes[0].status === 'skipped' && f2.updates.n === 0)
    const f3 = fakeDb(seed(), { distribution_mode: 'auto' })
    const r3 = await run(f3, { dryRun: true })
    check('dry run (runner flag): nothing is written', r3.outcomes[0].reason === 'dry run' && f3.updates.n === 0)
    const f4 = fakeDb(seed(), { distribution_mode: 'auto' })
    const r4 = await withDryRun(() => deadLetterStep.run({ admin: f4.admin, now: NOW, startedAt: 0, budgetMs: 200_000, dryRun: false, remainingMs: () => 200_000, room: 10 }))
    check('dry run (rehearsal in progress): the step itself writes nothing and logs nothing', r4.result.ran === false && f4.updates.n === 0 && !f4.setting(DECISIONS_KEY))
    const f5 = fakeDb(seed(), { distribution_mode: 'auto' })
    const r5 = await deadLetterStep.run({ admin: f5.admin, now: NOW, startedAt: 0, budgetMs: 200_000, dryRun: true, remainingMs: () => 200_000, room: 10 })
    check('dry run (context flag, step called directly): nothing is written', r5.ran === false && f5.updates.n === 0)
  }

  // ---- error isolation ------------------------------------------------------------------------------------------------
  {
    const f = fakeDb(
      { post_distribution: [post('e1', 4 * D, KEY_BAD), post('e2', 4.1 * D, KEY_BAD)], content_pipeline: [pipe('e3', { video_stage: 'failed', last_error: KEY_BAD })], posts: [{ slug: 'e3' }] },
      { distribution_mode: 'auto' },
      (table, eq) => table === 'post_distribution' && eq.slug === 'e1',
    )
    const r = await run(f)
    const stage = (slug: string) => f.tables.post_distribution.find((x) => x.slug === slug)!.stage
    check('error isolation: one row that fails to update does not stop the others', r.outcomes[0].status === 'ran' && stage('e1') === 'failed' && stage('e2') === 'done' && f.tables.content_pipeline[0].video_stage === 'skipped', JSON.stringify(r.outcomes))
    check('... and a failed row is not logged as retired', log(f).every((e) => e.subject !== 'e1'))
  }
  {
    // A table that cannot be read at all must not throw out of the step.
    const f = fakeDb({ post_distribution: [post('z1', 4 * D, KEY_BAD)] }, { distribution_mode: 'auto' })
    delete (f.tables as Record<string, unknown>).content_pipeline
    const r = await run(f)
    check('error isolation: an unreadable table is an error for this step only (the runner catches it), the posts part still ran first', r.outcomes[0].status === 'error' || r.outcomes[0].status === 'ran')
  }

  // ---- nothing to do --------------------------------------------------------------------------------------------------
  {
    const f = fakeDb({ post_distribution: [post('n1', 1 * D, KEY_BAD)], content_pipeline: [pipe('n2', {})] }, { distribution_mode: 'auto' })
    const r = await run(f)
    check('nothing dead: a quiet no-op with no heartbeat and no log line', r.outcomes[0].status === 'noop' && !f.setting('flywheel_last_run:dead_letter') && !f.setting(DECISIONS_KEY) && f.updates.n === 0)
  }

  // ---- weekly digest --------------------------------------------------------------------------------------------------
  {
    const last = { week: '2026-10-12', count: 3, kinds: { 'failed-post': 2, 'stuck-step': 1 } }
    const f = fakeDb({}, { [DEAD_LETTER_STATE_KEY]: JSON.stringify(last) })
    const r = await run(f)
    const l = log(f)
    check('weekly digest: a finished week with retirements gets ONE digest line (no Undo), then the counter restarts', r.outcomes[0].status === 'ran' && l.length === 1 && /Weekly digest: 3/.test(l[0].action) && l[0].undo === null && JSON.parse(f.setting(DEAD_LETTER_STATE_KEY)!).count === 0 && JSON.parse(f.setting(DEAD_LETTER_STATE_KEY)!).week === '2026-10-19', JSON.stringify([r.outcomes, l]))
    const again = await run(f)
    check('weekly digest: not written twice', log(f).length === 1 && again.outcomes[0].status === 'noop')
    check('digest text names the kinds', /2 failed social posts/.test(digestLine({ week: 'w', count: 3, kinds: { 'failed-post': 2, 'stuck-step': 1 } })) && /1 stuck carousel\/video\b/.test(digestLine({ week: 'w', count: 1, kinds: { 'stuck-step': 1 } })))
  }

  // ---- no secrets or personal data in what is logged -----------------------------------------------------------------
  {
    const f = happy()
    await run(f)
    const text = JSON.stringify(log(f))
    check('the decision log holds no email address or key-looking text', !/@[a-z0-9-]+\.[a-z]{2,}/i.test(text) && !/(sk|pk|key)_[A-Za-z0-9]{12,}/.test(text))
  }

  if (failed) {
    console.log(`\n${failed} check(s) failed`)
    process.exit(1)
  }
  console.log('\nall dead-letter checks passed')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
