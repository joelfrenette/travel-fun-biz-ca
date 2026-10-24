// Offline check: the Today queue (swipe cards), its rules, its API route and the grouped sidebar.
// Run: pnpm dlx tsx scripts/check-today-queue.ts   (exit 1 on a failure)
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  TODAY_KINDS, TODAY_KIND_IDS, GROUP_RANK, DISMISS_ACTIONS, actionFor, needsConfirm, parseCardId, cardId, type TodayCard, type TodayKindId,
} from '../lib/today-cards'
import {
  LOG_MAX, SNOOZE_MAX, DUPLICATE_WINDOW_MS, addSnooze, appendLog, isDuplicate, isSnoozed, lastOpenEntry, markUndone, orderCards, parseLog, parseSnoozed, removeSnooze, undoVerdict, visibleCards, plain, parseIdList, addToIdList, removeFromIdList, LEADS_DONE_MAX, type LogEntry,
} from '../lib/today-state'
import { cardsFromIssues } from '../lib/today-issues'
import { buildSystemCheck } from '../lib/today-queue'
import { adminNavItems, adminNavSections, adminTools } from '../lib/admin-nav'
import type { Issue } from '../lib/issues'
import { judgeCron } from '../lib/cron-health'

let failures = 0
function expect(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`)
  if (!ok) failures++
}
const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')
const DASH = /[—–]/

// ---- 1. The inventory: every human decision this admin asks for has a card kind
const INVENTORY: Record<string, TodayKindId> = {
  'failed post to social (Needs attention: Retry)': 'failed-post',
  'failed carousel or video (Retry, Dismiss)': 'failed-render',
  'paused video making (Resume now)': 'video-paused',
  'new lead needing a reply': 'lead-reply',
  'trip sent by an agent (Approve, Send back)': 'agent-submission',
  'news brief awaiting Approve and publish / Reject': 'news-draft',
  'guide post about a named place, auto-held': 'held-guide-post',
  'guide post held because the caption check failed': 'guide-caption-held',
  'social post held in Prepare mode': 'held-post',
  'blog topic awaiting approval': 'topic',
  'guide held in the review queue': 'guide-review',
  'blog draft awaiting publish (with its quality check)': 'blog-draft',
  'supplier page says a trip changed (Dismiss)': 'supplier-change',
  'other Needs attention items with a Dismiss button': 'issue-dismiss',
  'a high-impact SEO fix still open on the SEO and GEO Manager (Do it opens the fix, Later hides 7 days)': 'seo-fix',
  'Promote this package prompt': 'promote-prompt',
  'past trip with no recap yet (daily recap prompt)': 'recap-prompt',
  'thin trip page awaiting details (enrichment decision)': 'thin-page',
  'no affiliate partner switched on': 'affiliate-setup',
}
expect('every inventory item maps to a registered kind', Object.values(INVENTORY).every((k) => k in TODAY_KINDS))
expect('every registered kind is in the inventory (nothing unexplained)', TODAY_KIND_IDS.every((k) => Object.values(INVENTORY).includes(k)) && Object.keys(TODAY_KINDS).length === TODAY_KIND_IDS.length)

for (const id of TODAY_KIND_IDS) {
  const d = TODAY_KINDS[id]
  expect(`${id}: complete definition`, d.kind === id && !!d.badge && !!d.why && d.facts.length > 0 && !!d.primary.label && !!d.primary.hint && d.snoozeDays >= 1 && d.idPattern instanceof RegExp && !!d.routes.primary, JSON.stringify(d.kind))
  expect(`${id}: a kind with no second button never claims one is undoable`, d.secondary !== null || d.undo.secondary === false)
  expect(`${id}: keep and open buttons have their days`, [d.primary, d.secondary].every((a) => !a || a.mode === 'run' || (a.mode === 'keep' ? (d.keepDays ?? 0) >= 1 : (d.openDays ?? 0) >= 1)))
  expect(`${id}: route files exist`, d.routeFiles.length > 0 && d.routeFiles.every((f) => existsSync(join(process.cwd(), f))), d.routeFiles.join(','))
  for (const f of d.routeFiles) {
    const src = read(f)
    const handlers = [...src.matchAll(/export async function (GET|POST|PATCH|PUT|DELETE)\([^)]*\)[^{]*\{\s*\n([^\n]*\n[^\n]*\n)/g)]
    expect(`${id}: ${f} checks isAuthorized first in every handler`, handlers.length > 0 && handlers.every((m) => /isAuthorized\(request\)/.test(m[2])), f)
  }
}
expect('one-button and undo semantics: only unrecoverable run buttons need a confirm tap', (() => {
  return TODAY_KIND_IDS.every((k) => (['approve', 'reject'] as const).every((op) => {
    const a = actionFor(k, op)
    const expected = !!a && a.mode === 'run' && !(op === 'approve' ? TODAY_KINDS[k].undo.primary : TODAY_KINDS[k].undo.secondary)
    return needsConfirm(k, op) === expected
  }))
})())
expect('publishing a trip from an agent and promoting need a confirm tap', needsConfirm('agent-submission', 'approve') && needsConfirm('promote-prompt', 'approve') && needsConfirm('news-draft', 'approve'))
expect('retrying a failed post does not need a confirm tap', !needsConfirm('failed-post', 'approve') && !needsConfirm('held-post', 'approve'))

// ---- 2. Every Needs attention button is covered
const issuesSrc = read('lib/issues.ts')
const actionType = /export type IssueAction = ([^\n]+)/.exec(issuesSrc)?.[1] ?? ''
const issueActions = [...actionType.matchAll(/'([a-z-]+)'/g)].map((m) => m[1])
const covered = new Set<string>([...DISMISS_ACTIONS, 'retry-post', 'retry-carousel', 'retry-video', 'dismiss-carousel', 'dismiss-video', 'resume-video', 'dismiss-source-watch', 'snooze-recap'])
expect('every IssueAction in lib/issues.ts is handled by a card kind', issueActions.length >= 12 && issueActions.every((a) => covered.has(a)), issueActions.filter((a) => !covered.has(a)).join(','))
expect('the dismiss list a card may press is exactly the plain dismiss buttons', DISMISS_ACTIONS.every((a) => issueActions.includes(a)) && !DISMISS_ACTIONS.some((a) => /retry|resume|carousel|video|source-watch/.test(a)))

// ---- 3. Card ids are strict
expect('parseCardId accepts real ids', parseCardId('topic:123e4567-e89b-12d3-a456-426614174000')?.kind === 'topic' && parseCardId('failed-post:my-post-1')?.key === 'my-post-1' && parseCardId('failed-render:video:a-b')?.key === 'video:a-b' && parseCardId('issue-dismiss:dismiss-ghl:abc123')?.kind === 'issue-dismiss' && parseCardId('video-paused:paused')?.kind === 'video-paused')
expect('parseCardId refuses nonsense', [undefined, null, 5, '', 'topic', 'topic:', 'topic:not-a-uuid', 'nope:abc', 'failed-post:A B', 'failed-post:../x', 'failed-post:a;drop', 'issue-dismiss:retry-post', 'issue-dismiss:dismiss-ghl:a b', 'failed-render:audio:x', `failed-post:${'a'.repeat(400)}`].every((v) => parseCardId(v) === null))
expect('cardId round-trips', parseCardId(cardId('held-post', 'a-b'))?.key === 'a-b')

// ---- 4. Ordering: failed posts and leads first, then approvals, then prompts
const mk = (kind: TodayKindId, key: string, sortKey = 0): TodayCard => ({ id: cardId(kind, key), kind, title: key, why: 'w', facts: [], sortKey })
const shuffled: TodayCard[] = [
  mk('thin-page', 'a'), mk('topic', '123e4567-e89b-12d3-a456-426614174001', 5), mk('lead-reply', '123e4567-e89b-12d3-a456-426614174002'), mk('promote-prompt', '123e4567-e89b-12d3-a456-426614174003'),
  mk('failed-post', 'z', 9), mk('failed-post', 'y', 1), mk('blog-draft', '123e4567-e89b-12d3-a456-426614174004'), mk('agent-submission', '123e4567-e89b-12d3-a456-426614174005'), mk('video-paused', 'paused'), mk('held-post', 'h'), mk('failed-render', 'video:q'), mk('topic', '123e4567-e89b-12d3-a456-426614174000', 2),
]
const ordered = orderCards(shuffled)
const groups = ordered.map((c) => GROUP_RANK[TODAY_KINDS[c.kind].group])
expect('ordering: groups never go backwards (urgent, then approvals, then prompts)', groups.every((g, i) => i === 0 || groups[i - 1] <= g))
expect('ordering: failed posts first, then failed renders, paused video, then leads', ordered.slice(0, 5).map((c) => c.kind).join(',') === 'failed-post,failed-post,failed-render,video-paused,lead-reply', ordered.map((c) => c.kind).join(','))
expect('ordering: within a kind the lower sort key (older) comes first', ordered[0].id.endsWith(':y') && ordered[1].id.endsWith(':z'))
expect('ordering: approvals come before prompts', ordered.findIndex((c) => c.kind === 'blog-draft') < ordered.findIndex((c) => c.kind === 'promote-prompt'))
expect('ordering is stable for the same input', orderCards(ordered).map((c) => c.id).join() === ordered.map((c) => c.id).join() && orderCards([...shuffled].reverse()).map((c) => c.id).join() === ordered.map((c) => c.id).join())

// ---- 5. Snooze hides and un-hides
const NOW = Date.parse('2026-10-23T12:00:00Z')
const DAY = 86_400_000
let snoozed = addSnooze({}, ordered[0].id, 2, NOW)
expect('snoozed card is hidden now', isSnoozed(snoozed, ordered[0].id, NOW) && visibleCards(ordered, snoozed, NOW).length === ordered.length - 1)
expect('snoozed card is still hidden the next day', visibleCards(ordered, snoozed, NOW + DAY).length === ordered.length - 1)
expect('snoozed card comes back after N days', visibleCards(ordered, snoozed, NOW + 2 * DAY + 1000).length === ordered.length)
expect('snooze is stored as JSON and expired entries are pruned on read', (() => {
  const raw = JSON.stringify({ ...snoozed, 'topic:old': new Date(NOW - DAY).toISOString() })
  const back = parseSnoozed(raw, NOW)
  return ordered[0].id in back && !('topic:old' in back)
})())
expect('snooze: bad JSON, arrays and junk values are ignored', Object.keys(parseSnoozed('not json', NOW)).length === 0 && Object.keys(parseSnoozed('[1,2]', NOW)).length === 0 && Object.keys(parseSnoozed('{"a":5,"b":"nope"}', NOW)).length === 0)
expect('snooze: days are clamped between 1 and 60', Date.parse(addSnooze({}, 'x', 0, NOW).x) - NOW === DAY && Date.parse(addSnooze({}, 'x', 9999, NOW).x) - NOW === 60 * DAY)
expect('snooze: removing unhides', !isSnoozed(removeSnooze(snoozed, ordered[0].id), ordered[0].id, NOW))
expect('snooze map is bounded', (() => {
  const big: Record<string, string> = {}
  for (let i = 0; i < SNOOZE_MAX + 100; i++) big[`k${i}`] = new Date(NOW + (i + 1) * 1000).toISOString()
  return Object.keys(parseSnoozed(JSON.stringify(big), NOW)).length === SNOOZE_MAX
})())
expect('every kind has a Later time inside the clamp', TODAY_KIND_IDS.every((k) => TODAY_KINDS[k].snoozeDays >= 1 && TODAY_KINDS[k].snoozeDays <= 60 && (TODAY_KINDS[k].keepDays ?? 1) <= 60))

// ---- 6. The decision log: bounded, undo semantics
let log: LogEntry[] = []
const entry = (i: number, undoable = true): Omit<LogEntry, 'n'> => ({ id: `failed-post:p${i}`, kind: 'failed-post', op: 'approve', mode: 'run', title: `Post ${i}`, at: new Date(NOW + i * 1000).toISOString(), undoable })
for (let i = 1; i <= LOG_MAX + 10; i++) log = appendLog(log, entry(i))
expect(`log keeps only the last ${LOG_MAX} decisions`, log.length === LOG_MAX && log[0].id === 'failed-post:p11' && log[log.length - 1].id === `failed-post:p${LOG_MAX + 10}`)
expect('log numbers keep growing', log[log.length - 1].n === LOG_MAX + 10 && log.every((e, i, a) => i === 0 || a[i - 1].n < e.n))
expect('a stored log survives a round trip and drops junk', (() => {
  const back = parseLog(JSON.stringify([...log, { n: 'x' }, null, { n: 1, id: 'a', kind: 'nope', op: 'approve', at: 'z' }]))
  return back.length === LOG_MAX
})())
expect('parseLog caps an oversized stored log', parseLog(JSON.stringify(Array.from({ length: 200 }, (_, i) => ({ n: i + 1, id: 'topic:123e4567-e89b-12d3-a456-426614174000', kind: 'topic', op: 'approve', mode: 'run', title: 't', at: new Date(NOW).toISOString(), undoable: true })))).length === LOG_MAX)
expect('undo targets the newest decision that is not undone', undoVerdict(log).kind === 'ok' && lastOpenEntry(log)?.n === log[log.length - 1].n)
const after = markUndone(log, log[log.length - 1].n)
expect('after an undo, the next undo goes one step further back', lastOpenEntry(after)?.n === log[log.length - 2].n && undoVerdict(after).kind === 'ok')
expect('an empty log has nothing to undo', undoVerdict([]).kind === 'none')
expect('a last step that cannot be undone is reported, not silently skipped', (() => {
  const l = appendLog(appendLog([], entry(1)), { ...entry(2, false), kind: 'agent-submission', id: 'agent-submission:123e4567-e89b-12d3-a456-426614174000' })
  const v = undoVerdict(l)
  return v.kind === 'cannot' && v.entry.n === 2
})())
expect('undoing everything leaves nothing', undoVerdict(markUndone(markUndone(appendLog(appendLog([], entry(1)), entry(2)), 1), 2)).kind === 'none')

// ---- 7. Idempotency
const t0 = NOW
const l1 = appendLog([], { ...entry(1), at: new Date(t0).toISOString() })
expect('the same decision on the same card a moment later is a duplicate', isDuplicate(l1, 'failed-post:p1', 'approve', t0 + 1000))
expect('a different card or a different decision is not a duplicate', !isDuplicate(l1, 'failed-post:p2', 'approve', t0 + 1000) && !isDuplicate(l1, 'failed-post:p1', 'reject', t0 + 1000))
expect('after the window, or after an undo, it is not a duplicate', !isDuplicate(l1, 'failed-post:p1', 'approve', t0 + DUPLICATE_WINDOW_MS + 1000) && !isDuplicate(markUndone(l1, 1), 'failed-post:p1', 'approve', t0 + 1000))
const route = read('app/api/admin/today/route.ts')
expect('the route checks for a duplicate before it runs anything', route.indexOf('isDuplicate(') > 0 && route.indexOf('isDuplicate(') < route.indexOf('runCardAction('))
expect('the route refuses an unconfirmed irreversible action on the server too', /needsConfirm\(parsed\.kind, op\) && body\.confirm !== true/.test(route) && route.indexOf('needsConfirm(') < route.indexOf('runCardAction('))
expect('the actions say "nothing changed" for a card that was already handled', (read('lib/today-actions.ts').match(/noop\(/g) ?? []).length >= 8)

// ---- 8. The leads-answered list is bounded
expect('answered leads list is bounded and de-duplicated', (() => {
  let l: string[] = []
  for (let i = 0; i < LEADS_DONE_MAX + 20; i++) l = addToIdList(l, `id${i}`)
  return l.length === LEADS_DONE_MAX && addToIdList(l, l[0]).length === LEADS_DONE_MAX && removeFromIdList(l, l[0]).length === LEADS_DONE_MAX - 1 && parseIdList('nope').length === 0
})())

// ---- 9. Needs attention items become the right cards
const issue = (id: string, extra: Partial<Issue> = {}): Issue => ({ id, area: 'system', title: `Title of ${id}`, detail: 'A detail — with a long dash', fix: 'Do this – then that', ...extra })
const fixture: Issue[] = [
  issue('post:my-post', { area: 'post', actions: [{ label: 'Retry', kind: 'retry-post', slug: 'my-post' }] }),
  issue('video:abc', { area: 'video', actions: [{ label: 'Retry', kind: 'retry-video', slug: 'abc' }, { label: 'Dismiss', kind: 'dismiss-video', slug: 'abc' }] }),
  issue('carousel:def', { area: 'carousel' }), // having trouble, no buttons: not a decision
  issue('system:video-paused', { actions: [{ label: 'Resume now', kind: 'resume-video' }] }),
  issue('guide-caption:g1', { area: 'post' }), // listed from the distribution ledger instead
  issue('agent-submission:123e4567-e89b-12d3-a456-426614174000', { area: 'setup', title: 'An agent sent a trip to approve: Alps', detail: 'Sam Agent sent it. It is a draft.' }),
  issue('source-watch:alps', { area: 'setup', actions: [{ label: 'Dismiss', kind: 'dismiss-source-watch', slug: 'alps' }] }),
  issue('package:recap:rome', { area: 'setup', title: 'The Rome trip has no recap yet', link: { label: 'Open', href: '/admin/packages?edit=1' } }),
  issue('package:thin:paris', { area: 'setup' }),
  issue('setup:affiliate-partner', { area: 'setup' }),
  issue('system:guides-failing', { actions: [{ label: 'Dismiss', kind: 'dismiss-guides' }] }),
  issue('ghl:abc123', { area: 'post', actions: [{ label: 'Dismiss', kind: 'dismiss-ghl', slug: 'abc123' }] }),
  issue('system:mail-blocked'), // no button: stays on Needs attention
]
const cards = cardsFromIssues(fixture)
const kinds = cards.map((c) => c.kind).sort().join(',')
expect('Needs attention items become the right kinds, and button-less ones are left out', kinds === ['failed-post', 'failed-render', 'video-paused', 'agent-submission', 'supplier-change', 'recap-prompt', 'thin-page', 'affiliate-setup', 'issue-dismiss', 'issue-dismiss'].sort().join(','), kinds)
expect('every card made from an issue has a valid id', cards.every((c) => parseCardId(c.id)?.kind === c.kind), cards.map((c) => c.id).join(' '))
expect('long dashes in data are cleaned before they are shown', cards.every((c) => !DASH.test(c.title + c.why + c.facts.map((f) => f.label + f.value).join('')) ))
expect('the agent card says who sent it', cards.find((c) => c.kind === 'agent-submission')?.facts[0].value === 'Sam Agent')
expect('plain() removes long dashes and control characters', plain('a — b–c\u0007') === 'a - b - c')

// ---- 10. System check strip
const green = judgeCron('autopilot', { at: new Date().toISOString(), ok: true }, Date.now())
const sys = buildSystemCheck({ paused: false, autopilotOn: true, heartbeat: green, errorCount: 0, failedPostsToday: 0, amberCrons: 0, cronsReadable: true })
expect('system check is green when everything is fine', sys.overall === 'green' && sys.items.length === 5 && sys.link.href === '/admin/system-health')
const bad = buildSystemCheck({ paused: true, autopilotOn: true, heartbeat: judgeCron('autopilot', { at: new Date(Date.now() - 9 * 3600_000).toISOString(), ok: true }), errorCount: 2, failedPostsToday: 1, amberCrons: 1, cronsReadable: true })
expect('system check shows paused as amber and errors, failed posts and a quiet heartbeat as red', bad.overall === 'red' && bad.items.find((i) => i.key === 'automation')?.light === 'amber' && bad.items.find((i) => i.key === 'errors')?.light === 'red' && bad.items.find((i) => i.key === 'failed-posts')?.light === 'red' && bad.items.find((i) => i.key === 'heartbeat')?.light === 'red')
expect('an unreadable count is amber, never a made-up zero', buildSystemCheck({ paused: false, autopilotOn: true, heartbeat: green, errorCount: 0, failedPostsToday: null, amberCrons: 0, cronsReadable: false }).items.filter((i) => i.light === 'amber').length === 2)

// ---- 11. The API route and the actions
expect('the Today route checks isAuthorized first in GET and POST', (() => {
  const hs = [...route.matchAll(/export async function (GET|POST)\(request: Request\) \{\r?\n([^\n]*)\n/g)]
  return hs.length === 2 && hs.every((m) => /isAuthorized\(request\)/.test(m[2]))
})())
expect('the route logs every decision to today_log and keeps snoozes in today_snoozed', /TODAY_LOG_KEY/.test(route) && /TODAY_SNOOZE_KEY/.test(route) && read('lib/today-state.ts').includes("'today_log'") && read('lib/today-state.ts').includes("'today_snoozed'"))
const actions = read('lib/today-actions.ts')
expect('every run button has a real action in lib/today-actions.ts', TODAY_KIND_IDS.filter((k) => [TODAY_KINDS[k].primary, TODAY_KINDS[k].secondary].some((a) => a && a.mode === 'run')).every((k) => new RegExp(`case '${k}'`).test(actions)))
expect('reversible kinds have an undo in lib/today-actions.ts', TODAY_KIND_IDS.filter((k) => (TODAY_KINDS[k].primary.mode === 'run' && TODAY_KINDS[k].undo.primary) || (TODAY_KINDS[k].secondary?.mode === 'run' && TODAY_KINDS[k].undo.secondary)).every((k) => new RegExp(`case '${k}'`).test(actions.slice(actions.indexOf('export async function undoCardAction')))))
expect('the actions reuse existing code (resolveIssue, decideSubmission, setDistributionStage, setTopicStatus and the route handlers)', ['resolveIssue', 'decideSubmission', 'setDistributionStage', 'setTopicStatus', 'dismissFindings', "import('@/app/api/admin/news/feeds/route')", "import('@/app/api/admin/guides/[id]/route')", "import('@/app/api/admin/blog/[id]/route')", "import('@/app/api/admin/packages/[id]/promote/route')"].every((s) => actions.includes(s)))
expect('a route handler call forwards the caller\'s own Authorization header', /headers\.set\('authorization', auth\)/.test(actions))

// ---- 12. The sidebar
// The numbered, sectioned menu is proved in full by scripts/check-admin-v2.ts; this file keeps the checks that tie it to Today.
const navLinks = adminNavSections.flatMap((s) => s.links)
expect('Today is the first link in the menu and goes to /admin, Dashboard follows at /admin/dashboard', navLinks[0].title === 'Today' && navLinks[0].href === '/admin' && navLinks.some((i) => i.title === 'Dashboard' && i.href === '/admin/dashboard') && !navLinks.some((i) => (i.href ?? '').includes('#dashboard')))
const grouped = [...navLinks.filter((i) => !i.shortcut), ...adminNavSections.flatMap((s) => s.later ?? [])].map((i) => i.title)
const modules = adminNavItems.slice(1).map((i) => i.title) // adminNavItems[0] is the old Dashboard entry
expect('no menu item is lost: every old module appears in a section', modules.every((t) => grouped.includes(t)), modules.filter((t) => !grouped.includes(t)).join(','))
expect('same links as before (no route renamed)', navLinks.filter((i) => !i.shortcut && i.href && modules.includes(i.title)).every((i) => adminNavItems.some((o) => o.title === i.title && o.href === i.href)))
expect('the tool grid under the cards still lists every module', adminTools.length === modules.length)

// ---- 13. Copy: no long dashes in anything new
const NEW_FILES = ['lib/today-cards.ts', 'lib/today-state.ts', 'lib/today-issues.ts', 'lib/today-queue.ts', 'lib/today-actions.ts', 'app/api/admin/today/route.ts', 'components/admin/today-stack.tsx', 'components/admin/system-check-strip.tsx', 'components/admin/today-client.ts', 'components/admin/admin-shell.tsx']
expect('no long dash in any new file', NEW_FILES.every((f) => !DASH.test(read(f).replace(/\/\/[^\n]*/g, '').replace(/─/g, ''))), NEW_FILES.filter((f) => DASH.test(read(f).replace(/\/\/[^\n]*/g, ''))).join(','))
expect('no long dash in any kind text or menu title', TODAY_KIND_IDS.every((k) => !DASH.test(JSON.stringify({ ...TODAY_KINDS[k], idPattern: '' }))) && adminNavSections.every((x) => !DASH.test(x.title + x.hint + x.links.map((i) => i.title + i.description).join(''))))
expect('no source text uses the word "Reject" on a button that only hides', TODAY_KIND_IDS.every((k) => { const s = TODAY_KINDS[k].secondary; return !s || s.mode === 'run' || !/^reject/i.test(s.label) }))

// ---- 14. The page and the shell
const page = read('app/admin/page.tsx')
const dashPage = read('app/admin/dashboard/page.tsx')
expect('/admin is Today only and the dashboard moved to /admin/dashboard with all its content', page.indexOf('<TodayStack') > 0 && !page.includes('<FunnelPanel') && !page.includes('adminTools.map') && !page.includes('<DashboardRangePills') && dashPage.includes('<TrafficChartCard') && dashPage.includes('<FunnelPanel') && dashPage.includes('adminTools.map') && !dashPage.includes('<TodayStack'))
const stack = read('components/admin/today-stack.tsx')
expect('the stack is accessible: live counter, status note, labelled buttons, keyboard, Later, Undo', /aria-live="polite"/.test(stack) && /role="status"/.test(stack) && /ArrowRight/.test(stack) && /ArrowLeft/.test(stack) && /ArrowDown/.test(stack) && /Undo last/.test(stack) && /left today/.test(stack) && /All clear\. The machine has it\./.test(stack) && /aria-describedby/.test(stack))
expect('the stack has a swipe with a distance threshold and does not block vertical scroll', /SWIPE_PX/.test(stack) && /touchAction: "pan-y"/.test(stack))
const shell = read('components/admin/admin-shell.tsx')
expect('the shell remembers open groups in localStorage inside try/catch', /adminNavOpen/.test(shell) && /try \{\s*localStorage\.setItem\(OPEN_KEY/.test(shell) && /try \{\s*const v = JSON\.parse\(localStorage\.getItem\(OPEN_KEY/.test(shell))
expect('the shell shows the Today count in the menu and the phone bottom bar, Today first', /<Badge kind=\{link\.badge\} badges=\{badges\}/.test(shell) && /aria-label="Quick links"/.test(shell) && shell.indexOf('label="Today"') > 0 && shell.indexOf('label="Today"') < shell.indexOf('label="Follow-ups"') && shell.indexOf('label="Follow-ups"') < shell.indexOf('label="Check"'))
const nav = read('lib/admin-nav.ts')
expect('the old flat list is kept for the dashboard grid and older checks', /export const adminNavItems/.test(nav) && /export const adminTools/.test(nav))

// ---- 15. Behaviour against an in-memory database: the real actions, undo and the queue
async function behaviour() {
  const { fakeAdmin } = await import('./fake-admin')
  const { runCardAction, undoCardAction } = await import('../lib/today-actions')
  const { buildTodayQueue } = await import('../lib/today-queue')
  const TOPIC = '123e4567-e89b-12d3-a456-426614174000'
  const LEAD = '123e4567-e89b-12d3-a456-426614174111'
  const now = new Date().toISOString()
  const db = {
    tables: {
      app_settings: [],
      blog_topic_queue: [{ id: TOPIC, angle: 'A topic', keyword: 'group trip', why: 'because', source: 'ai', status: 'suggested', created_at: now }],
      post_distribution: [
        { content_type: 'post', slug: 'held-one', title: 'Held one', stage: 'held', last_error: null, attempts: 0, created_at: now },
        { content_type: 'post', slug: 'guide-hotels-ritz', title: 'Ritz guide', stage: 'held', last_error: 'Auto-hold: waiting 24 hours', attempts: 0, created_at: now },
        { content_type: 'post', slug: 'guide-hotels-bad', title: 'Bad caption guide', stage: 'held', last_error: 'Caption check failed: a number', attempts: 0, created_at: now },
        { content_type: 'post', slug: 'failed-one', title: 'Failed one', stage: 'failed', last_error: 'boom', attempts: 3, created_at: now },
      ],
      leads: [{ id: LEAD, name: 'Pat', email: 'pat@example.com', phone: '', package: 'Alps', forwarded_to_ghl: false, is_test: false, created_at: now }],
      content_pipeline: [],
      posts: [],
      guides: [],
      news_items: [],
      travel_packages: [],
    },
  }
  const admin = fakeAdmin(db as never)
  const request = new Request('http://localhost/api/admin/today', { method: 'POST', headers: { authorization: 'Bearer test' } })
  const tbl = (t: string) => (db.tables as Record<string, Record<string, unknown>[]>)[t]

  // topic: approve, a second approve changes nothing, undo puts it back
  const a1 = await runCardAction({ admin, request, kind: 'topic', key: TOPIC, op: 'approve' })
  expect('topic approve sets it approved', a1.ok && !('noop' in a1 && a1.noop) && tbl('blog_topic_queue')[0].status === 'approved')
  const a2 = await runCardAction({ admin, request, kind: 'topic', key: TOPIC, op: 'approve' })
  expect('a second approve of the same topic is a no-op (idempotent)', a2.ok && 'noop' in a2 && a2.noop === true && tbl('blog_topic_queue')[0].status === 'approved')
  const u1 = await undoCardAction({ admin, request, kind: 'topic', key: TOPIC, op: 'approve', prev: a1.ok ? a1.prev : undefined })
  expect('undo puts the topic back to suggested', u1.ok && tbl('blog_topic_queue')[0].status === 'suggested')
  const r1 = await runCardAction({ admin, request, kind: 'topic', key: TOPIC, op: 'reject' })
  expect('topic reject sets it rejected', r1.ok && tbl('blog_topic_queue')[0].status === 'rejected')
  await undoCardAction({ admin, request, kind: 'topic', key: TOPIC, op: 'reject', prev: r1.ok ? r1.prev : undefined })

  // held post: approve queues it, undo holds it again, but not once it has gone out
  const h1 = await runCardAction({ admin, request, kind: 'held-post', key: 'held-one', op: 'approve' })
  expect('approving a held post queues it', h1.ok && tbl('post_distribution')[0].stage === 'queued')
  const hu = await undoCardAction({ admin, request, kind: 'held-post', key: 'held-one', op: 'approve' })
  expect('undo holds it again', hu.ok && tbl('post_distribution')[0].stage === 'held')
  await runCardAction({ admin, request, kind: 'held-post', key: 'held-one', op: 'approve' })
  tbl('post_distribution')[0].stage = 'done'
  const hu2 = await undoCardAction({ admin, request, kind: 'held-post', key: 'held-one', op: 'approve' })
  expect('undo refuses once the post has gone out', !hu2.ok && tbl('post_distribution')[0].stage === 'done')
  tbl('post_distribution')[0].stage = 'held'

  // failed post: retry queues it, undo restores the failed state and the error
  const f1 = await runCardAction({ admin, request, kind: 'failed-post', key: 'failed-one', op: 'approve' })
  expect('retry of a failed post queues it', f1.ok && tbl('post_distribution')[3].stage === 'queued', JSON.stringify(f1))
  const fu = await undoCardAction({ admin, request, kind: 'failed-post', key: 'failed-one', op: 'approve', prev: f1.ok ? f1.prev : undefined })
  expect('undo puts the failed state, error and attempts back', fu.ok && tbl('post_distribution')[3].stage === 'failed' && tbl('post_distribution')[3].last_error === 'boom' && tbl('post_distribution')[3].attempts === 3)
  const f2 = await runCardAction({ admin, request, kind: 'failed-post', key: 'failed-one', op: 'reject' })
  expect('"Hold it" moves a failed post to held', f2.ok && tbl('post_distribution')[3].stage === 'held')
  const f3 = await runCardAction({ admin, request, kind: 'failed-post', key: 'failed-one', op: 'approve' })
  expect('a post that is no longer failed is left alone', f3.ok && 'noop' in f3 && f3.noop === true)

  // lead: answered leads leave the queue, undo brings them back
  const l1 = await runCardAction({ admin, request, kind: 'lead-reply', key: LEAD, op: 'approve' })
  expect('marking a lead answered stores it in today_leads_done', l1.ok && String(tbl('app_settings').find((r) => r.key === 'today_leads_done')?.value).includes(LEAD))
  const queueAfter = await buildTodayQueue(admin, Date.now())
  expect('an answered lead is not on the queue', !queueAfter.cards.some((c) => c.id === `lead-reply:${LEAD}`))
  await undoCardAction({ admin, request, kind: 'lead-reply', key: LEAD, op: 'approve' })
  expect('undo puts the lead back in the queue', (await buildTodayQueue(admin, Date.now())).cards.some((c) => c.id === `lead-reply:${LEAD}`))

  // the queue
  const q = await buildTodayQueue(admin, Date.now())
  const ids = q.cards.map((c) => c.id)
  expect('the queue holds the held posts, the topic and the lead', ids.includes('held-post:held-one') && ids.includes('held-guide-post:guide-hotels-ritz') && ids.includes('guide-caption-held:guide-hotels-bad') && ids.includes(`topic:${TOPIC}`) && ids.includes(`lead-reply:${LEAD}`), ids.join(' | ') + ' PROBLEMS ' + q.problems.join(' | '))
  expect('the queue is ordered: the lead (urgent) before held posts before the topic', ids.indexOf(`lead-reply:${LEAD}`) < ids.indexOf('held-guide-post:guide-hotels-ritz') && ids.indexOf('held-guide-post:guide-hotels-ritz') < ids.indexOf('held-post:held-one') && ids.indexOf('held-post:held-one') < ids.indexOf(`topic:${TOPIC}`), ids.join(' | '))
  expect('every card in the queue has a valid id, a title and no long dash', q.cards.every((c) => parseCardId(c.id) && c.title && !DASH.test(JSON.stringify(c))))
  // snooze through the stored setting
  tbl('app_settings').push({ key: 'today_snoozed', value: JSON.stringify({ [`topic:${TOPIC}`]: new Date(Date.now() + 2 * 86_400_000).toISOString() }) })
  const q2 = await buildTodayQueue(admin, Date.now())
  expect('a snoozed card disappears from the queue and is counted as hidden', !q2.cards.some((c) => c.id === `topic:${TOPIC}`) && q2.snoozedCount === 1)
  const q3 = await buildTodayQueue(admin, Date.now() + 3 * 86_400_000)
  expect('and comes back once the snooze has passed', q3.cards.some((c) => c.id === `topic:${TOPIC}`) && q3.snoozedCount === 0)
}

behaviour()
  .catch((e) => {
    console.log(`FAIL  behaviour section threw  ${e instanceof Error ? e.stack : e}`)
    failures++
  })
  .finally(() => {
    console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll Today checks passed')
    process.exit(failures ? 1 : 0)
  })
