// Offline check for Auto-heal's bounded AI step (lib/system-check-ai.ts, wired in lib/system-check-heal.ts and the heal op of
// app/api/admin/system-check/route.ts). Uses fake repair functions: no database, no network, no AI.
// Run: pnpm dlx tsx scripts/check-system-check-ai.ts  (exit 1 on a failure)
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { AI_ITEMS_PER_CLICK, aiCacheKey, pickKinds, runAiFixStep, type AiEditLike, type RepairOutcome } from '../lib/system-check-ai'
import { runAutoHeal } from '../lib/system-check-heal'
import { buildClaudePrompt, type HealReport } from '../lib/system-check-prompt'
import { STAGE_IDS, evaluateCheck, unreadFacts, type CheckStage } from '../lib/system-check'
import { memoryBudget } from '../lib/heal-loop'
import { parseDecisions, type AutoDecision } from '../lib/auto-decisions'

let failures = 0
function expect(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`)
  if (!ok) failures++
}
const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')
const NOW = new Date('2026-10-24T14:00:00Z')

function fakeAdmin(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial))
  const admin = {
    from(table: string) {
      if (table !== 'app_settings') throw new Error(`unexpected table ${table}`)
      return {
        select: () => ({ eq: (_c: string, key: string) => ({ maybeSingle: async () => ({ data: store.has(key) ? { value: store.get(key) } : null, error: null }) }) }),
        upsert: async (row: { key: string; value: string }) => {
          store.set(row.key, row.value)
          return { error: null }
        },
      }
    },
  }
  return { admin: admin as never, store }
}

const out = (tried: number, changed: number, calls: number, note = ''): RepairOutcome => ({ tried, changed, calls, note })
const edit = (id: string, path: string): AiEditLike => ({ id, path, field: 'body', reason: 'Fixed what failed the quality check.', reverted_at: null })

async function main() {
  const quality = [{ id: 'quality' as const, light: 'amber' as const }]

  // ---- pure picking
  expect('only amber or red stages with a safe fix pick a repair; red comes first; each kind once', pickKinds([{ id: 'money', light: 'red' }, { id: 'seo', light: 'amber' }, { id: 'quality', light: 'red' }]).join(',') === 'posts,guides,copy' && pickKinds([{ id: 'quality', light: 'green' }]).length === 0 && pickKinds([{ id: 'production', light: 'amber' }, { id: 'quality', light: 'amber' }]).join(',') === 'posts,guides,copy')

  // ---- nothing listed: nothing runs
  {
    const a = fakeAdmin()
    let ran = 0
    const repairs = { posts: async () => (ran++, out(1, 1, 3)), guides: async () => (ran++, out(1, 1, 3)), copy: async () => (ran++, out(1, 1, 3)) }
    const r1 = await runAiFixStep(a.admin, [], { now: NOW, aiConfigured: () => true, repairs, budget: async () => memoryBudget(40) })
    const r2 = await runAiFixStep(a.admin, STAGE_IDS.map((id) => ({ id, light: 'green' as const })), { now: NOW, aiConfigured: () => true, repairs, budget: async () => memoryBudget(40) })
    const r3 = await runAiFixStep(a.admin, [{ id: 'money', light: 'red' }, { id: 'jobs', light: 'amber' }], { now: NOW, aiConfigured: () => true, repairs, budget: async () => memoryBudget(40) })
    expect('nothing runs when nothing is listed, or when what is listed has no safe fix', ran === 0 && r1.items.length === 0 && r2.items.length === 0 && r3.items.length === 0 && r1.calls === 0 && /Nothing/.test(r3.skipped))
  }

  // ---- paused / no key / spend limit / budget
  {
    let ran = 0
    const repairs = { posts: async () => (ran++, out(1, 1, 3)), guides: async () => (ran++, out(1, 1, 3)), copy: async () => (ran++, out(1, 1, 3)) }
    const paused = await runAiFixStep(fakeAdmin({ automation_paused: 'true' }).admin, quality, { now: NOW, aiConfigured: () => true, repairs, budget: async () => memoryBudget(40) })
    expect('paused (kill switch): no repair runs and the reason is given', ran === 0 && /paused/.test(paused.skipped) && paused.calls === 0)
    const nokey = await runAiFixStep(fakeAdmin().admin, quality, { now: NOW, aiConfigured: () => false, repairs, budget: async () => memoryBudget(40) })
    expect('no AI key: nothing runs', ran === 0 && /No AI key/.test(nokey.skipped))
    const over = await runAiFixStep(fakeAdmin().admin, quality, { now: NOW, aiConfigured: () => true, spend: async () => ({ spend: 6, ceiling: 5 }), repairs, budget: async () => memoryBudget(40) })
    expect('AI spend tripwire over its limit: nothing runs', ran === 0 && /spend limit/.test(over.skipped))
    const full = memoryBudget(40)
    full.used = 40
    const capped = await runAiFixStep(fakeAdmin().admin, quality, { now: NOW, aiConfigured: () => true, spend: async () => ({ spend: 1, ceiling: 5 }), repairs, budget: async () => full })
    expect('heal_loop_calls_per_day used up: nothing runs', ran === 0 && /used up/.test(capped.skipped))
    const unreadable = await runAiFixStep(fakeAdmin().admin, quality, { now: NOW, aiConfigured: () => true, repairs, budget: async () => ({ cap: 0, used: 0, readable: false, reason: 'boom', remaining: () => 0, take: async () => false }) })
    expect('an unreadable call counter fails closed', ran === 0 && /could not be read/.test(unreadable.skipped))
  }

  // ---- per-click cap of 3, Undo entries, calls, and the cache
  {
    const a = fakeAdmin()
    const limits: Record<string, number> = {}
    const logged: AutoDecision[] = []
    let total = 0
    const mk = (kind: string, tried: number, changed: number, calls: number) => async (ctx: { limit: number }) => {
      limits[kind] = ctx.limit
      total += tried
      return out(tried, changed, calls, `${kind} done`)
    }
    const repairs = { posts: mk('posts', 2, 2, 6), guides: mk('guides', 1, 1, 4), copy: mk('copy', 1, 1, 2) }
    const deps = {
      now: NOW,
      aiConfigured: () => true,
      spend: async () => ({ spend: 1, ceiling: 5 }),
      budget: async () => memoryBudget(40),
      repairs,
      edits: async (type: string) => (type === 'post' ? [edit('e1', '/blog/a'), edit('e2', '/blog/b')] : type === 'guide' ? [edit('e3', '/guides/x')] : []),
      append: async (e: AutoDecision[]) => void logged.push(...e),
    }
    const r = await runAiFixStep(a.admin, quality, deps)
    expect('at most 3 pages per click: posts (2) and guides (1) ran, page copy was skipped for the cap', total === 3 && total <= AI_ITEMS_PER_CLICK && r.items.map((i) => `${i.kind}:${i.status}`).join(',') === 'posts:fixed,guides:fixed,copy:skipped' && /per click/.test(r.items[2].note))
    expect('a repair is never given more room than the slots left', limits.guides === 1 && limits.copy === undefined)
    expect('approximate AI calls are summed', r.calls === 10 && r.items[0].calls === 6)
    expect('every change gets a decisions-log line with a revert-edit Undo pointing at its content_edits id', logged.length === 3 && logged.every((d) => d.policy === 'system_check_ai' && d.undo?.kind === 'revert-edit') && logged.map((d) => d.undo?.ref).join(',') === 'e1,e2,e3')
    expect('those lines survive the log parser (the policy is known)', parseDecisions(JSON.stringify(logged)).length === 3)
    const calls1 = total
    const again = await runAiFixStep(a.admin, quality, deps)
    expect('cache: the same items again the same day cost nothing and say so', total === calls1 + 1 && again.items[0].status === 'skipped' && /Already tried today/.test(again.items[0].note) && again.items[1].status === 'skipped' && again.items[2].status === 'fixed' && again.calls === 2 /* only page copy, now free of the cap, ran */)
    expect('the cache is per day', a.store.has(aiCacheKey('posts', NOW)) && aiCacheKey('posts', NOW) !== aiCacheKey('posts', new Date(NOW.getTime() + 24 * 3600_000)))
    const tomorrow = await runAiFixStep(a.admin, quality, { ...deps, now: new Date(NOW.getTime() + 24 * 3600_000) })
    expect('next day the items may be tried again', tomorrow.items.some((i) => i.kind === 'posts' && i.status === 'fixed'))
  }

  // ---- nothing waiting costs nothing and is not cached; a throwing repair is reported, not cached
  {
    const a = fakeAdmin()
    const r = await runAiFixStep(a.admin, quality, {
      now: NOW,
      aiConfigured: () => true,
      spend: async () => ({ spend: null, ceiling: 5 }),
      budget: async () => memoryBudget(40),
      repairs: { posts: async () => out(0, 0, 0, 'no stuck drafts'), guides: async () => { throw new Error('model down') }, copy: async () => out(1, 0, 2, 'deferred') },
      edits: async () => [],
      append: async () => undefined,
    })
    expect('nothing waiting: skipped with no calls and not remembered; a throwing repair is reported; a repair that changed nothing is "tried"', r.items[0].status === 'skipped' && r.items[1].status === 'skipped' && /model down/.test(r.items[1].note) && r.items[2].status === 'tried' && r.calls === 2 && !a.store.has(aiCacheKey('posts', NOW)) && !a.store.has(aiCacheKey('guides', NOW)) && a.store.has(aiCacheKey('copy', NOW)))
  }

  // ---- through Auto-heal
  {
    const base = {
      now: NOW,
      watchdog: async () => ({ note: 'ok', decisions: [] as unknown[] }),
      retry: async () => ({ acted: 0, note: '' }),
      topics: async () => ({ acted: 0, note: '' }),
      crawl: async () => ({ note: '', fixed: 0, changedPaths: [] as string[] }),
    }
    const without = await runAutoHeal(fakeAdmin().admin, base)
    expect('without a listed-stages reader the AI step is not part of the report (old behavior)', without.report.ai === undefined)
    let ran = 0
    const a = fakeAdmin()
    const run = await runAutoHeal(a.admin, {
      ...base,
      listed: async () => quality,
      ai: { aiConfigured: () => true, spend: async () => ({ spend: 0, ceiling: 5 }), budget: async () => memoryBudget(40), repairs: { posts: async () => (ran++, out(1, 1, 3)), guides: async () => out(0, 0, 0), copy: async () => out(0, 0, 0) }, edits: async () => [edit('e9', '/blog/z')], append: async () => undefined },
    })
    const stored = JSON.parse(a.store.get('auto_heal_last') ?? '{}') as HealReport
    expect('Auto-heal runs the AI step after the four plain repairs and stores its result for the cooldown', ran === 1 && run.report.steps.length === 4 && run.report.ai?.items[0].status === 'fixed' && stored.ai?.calls === 3)
    const cooled = await runAutoHeal(a.admin, { ...base, now: new Date(NOW.getTime() + 20_000), listed: async () => quality, ai: { aiConfigured: () => true, repairs: { posts: async () => (ran++, out(1, 1, 3)) } } })
    expect('a click inside the 90 second cooldown returns the last answer including the AI part, with no AI run', cooled.cooledDown && ran === 1 && cooled.report.ai?.items[0].status === 'fixed')
    const paused = await runAutoHeal(fakeAdmin({ automation_paused: 'true' }).admin, { ...base, listed: async () => quality, ai: { aiConfigured: () => true, repairs: { posts: async () => (ran++, out(1, 1, 3)) } } })
    expect('paused Auto-heal does not reach the AI step', ran === 1 && paused.report.paused && /paused/.test(paused.report.ai?.skipped ?? ''))
  }

  // ---- the prompt
  {
    const check = evaluateCheck(unreadFacts(NOW))
    const stages: CheckStage[] = check.stages.map((s) => ({ ...s, light: s.id === 'quality' ? 'amber' : 'green', read: true, sentence: 'Quality sentence.', number: '1', fixed: [], needs: null }))
    const heal: HealReport = {
      at: NOW.toISOString(),
      paused: false,
      steps: [],
      ai: { calls: 6, skipped: '', items: [{ kind: 'posts', label: 'Held blog posts (below the quality bar)', status: 'fixed', changed: 2, calls: 6, note: 'repaired 2' }, { kind: 'copy', label: 'Held page copy (below the quality bar)', status: 'skipped', changed: 0, calls: 0, note: 'The limit of 3 AI fixes per click was reached.' }] },
    }
    const text = buildClaudePrompt({ now: NOW, check: { ...check, stages, overall: 'amber', worst: null }, heal })
    expect('Copy for Claude lists what the AI already tried, with calls, and says not to redo it', /AI fix, Held blog posts[^\n]*changed 2 \(about 6 AI calls/.test(text) && /AI fix, Held page copy[^\n]*skipped\. The limit of 3/.test(text) && /AI fix step total: about 6 AI calls/.test(text) && !/[—–]/.test(text))
    const paused = buildClaudePrompt({ now: NOW, check: { ...check, stages, overall: 'amber', worst: null }, heal: { ...heal, ai: { items: [], calls: 0, skipped: 'Automation is paused (kill switch), so no AI call was made.' } } })
    expect('a skipped whole step is named in the prompt', /AI fix step: did not run\. Automation is paused/.test(paused))
  }

  // ---- wiring
  {
    const ai = read('lib/system-check-ai.ts')
    expect('the AI step calls only existing repair entry points, and checks the kill switch, the tripwire and the heal loop budget', /rehealStuckDrafts/.test(ai) && /healHeldGuides/.test(ai) && /healHeldCopy/.test(ai) && /isAutomationPaused/.test(ai) && /readStoredAiSpend/.test(ai) && /openBudget/.test(ai) && !/callAnthropic|fetch\(/.test(ai))
    const route = read('app/api/admin/system-check/route.ts')
    expect('the route gives Auto-heal a fresh check to read the still-listed stages from, and has time for model calls', /listed:/.test(route) && /force: true/.test(route) && /maxDuration = 300/.test(route))
    const page = read('app/admin/system-check/page.tsx')
    expect('the page shows the AI part of the result', /data-testid="heal-ai"/.test(page) && /heal\.report\.ai/.test(page))
  }

  console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed.')
  process.exit(failures ? 1 : 0)
}
void main()
