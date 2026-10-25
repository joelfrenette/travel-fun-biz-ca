// Offline check for WP3, the Lead to GoHighLevel retry ladder (lib/lead-retry-ladder.ts, lib/flywheel/steps/lead-retry.ts, healLeads in lib/heal.ts).
// Covers: the pure ladder, the happy path, the hand-over to a person, the daily cap, the kill switch and the policy switch, dry run, error
// isolation, Undo (stop and reopen, with the veto), and the legacy healLeads share. In-memory fake database and fake send/alert only:
// no network, no real database, no GoHighLevel call (its env is cleared).
// Run: pnpm dlx tsx scripts/check-lead-retry.ts   (exits 1 on any failed expectation)
import type { SupabaseClient } from '@supabase/supabase-js'
import { AUTOMATION_PAUSED_KEY } from '../lib/automation-kill-switch'
import { DECISIONS_KEY, POLICY_CAPS, decision, parseDecisions, policyKey, undoAutoDecision, type AutoDecision } from '../lib/auto-decisions'
import { runFlywheelSteps } from '../lib/flywheel/registry'
import { leadRetryStep, runLeadRetry, undoLeadRetry, type LeadRetryDeps } from '../lib/flywheel/steps/lead-retry'
import type { FlywheelContext, FlywheelStep } from '../lib/flywheel/types'
import { healLeads, type LeadRow } from '../lib/heal'
import { HEAL_TRIES, LADDER_TRIES, LADDER_WAITS_MIN, LADDER_WINDOW_MS, needsPerson, parseLeadMarker, retryDue, retryMarker, stripMarker } from '../lib/lead-retry-ladder'

for (const k of ['GOHIGHLEVEL_PRIVATE_TOKEN', 'GOHIGHLEVEL_API_KEY', 'GOHIGHLEVEL_LOCATION_ID', 'LOCATION_ID']) delete process.env[k]

let failed = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` (${detail})` : ''}`)
}

type Row = Record<string, unknown>
const NOW = new Date('2026-10-24T15:00:00.000Z')
const HOUR = 3_600_000
const ago = (ms: number): string => new Date(NOW.getTime() - ms).toISOString()

/** A fake of the two tables used: app_settings and leads. Supports select/eq/lt/gt/order/limit/maybeSingle, update().eq() and upsert. */
function fakeAdmin(seedSettings: Record<string, string> = {}, leads: Row[] = []): { admin: SupabaseClient; settings: Map<string, string>; leads: Row[] } {
  const settings = new Map<string, string>(Object.entries(seedSettings))
  type Filter = (r: Row) => boolean
  class Q implements PromiseLike<{ data: Row[] | Row | null; error: { message: string } | null }> {
    private filters: Filter[] = []
    private max = Infinity
    private orderBy: { col: string; asc: boolean } | null = null
    constructor(private rows: Row[], private patch: Row | null) {}
    eq(col: string, v: unknown): this { this.filters.push((r) => r[col] === v); return this }
    lt(col: string, v: string): this { this.filters.push((r) => String(r[col]) < v); return this }
    gt(col: string, v: string): this { this.filters.push((r) => String(r[col]) > v); return this }
    order(col: string, o: { ascending: boolean }): this { this.orderBy = { col, asc: o.ascending }; return this }
    limit(n: number): this { this.max = n; return this }
    private matched(): Row[] {
      let out = this.rows.filter((r) => this.filters.every((f) => f(r)))
      if (this.orderBy) { const { col, asc } = this.orderBy; out = [...out].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : 1) * (asc ? 1 : -1)) }
      return out.slice(0, this.max)
    }
    async maybeSingle(): Promise<{ data: Row | null; error: null }> { return { data: this.matched()[0] ?? null, error: null } }
    then<A, B>(ok?: ((v: { data: Row[] | Row | null; error: { message: string } | null }) => A | PromiseLike<A>) | null, bad?: ((e: unknown) => B | PromiseLike<B>) | null): PromiseLike<A | B> {
      const run = async () => {
        if (this.patch) { for (const r of this.matched()) Object.assign(r, this.patch); return { data: null, error: null } }
        return { data: this.matched(), error: null }
      }
      return run().then(ok, bad)
    }
  }
  const admin = {
    from(table: string) {
      if (table === 'app_settings') {
        return {
          select: () => ({ eq: (_c: string, key: string) => ({ maybeSingle: async () => ({ data: settings.has(key) ? { value: settings.get(key) } : null, error: null }) }) }),
          upsert: async (row: { key: string; value: string }) => { settings.set(row.key, row.value); return { error: null } },
        }
      }
      if (table === 'leads') return { select: () => new Q(leads, null), update: (patch: Row) => new Q(leads, patch) }
      throw new Error(`unexpected table ${table}`)
    },
  } as unknown as SupabaseClient
  return { admin, settings, leads }
}

let seq = 0
function lead(over: Row = {}): Row {
  seq++
  return { id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`, created_at: ago(30 * HOUR), name: 'Test Person', email: `person${seq}@example.com`, phone: null, package: 'Alps', travel_date: null, travelers: null, message: null, utm_source: null, utm_medium: null, utm_campaign: null, utm_content: null, page_path: null, ghl_error: null, forwarded_to_ghl: false, is_test: false, ...over }
}
const dueLead = (over: Row = {}): Row => lead({ created_at: ago(30 * HOUR), ghl_error: retryMarker(3, 'GoHighLevel responded 500', new Date(NOW.getTime() - 25 * HOUR)), ...over })

function deps(over: Partial<LeadRetryDeps> = {}): { d: LeadRetryDeps; sent: string[]; alerts: string[][] } {
  const sent: string[] = []
  const alerts: string[][] = []
  const d: LeadRetryDeps = { send: async (row: LeadRow) => (sent.push(row.id), { ok: true }), alert: async (_a, _s, lines) => (alerts.push(lines), 'sent'), isDry: () => false, ...over }
  return { d, sent, alerts }
}
const ctx = (admin: SupabaseClient, over: Partial<FlywheelContext> = {}): FlywheelContext => ({ admin, now: NOW, startedAt: 0, budgetMs: 200_000, dryRun: false, remainingMs: () => 150_000, room: POLICY_CAPS.lead_retry, ...over })
const logOf = (settings: Map<string, string>): AutoDecision[] => parseDecisions(settings.get(DECISIONS_KEY))
const byId = (rows: Row[], id: unknown): Row => rows.find((r) => r.id === id) as Row
const runnerStep = (d: LeadRetryDeps): FlywheelStep => ({ ...leadRetryStep, run: (c) => runLeadRetry(c, d) })
const runner = (admin: SupabaseClient, step: FlywheelStep, over: Record<string, unknown> = {}) => runFlywheelSteps({ admin, startedAt: 0, budgetMs: 200_000, now: NOW, clock: () => 1_000, ...over }, [step])

async function main(): Promise<void> {
  // ---- the pure ladder ---------------------------------------------------------------------------------------------
  check('the ladder is 5 min, 1 h, 6 h, 24 h, 72 h and five tries', LADDER_WAITS_MIN.join() === '5,60,360,1440,4320' && LADDER_TRIES === 5 && HEAL_TRIES === 3)
  check('the window is 7 days', LADDER_WINDOW_MS === 7 * 24 * HOUR)
  check('an older marker without a time still parses', parseLeadMarker('[retry 2] boom').tries === 2 && parseLeadMarker('[retry 2] boom').lastAt === null)
  check('a marker with a time round trips', parseLeadMarker(retryMarker(4, 'x', NOW)).tries === 4 && parseLeadMarker(retryMarker(4, 'x', NOW)).lastAt === NOW.getTime())
  check('gave up and stopped read as finished; the pending note is try 0', parseLeadMarker('[gave up] x').finished === 'gave up' && parseLeadMarker('[stopped] x').finished === 'stopped' && parseLeadMarker('Saved here first; the send to GoHighLevel did not finish.').tries === 0)
  check('a marker is never longer than 300 characters', retryMarker(1, 'x'.repeat(900), NOW).length === 300)
  check('stripMarker removes only the gave up / stopped prefix', stripMarker('[gave up] [retry 5 at 2026] why') === '[retry 5 at 2026] why' && stripMarker(null) === '')
  const t = NOW.getTime()
  check('try 1 is due at 5 minutes, not before', retryDue(parseLeadMarker(null), t - 6 * 60_000, t) && !retryDue(parseLeadMarker(null), t - 4 * 60_000, t))
  check('try 4 waits for 24 hours of age', !retryDue(parseLeadMarker('[retry 3] x'), t - 23 * HOUR, t) && retryDue(parseLeadMarker('[retry 3] x'), t - 25 * HOUR, t))
  check('try 5 waits for 72 hours of age', !retryDue(parseLeadMarker('[retry 4] x'), t - 71 * HOUR, t) && retryDue(parseLeadMarker('[retry 4] x'), t - 73 * HOUR, t))
  check('a send made a moment ago is not repeated even if the age says so', !retryDue(parseLeadMarker(retryMarker(3, 'x', new Date(t - 60_000))), t - 30 * HOUR, t))
  check('no further send after five tries or past 7 days; both need a person', !retryDue(parseLeadMarker('[retry 5] x'), t - 80 * HOUR, t) && needsPerson(parseLeadMarker('[retry 5] x'), t - 80 * HOUR, t) && needsPerson(parseLeadMarker(null), t - 8 * 24 * HOUR, t) && !retryDue(parseLeadMarker(null), t - 8 * 24 * HOUR, t))
  check('a finished row never needs a person again', !needsPerson(parseLeadMarker('[gave up] x'), t - 20 * 24 * HOUR, t))

  // ---- happy path ----------------------------------------------------------------------------------------------------
  {
    const a = lead({ ghl_error: retryMarker(3, 'x', new Date(t - 25 * HOUR)) })
    const b = lead({ ghl_error: retryMarker(4, 'x', new Date(t - 49 * HOUR)), created_at: ago(80 * HOUR) })
    const { admin, settings, leads } = fakeAdmin({}, [a, b])
    const { d, sent, alerts } = deps()
    const r = await runLeadRetry(ctx(admin), d)
    check('happy path: both due leads are sent', r.ran === true && r.acted === 2 && sent.length === 2, JSON.stringify(r))
    check('happy path: rows are marked sent and the error is cleared', leads.every((l) => l.forwarded_to_ghl === true && l.ghl_error === null))
    const log = logOf(settings)
    check('happy path: each send is logged, without an Undo (a sent lead cannot be unsent)', log.length === 2 && log.every((e) => e.policy === 'lead_retry' && e.undo === null && /Sent a saved lead/.test(e.action)))
    check('happy path: no alert email when nobody needs a person', alerts.length === 0)
    check('the log holds no name, email or phone', !/@|Test Person/.test(settings.get(DECISIONS_KEY) ?? ''))
  }

  // ---- not due / out of scope -----------------------------------------------------------------------------------------
  {
    const young = lead({ created_at: ago(2 * HOUR), ghl_error: retryMarker(2, 'x', new Date(t - HOUR)) })
    const healShare = lead({ created_at: ago(7 * HOUR), ghl_error: retryMarker(2, 'x', new Date(t - 6 * HOUR)) })
    const tooSoon = dueLead({ ghl_error: retryMarker(3, 'x', new Date(t - 30 * 60_000)) })
    const test = dueLead({ is_test: true })
    const fresh = lead({ created_at: ago(2 * 60_000) })
    const noConsent = dueLead({ package: 'Newsletter signup', message: 'Deal interests: general' })
    const stopped = dueLead({ ghl_error: '[stopped] x' })
    const already = dueLead({ forwarded_to_ghl: true })
    const { admin, settings } = fakeAdmin({}, [young, healShare, tooSoon, test, fresh, noConsent, stopped, already])
    const { d, sent } = deps()
    const r = await runLeadRetry(ctx(admin), d)
    check('nothing is sent for a young, too-soon, test, brand new, no-consent, stopped or already sent row', r.ran === false && sent.length === 0 && logOf(settings).length === 0, JSON.stringify(r))
  }

  // ---- failed try, then the hand-over -----------------------------------------------------------------------------------
  {
    const l = dueLead()
    const { admin, settings, leads } = fakeAdmin({}, [l])
    const { d, alerts } = deps({ send: async () => ({ ok: false, error: 'GoHighLevel responded 502' }) })
    const r = await runLeadRetry(ctx(admin), d)
    const m = parseLeadMarker(String(leads[0].ghl_error))
    check('a failed try moves the marker to try 4 with a time and keeps the reason', r.ran === true && m.tries === 4 && m.lastAt === NOW.getTime() && /502/.test(String(leads[0].ghl_error)) && leads[0].forwarded_to_ghl === false, String(leads[0].ghl_error))
    const e = logOf(settings)[0]
    check('a failed try is logged with an Undo that stops the retries', e.undo?.kind === 'fw:lead_retry' && e.undo.ref === `stop:${l.id}` && !/502/.test(e.reason))
    check('a failed try sends no alert', alerts.length === 0)
    const r2 = await runLeadRetry(ctx(admin), d)
    check('the next pass does not repeat the try (the wait has not passed)', r2.ran === false)
  }
  {
    const l5 = lead({ created_at: ago(80 * HOUR), ghl_error: retryMarker(5, 'GoHighLevel responded 502', new Date(t - 5 * HOUR)) })
    const old = lead({ created_at: ago(9 * 24 * HOUR), ghl_error: null })
    const { admin, settings, leads } = fakeAdmin({}, [l5, old])
    const { d, sent, alerts } = deps()
    const r = await runLeadRetry(ctx(admin), d)
    check('hand-over: a lead with five failed tries and one past 7 days are marked gave up', r.ran === true && leads.every((l) => /^\[gave up\]/.test(String(l.ghl_error))) && sent.length === 0, JSON.stringify(leads.map((l) => l.ghl_error)))
    check('hand-over: still unsent, so the Leads page and Needs attention show them', leads.every((l) => l.forwarded_to_ghl === false))
    check('hand-over: exactly one alert email, with no personal data', alerts.length === 1 && !alerts[0].join(' ').match(/@|Test Person/) && /2 saved leads/.test(alerts[0][0]))
    const log = logOf(settings)
    check('hand-over: logged as "Needs you" with a reopen Undo, and not counted against the cap', log.length === 2 && log.every((e) => /^Needs you/.test(e.action) && e.undo?.ref.startsWith('reopen:')))
    const r2 = await runLeadRetry(ctx(admin), d)
    check('hand-over happens once: the next pass does nothing and sends no second alert', r2.ran === false && alerts.length === 1)
  }
  {
    const rows = Array.from({ length: 8 }, () => lead({ ghl_error: retryMarker(5, 'x', new Date(t - HOUR)), created_at: ago(80 * HOUR) }))
    const { admin, leads } = fakeAdmin({}, rows)
    const { d } = deps()
    await runLeadRetry(ctx(admin), d)
    check('at most 5 leads are handed over in one pass', leads.filter((l) => /^\[gave up\]/.test(String(l.ghl_error))).length === 5)
  }

  // ---- cap ---------------------------------------------------------------------------------------------------------------
  {
    const rows = Array.from({ length: 4 }, () => dueLead())
    const prior = Array.from({ length: POLICY_CAPS.lead_retry - 2 }, (_, i) => decision('lead_retry', `p${i}`, 'Sent a saved lead to GoHighLevel', 'test', null, NOW))
    const { admin } = fakeAdmin({ [DECISIONS_KEY]: JSON.stringify(prior) }, rows)
    const { d, sent } = deps()
    const r = await runner(admin, runnerStep(d))
    check('cap: with room for 2 only 2 of 4 due leads are tried', r.outcomes[0].status === 'ran' && sent.length === 2, JSON.stringify(r.outcomes))
  }
  {
    const prior = Array.from({ length: POLICY_CAPS.lead_retry }, (_, i) => decision('lead_retry', `p${i}`, 'Sent a saved lead to GoHighLevel', 'test', null, NOW))
    const { admin } = fakeAdmin({ [DECISIONS_KEY]: JSON.stringify(prior) }, [dueLead()])
    const { d, sent } = deps()
    const r = await runner(admin, runnerStep(d))
    check('cap: a used-up cap means no send at all', r.outcomes[0].status === 'skipped' && sent.length === 0, JSON.stringify(r.outcomes))
  }
  {
    const { admin } = fakeAdmin({}, [dueLead(), dueLead(), dueLead()])
    const { d, sent } = deps()
    await runLeadRetry(ctx(admin, { room: 1 }), d)
    check('the step itself never exceeds the room it is given', sent.length === 1)
  }

  // ---- kill switch, own switch, dry run -----------------------------------------------------------------------------------
  {
    const { admin } = fakeAdmin({ [AUTOMATION_PAUSED_KEY]: 'true' }, [dueLead()])
    const { d, sent } = deps()
    const r = await runner(admin, runnerStep(d))
    check('kill switch (Pause all automation): nothing is sent', sent.length === 0 && r.outcomes[0].status === 'skipped' && /paused/.test(r.outcomes[0].reason))
  }
  {
    const { admin } = fakeAdmin({ [policyKey('lead_retry')]: 'off' }, [dueLead()])
    const { d, sent } = deps()
    const r = await runner(admin, runnerStep(d))
    check('own switch off: nothing is sent', sent.length === 0 && r.outcomes[0].status === 'skipped' && /switched off/.test(r.outcomes[0].reason))
  }
  {
    const { admin, settings, leads } = fakeAdmin({}, [dueLead()])
    const { d, sent } = deps()
    const r = await runner(admin, runnerStep(d), { dryRun: true })
    check('dry run (runner): nothing is sent or written', sent.length === 0 && r.outcomes[0].reason === 'dry run' && leads[0].forwarded_to_ghl === false && !settings.has(DECISIONS_KEY))
    const r2 = await runLeadRetry(ctx(admin, { dryRun: true }), d)
    const r3 = await runLeadRetry(ctx(admin), deps({ isDry: () => true }).d)
    check('dry run (step itself, both flags): nothing is sent or written', r2.ran === false && r3.ran === false && sent.length === 0 && !settings.has(DECISIONS_KEY))
  }

  // ---- error isolation ---------------------------------------------------------------------------------------------------
  {
    const bad = dueLead()
    const good = dueLead()
    const { admin, leads } = fakeAdmin({}, [bad, good])
    const { d, alerts } = deps({ send: async (row) => { if (row.id === bad.id) throw new Error('boom'); return { ok: true } } })
    const r = await runLeadRetry(ctx(admin), d)
    check('error isolation: a throwing send does not stop the next lead', byId(leads, good.id).forwarded_to_ghl === true && byId(leads, bad.id).forwarded_to_ghl === false && r.ran === true && /skipped after an error/.test(r.note ?? ''), JSON.stringify(r))
    check('error isolation: no alert for a send that threw', alerts.length === 0)
  }
  {
    const l5 = lead({ created_at: ago(80 * HOUR), ghl_error: retryMarker(5, 'x', new Date(t - HOUR)) })
    const { admin } = fakeAdmin({}, [l5])
    const { d } = deps({ alert: async () => { throw new Error('mail down') } })
    const r = await runLeadRetry(ctx(admin), d)
    check('error isolation: a failing alert email does not undo the hand-over', r.ran === true && /^\[gave up\]/.test(String(l5.ghl_error)))
  }
  {
    const broken = { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ lt: () => ({ gt: () => ({ order: () => ({ limit: async () => ({ data: null, error: { message: 'db down' } }) }) }) }) }) }) }) }) } as unknown as SupabaseClient
    const r = await runLeadRetry(ctx(broken), deps().d)
    check('error isolation: an unreadable table is a quiet no-op, not a crash', r.ran === false && /db down/.test(r.reason ?? ''))
  }
  {
    const { admin } = fakeAdmin({}, [dueLead()])
    const r = await runFlywheelSteps({ admin, startedAt: 0, budgetMs: 200_000, now: NOW, clock: () => 1_000 }, [{ ...leadRetryStep, run: async () => { throw new Error('step blew up') } }])
    check('error isolation: the runner reports a throwing step and does not throw', r.outcomes[0].status === 'error')
  }

  // ---- Undo --------------------------------------------------------------------------------------------------------------
  {
    const l = dueLead()
    const { admin, settings, leads } = fakeAdmin({}, [l])
    const { d } = deps({ send: async () => ({ ok: false, error: 'GoHighLevel responded 502' }) })
    await runLeadRetry(ctx(admin), d)
    const entry = logOf(settings)[0]
    const u = await undoAutoDecision(admin, entry)
    check('undo (stop): the row is marked stopped and the undo reports ok', u.ok === true && /^\[stopped\]/.test(String(leads[0].ghl_error)), JSON.stringify(u))
    const after = deps()
    check('undo (stop): the lead is vetoed and finished, so the step leaves it alone', (await runLeadRetry(ctx(admin), after.d)).ran === false && after.sent.length === 0)
    check('undo (stop): a second undo is refused', (await undoAutoDecision(admin, entry)).ok === false)
  }
  {
    const l5 = lead({ created_at: ago(80 * HOUR), ghl_error: retryMarker(5, 'GoHighLevel responded 502', new Date(t - HOUR)) })
    const original = String(l5.ghl_error)
    const { admin, settings } = fakeAdmin({}, [l5])
    await runLeadRetry(ctx(admin), deps().d)
    const u = await undoAutoDecision(admin, logOf(settings)[0])
    check('undo (reopen): the reason is back exactly as it was', u.ok === true && l5.ghl_error === original, String(l5.ghl_error))
    const { d, sent, alerts } = deps()
    await runLeadRetry(ctx(admin), d)
    check('undo (reopen): the lead is vetoed, so no second hand-over, send or alert', sent.length === 0 && alerts.length === 0 && l5.ghl_error === original)
  }
  {
    const { admin } = fakeAdmin({}, [lead({ forwarded_to_ghl: true })])
    check('undo: a bad reference is refused', (await undoLeadRetry(admin, 'nonsense')).ok === false && (await undoLeadRetry(admin, 'stop:../x')).ok === false)
    check('undo: a lead that is gone is reported, not thrown', (await undoLeadRetry(admin, 'stop:99999999-0000-4000-8000-000000000000')).ok === false)
  }
  check('the step registers its undo handler', typeof leadRetryStep.undo === 'function' && leadRetryStep.id === 'lead_retry' && leadRetryStep.policy === 'lead_retry')

  // ---- healLeads keeps the early rungs and never gives up --------------------------------------------------------------------
  {
    // healLeads reads the real clock, so these rows are dated from it.
    const real = Date.now()
    const rAgo = (ms: number): string => new Date(real - ms).toISOString()
    const first = lead({ created_at: rAgo(10 * 60_000), ghl_error: 'Saved here first; the send to GoHighLevel did not finish.' })
    const early = lead({ created_at: rAgo(2 * HOUR), ghl_error: retryMarker(1, 'x', new Date(real - 90 * 60_000)) })
    const burst = lead({ created_at: rAgo(2 * HOUR), ghl_error: retryMarker(1, 'x', new Date(real - 60_000)) })
    const flywheelShare = lead({ created_at: rAgo(30 * HOUR), ghl_error: retryMarker(3, 'x', new Date(real - 25 * HOUR)) })
    const legacyDone = lead({ created_at: rAgo(30 * HOUR), ghl_error: '[retry 3] x' })
    const { admin, leads } = fakeAdmin({}, [first, early, burst, flywheelShare, legacyDone])
    const before = String(flywheelShare.ghl_error)
    await healLeads(admin)
    check('healLeads: try 1 and try 2 are made and recorded with a time (GoHighLevel is not configured here, so they fail)', parseLeadMarker(String(first.ghl_error)).tries === 1 && parseLeadMarker(String(early.ghl_error)).tries === 2, `${first.ghl_error} | ${early.ghl_error}`)
    check('healLeads: a send made a minute ago is not repeated', parseLeadMarker(String(burst.ghl_error)).tries === 1)
    check('healLeads: tries 4 and 5 are left to the flywheel step, and it never writes "gave up"', flywheelShare.ghl_error === before && legacyDone.ghl_error === '[retry 3] x' && leads.every((l) => !/^\[gave up\]/.test(String(l.ghl_error))))
  }
  {
    const old = lead({ created_at: new Date(Date.now() - 5 * 24 * HOUR).toISOString(), ghl_error: null })
    const { admin } = fakeAdmin({}, [old])
    await healLeads(admin)
    check('healLeads: the window is now 7 days, not 48 hours', parseLeadMarker(String(old.ghl_error)).tries === 1)
  }

  console.log(failed === 0 ? '\nAll lead retry checks passed (0 failed).' : `\n${failed} lead retry check(s) FAILED.`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
