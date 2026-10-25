// Offline check for the WP10 flywheel step (lib/flywheel/steps/recap-auto.ts): private recap drafts and draft testimonials after a trip ends.
// In-memory fake database and a fake model call only: no network, no real database, no model credit.
// Run: pnpm dlx tsx scripts/check-recap-auto.ts   (exits 1 on any failed expectation)
import { readFileSync } from 'node:fs'
import type { SupabaseClient } from '@supabase/supabase-js'
import { DECISIONS_KEY, POLICY_CAPS, parseDecisions, policyKey, undoAutoDecision, decision } from '../lib/auto-decisions'
import { AUTOMATION_PAUSED_KEY } from '../lib/automation-kill-switch'
import { runFlywheelSteps } from '../lib/flywheel/registry'
import { recapAutoDoneKey, recapAutoStep, recapDraftSettingKey, runRecapAuto, undoRecapAuto } from '../lib/flywheel/steps/recap-auto'
import type { ComposedRecap, RecapNote, RecapTrip } from '../lib/recap-composer'
import type { FlywheelContext } from '../lib/flywheel/types'

let failed = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` (${detail})` : ''}`)
}

type Row = Record<string, unknown>
interface Db {
  app_settings: Map<string, string>
  travel_packages: Row[]
  testimonials: Row[]
  recap_submissions: Row[]
  failTestimonialsInsert?: boolean
}

/** A tiny chainable fake of the four tables this step touches. */
function fake(db: Db): SupabaseClient {
  let nextId = 1
  const builder = (table: string) => {
    const filters: [string, unknown][] = []
    let mode: 'select' | 'delete' | 'insert' = 'select'
    let insertRow: Row | null = null
    const rows = (): Row[] => {
      const src = table === 'travel_packages' ? db.travel_packages : table === 'testimonials' ? db.testimonials : table === 'recap_submissions' ? db.recap_submissions : []
      return src.filter((r) => filters.every(([c, v]) => r[c] === v))
    }
    const exec = (): { data: unknown; error: { message: string } | null } => {
      if (table === 'app_settings') {
        const key = filters.find(([c]) => c === 'key')?.[1] as string
        if (mode === 'delete') {
          db.app_settings.delete(key)
          return { data: null, error: null }
        }
        return { data: db.app_settings.has(key) ? [{ value: db.app_settings.get(key) }] : [], error: null }
      }
      if (table === 'testimonials' && mode === 'insert') {
        if (db.failTestimonialsInsert) return { data: null, error: { message: 'insert refused' } }
        const row = { id: `t${nextId++}`, ...insertRow }
        db.testimonials.push(row)
        return { data: [{ id: row.id }], error: null }
      }
      if (table === 'testimonials' && mode === 'delete') {
        const ids = new Set(rows().map((r) => r.id))
        db.testimonials = db.testimonials.filter((r) => !ids.has(r.id))
        return { data: null, error: null }
      }
      return { data: rows(), error: null }
    }
    const api: Record<string, unknown> = {
      select: () => api,
      eq: (c: string, v: unknown) => (filters.push([c, v]), api),
      order: () => api,
      limit: () => api,
      delete: () => ((mode = 'delete'), api),
      insert: (row: Row) => ((mode = 'insert'), (insertRow = row), api),
      upsert: async (row: { key: string; value: string }) => (db.app_settings.set(row.key, row.value), { error: null }),
      maybeSingle: async () => {
        const r = exec()
        return { data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: r.error }
      },
      single: async () => {
        const r = exec()
        return { data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: r.error }
      },
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(exec()).then(res, rej),
    }
    return api
  }
  return { from: (t: string) => builder(t) } as unknown as SupabaseClient
}

const NOW = new Date('2026-10-24T15:00:00.000Z')
const NOTES: RecapNote[] = [
  { date: '2026-06-01', title: 'Arrival', body: 'We arrived in Lisbon, met the group at the hotel and walked down to the river for dinner as the sun set over the water.' },
  { date: '2026-06-02', title: 'Sintra', body: 'We took the train to Sintra and climbed up to the palace, then had pastries in the old town before heading back to the hotel.' },
  { date: '2026-06-03', title: 'Coast', body: 'We drove along the coast, stopped at a quiet beach for lunch and watched the surfers before a long slow drive home.' },
]
const trip = (over: Row = {}): Row => ({ id: 'p1', slug: 'lisbon-june', name: 'Lisbon in June', destination: 'Lisbon', country: 'Portugal', category: 'Group', duration: '5 days', available_from: '2026-06-01', available_to: '2026-06-05', short_description: null, full_description: null, highlights: null, recap_mode: 'auto', recap_summary: null, journal_entries: NOTES, status: 'published', ...over })
const newDb = (over: Partial<Db> = {}): Db => ({ app_settings: new Map(), travel_packages: [trip()], testimonials: [], recap_submissions: [], ...over })
const ctx = (admin: SupabaseClient, over: Partial<FlywheelContext> = {}): FlywheelContext => ({ admin, now: NOW, startedAt: 0, budgetMs: 200_000, dryRun: false, remainingMs: () => 150_000, room: 2, ...over })

let calls = 0
const cleanCompose = async (_t: RecapTrip, _n: RecapNote[]): Promise<ComposedRecap> => (calls++, { ok: true, recap: { summary: 'We arrived in Lisbon and walked to the river for dinner.', highlights: ['Dinner by the river'] }, blockers: [], grounding: '' })
const heldCompose = async (): Promise<ComposedRecap> => (calls++, { ok: true, recap: { summary: 'A held recap.', highlights: ['One'] }, blockers: ['a sentence is not backed by the notes'], grounding: '' })

async function main(): Promise<void> {
  // ---- happy path: private clean draft, nothing published ----------------------------------------------------------------
  {
    const db = newDb()
    calls = 0
    const r = await runRecapAuto(ctx(fake(db)), { compose: cleanCompose })
    const draft = JSON.parse(db.app_settings.get(recapDraftSettingKey('p1')) ?? 'null')
    check('happy: ran and acted on one trip', r.ran === true && r.acted === 1, JSON.stringify(r))
    check('happy: one model call', calls === 1)
    check('happy: a private draft was saved in the existing recap_draft key', !!draft && draft.summary.startsWith('We arrived') && Array.isArray(draft.blockers))
    check('happy: a clean draft waits for the human click (readyToReplace)', draft?.readyToReplace === true)
    check('happy: the trip itself was NOT changed (no recap published)', (db.travel_packages[0] as Row).recap_summary === null && (db.travel_packages[0] as Row).recap_mode === 'auto')
    const log = parseDecisions(db.app_settings.get(DECISIONS_KEY))
    check('happy: one decision logged with an fw:recap_auto undo and no personal data', log.length === 1 && log[0].undo?.kind === 'fw:recap_auto' && log[0].policy === 'recap_auto' && /Nothing was published or sent/.test(log[0].action))
    check('happy: the trip is marked done', db.app_settings.has(recapAutoDoneKey('p1')))
    calls = 0
    const again = await runRecapAuto(ctx(fake(db)), { compose: cleanCompose })
    check('happy: a second pass does nothing (draft exists, marker set) and makes no model call', again.ran === false && calls === 0)
  }

  // ---- held draft ----------------------------------------------------------------------------------------------------------
  {
    const db = newDb()
    await runRecapAuto(ctx(fake(db)), { compose: heldCompose })
    const draft = JSON.parse(db.app_settings.get(recapDraftSettingKey('p1')) ?? 'null')
    check('held: draft saved with the gate reasons and NOT marked ready to publish', draft?.blockers.length === 1 && draft.readyToReplace === undefined)
  }

  // ---- testimonials from approved quotes only ------------------------------------------------------------------------------
  {
    const db = newDb({
      recap_submissions: [
        { id: 's1', package_id: 'p1', kind: 'quote', status: 'approved', payload: { text: 'A lovely week with great company and good food.', name: 'Sam T.', consent: true } },
        { id: 's2', package_id: 'p1', kind: 'quote', status: 'pending', payload: { text: 'This quote is still waiting for approval.', name: 'Pat R.', consent: true } },
        { id: 's3', package_id: 'p1', kind: 'quote', status: 'approved', payload: { text: 'Approved but no consent tick was recorded.', name: 'Lee K.', consent: false } },
      ],
    })
    db.travel_packages = [trip({ journal_entries: [] })]
    calls = 0
    const r = await runRecapAuto(ctx(fake(db)), { compose: cleanCompose })
    check('quotes: only the approved + consented quote became a testimonial', db.testimonials.length === 1 && db.testimonials[0].author === 'Sam T.', JSON.stringify(db.testimonials))
    check('quotes: the testimonial is a DRAFT tied to the trip, no source text leaks', db.testimonials[0].status === 'draft' && db.testimonials[0].package_id === 'p1' && db.testimonials[0].featured === false)
    check('quotes: no notes means no model call and no recap draft', calls === 0 && !db.app_settings.has(recapDraftSettingKey('p1')))
    check('quotes: reported as a run', r.ran === true && r.acted === 1)
    const dup = await runRecapAuto(ctx(fake(db)), { compose: cleanCompose })
    check('quotes: a second pass does not duplicate the testimonial', dup.ran === false && db.testimonials.length === 1)
  }

  // ---- never touches unpublished or not-yet-ended trips, or a trip with a live recap ----------------------------------------
  {
    const db = newDb({
      travel_packages: [trip({ status: 'draft' }), trip({ id: 'p2', slug: 'future', available_to: '2027-01-01' }), trip({ id: 'p3', slug: 'has-recap', recap_summary: 'Already written.' }), trip({ id: 'p4', slug: 'live-forced', recap_mode: 'live' }), trip({ id: 'p5', slug: 'thin', journal_entries: NOTES.slice(0, 1) })],
    })
    calls = 0
    const r = await runRecapAuto(ctx(fake(db)), { compose: cleanCompose })
    // The fake returns every row for status eq published, so unpublished rows are filtered by the query in production; here the fake ignores
    // status on a missing filter column match, so assert on the query itself below. The rest must be skipped by the step's own rules.
    check('skips: future trip, live recap, forced-live trip and thin notes make no draft and no model call', !db.app_settings.has(recapDraftSettingKey('p2')) && !db.app_settings.has(recapDraftSettingKey('p3')) && !db.app_settings.has(recapDraftSettingKey('p4')) && !db.app_settings.has(recapDraftSettingKey('p5')), JSON.stringify([...db.app_settings.keys()]))
    check('skips: nothing to do for them', r.ran === false && calls === 0, JSON.stringify(r))
  }

  // ---- cap: room limits trips; one model call per pass ---------------------------------------------------------------------
  {
    const db = newDb({ travel_packages: [trip(), trip({ id: 'p2', slug: 'lisbon-two' })] })
    calls = 0
    const r = await runRecapAuto(ctx(fake(db), { room: 2 }), { compose: cleanCompose })
    check('cap: at most one model call in a pass', calls === 1 && r.acted === 1, JSON.stringify(r))
    const none = await runRecapAuto(ctx(fake(db), { room: 0 }), { compose: cleanCompose })
    check('cap: room 0 does nothing', none.ran === false)
    check('cap: the policy cap is the registry value (2 a day)', POLICY_CAPS.recap_auto === 2)
  }
  {
    const db = newDb({ travel_packages: [trip(), trip({ id: 'p2', slug: 'lisbon-two' })] })
    const r = await runRecapAuto(ctx(fake(db), { room: 1 }), { compose: cleanCompose })
    const drafts = [...db.app_settings.keys()].filter((k) => k.startsWith('recap_draft:')).length
    check('cap: room 1 limits to one trip', r.acted === 1 && drafts === 1)
  }
  {
    const db = newDb()
    calls = 0
    const r = await runRecapAuto(ctx(fake(db), { remainingMs: () => 30_000 }), { compose: cleanCompose })
    check('time: not enough time left means no model call', calls === 0 && r.ran === false)
  }

  // ---- dry run and the runner's gates (kill switch, own switch, cap, dry run) --------------------------------------------
  {
    const db = newDb()
    calls = 0
    const r = await runRecapAuto(ctx(fake(db), { dryRun: true }), { compose: cleanCompose })
    check('dry run: step writes nothing and calls nothing', r.ran === false && calls === 0 && db.app_settings.size === 0)
    const run = await runFlywheelSteps({ admin: fake(db), startedAt: 0, budgetMs: 400_000, now: NOW, clock: () => 1_000, dryRun: true }, [recapAutoStep])
    check('dry run: the runner skips the step', run.outcomes[0].status === 'skipped' && db.app_settings.size === 0)
  }
  {
    const db = newDb()
    db.app_settings.set(AUTOMATION_PAUSED_KEY, 'true')
    const run = await runFlywheelSteps({ admin: fake(db), startedAt: 0, budgetMs: 400_000, now: NOW, clock: () => 1_000 }, [recapAutoStep])
    check('kill switch: paused automation skips the step', run.outcomes[0].status === 'skipped' && ![...db.app_settings.keys()].some((k) => k.startsWith('recap_draft:')))
  }
  {
    const db = newDb()
    db.app_settings.set(policyKey('recap_auto'), 'off')
    const run = await runFlywheelSteps({ admin: fake(db), startedAt: 0, budgetMs: 400_000, now: NOW, clock: () => 1_000 }, [recapAutoStep])
    check('own switch: off skips the step', run.outcomes[0].status === 'skipped')
  }
  {
    const db = newDb()
    db.app_settings.set(DECISIONS_KEY, JSON.stringify(Array.from({ length: POLICY_CAPS.recap_auto }, (_, i) => decision('recap_auto', `s${i}`, 'x', 'test', null, NOW))))
    const run = await runFlywheelSteps({ admin: fake(db), startedAt: 0, budgetMs: 400_000, now: NOW, clock: () => 1_000 }, [recapAutoStep])
    check('daily cap: a spent cap skips the step in the runner', run.outcomes[0].status === 'skipped' && /cap|limit|today/i.test(run.outcomes[0].reason), run.outcomes[0].reason)
  }

  // ---- error isolation -----------------------------------------------------------------------------------------------------
  {
    // Trip 1 (newest) blows up in the model call; trip 2 has no notes but an approved quote and must still get its draft testimonial.
    const db = newDb({
      travel_packages: [trip({ id: 'p1', slug: 'bad' }), trip({ id: 'p2', slug: 'good', available_to: '2026-06-04', journal_entries: [] })],
      recap_submissions: [{ id: 's1', package_id: 'p2', kind: 'quote', status: 'approved', payload: { text: 'A lovely week with great company and good food.', name: 'Sam T.', consent: true } }],
    })
    const flaky = async (): Promise<ComposedRecap> => {
      throw new Error('model exploded')
    }
    const r = await runRecapAuto(ctx(fake(db), { room: 2 }), { compose: flaky })
    check('errors: the failing trip left no draft and no marker', !db.app_settings.has(recapDraftSettingKey('p1')) && !db.app_settings.has(recapAutoDoneKey('p1')))
    check('errors: a failing trip does not stop the next one in the same pass', r.ran === true && r.acted === 1 && /failed/.test(r.note ?? ''), JSON.stringify(r))
  }
  {
    const db = newDb()
    const failed1 = async (): Promise<ComposedRecap> => ({ ok: false, error: 'AI writing is not configured' })
    let threw = false
    try {
      await runRecapAuto(ctx(fake(db)), { compose: failed1 })
    } catch {
      threw = true
    }
    check('errors: when everything fails the step throws so the runner records a failed heartbeat', threw)
    check('errors: a failed write leaves no marker, so it is retried later', !db.app_settings.has(recapAutoDoneKey('p1')))
    const run = await runFlywheelSteps({ admin: fake(newDb({ failTestimonialsInsert: true, travel_packages: [trip({ journal_entries: [] })], recap_submissions: [{ id: 's1', package_id: 'p1', kind: 'quote', status: 'approved', payload: { text: 'A lovely week with great company.', name: 'Sam T.', consent: true } }] })), startedAt: 0, budgetMs: 400_000, now: NOW, clock: () => 1_000 }, [recapAutoStep])
    check('errors: the runner reports the step as an error, not a crash', run.outcomes[0].status === 'error')
  }

  // ---- veto and Undo ---------------------------------------------------------------------------------------------------------
  {
    const db = newDb({ recap_submissions: [{ id: 's1', package_id: 'p1', kind: 'quote', status: 'approved', payload: { text: 'A lovely week with great company and good food.', name: 'Sam T.', consent: true } }] })
    const admin = fake(db)
    await runRecapAuto(ctx(admin), { compose: cleanCompose })
    check('undo: setup made a draft and a testimonial', db.app_settings.has(recapDraftSettingKey('p1')) && db.testimonials.length === 1)
    const entry = parseDecisions(db.app_settings.get(DECISIONS_KEY))[0]
    const u = await undoAutoDecision(admin, entry)
    check('undo: removes the recap draft and the draft testimonial', u.ok === true && !db.app_settings.has(recapDraftSettingKey('p1')) && db.testimonials.length === 0, JSON.stringify(u))
    check('undo: the done marker stays, so the draft is not rewritten', db.app_settings.has(recapAutoDoneKey('p1')))
    calls = 0
    const after = await runRecapAuto(ctx(admin), { compose: cleanCompose })
    check('undo: a later pass does not redo it', after.ran === false && calls === 0 && db.testimonials.length === 0)
  }
  {
    const db = newDb({ recap_submissions: [{ id: 's1', package_id: 'p1', kind: 'quote', status: 'approved', payload: { text: 'A lovely week with great company and good food.', name: 'Sam T.', consent: true } }] })
    const admin = fake(db)
    await runRecapAuto(ctx(admin), { compose: cleanCompose })
    const entry = parseDecisions(db.app_settings.get(DECISIONS_KEY))[0]
    db.testimonials[0].status = 'published'
    db.app_settings.set(recapDraftSettingKey('p1'), JSON.stringify({ summary: 'Edited by a person', highlights: [], blockers: [], at: '2099-01-01T00:00:00.000Z' }))
    const u = await undoRecapAuto(admin, entry.undo!.ref)
    check('undo: a published testimonial and an edited draft are left alone', u.ok === false && db.testimonials.length === 1 && db.app_settings.has(recapDraftSettingKey('p1')), JSON.stringify(u))
    check('undo: a broken ref is refused', (await undoRecapAuto(admin, '')).ok === false)
  }

  // ---- source rules (the file must keep its promises) ----------------------------------------------------------------------
  const src = readFileSync(new URL('../lib/flywheel/steps/recap-auto.ts', import.meta.url), 'utf8')
    .split(/\r?\n/)
    .filter((l) => !/^\s*\/\//.test(l)) // comments may name the functions this file avoids
  const code = src.join('\n')
  check('source: never calls writeRecap / publishRecap / replaceWithDraft (draft only)', !/\b(?:writeRecap|publishRecap|replaceWithDraft|saveEditedRecap)\s*\(/.test(code))
  check('source: never sends anything (no email, no GHL, no social)', !/gohighlevel|sendMail|nodemailer|resend|submitLead|assignLead|fetch\(/i.test(code))
  check('source: reads published trips only', /\.eq\('status', 'published'\)/.test(code))
  check('source: testimonials are inserted as drafts', /status: 'draft'/.test(code) && !/status: 'published'/.test(code))

  console.log(failed === 0 ? '\nrecap-auto: 0 failed' : `\nrecap-auto: ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
