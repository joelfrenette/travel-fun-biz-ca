// Offline check for the scheduled AI auto-heal step (lib/flywheel/steps/ai-heal.ts, policy ai_heal, WP4): the happy path through the REAL
// runAiFixStep with faked repairs, only-safe-stages, the daily cap, the 2 hour gap, kill switch, own switch, dry run, error isolation, the
// decision lines with Undo, and that nothing but the faked repairs is ever called. In-memory fake database only: no network, no real database.
// Run: pnpm dlx tsx scripts/check-ai-heal.ts
import type { SupabaseClient } from '@supabase/supabase-js'
import { AUTOMATION_PAUSED_KEY } from '../lib/automation-kill-switch'
import { DECISIONS_KEY, POLICY_CAPS, parseDecisions, policyKey } from '../lib/auto-decisions'
import { FLYWHEEL_STEPS, runFlywheelSteps } from '../lib/flywheel/registry'
import { AI_HEAL_LAST_KEY, AI_HEAL_MIN_GAP_MS, aiHealStep, gapLeftMs, relabel, runAiHeal, type AiHealDeps } from '../lib/flywheel/steps/ai-heal'
import { aiCacheKey, runAiFixStep, type AiFixDeps, type AiKind, type RepairOutcome } from '../lib/system-check-ai'
import type { HealBudget } from '../lib/heal-loop'
import type { FlywheelStep } from '../lib/flywheel/types'
import { decision } from '../lib/auto-decisions'

let failed = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` (${detail})` : ''}`)
}

function fakeAdmin(seed: Record<string, string> = {}): { admin: SupabaseClient; store: Map<string, string> } {
  const store = new Map<string, string>(Object.entries(seed))
  const admin = {
    from(table: string) {
      if (table === 'content_edits') return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }
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
const ctxOf = (admin: SupabaseClient, over: Partial<Parameters<typeof runAiHeal>[0]> = {}) => ({ admin, now: NOW, startedAt: 0, budgetMs: 200_000, dryRun: false, remainingMs: () => 100_000, room: POLICY_CAPS.ai_heal, ...over })
const decisionsOf = (store: Map<string, string>) => parseDecisions(store.get(DECISIONS_KEY))

const openBudget = (left = 10): HealBudget => ({ cap: 12, used: 12 - left, readable: true, remaining: () => left, take: async () => true })

interface Fakes {
  deps: AiHealDeps
  aiDeps: AiFixDeps
  repaired: AiKind[]
  listedCalls: number
}
function fakes(listed: { id: string; light: 'green' | 'amber' | 'red' }[], over: { repairs?: AiFixDeps['repairs']; edits?: AiFixDeps['edits']; budget?: () => Promise<HealBudget>; aiConfigured?: boolean } = {}): Fakes {
  const f: Fakes = { repaired: [], listedCalls: 0 } as unknown as Fakes
  f.repaired = []
  f.listedCalls = 0
  const rep = (kind: AiKind, out: RepairOutcome) => async () => (f.repaired.push(kind), out)
  f.deps = {
    listed: async () => (f.listedCalls++, listed as never),
    runAi: runAiFixStep,
  }
  f.aiDeps = {
    aiConfigured: () => over.aiConfigured !== false,
    spend: async () => ({ spend: 0, ceiling: 10 }),
    budget: over.budget ?? (async () => openBudget()),
    repairs: over.repairs ?? {
      posts: rep('posts', { tried: 1, changed: 1, calls: 2, note: 'one draft repaired' }),
      guides: rep('guides', { tried: 0, changed: 0, calls: 0, note: '' }),
      copy: rep('copy', { tried: 0, changed: 0, calls: 0, note: '' }),
    },
    edits: over.edits ?? (async (type) => (type === 'post' ? [{ id: 'edit-1', path: '/blog/a', field: 'body', reason: 'it failed the quality check', reverted_at: null }] : [])),
  }
  return f
}

async function main(): Promise<void> {
  // ---- registration ----------------------------------------------------------------------------------------------------
  check('the step is registered under ai_heal with an Undo handler', FLYWHEEL_STEPS.some((s) => s.id === 'ai_heal' && typeof s.undo === 'function' && s.policy === 'ai_heal'))
  check('the daily cap is 3', POLICY_CAPS.ai_heal === 3)

  // ---- pure rules ------------------------------------------------------------------------------------------------------
  {
    check('gap: never tried = free', gapLeftMs(null, NOW) === 0 && gapLeftMs('junk', NOW) === 0)
    check('gap: tried 10 minutes ago = wait', gapLeftMs(new Date(NOW.getTime() - 600_000).toISOString(), NOW) === AI_HEAL_MIN_GAP_MS - 600_000)
    check('gap: tried 3 hours ago = free', gapLeftMs(new Date(NOW.getTime() - 3 * 3_600_000).toISOString(), NOW) === 0)
    const r = relabel([decision('system_check_ai', '/blog/a', 'AI fixed body on /blog/a', 'Started by a person with Auto-heal on the System check. It failed the quality check.', { kind: 'revert-edit', ref: 'e1' }, NOW), decision('system_check_ai', 'posts', 'AI changed 1 page(s)', 'Started by Auto-heal. Open Content edits.', null, NOW)])
    check('relabel: policy ai_heal, no "by a person" text, Undo is fw:ai_heal with the same ref, null stays null', r.every((e) => e.policy === 'ai_heal') && !r.some((e) => /by a person/.test(e.reason)) && /automatically/.test(r[0].reason) && r[0].undo?.kind === 'fw:ai_heal' && r[0].undo.ref === 'e1' && r[1].undo === null, JSON.stringify(r))
  }

  // ---- happy path, through the real runAiFixStep -----------------------------------------------------------------------------
  {
    const { admin, store } = fakeAdmin()
    const f = fakes([{ id: 'quality', light: 'red' }, { id: 'seo', light: 'green' }])
    const r = await runAiHeal(ctxOf(admin), f.deps, f.aiDeps)
    const d = decisionsOf(store)
    check('happy path: the post repair ran once and changed one page', r.ran === true && r.acted === 1 && f.repaired.filter((k) => k === 'posts').length === 1, JSON.stringify({ r, rep: f.repaired }))
    check('happy path: one ai_heal decision line with an fw:ai_heal Undo to the edit id', d.length === 1 && d[0].policy === 'ai_heal' && d[0].subject === '/blog/a' && d[0].undo?.kind === 'fw:ai_heal' && d[0].undo.ref === 'edit-1', JSON.stringify(d))
    check('happy path: the attempt is remembered', JSON.parse(store.get(AI_HEAL_LAST_KEY) ?? '{}').changed === 1)
    check('happy path: the per-kind daily cache was written by the reused step', store.has(aiCacheKey('posts', NOW)))
    const again = await runAiHeal(ctxOf(admin, { now: new Date(NOW.getTime() + 15 * 60_000) }), f.deps, f.aiDeps)
    check('second pass 15 minutes later: no second run (2 hour gap)', again.ran === false && /next try/.test(again.reason ?? '') && f.repaired.filter((k) => k === 'posts').length === 1, JSON.stringify(again))
    const later = await runAiHeal(ctxOf(admin, { now: new Date(NOW.getTime() + 3 * 3_600_000) }), f.deps, f.aiDeps)
    check('3 hours later: runs again but the daily cache stops a repeat AI spend', later.ran === false && f.repaired.filter((k) => k === 'posts').length === 1, JSON.stringify({ later, rep: f.repaired }))
  }

  // ---- only safe stages --------------------------------------------------------------------------------------------------------
  {
    const { admin, store } = fakeAdmin()
    const f = fakes([{ id: 'funnel', light: 'red' }, { id: 'jobs', light: 'amber' }, { id: 'quality', light: 'green' }])
    const r = await runAiHeal(ctxOf(admin), f.deps, f.aiDeps)
    check('only unsafe or green stages: no repair, no AI, no write', r.ran === false && f.repaired.length === 0 && store.size === 0, JSON.stringify({ r, size: store.size }))
  }

  // ---- no AI key / budget used up / spend over -----------------------------------------------------------------------------------
  {
    const { admin, store } = fakeAdmin()
    const f = fakes([{ id: 'quality', light: 'red' }], { aiConfigured: false })
    const r = await runAiHeal(ctxOf(admin), f.deps, f.aiDeps)
    check('no AI key: nothing runs and nothing is remembered', r.ran === false && /AI key/.test(r.reason ?? '') && f.repaired.length === 0 && !store.has(AI_HEAL_LAST_KEY), JSON.stringify(r))
    const f2 = fakes([{ id: 'quality', light: 'red' }], { budget: async () => openBudget(0) })
    const r2 = await runAiHeal(ctxOf(admin), f2.deps, f2.aiDeps)
    check('heal-loop daily budget used up: nothing runs', r2.ran === false && f2.repaired.length === 0, JSON.stringify(r2))
    const f3 = fakes([{ id: 'quality', light: 'red' }])
    const r3 = await runAiHeal(ctxOf(admin), f3.deps, { ...f3.aiDeps, spend: async () => ({ spend: 11, ceiling: 10 }) })
    check('AI spend over its limit: nothing runs', r3.ran === false && /spend limit/.test(r3.reason ?? '') && f3.repaired.length === 0, JSON.stringify(r3))
  }

  // ---- kill switch, own switch, dry run, cap --------------------------------------------------------------------------------------
  {
    const wrap = (f: Fakes): FlywheelStep => ({ ...aiHealStep, run: (ctx) => runAiHeal(ctx, f.deps, f.aiDeps) })
    const run = (admin: SupabaseClient, step: FlywheelStep, extra: { dryRun?: boolean } = {}) => runFlywheelSteps({ admin, startedAt: 0, budgetMs: 200_000, now: NOW, clock: () => 1_000, ...extra }, [step])

    const a = fakeAdmin({ [AUTOMATION_PAUSED_KEY]: 'true' })
    const fa = fakes([{ id: 'quality', light: 'red' }])
    const ra = await run(a.admin, wrap(fa))
    check('kill switch via runner: the step does not run', ra.outcomes[0]?.status === 'skipped' && fa.repaired.length === 0, JSON.stringify(ra.outcomes))

    const b = fakeAdmin({ [policyKey('ai_heal')]: 'off' })
    const fb = fakes([{ id: 'quality', light: 'red' }])
    const rb = await run(b.admin, wrap(fb))
    check('own switch off via runner: the step does not run', rb.outcomes[0]?.status === 'skipped' && fb.repaired.length === 0, JSON.stringify(rb.outcomes))

    const c = fakeAdmin()
    const fc = fakes([{ id: 'quality', light: 'red' }])
    const rc = await run(c.admin, wrap(fc), { dryRun: true })
    check('dry run via runner: nothing runs, nothing is written', rc.outcomes[0]?.status === 'skipped' && fc.repaired.length === 0 && c.store.size === 0, JSON.stringify(rc.outcomes))
    const direct = await runAiHeal(ctxOf(c.admin, { dryRun: true }), fc.deps, fc.aiDeps)
    check('dry run direct call: no check read, no repair, no write', direct.ran === false && fc.listedCalls === 0 && fc.repaired.length === 0 && c.store.size === 0, JSON.stringify(direct))

    const d = fakeAdmin()
    const fd = fakes([{ id: 'quality', light: 'red' }])
    const capped = await runAiHeal(ctxOf(d.admin, { room: 0 }), fd.deps, fd.aiDeps)
    check('daily cap used up: nothing runs', capped.ran === false && /cap/.test(capped.reason ?? '') && fd.listedCalls === 0 && fd.repaired.length === 0, JSON.stringify(capped))

    const e = fakeAdmin()
    const fe = fakes([{ id: 'quality', light: 'red' }])
    const ok = await run(e.admin, wrap(fe))
    check('on by default via runner: the step runs when nothing is switched', ok.outcomes[0]?.status === 'ran' && fe.repaired.filter((k) => k === 'posts').length === 1, JSON.stringify(ok.outcomes))
  }

  // ---- error isolation ------------------------------------------------------------------------------------------------------
  {
    const { admin, store } = fakeAdmin()
    const f = fakes([{ id: 'quality', light: 'red' }], {
      repairs: {
        posts: async () => {
          throw new Error('model timed out')
        },
        guides: async () => ({ tried: 1, changed: 0, calls: 1, note: 'checked' }),
        copy: async () => ({ tried: 0, changed: 0, calls: 0, note: '' }),
      },
    })
    const r = await runAiHeal(ctxOf(admin), f.deps, f.aiDeps)
    check('one repair throws: the others still run and the pass is not broken', r.ran === true && r.acted === 0 && decisionsOf(store).length === 0, JSON.stringify(r))
    const g = fakes([{ id: 'quality', light: 'red' }])
    g.deps.listed = async () => {
      throw new Error('check unreadable')
    }
    let threw = false
    try {
      await runAiHeal(ctxOf(fakeAdmin().admin), g.deps, g.aiDeps)
    } catch {
      threw = true
    }
    check('check unreadable: the throw is left for the runner to log as one error', threw)
    const run = await runFlywheelSteps({ admin: fakeAdmin().admin, startedAt: 0, budgetMs: 200_000, now: NOW, clock: () => 1_000 }, [{ ...aiHealStep, run: (ctx) => runAiHeal(ctx, g.deps, g.aiDeps) }])
    check('runner turns that throw into an error outcome', run.outcomes[0]?.status === 'error', JSON.stringify(run.outcomes))
  }

  // ---- never touches anything but the repairs --------------------------------------------------------------------------------------
  {
    const { admin, store } = fakeAdmin()
    const f = fakes([{ id: 'quality', light: 'red' }])
    await runAiHeal(ctxOf(admin), f.deps, f.aiDeps)
    const keys = [...store.keys()].filter((k) => k !== DECISIONS_KEY && k !== AI_HEAL_LAST_KEY && k !== aiCacheKey('posts', NOW))
    check('only the decision log, its own marker and the reused per-day cache are written', keys.length === 0, keys.join())
  }

  // ---- Undo ---------------------------------------------------------------------------------------------------------------
  {
    const { admin } = fakeAdmin()
    const r = await aiHealStep.undo!(admin, 'no-such-edit')
    check('Undo of an edit that is gone: says so, changes nothing', r.ok === false && /no longer exists/.test(r.message), JSON.stringify(r))
  }

  console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed')
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
