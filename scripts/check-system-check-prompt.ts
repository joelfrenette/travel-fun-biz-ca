// Offline check for the System check "Copy for Claude" prompt, the before/after diff and Auto-heal (lib/system-check-prompt.ts, lib/system-check-heal.ts,
// the heal op in app/api/admin/system-check/route.ts, and the page wiring). Run: pnpm dlx tsx scripts/check-system-check-prompt.ts  (exit 1 on a failure)
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { STAGE_IDS, evaluateCheck, unreadFacts, type CheckResult, type CheckStage } from '../lib/system-check'
import { STAGE_FILES, buildClaudePrompt, diffChecks, type HealReport } from '../lib/system-check-prompt'
import { HEAL_COOLDOWN_MS, HEAL_LAST_KEY, cooldownLeftSeconds, parseHealReport, runAutoHeal } from '../lib/system-check-heal'

let failures = 0
function expect(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`)
  if (!ok) failures++
}
const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

const NOW = new Date('2026-10-24T14:00:00Z')
const base = evaluateCheck(unreadFacts(NOW)) // every stage unread = amber
const withLights = (lights: Partial<Record<(typeof STAGE_IDS)[number], 'green' | 'amber' | 'red'>>, at = NOW): CheckResult => {
  const stages: CheckStage[] = base.stages.map((s) => ({ ...s, light: lights[s.id] ?? 'green', read: true, sentence: `${s.label} sentence.`, number: '3', fixed: [], needs: lights[s.id] && lights[s.id] !== 'green' ? { text: `Open ${s.label}`, href: `/admin/${s.id}` } : null }))
  const bad = stages.find((s) => s.light === 'red') ?? stages.find((s) => s.light === 'amber') ?? null
  const overall = stages.some((s) => s.light === 'red') ? 'red' : stages.some((s) => s.light === 'amber') ? 'amber' : 'green'
  return { at: at.toISOString(), overall, stages, worst: bad ? { id: bad.id, label: bad.label, light: bad.light, sentence: bad.sentence } : null }
}

// ---- 1. the prompt
const check = withLights({ money: 'red', seo: 'amber', jobs: 'amber' })
const heal: HealReport = { at: NOW.toISOString(), paused: false, steps: [{ id: 'watchdog', label: 'Funnel watchdog repairs', ran: true, acted: 1, note: 'funnel watchdog: 6 ok' }, { id: 'crawl', label: 'Site crawl safe repairs', ran: false, acted: 0, note: 'automation is paused' }] }
const diff = diffChecks(withLights({ money: 'red', seo: 'amber', jobs: 'amber', quality: 'amber' }), check)
const text = buildClaudePrompt({ now: NOW, check, heal, diff, siteUrl: 'https://travelfunbiz.ca' })
expect('the prompt names the project, the stack and the date', /TravelFunBiz\.ca/.test(text) && /Next\.js 14/.test(text) && /Supabase/.test(text) && text.includes('2026-10-24'))
expect('it tells Claude Code to read CLAUDE.md and restates the repo rules', /Read CLAUDE\.md/.test(text) && /isAuthorized/.test(text) && /service role/.test(text))
expect('every amber and red stage is listed with its plain sentence, its number and its page', ['Money', 'SEO score', 'Daily jobs'].every((l) => text.includes(l)) && text.includes('Money sentence.') && text.includes('/admin/money') && text.includes('The number: 3'))
expect('green stages are not listed as issues', !text.includes('Production sentence.') && /Issues to fix \(3\)/.test(text))
expect('red comes before amber', text.indexOf('Money - RED') > 0 && text.indexOf('Money - RED') < text.indexOf('SEO score - AMBER'))
expect('each issue points at the code to start from, and those files exist', STAGE_IDS.every((id) => STAGE_FILES[id].length > 0 && STAGE_FILES[id].every((f) => existsSync(join(process.cwd(), f)))), STAGE_IDS.flatMap((id) => STAGE_FILES[id].filter((f) => !existsSync(join(process.cwd(), f)))).join(','))
expect('it says what Auto-heal already tried and the result', /What Auto-heal already tried/.test(text) && /Funnel watchdog repairs: changed 1/.test(text) && /Site crawl safe repairs: skipped/.test(text) && /1 fixed \(Quality\), 3 still open/.test(text))
expect('it carries the safety rules: no secrets, no live changes, verify with tsc, checks and build, commit and push only when asked', /no secret|Do not print, copy or commit any secret/.test(text) && /live settings/.test(text) && /tsc --noEmit/.test(text) && /scripts\/check-\*\.ts/.test(text) && /next build/.test(text) && /Commit and push only when I ask/.test(text))
expect('it ends by asking for a fix one by one and a report', /fix the issues one by one/i.test(text) && /report: fixed, not fixed/.test(text))
expect('it asks for the full loop: identify, propose, implement, test, monitor, make a rule, and a closing table', ['1. IDENTIFY', '2. PROPOSE', '3. IMPLEMENT', '4. TEST', '5. MONITOR', '6. MAKE A RULE'].every((w) => text.includes(w)) && /one table: issue, cause, fix, test, how to monitor, rule added/.test(text))
expect('the loop is in the prompt without an Auto-heal run too', /6\. MAKE A RULE/.test(buildClaudePrompt({ now: NOW, check })))
expect('no long dash anywhere in the prompt', !/[—–]/.test(text))
const noHeal = buildClaudePrompt({ now: NOW, check })
expect('without an Auto-heal run it says so', /Auto-heal has not been run yet/.test(noHeal))
const green = buildClaudePrompt({ now: NOW, check: withLights({}) })
expect('all green: nothing to fix, no issue list', /Nothing to fix/.test(green) && !/Issues to fix/.test(green))
const unread = buildClaudePrompt({ now: NOW, check: { ...check, stages: check.stages.map((s) => (s.id === 'seo' ? { ...s, read: false } : s)) } })
expect('a stage whose number could not be read is flagged as maybe a read problem', /could not be read, so this may be a read problem/.test(unread))
expect('it is a pure function: same input, same text', buildClaudePrompt({ now: NOW, check, heal, diff }) === buildClaudePrompt({ now: NOW, check, heal, diff }))
expect('it never mentions an environment variable value or a key', !/sk-|eyJ|service_role_key|SUPABASE_SERVICE/i.test(text))

// ---- 2. the diff
const d = diffChecks(withLights({ money: 'red', seo: 'amber', quality: 'amber' }), withLights({ money: 'amber', jobs: 'red' }))
expect('diff: fixed = was not green, is green now', d.fixed.map((f) => f.id).sort().join(',') === 'quality,seo')
expect('diff: still open keeps the new light and sentence', d.stillOpen.map((f) => `${f.id}:${f.light}`).sort().join(',') === 'jobs:red,money:amber')
expect('diff: newly worse = was green, is not now', d.newlyWorse.map((f) => f.id).join(',') === 'jobs')
expect('diff with no earlier check: nothing fixed, everything not green is open', diffChecks(null, check).fixed.length === 0 && diffChecks(null, check).stillOpen.length === 3)

// ---- 3. cooldown and report parsing
expect('cooldown: free when never run, locked just after, free again after the window', cooldownLeftSeconds(null, NOW) === 0 && cooldownLeftSeconds(NOW.toISOString(), NOW) === Math.ceil(HEAL_COOLDOWN_MS / 1000) && cooldownLeftSeconds(new Date(NOW.getTime() - HEAL_COOLDOWN_MS - 1).toISOString(), NOW) === 0)
expect('parseHealReport keeps a good report and drops junk', parseHealReport(JSON.stringify(heal))?.steps.length === 2 && parseHealReport('{') === null && parseHealReport(JSON.stringify({ at: 1 })) === null && parseHealReport(null) === null)

// ---- 4. Auto-heal itself, against an in-memory settings table
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
async function main() {
  const calls: string[] = []
  const deps = {
    now: NOW,
    watchdog: async () => (calls.push('watchdog'), { note: 'funnel watchdog: 6 ok', decisions: [] as unknown[] }),
    retry: async () => (calls.push('retry'), { acted: 2, note: 'retried 2' }),
    topics: async () => (calls.push('topics'), { acted: 0, note: '' }),
    crawl: async () => (calls.push('crawl'), { note: 'site crawl: ok', fixed: 1, changedPaths: ['/blog/x'] }),
  }
  const a = fakeAdmin()
  const run = await runAutoHeal(a.admin, deps)
  expect('Auto-heal runs the four existing safe repairs, once each, in order', calls.join(',') === 'watchdog,retry,topics,crawl' && run.report.steps.map((s) => s.id).join(',') === 'watchdog,retry,topics,crawl' && !run.cooledDown && !run.report.paused)
  expect('it reports what each did and which pages to refresh', run.report.steps[1].acted === 2 && run.report.steps[3].acted === 1 && run.changedPaths.join(',') === '/blog/x')
  expect('the report is stored for the cooldown', parseHealReport(a.store.get(HEAL_LAST_KEY))?.at === NOW.toISOString())
  const again = await runAutoHeal(a.admin, { ...deps, now: new Date(NOW.getTime() + 30_000) })
  expect('a second click inside the cooldown returns the last report and runs nothing', again.cooledDown && again.cooldownSeconds > 0 && calls.length === 4 && again.report.at === NOW.toISOString())
  const later = await runAutoHeal(a.admin, { ...deps, now: new Date(NOW.getTime() + HEAL_COOLDOWN_MS + 1000) })
  expect('after the cooldown it runs again', !later.cooledDown && calls.length === 8)
  const p = fakeAdmin({ automation_paused: 'true' })
  const pcalls: string[] = []
  const paused = await runAutoHeal(p.admin, { now: NOW, watchdog: async () => (pcalls.push('w'), { note: '', decisions: [] }), retry: async () => (pcalls.push('r'), { acted: 0, note: '' }), topics: async () => (pcalls.push('t'), { acted: 0, note: '' }), crawl: async () => (pcalls.push('c'), { note: '', fixed: 0, changedPaths: [] }) })
  expect('with automation paused (kill switch) nothing runs and every step says so', pcalls.length === 0 && paused.report.paused && paused.report.steps.every((s) => !s.ran && /paused/.test(s.note)))
  const boom = await runAutoHeal(fakeAdmin().admin, { now: NOW, watchdog: async () => { throw new Error('nope') }, retry: deps.retry, topics: deps.topics, crawl: deps.crawl })
  expect('a step that throws is reported and the others still run', /failed: nope/.test(boom.report.steps[0].note) && boom.report.steps.length === 4 && boom.report.steps[3].acted === 1)

  // ---- 5. wiring
  const route = read('app/api/admin/system-check/route.ts')
  expect('the heal op is behind isAuthorized, is a POST op, and re-runs the check and returns the diff', /export async function POST[\s\S]*isAuthorized[\s\S]*op === 'heal'/.test(route) && /runAutoHeal/.test(route) && /diffChecks/.test(route) && /answer\(true\)/.test(route))
  const heallib = read('lib/system-check-heal.ts')
  expect('Auto-heal uses only existing capped functions; its file makes no AI call of its own (the bounded AI step lives in lib/system-check-ai.ts)', /runFunnelWatchdog/.test(heallib) && /runRetryFailedPosts/.test(heallib) && /runApproveSafeTopics/.test(heallib) && /runSiteCrawl/.test(heallib) && !/callAnthropic|ai-verify/.test(heallib) && /isAutomationPaused/.test(heallib))
  const page = read('app/admin/system-check/page.tsx')
  expect('the page: Auto-heal, Run check now, Copy all to Claude, Skip and Continue are in ONE row, Copy all to Claude shows without a heal run, Skip and Continue to admin both go to /admin', /data-testid="auto-heal"/.test(page) && (() => { const row = page.slice(page.indexOf('data-testid="check-actions"')); const at = (s: string) => row.indexOf(s); return at('data-testid="auto-heal"') > -1 && at('data-testid="auto-heal"') < at('Run check now') && at('Run check now') < at('data-testid="copy-for-claude"') && at('data-testid="copy-for-claude"') < at('data-testid="skip"') && at('data-testid="skip"') < at('data-testid="continue"') })() && !/\{heal && \(\s*<button[\s\S]{0,200}?copy-for-claude/.test(page) && /"Copy all to Claude"/.test(page) && /data-testid="skip"/.test(page) && /data-testid="continue"/.test(page) && (page.match(/<Link href="\/admin"/g) ?? []).length >= 2 && />\s*Skip\s*</.test(page) && /Continue to admin/.test(page))
  expect('Continue only shows after the run finished', /data && !busy && \(\s*<Link href="\/admin" data-testid="continue"/.test(page))
  expect('the page runs a fresh check by itself once per login (sessionStorage flag), not on every visit', /void load\(!checkAlreadyRanToday\(\)\)/.test(page) && /markCheckRan\(\)/.test(page) && /sessionStorage/.test(read('components/admin/today-client.ts')))
  expect('it shows progress while the check or the heal runs', /data-testid="check-progress"/.test(page) && /role="status"/.test(page))
  expect('the Fix these today list stays on this page', /data-testid="fix-list"/.test(page) && /Fix these today/.test(page))
  expect('copying uses navigator.clipboard with a textarea fallback', /navigator\.clipboard\.writeText/.test(read('components/admin/today-client.ts')) && /execCommand\("copy"\)/.test(read('components/admin/today-client.ts')) && /createElement\("textarea"\)/.test(read('components/admin/today-client.ts')))
  const shell = read('components/admin/admin-shell.tsx')
  expect('a sign-in lands on the system check and clears the once-per-login flag', /function handleLogin[\s\S]*clearCheckRan\(\)[\s\S]*router\.replace\("\/admin\/system-check"\)/.test(shell))
  expect('a new session (new tab or day) opening Today is sent to the system check once; other pages are not hijacked', /LANDED_KEY/.test(shell) && /pathname === "\/admin"/.test(shell) && /router\.replace\("\/admin\/system-check"\)/.test(shell))

  console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed.')
  process.exit(failures ? 1 : 0)
}
void main()
