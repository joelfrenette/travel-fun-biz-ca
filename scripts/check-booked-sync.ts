// Offline check for WP2, the order to lead booked sync (lib/flywheel/steps/booked-sync.ts): happy path, the daily cap, the kill switch and
// the step's own switch (through the runner), dry run, error isolation, Undo, "once per order", and that nothing but status/note/first
// contact is written. In-memory fake database only: no network, no real database.
// Run: pnpm dlx tsx scripts/check-booked-sync.ts   (exits 1 on any failed expectation)
import type { SupabaseClient } from '@supabase/supabase-js'
import { AUTOMATION_PAUSED_KEY } from '../lib/automation-kill-switch'
import { DECISIONS_KEY, POLICY_CAPS, parseDecisions, policyKey } from '../lib/auto-decisions'
import { runFlywheelSteps, undoFlywheel } from '../lib/flywheel/registry'
import { DONE_KEY, bookedNote, bookedSyncStep } from '../lib/flywheel/steps/booked-sync'
import type { FlywheelContext } from '../lib/flywheel/types'

let failed = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` (${detail})` : ''}`)
}

type Row = Record<string, unknown>
interface Db {
  orders: Row[]
  leads: Row[]
  app_settings: Row[]
}

/** A small fake of the tables this step touches, with the query methods it uses. `failOrders` makes the orders read error. */
function fake(db: Db, opts: { failOrders?: boolean } = {}): SupabaseClient {
  const likeToRe = (p: string): RegExp => new RegExp(`^${p.replace(/\\([\\%_])/g, '\u0001$1').replace(/[.*+?^${}()|[\]]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.').replace(/\u0001(.)/g, (_m, c: string) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))}$`, 'i')
  return {
    from(table: keyof Db) {
      const rows = db[table]
      if (!rows) throw new Error(`unexpected table ${String(table)}`)
      const filters: Array<(r: Row) => boolean> = []
      let order: { col: string; asc: boolean } | null = null
      let lim = Infinity
      let patch: Row | null = null
      let upsertRow: Row | null = null
      const result = (): { data: Row[]; error: { message: string } | null } => {
        if (table === 'orders' && opts.failOrders) return { data: [], error: { message: 'orders unavailable' } }
        if (patch) {
          for (const r of rows.filter((x) => filters.every((f) => f(x)))) Object.assign(r, patch)
          return { data: [], error: null }
        }
        if (upsertRow) {
          const i = rows.findIndex((r) => r.key === upsertRow!.key)
          if (i >= 0) rows[i] = { ...rows[i], ...upsertRow }
          else rows.push({ ...upsertRow })
          return { data: [], error: null }
        }
        let out = rows.filter((x) => filters.every((f) => f(x)))
        if (order) out = [...out].sort((a, b) => (String(a[order!.col]) < String(b[order!.col]) ? -1 : 1) * (order!.asc ? 1 : -1))
        return { data: out.slice(0, lim).map((r) => ({ ...r })), error: null }
      }
      const b: Record<string, unknown> = {
        select: () => b,
        eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), b),
        gte: (c: string, v: string) => (filters.push((r) => String(r[c]) >= v), b),
        ilike: (c: string, p: string) => {
          const re = likeToRe(p)
          return filters.push((r) => re.test(String(r[c] ?? ''))), b
        },
        order: (c: string, o: { ascending: boolean }) => ((order = { col: c, asc: o.ascending }), b),
        limit: (n: number) => ((lim = n), b),
        update: (p: Row) => ((patch = p), b),
        upsert: (r: Row) => ((upsertRow = r), Promise.resolve(result())),
        maybeSingle: () => {
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
const leadOf = (db: Db, id: string): Row => db.leads.find((l) => l.id === id) as Row
const order = (id: string, email: string | null, over: Row = {}): Row => ({ id, email, status: 'paid', is_test: false, package_slug: 'bali-escape', created_at: iso(0.1), amount_cents: 123456, ...over })
const lead = (id: string, email: string, over: Row = {}): Row => ({ id, email, status: 'new', is_test: false, desk_note: null, first_contact_at: null, created_at: iso(3), ...over })

function ctx(admin: SupabaseClient, over: Partial<FlywheelContext> = {}): FlywheelContext {
  return { admin, now: NOW, startedAt: 0, budgetMs: 200_000, dryRun: false, remainingMs: () => 100_000, room: POLICY_CAPS.booked_sync, ...over }
}

async function main(): Promise<void> {
  // ---- happy path ---------------------------------------------------------------------------------------------------
  {
    const db: Db = { orders: [order('o1', 'Ann@Example-Travel.ca')], leads: [lead('l1', 'ann@example-travel.ca', { desk_note: 'called twice', status: 'contacted', first_contact_at: iso(2) })], app_settings: [] }
    const r = await bookedSyncStep.run(ctx(fake(db)))
    check('happy: the step ran and acted once', r.ran === true && r.acted === 1, JSON.stringify(r))
    check('happy: the lead is booked (email matched case-insensitively)', leadOf(db, 'l1').status === 'booked')
    check('happy: the old note is kept and the package slug is added', String(leadOf(db, 'l1').desk_note).includes('called twice') && String(leadOf(db, 'l1').desk_note).includes('bali-escape'))
    check('happy: no price anywhere in the note', !/123456|1234\.56|\$/.test(String(leadOf(db, 'l1').desk_note)))
    check('happy: first contact time kept', leadOf(db, 'l1').first_contact_at === iso(2))
    const log = parseDecisions(setting(db, DECISIONS_KEY))
    check('happy: one decision line with an fw:booked_sync undo', log.length === 1 && log[0].policy === 'booked_sync' && log[0].undo?.kind === 'fw:booked_sync' && log[0].undo.ref === 'o1', JSON.stringify(log))
    check('happy: no email in the log', !JSON.stringify(log).includes('example-travel'))
    check('happy: assignment untouched', !('assigned_agent_id' in leadOf(db, 'l1')))

    // once per order
    leadOf(db, 'l1').status = 'contacted'
    const again = await bookedSyncStep.run(ctx(fake(db)))
    check('once: a second pass does nothing for the same order', again.ran === false && leadOf(db, 'l1').status === 'contacted', JSON.stringify(again))

    // ---- undo ------------------------------------------------------------------------------------------------------
  }
  {
    const db: Db = { orders: [order('o1', 'ann@x.ca')], leads: [lead('l1', 'ann@x.ca', { desk_note: 'called twice', status: 'contacted', first_contact_at: iso(2) })], app_settings: [] }
    const admin = fake(db)
    await bookedSyncStep.run(ctx(admin))
    const u = await undoFlywheel(admin, 'booked_sync', 'o1')
    check('undo: ok', u.ok === true, u.message)
    check('undo: status, note and first contact restored', leadOf(db, 'l1').status === 'contacted' && leadOf(db, 'l1').desk_note === 'called twice' && leadOf(db, 'l1').first_contact_at === iso(2))
    const u2 = await undoFlywheel(admin, 'booked_sync', 'o1')
    check('undo: a second undo is refused', u2.ok === false)
    const r = await bookedSyncStep.run(ctx(admin))
    check('undo: the order is not booked again afterwards', r.ran === false && leadOf(db, 'l1').status === 'contacted', JSON.stringify(r))
    check('undo: unknown ref is refused', (await undoFlywheel(admin, 'booked_sync', 'nope')).ok === false)
  }
  {
    const db: Db = { orders: [order('o1', 'ann@x.ca')], leads: [lead('l1', 'ann@x.ca')], app_settings: [] }
    const admin = fake(db)
    await bookedSyncStep.run(ctx(admin))
    leadOf(db, 'l1').status = 'lost'
    const u = await undoFlywheel(admin, 'booked_sync', 'o1')
    check('undo: leaves a lead a person changed since', u.ok === false && leadOf(db, 'l1').status === 'lost', u.message)
    const db2: Db = { orders: [order('o1', 'ann@x.ca')], leads: [lead('l1', 'ann@x.ca')], app_settings: [] }
    const a2 = fake(db2)
    await bookedSyncStep.run(ctx(a2))
    await undoFlywheel(a2, 'booked_sync', 'o1')
    check('undo: a never-contacted lead goes back to new with no first contact', leadOf(db2, 'l1').status === 'new' && leadOf(db2, 'l1').first_contact_at === null)
  }

  // ---- what is NOT booked -------------------------------------------------------------------------------------------
  {
    const db: Db = {
      orders: [
        order('t1', 'a@x.ca', { is_test: true }),
        order('t2', 'fake@example.com'),
        order('t3', 'refund@x.ca', { status: 'refunded' }),
        order('t4', 'old@x.ca', { created_at: iso(30) }),
        order('t5', null),
        order('t6', 'nolead@x.ca'),
        order('t7', 'lost@x.ca'),
        order('t8', 'booked@x.ca'),
        order('t9', 'testlead@x.ca'),
      ],
      leads: [lead('a', 'a@x.ca'), lead('b', 'refund@x.ca'), lead('c', 'old@x.ca'), lead('d', 'lost@x.ca', { status: 'lost' }), lead('e', 'booked@x.ca', { status: 'booked' }), lead('f', 'testlead@x.ca', { is_test: true })],
      app_settings: [],
    }
    const r = await bookedSyncStep.run(ctx(fake(db)))
    check('skip: test, fake-email, refunded, old, no-email, no-lead, lost, already booked and test-lead orders change nothing', r.ran === false && ['new', 'new', 'new', 'lost', 'booked', 'new'].every((s, i) => db.leads[i].status === s), JSON.stringify(r))
    check('skip: an unmatched order logs nothing', parseDecisions(setting(db, DECISIONS_KEY)).length === 0)
  }
  {
    // lead arrives after the order: still matched on a later pass; an old unmatched order is remembered as no-lead
    const db: Db = { orders: [order('n1', 'late@x.ca', { created_at: iso(5) }), order('n2', 'soon@x.ca', { created_at: iso(0.5) })], leads: [], app_settings: [] }
    await bookedSyncStep.run(ctx(fake(db)))
    const m = JSON.parse(setting(db, DONE_KEY) ?? '{}')
    check('no-lead: an order older than the re-check period is remembered, a fresh one is not', m.n1?.result === 'no-lead' && !m.n2)
    db.leads.push(lead('l9', 'soon@x.ca'))
    const r = await bookedSyncStep.run(ctx(fake(db)))
    check('no-lead: a lead that shows up later is still matched', r.ran === true && leadOf(db, 'l9').status === 'booked')
  }
  {
    const db: Db = { orders: [order('o1', 'dup@x.ca')], leads: [lead('old', 'dup@x.ca', { status: 'lost', created_at: iso(9) }), lead('new1', 'dup@x.ca', { created_at: iso(2) }), lead('new0', 'dup@x.ca', { created_at: iso(6) })], app_settings: [] }
    await bookedSyncStep.run(ctx(fake(db)))
    check('multi: only the most recent open lead is booked', leadOf(db, 'new1').status === 'booked' && leadOf(db, 'new0').status === 'new' && leadOf(db, 'old').status === 'lost')
  }

  // ---- cap ----------------------------------------------------------------------------------------------------------
  {
    const orders = [1, 2, 3, 4, 5].map((i) => order(`o${i}`, `p${i}@x.ca`, { created_at: iso(1 + i / 10) }))
    const leads = [1, 2, 3, 4, 5].map((i) => lead(`l${i}`, `p${i}@x.ca`))
    const db: Db = { orders, leads, app_settings: [] }
    const r = await bookedSyncStep.run(ctx(fake(db), { room: 2 }))
    check('cap: stops at the room it is given', r.acted === 2 && db.leads.filter((l) => l.status === 'booked').length === 2, JSON.stringify(r))
    const r0 = await bookedSyncStep.run(ctx(fake(db), { room: 0 }))
    check('cap: no room means no work', r0.ran === false && db.leads.filter((l) => l.status === 'booked').length === 2)
    const rest = await bookedSyncStep.run(ctx(fake(db), { room: 10 }))
    check('cap: the next day picks up the rest', rest.acted === 3 && db.leads.every((l) => l.status === 'booked'))
  }
  {
    // the runner's own cap: 10 decisions today leaves no room
    const db: Db = { orders: [order('o1', 'cap@x.ca')], leads: [lead('l1', 'cap@x.ca')], app_settings: [] }
    const full = Array.from({ length: POLICY_CAPS.booked_sync }, (_v, i) => ({ at: NOW.toISOString(), policy: 'booked_sync', subject: `s${i}`, action: 'x', reason: 'y', undo: null }))
    db.app_settings.push({ key: DECISIONS_KEY, value: JSON.stringify(full) })
    const out = await runFlywheelSteps({ admin: fake(db), startedAt: 0, budgetMs: 200_000, now: NOW, clock: () => 1_000 }, [bookedSyncStep])
    check('cap via runner: a full day skips the step', out.outcomes[0]?.status === 'skipped' && leadOf(db, 'l1').status === 'new', JSON.stringify(out.outcomes))
  }

  // ---- kill switch, own switch, dry run ----------------------------------------------------------------------------
  {
    const mk = (): Db => ({ orders: [order('o1', 'k@x.ca')], leads: [lead('l1', 'k@x.ca')], app_settings: [] })
    const run = (db: Db, extra: { dryRun?: boolean } = {}) => runFlywheelSteps({ admin: fake(db), startedAt: 0, budgetMs: 200_000, now: NOW, clock: () => 1_000, ...extra }, [bookedSyncStep])

    const dbOn = mk()
    const on = await run(dbOn)
    check('runner: works by default (switch unset)', on.outcomes[0]?.status === 'ran' && leadOf(dbOn, 'l1').status === 'booked', JSON.stringify(on.outcomes))

    const dbOff = mk()
    dbOff.app_settings.push({ key: policyKey('booked_sync'), value: 'off' })
    const off = await run(dbOff)
    check('own switch off: nothing happens', off.outcomes[0]?.status === 'skipped' && leadOf(dbOff, 'l1').status === 'new', JSON.stringify(off.outcomes))

    const dbKill = mk()
    dbKill.app_settings.push({ key: AUTOMATION_PAUSED_KEY, value: 'true' })
    const kill = await run(dbKill)
    check('kill switch (pause all): nothing happens', kill.outcomes[0]?.status === 'skipped' && leadOf(dbKill, 'l1').status === 'new', JSON.stringify(kill.outcomes))

    const dbDry = mk()
    const dry = await run(dbDry, { dryRun: true })
    check('dry run via runner: nothing happens', dry.outcomes[0]?.status === 'skipped' && leadOf(dbDry, 'l1').status === 'new' && setting(dbDry, DONE_KEY) === null)
    const dbDry2 = mk()
    const direct = await bookedSyncStep.run(ctx(fake(dbDry2), { dryRun: true }))
    check('dry run direct call: no write, no log', direct.ran === false && leadOf(dbDry2, 'l1').status === 'new' && setting(dbDry2, DONE_KEY) === null && setting(dbDry2, DECISIONS_KEY) === null)
  }

  // ---- error isolation ----------------------------------------------------------------------------------------------
  {
    const db: Db = { orders: [order('o1', 'e@x.ca')], leads: [lead('l1', 'e@x.ca')], app_settings: [] }
    const out = await runFlywheelSteps({ admin: fake(db, { failOrders: true }), startedAt: 0, budgetMs: 200_000, now: NOW, clock: () => 1_000 }, [bookedSyncStep, { ...bookedSyncStep, id: 'lead_retry', policy: 'lead_retry', order: 30, run: async () => ({ ran: true, note: 'second step still ran', acted: 1 }) }])
    check('error: a failed orders read is an error for this step only', out.outcomes[0]?.status === 'error' && out.outcomes[1]?.status === 'ran', JSON.stringify(out.outcomes))
    check('error: nothing was changed', leadOf(db, 'l1').status === 'new')
    // one lead's write failing does not stop the next lead
    const db2: Db = { orders: [order('o1', 'a@x.ca', { created_at: iso(2) }), order('o2', 'b@x.ca', { created_at: iso(1) })], leads: [lead('la', 'a@x.ca'), lead('lb', 'b@x.ca')], app_settings: [] }
    const base = fake(db2)
    const flaky = {
      from(t: string) {
        const q = (base as unknown as { from: (t: string) => Record<string, unknown> }).from(t)
        if (t !== 'leads') return q
        return new Proxy(q, {
          get(target, prop) {
            if (prop === 'update') return () => ({ eq: () => Promise.resolve({ error: { message: 'write failed' } }) })
            return target[prop as string]
          },
        })
      },
    } as unknown as SupabaseClient
    let threw = ''
    try {
      await bookedSyncStep.run(ctx(flaky))
    } catch (e) {
      threw = e instanceof Error ? e.message : ''
    }
    check('error: every write failing surfaces as an error, no decision logged', threw.includes('could not mark') && setting(db2, DECISIONS_KEY) === null, threw)
  }

  // ---- pure note helper ---------------------------------------------------------------------------------------------
  check('note: capped at 500 characters and keeps the booked line', bookedNote('x'.repeat(900), 'bali').length <= 500 && bookedNote('x'.repeat(900), 'bali').endsWith('(package: bali).'))
  check('note: no slug, no old note', bookedNote(null, null) === 'Marked booked automatically from a paid order.')

  console.log(failed === 0 ? '\n0 failed' : `\n${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
