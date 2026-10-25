// Offline check for the flywheel registry (lib/flywheel/registry.ts): ordering, gating (kill switch, own switch, cap, opt-in step, dry run),
// error isolation, the time floor and the pass budget, the per-step heartbeat, the Undo hand-off, and that every package id WP2 to WP11 is
// registered exactly once with a policy name, label and cap. In-memory fake database only: no network, no real database, no model call.
// Run: pnpm dlx tsx scripts/check-flywheel-registry.ts   (exits 1 on any failed expectation)
import { readFileSync } from 'node:fs'
import type { SupabaseClient } from '@supabase/supabase-js'
import { FLYWHEEL_POLICIES, POLICY_CAPS, POLICY_LABELS, decision, isPolicyName, parseDecisions, policyKey, DECISIONS_KEY, appendDecisions, undoAutoDecision, setPolicySwitch, type FlywheelPolicyName, type AutoDecision } from '../lib/auto-decisions'
import { AUTOMATION_PAUSED_KEY } from '../lib/automation-kill-switch'
import { FLYWHEEL_STEPS, heartbeatKey, runFlywheelSteps, undoFlywheel } from '../lib/flywheel/registry'
import { capRoom, logDecision, readNumberSetting, readSetting, todayCount, writeSetting } from '../lib/flywheel/ctx'
import { NOT_BUILT, type FlywheelStep } from '../lib/flywheel/types'
import type { PipelineRun } from '../lib/pipeline-log'

let failed = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` (${detail})` : ''}`)
}

/** A tiny fake of the one table these helpers use: app_settings (select value by key, upsert). */
function fakeAdmin(seed: Record<string, string> = {}): { admin: SupabaseClient; store: Map<string, string> } {
  const store = new Map<string, string>(Object.entries(seed))
  const admin = {
    from(table: string) {
      if (table !== 'app_settings') throw new Error(`unexpected table ${table}`)
      return {
        select: () => ({
          eq: (_col: string, key: string) => ({
            maybeSingle: async () => ({ data: store.has(key) ? { value: store.get(key) } : null, error: null }),
          }),
        }),
        upsert: async (row: { key: string; value: string }) => {
          store.set(row.key, row.value)
          return { error: null }
        },
      }
    },
  } as unknown as SupabaseClient
  return { admin, store }
}

const NOW = new Date('2026-10-24T15:00:00.000Z')
const base = (admin: SupabaseClient, over: Partial<Parameters<typeof runFlywheelSteps>[0]> = {}) => ({ admin, startedAt: 0, budgetMs: 200_000, now: NOW, clock: () => 1_000, ...over })

function step(id: string, order: number, fn: FlywheelStep['run'], extra: Partial<FlywheelStep> = {}): FlywheelStep {
  return { id, policy: 'booked_sync', label: id, order, floorMs: 0, run: fn, ...extra }
}

async function main(): Promise<void> {
  // ---- registry shape ------------------------------------------------------------------------------------------------
  const WP: Record<string, FlywheelPolicyName> = { WP2: 'booked_sync', WP3: 'lead_retry', WP4: 'ai_heal', WP5: 'dead_letter', WP6: 'verify_fix', WP7: 'network_recover', WP8: 'promote_pick', WP9: 'keyword_assign', WP10: 'recap_auto', WP11: 'autonomy_ladder' }
  for (const [wp, id] of Object.entries(WP)) {
    check(`${wp} (${id}) is registered exactly once`, FLYWHEEL_STEPS.filter((s) => s.id === id).length === 1)
    check(`${wp} (${id}) has a label, a cap and is a known policy name`, typeof POLICY_LABELS[id] === 'string' && POLICY_LABELS[id].length > 10 && POLICY_CAPS[id] > 0 && isPolicyName(id) && FLYWHEEL_POLICIES.includes(id))
  }
  check('the registry holds exactly the ten packages', FLYWHEEL_STEPS.length === 10 && FLYWHEEL_POLICIES.length === 10)
  check('step ids are unique and equal their policy name', new Set(FLYWHEEL_STEPS.map((s) => s.id)).size === FLYWHEEL_STEPS.length && FLYWHEEL_STEPS.every((s) => s.id === s.policy))
  check('step orders are unique', new Set(FLYWHEEL_STEPS.map((s) => s.order)).size === FLYWHEEL_STEPS.length)
  check('every placeholder is a no-op that says "not built yet"', (await Promise.all(FLYWHEEL_STEPS.map((s) => s.run({ admin: fakeAdmin().admin, now: NOW, startedAt: 0, budgetMs: 1, dryRun: false, remainingMs: () => 1, room: 1 }).catch(() => NOT_BUILT)))).every((r) => r.ran === false && r.reason === NOT_BUILT.reason))
  check('only the autonomy ladder is opt-in (defaultOn false)', FLYWHEEL_STEPS.filter((s) => s.defaultOn === false).map((s) => s.id).join() === 'autonomy_ladder')
  check('caps are conservative (at most 12 a day, at least 1)', FLYWHEEL_POLICIES.every((p) => POLICY_CAPS[p] >= 1 && POLICY_CAPS[p] <= 12))

  // ---- ordering ------------------------------------------------------------------------------------------------------
  {
    const { admin } = fakeAdmin()
    const seen: string[] = []
    const mk = (id: string, order: number) => step(id, order, async () => (seen.push(id), { ran: true, note: id }))
    await runFlywheelSteps(base(admin), [mk('c', 30), mk('a', 10), mk('b', 20)])
    check('steps run in order, whatever order they were listed in', seen.join() === 'a,b,c', seen.join())
  }

  // ---- gating --------------------------------------------------------------------------------------------------------
  {
    const { admin } = fakeAdmin({ [AUTOMATION_PAUSED_KEY]: 'true' })
    let calls = 0
    const r = await runFlywheelSteps(base(admin), [step('x', 1, async () => (calls++, { ran: true }))])
    check('kill switch (Pause all automation): the step does not run', calls === 0 && r.outcomes[0].status === 'skipped' && /paused/.test(r.outcomes[0].reason), JSON.stringify(r.outcomes))
  }
  {
    const { admin } = fakeAdmin({ [policyKey('booked_sync')]: 'off' })
    let calls = 0
    const r = await runFlywheelSteps(base(admin), [step('x', 1, async () => (calls++, { ran: true }))])
    check('own switch off: the step does not run', calls === 0 && r.outcomes[0].status === 'skipped' && /switched off/.test(r.outcomes[0].reason))
  }
  {
    const { admin } = fakeAdmin()
    let calls = 0
    const r = await runFlywheelSteps(base(admin), [step('x', 1, async () => (calls++, { ran: true }))])
    check('no switch set: a normal step runs (default on)', calls === 1 && r.outcomes[0].status === 'ran')
  }
  {
    const { admin } = fakeAdmin({ [DECISIONS_KEY]: JSON.stringify(Array.from({ length: POLICY_CAPS.booked_sync }, (_, i) => decision('booked_sync', `s${i}`, 'Marked booked', 'test', null, NOW))) })
    let calls = 0
    const r = await runFlywheelSteps(base(admin), [step('x', 1, async () => (calls++, { ran: true }))])
    check('cap exhausted: the step does not run', calls === 0 && r.outcomes[0].status === 'skipped' && /limit/.test(r.outcomes[0].reason), JSON.stringify(r.outcomes))
    check('capRoom/todayCount read the same log', (await todayCount(admin, 'booked_sync', NOW)) === POLICY_CAPS.booked_sync && (await capRoom(admin, 'booked_sync', NOW)) === 0)
  }
  {
    const { admin } = fakeAdmin()
    let room = -1
    await runFlywheelSteps(base(admin), [step('x', 1, async (c) => ((room = c.room), { ran: false, reason: 'x' }))])
    check('the step is told how much room its cap leaves', room === POLICY_CAPS.booked_sync)
  }
  {
    const { admin, store } = fakeAdmin()
    let calls = 0
    const opt = step('opt', 1, async () => (calls++, { ran: true }), { policy: 'autonomy_ladder', defaultOn: false })
    const r1 = await runFlywheelSteps(base(admin), [opt])
    check('opt-in step: does not run when its switch is unset', calls === 0 && r1.outcomes[0].status === 'skipped')
    store.set(policyKey('autonomy_ladder'), 'on')
    const r2 = await runFlywheelSteps(base(admin), [opt])
    check('opt-in step: runs only when its switch is exactly on', calls === 1 && r2.outcomes[0].status === 'ran')
  }
  {
    const { admin } = fakeAdmin()
    let calls = 0
    const r = await runFlywheelSteps(base(admin, { dryRun: true }), [step('x', 1, async () => (calls++, { ran: true }))])
    check('dry run: nothing runs and nothing is written', calls === 0 && r.outcomes[0].reason === 'dry run')
  }

  // ---- isolation, heartbeat, log line --------------------------------------------------------------------------------
  {
    const { admin, store } = fakeAdmin()
    const seen: string[] = []
    const run: PipelineRun = { at: NOW.toISOString(), trigger: 'schedule', steps: [] }
    const r = await runFlywheelSteps(base(admin, { run }), [
      step('a', 1, async () => (seen.push('a'), { ran: true, note: 'did a' })),
      step('boom', 2, async () => {
        throw new Error('kaboom')
      }),
      step('c', 3, async () => (seen.push('c'), { ran: true, note: 'did c' })),
    ])
    check('a throwing step does not stop the later steps', seen.join() === 'a,c' && r.outcomes.map((o) => o.status).join() === 'ran,error,ran', JSON.stringify(r.outcomes))
    check('the failure is reported for that step only', r.outcomes[1].reason === 'kaboom' && /boom failed: kaboom/.test(r.note ?? ''))
    check('heartbeats: written for steps that ran or failed, with ok true/false', JSON.parse(store.get(heartbeatKey('a')) ?? '{}').ok === true && JSON.parse(store.get(heartbeatKey('boom')) ?? '{}').ok === false && store.has(heartbeatKey('c')))
    check('one summary line lands in the pass log, marked not ok', run.steps.length === 1 && run.steps[0].step === 'flywheel' && run.steps[0].ok === false)
  }
  {
    const { admin, store } = fakeAdmin()
    const run: PipelineRun = { at: NOW.toISOString(), trigger: 'schedule', steps: [] }
    const r = await runFlywheelSteps(base(admin, { run }), [step('quiet', 1, async () => NOT_BUILT)])
    check('a no-op step is silent: no heartbeat, no log line', r.note === null && run.steps.length === 0 && store.size === 0 && r.outcomes[0].status === 'noop')
  }
  {
    const { admin } = fakeAdmin()
    const r = await runFlywheelSteps(base(admin), [step('slow', 1, () => new Promise(() => undefined), { maxMs: 30 }), step('after', 2, async () => ({ ran: true }))])
    check('a hung step is cut off and the next one still runs', r.outcomes[0].status === 'error' && /stopped after/.test(r.outcomes[0].reason) && r.outcomes[1].status === 'ran')
  }

  // ---- time floor and pass budget ------------------------------------------------------------------------------------
  {
    const { admin } = fakeAdmin()
    let calls = 0
    const r = await runFlywheelSteps(base(admin, { startedAt: 0, budgetMs: 200_000, clock: () => 170_000 }), [step('needs60', 1, async () => (calls++, { ran: true }), { floorMs: 60_000 }), step('needs10', 2, async () => (calls++, { ran: true }), { floorMs: 10_000 })])
    check('time floor: a step needing more than is left is skipped, a smaller one still runs', r.outcomes[0].status === 'skipped' && /time left/.test(r.outcomes[0].reason) && r.outcomes[1].status === 'ran' && calls === 1, JSON.stringify(r.outcomes))
  }
  {
    const { admin } = fakeAdmin()
    let calls = 0
    const r = await runFlywheelSteps(base(admin, { startedAt: 0, budgetMs: 200_000, clock: () => 200_001 }), [step('a', 1, async () => (calls++, { ran: true }))])
    check('pass budget used up: nothing starts', calls === 0 && /budget/.test(r.outcomes[0].reason))
  }
  {
    let t = 0
    const { admin } = fakeAdmin()
    const r = await runFlywheelSteps(base(admin, { startedAt: 0, budgetMs: 100, clock: () => t }), [
      step('eats', 1, async () => ((t = 150), { ran: true })),
      step('late', 2, async () => ({ ran: true })),
    ])
    check('a step that spends the budget stops the later ones', r.outcomes[0].status === 'ran' && r.outcomes[1].status === 'skipped')
  }

  // ---- ctx helpers and undo hand-off ---------------------------------------------------------------------------------
  {
    const { admin, store } = fakeAdmin()
    await logDecision(admin, 'booked_sync', 'lead-1', 'Marked booked', 'order arrived', { kind: 'fw:booked_sync', ref: 'lead-1|new' }, NOW)
    const log = parseDecisions(store.get(DECISIONS_KEY))
    check('logDecision writes a line with an fw: undo that survives the log parser', log.length === 1 && log[0].undo?.kind === 'fw:booked_sync' && log[0].undo?.ref === 'lead-1|new')
    check('todayCount counts it', (await todayCount(admin, 'booked_sync', NOW)) === 1)
    check('readSetting/readNumberSetting use the default for missing or bad values', (await readSetting(admin, 'nope', 'dflt')) === 'dflt' && (await readNumberSetting(admin, 'nope', 7)) === 7)
    await writeSetting(admin, 'n', 'abc')
    await writeSetting(admin, 'm', '4')
    check('readNumberSetting: bad text gives the default, a number is read', (await readNumberSetting(admin, 'n', 7)) === 7 && (await readNumberSetting(admin, 'm', 7)) === 4)
  }
  {
    const { admin } = fakeAdmin()
    // undoFlywheel looks in the real registry, so exercise the unknown-step and no-handler paths and the auto-decisions hand-off.
    const none = await undoFlywheel(admin, 'booked_sync', 'r')
    check('undo for a step without a handler is a clear no, not a crash', none.ok === false && /cannot be undone/.test(none.message))
    const unknown = await undoFlywheel(admin, 'nope', 'r')
    check('undo for an unknown step is a clear no', unknown.ok === false)
    const e: AutoDecision = decision('booked_sync', 'lead-9', 'Marked booked', 'test', { kind: 'fw:booked_sync', ref: 'r' }, NOW)
    await appendDecisions(admin, [e])
    const viaLog = await undoAutoDecision(admin, e)
    check('Autopilot decisions Undo routes an fw: kind to the flywheel (no handler: refused cleanly)', viaLog.ok === false && /cannot be undone/.test(viaLog.message), viaLog.message)
    check('setPolicySwitch works for a flywheel policy', (await setPolicySwitch(admin, 'recap_auto', false)).error === undefined)
  }

  // ---- wiring (source text) ------------------------------------------------------------------------------------------
  {
    const pipe = readFileSync('lib/pipeline.ts', 'utf8')
    check('pipeline: exactly one call site of runFlywheelSteps', (pipe.match(/runFlywheelSteps\(/g) ?? []).length === 1)
    check('pipeline: the flywheel runs after the automatic decisions and before posting', pipe.indexOf('runAutoPolicies(admin)') < pipe.indexOf('runFlywheelSteps(') && pipe.indexOf('runFlywheelSteps(') < pipe.indexOf('runDistribution(admin)'))
    const reg = readFileSync('lib/flywheel/registry.ts', 'utf8')
    check('registry: uses the existing gate and dry-run helpers, no new tables', /policyGate/.test(reg) && /isDryRunActive/.test(reg) && !/\.from\(['"]/.test(reg))
    check('no step file imports the registry or the pipeline (no cycles)', FLYWHEEL_STEPS.every((s) => !/flywheel\/registry|@\/lib\/pipeline'/.test(readFileSync(`lib/flywheel/steps/${stepFile(s.id)}.ts`, 'utf8'))))
  }

  if (failed) {
    console.log(`\n${failed} check(s) failed`)
    process.exit(1)
  }
  console.log('\nall flywheel registry checks passed')
}

const FILES: Record<string, string> = { booked_sync: 'booked-sync', lead_retry: 'lead-retry', ai_heal: 'ai-heal', dead_letter: 'dead-letter', verify_fix: 'verify-fix', network_recover: 'network-recover', promote_pick: 'promote-pick', keyword_assign: 'keyword-assign', recap_auto: 'recap-auto', autonomy_ladder: 'autonomy' }
function stepFile(id: string): string {
  return FILES[id]
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
