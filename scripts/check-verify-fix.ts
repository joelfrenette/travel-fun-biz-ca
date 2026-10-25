// Offline check for the publish-verify remediation step (lib/flywheel/steps/verify-fix.ts, policy verify_fix, WP6): the happy path, the
// one-refresh-then-recheck rule, the per-page and per-pass limits, the daily cap, the kill switch, dry run, error isolation and the Undo.
// In-memory fake database and fake refresh/ping only: no network, no real database. Run: pnpm dlx tsx scripts/check-verify-fix.ts
import type { SupabaseClient } from '@supabase/supabase-js'
import { AUTOMATION_PAUSED_KEY } from '../lib/automation-kill-switch'
import { DECISIONS_KEY, VETO_KEY, parseDecisions, policyKey, undoAutoDecision, POLICY_CAPS, appendDecisions, decision } from '../lib/auto-decisions'
import { FLYWHEEL_STEPS, runFlywheelSteps } from '../lib/flywheel/registry'
import { runVerifyFix, verifyFixStep, VERIFY_FIX_PER_PASS, type VerifyFixDeps } from '../lib/flywheel/steps/verify-fix'
import { VERIFY_FIX_STATE_KEY, VERIFY_STATE_KEY, emptyVerifyState, parseFixState, remediationTargets, type VerifyEntry, type VerifyState } from '../lib/publish-verify'
import type { FlywheelStep } from '../lib/flywheel/types'
import { readFileSync } from 'node:fs'

let failed = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` (${detail})` : ''}`)
}

function fakeAdmin(seed: Record<string, string> = {}): { admin: SupabaseClient; store: Map<string, string> } {
  const store = new Map<string, string>(Object.entries(seed))
  const admin = {
    from(table: string) {
      if (table !== 'app_settings') throw new Error(`unexpected table ${table}`)
      return {
        select: () => ({ eq: (_c: string, key: string) => ({ maybeSingle: async () => ({ data: store.has(key) ? { value: store.get(key) } : null, error: null }) }) }),
        upsert: async (row: { key: string; value: string }) => (store.set(row.key, row.value), { error: null }),
      }
    },
  } as unknown as SupabaseClient
  return { admin, store }
}

const NOW = new Date('2026-10-24T15:00:00.000Z')
const iso = (minAgo: number) => new Date(NOW.getTime() - minAgo * 60_000).toISOString()
const entry = (path: string, over: Partial<VerifyEntry> = {}): VerifyEntry => ({ path, kind: 'post', at: iso(120), tries: 1, reasons: ['HTTP 500 for a visitor with no cookie (a 200 is expected)'], ...over })
const stateOf = (over: Partial<VerifyState>): string => JSON.stringify({ ...emptyVerifyState(), lastRun: iso(10), ...over })

function fakeDeps(over: Partial<VerifyFixDeps> = {}): { deps: VerifyFixDeps; refreshed: string[]; pinged: string[] } {
  const refreshed: string[] = []
  const pinged: string[] = []
  return {
    refreshed,
    pinged,
    deps: {
      revalidate: (p) => (refreshed.push(p), true),
      ping: async (p) => (pinged.push(p), { ok: true }),
      ...over,
    },
  }
}

const ctxOf = (admin: SupabaseClient, over: Partial<Parameters<typeof runVerifyFix>[0]> = {}) => ({ admin, now: NOW, startedAt: 0, budgetMs: 200_000, dryRun: false, remainingMs: () => 100_000, room: 6, ...over })
const decisionsOf = (store: Map<string, string>) => parseDecisions(store.get(DECISIONS_KEY))

async function main(): Promise<void> {
  // ---- registration ----------------------------------------------------------------------------------------------------
  check('the step is registered under verify_fix with an Undo handler', FLYWHEEL_STEPS.some((s) => s.id === 'verify_fix' && typeof s.undo === 'function'))
  check('the daily cap is 6', POLICY_CAPS.verify_fix === 6)

  // ---- pure rules ------------------------------------------------------------------------------------------------------
  {
    const st: VerifyState = { ...emptyVerifyState(), lastRun: iso(10), pending: [entry('/blog/a'), entry('/blog/new', { tries: 0, reasons: undefined })], failing: [entry('/blog/b', { since: iso(30) })] }
    const t = remediationTargets(st, {}, NOW.getTime(), 5)
    check('targets: a once-failed pending page first, then reported failures; a first look with no reason is skipped', t.map((e) => e.path).join() === '/blog/a,/blog/b', t.map((e) => e.path).join())
    check('targets: limited to max', remediationTargets(st, {}, NOW.getTime(), 1).length === 1)
    check('targets: not re-fixed before a re-check happened', remediationTargets(st, { '/blog/a': { n: 1, at: iso(5) } }, NOW.getTime(), 5).map((e) => e.path).join() === '/blog/b')
    check('targets: fixed again after a re-check, once', remediationTargets(st, { '/blog/a': { n: 1, at: iso(20) } }, NOW.getTime(), 5).some((e) => e.path === '/blog/a'))
    check('targets: never a third refresh', !remediationTargets(st, { '/blog/a': { n: 2, at: iso(60) } }, NOW.getTime(), 5).some((e) => e.path === '/blog/a'))
    check('fix state parser tolerates garbage', Object.keys(parseFixState('not json')).length === 0 && Object.keys(parseFixState('[1]')).length === 0 && Object.keys(parseFixState(JSON.stringify({ bad: { n: 1, at: 'x' }, '/ok': { n: 1, at: iso(1) } }))).join() === '/ok')
  }

  // ---- happy path ------------------------------------------------------------------------------------------------------
  {
    const { admin, store } = fakeAdmin({ [VERIFY_STATE_KEY]: stateOf({ pending: [entry('/blog/a')] }) })
    const { deps, refreshed, pinged } = fakeDeps()
    const r = await runVerifyFix(ctxOf(admin), deps)
    const d = decisionsOf(store)
    check('happy path: the failing page is refreshed and pinged once', r.ran === true && r.acted === 1 && refreshed.join() === '/blog/a' && pinged.join() === '/blog/a', JSON.stringify(r))
    check('happy path: one decision line with an fw:verify_fix Undo', d.length === 1 && d[0].policy === 'verify_fix' && d[0].subject === '/blog/a' && d[0].undo?.kind === 'fw:verify_fix' && d[0].undo.ref === '/blog/a', JSON.stringify(d))
    check('happy path: the refresh is remembered', parseFixState(store.get(VERIFY_FIX_STATE_KEY))['/blog/a']?.n === 1)
    check('the verify state itself is not touched', store.get(VERIFY_STATE_KEY) === stateOf({ pending: [entry('/blog/a')] }))
    const again = await runVerifyFix(ctxOf(admin), fakeDeps().deps)
    check('same pass state again: no second refresh before a re-check', again.ran === false && /waiting/.test(again.reason ?? ''), JSON.stringify(again))
  }

  // ---- nothing to do -----------------------------------------------------------------------------------------------------
  {
    const { admin, store } = fakeAdmin()
    const { deps, refreshed } = fakeDeps()
    const r = await runVerifyFix(ctxOf(admin), deps)
    check('no verify state: a quiet no-op, nothing written', r.ran === false && refreshed.length === 0 && store.size === 0)
  }

  // ---- per-pass limit ----------------------------------------------------------------------------------------------------
  {
    const many = ['/blog/1', '/blog/2', '/blog/3', '/blog/4', '/blog/5'].map((p) => entry(p))
    const { admin } = fakeAdmin({ [VERIFY_STATE_KEY]: stateOf({ pending: many }) })
    const { deps, refreshed } = fakeDeps()
    const r = await runVerifyFix(ctxOf(admin), deps)
    check(`per-pass limit: at most ${VERIFY_FIX_PER_PASS} pages`, refreshed.length === VERIFY_FIX_PER_PASS && r.acted === VERIFY_FIX_PER_PASS)
    const small = await runVerifyFix(ctxOf(fakeAdmin({ [VERIFY_STATE_KEY]: stateOf({ pending: many }) }).admin, { room: 2 }), fakeDeps().deps)
    check('room (the remaining daily cap) bounds the pass', small.acted === 2)
  }

  // ---- the daily cap, through the real runner ----------------------------------------------------------------------------
  const asStep = (deps: VerifyFixDeps): FlywheelStep => ({ ...verifyFixStep, run: (c) => runVerifyFix(c, deps) })
  const runner = (admin: SupabaseClient, deps: VerifyFixDeps, over: Record<string, unknown> = {}) => runFlywheelSteps({ admin, startedAt: 0, budgetMs: 200_000, now: NOW, clock: () => 1_000, ...over }, [asStep(deps)])
  {
    const { admin, store } = fakeAdmin({ [VERIFY_STATE_KEY]: stateOf({ pending: [entry('/blog/a')] }) })
    await appendDecisions(admin, Array.from({ length: POLICY_CAPS.verify_fix }, (_, i) => decision('verify_fix', `/blog/old${i}`, 'x', 'x', null, NOW)))
    const { deps, refreshed } = fakeDeps()
    const r = await runner(admin, deps)
    check('daily cap: at the cap the step does not run', refreshed.length === 0 && r.outcomes[0].status === 'skipped', JSON.stringify(r.outcomes))
    void store
  }

  // ---- kill switch and own switch --------------------------------------------------------------------------------------
  {
    const { admin } = fakeAdmin({ [VERIFY_STATE_KEY]: stateOf({ pending: [entry('/blog/a')] }), [AUTOMATION_PAUSED_KEY]: 'true' })
    const { deps, refreshed } = fakeDeps()
    const r = await runner(admin, deps)
    check('kill switch (Pause all automation): nothing is refreshed', refreshed.length === 0 && r.outcomes[0].status === 'skipped', JSON.stringify(r.outcomes))
    const off = fakeAdmin({ [VERIFY_STATE_KEY]: stateOf({ pending: [entry('/blog/a')] }), [policyKey('verify_fix')]: 'off' })
    const f2 = fakeDeps()
    const r2 = await runner(off.admin, f2.deps)
    check('own switch off: nothing is refreshed', f2.refreshed.length === 0 && r2.outcomes[0].status === 'skipped')
    const on = fakeAdmin({ [VERIFY_STATE_KEY]: stateOf({ pending: [entry('/blog/a')] }) })
    const f3 = fakeDeps()
    const r3 = await runner(on.admin, f3.deps)
    check('default (switch unset): it runs through the runner', f3.refreshed.length === 1 && r3.outcomes[0].status === 'ran', JSON.stringify(r3.outcomes))
  }

  // ---- dry run ---------------------------------------------------------------------------------------------------------
  {
    const { admin, store } = fakeAdmin({ [VERIFY_STATE_KEY]: stateOf({ pending: [entry('/blog/a')] }) })
    const { deps, refreshed, pinged } = fakeDeps()
    const direct = await runVerifyFix(ctxOf(admin, { dryRun: true }), deps)
    const viaRunner = await runner(admin, deps, { dryRun: true })
    check('dry run: no refresh, no ping, nothing written', direct.ran === false && viaRunner.outcomes[0].status === 'skipped' && refreshed.length === 0 && pinged.length === 0 && !store.has(DECISIONS_KEY) && !store.has(VERIFY_FIX_STATE_KEY))
  }

  // ---- error isolation -------------------------------------------------------------------------------------------------
  {
    const { admin, store } = fakeAdmin({ [VERIFY_STATE_KEY]: stateOf({ pending: [entry('/blog/bad'), entry('/blog/good')] }) })
    const { deps, refreshed } = fakeDeps({
      revalidate: (p) => {
        if (p === '/blog/bad') throw new Error('boom')
        refreshed.push(p)
        return true
      },
    })
    const r = await runVerifyFix(ctxOf(admin), deps)
    check('one page throwing does not stop the others', r.ran === true && r.acted === 1 && refreshed.join() === '/blog/good' && /1 failed/.test(r.note ?? ''), JSON.stringify(r))
    check('a failed refresh is not logged or counted as fixed', decisionsOf(store).length === 1 && !parseFixState(store.get(VERIFY_FIX_STATE_KEY))['/blog/bad'])
    const pingFail = fakeAdmin({ [VERIFY_STATE_KEY]: stateOf({ pending: [entry('/blog/a')] }) })
    const pf = fakeDeps({ ping: async () => { throw new Error('net down') } })
    const r2 = await runVerifyFix(ctxOf(pingFail.admin), pf.deps)
    check('a failing ping does not undo the refresh', r2.ran === true && r2.acted === 1 && pf.refreshed.length === 1)
    const gone = fakeAdmin({ [VERIFY_STATE_KEY]: '{broken' })
    const r3 = await runVerifyFix(ctxOf(gone.admin), fakeDeps().deps)
    check('a damaged verify state is a quiet no-op', r3.ran === false)
  }

  // ---- Undo ------------------------------------------------------------------------------------------------------------
  {
    const { admin, store } = fakeAdmin({ [VERIFY_STATE_KEY]: stateOf({ pending: [entry('/blog/a'), entry('/blog/b')] }) })
    const { deps } = fakeDeps()
    await runVerifyFix(ctxOf(admin), deps)
    const line = decisionsOf(store).find((e) => e.subject === '/blog/a')
    const undone = line ? await undoAutoDecision(admin, line) : { ok: false, message: 'no line' }
    check('Undo: accepted, says the page will not be auto-refreshed again', undone.ok === true && /not be refreshed automatically/.test(undone.message), JSON.stringify(undone))
    check('Undo: the page is added to the veto list', (store.get(VETO_KEY) ?? '').includes('/blog/a'))
    // a later pass (re-check happened, page still failing): the vetoed page is skipped, the other is refreshed
    store.set(VERIFY_STATE_KEY, stateOf({ lastRun: new Date(NOW.getTime() + 10 * 60_000).toISOString(), failing: [entry('/blog/a', { since: iso(30) }), entry('/blog/b', { since: iso(30) })] }))
    const f = fakeDeps()
    await runVerifyFix(ctxOf(admin, { now: new Date(NOW.getTime() + 20 * 60_000) }), f.deps)
    check('Undo: a vetoed page is never refreshed again', !f.refreshed.includes('/blog/a'), f.refreshed.join())
    check('a second, re-checked refresh of another page is allowed', f.refreshed.join() === '/blog/b', f.refreshed.join())
  }

  // ---- source rules ----------------------------------------------------------------------------------------------------
  {
    const src = readFileSync('lib/flywheel/steps/verify-fix.ts', 'utf8')
    check('step source: never edits or unpublishes content, no assignLead, no price', !/\.update\(|\.delete\(|assignLead|price|status:\s*['"]draft/i.test(src.replace(/\/\/.*$/gm, '')))
    check('step source: no new cron', !/vercel\.json|cron/i.test(src.replace(/\/\/.*$/gm, '')))
  }

  console.log(failed === 0 ? '\n0 failed' : `\n${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
