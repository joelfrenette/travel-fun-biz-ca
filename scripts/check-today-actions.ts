// Offline check: the second row of buttons on a Today card (Previous, Later, Skip, Auto-heal, Copy for Claude, Undo last).
// Run: pnpm dlx tsx scripts/check-today-actions.ts   (exit 1 on a failure)
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { TODAY_KIND_IDS, TODAY_KINDS, type TodayCard, type TodayKindId } from '../lib/today-cards'
import {
  CARD_ACTIONS, DEFAULT_CARD_ACTIONS, DEFAULT_SNOOZE_DAYS, SNOOZE_CHOICES, openTargetFor, parseSnoozeDays, applySession, canGoBack, cardActionsFor, emptySession, healDay, kindsWithoutActions, parseHealCache, parseSkipped, putHeal, rowTwoFor, sessionReducer, undoOffered, TODAY_HEAL_KEY,
  type CardHealResult, type SessionAction, type SessionState,
} from '../lib/today-card-actions'
import { buildCardPrompt, maskSensitive } from '../lib/today-card-prompt'
import { runCardHeal, type Healer, type HealStore } from '../lib/today-heal'

let failures = 0
function expect(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`)
  if (!ok) failures++
}
const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')
const DASH = new RegExp(`[${String.fromCharCode(0x2014)}${String.fromCharCode(0x2013)}]`)
const UUID = '0b8f1c1e-3b6a-4f0e-9a52-0123456789ab'

const mk = (kind: TodayKindId, key: string, extra: Partial<TodayCard> = {}): TodayCard => ({ id: `${kind}:${key}`, kind, title: `Card ${key}`, why: 'Because.', facts: [], sortKey: 0, ...extra })
const run = (s: SessionState, ...as: SessionAction[]) => as.reduce(sessionReducer, s)

async function main() {
  // ---- 1. The registry
  expect('every kind has an entry or the safe default', kindsWithoutActions().length === 0)
  expect('every kind resolves to a definition', TODAY_KIND_IDS.every((k) => !!cardActionsFor(k)))
  expect('an unknown or new kind (hot-lead) gets the safe default with no Auto-heal', cardActionsFor('hot-lead') === DEFAULT_CARD_ACTIONS && !cardActionsFor('hot-lead').canAutoHeal && cardActionsFor('hot-lead').healFn === null)
  expect('the registry has no entry for a kind that does not exist', Object.keys(CARD_ACTIONS).every((k) => (TODAY_KIND_IDS as readonly string[]).includes(k)))
  expect('canAutoHeal and healFn always agree', Object.values(CARD_ACTIONS).every((a) => !!a && a.canAutoHeal === (a.healFn !== null)))
  const healable = TODAY_KIND_IDS.filter((k) => cardActionsFor(k).canAutoHeal).sort()
  expect('Auto-heal exists only for failed post, failed render, guide review and SEO fix', JSON.stringify(healable) === JSON.stringify(['failed-post', 'failed-render', 'guide-review', 'seo-fix'].sort()), healable.join(','))
  expect('no publish, approve or lead kind is auto-healable', ['lead-reply', 'agent-submission', 'news-draft', 'held-post', 'held-guide-post', 'guide-caption-held', 'blog-draft', 'topic', 'promote-prompt'].every((k) => !cardActionsFor(k).canAutoHeal))
  const fns = read('lib/today-heal-fns.ts')
  for (const k of healable) {
    const fn = cardActionsFor(k).healFn as string
    expect(`${k}: healer "${fn}" is wired in lib/today-heal-fns.ts`, fns.includes(`'${fn}':`), fn)
  }
  for (const k of [...TODAY_KIND_IDS, 'hot-lead']) {
    const f = cardActionsFor(k).copyPromptFields
    expect(`${k}: Copy for Claude files exist`, f.files.length > 0 && f.files.every((p) => existsSync(join(process.cwd(), p))), f.files.filter((p) => !existsSync(join(process.cwd(), p))).join(','))
  }
  const two = rowTwoFor('lead-reply', { canGoBack: true, readOnly: false })
  expect('a lead card gets Previous, Later, Skip, Copy and no Auto-heal', two.previous && two.later && two.skip && two.copy && !two.autoHeal)
  expect('a failed post gets Auto-heal', rowTwoFor('failed-post', { canGoBack: false, readOnly: false }).autoHeal)
  expect('Previous is hidden at the start', !rowTwoFor('failed-post', { canGoBack: false, readOnly: false }).previous)
  const ro = rowTwoFor('failed-post', { canGoBack: true, readOnly: true })
  expect('a read-only card offers no Later, Skip or Auto-heal', !ro.later && !ro.skip && !ro.autoHeal && ro.previous && ro.copy)

  // ---- 2. Session state: Previous, Skip, Undo as pure functions
  const A = mk('failed-post', 'a')
  const B = mk('lead-reply', UUID)
  const C = mk('topic', UUID.replace('0b8f', '1b8f'))
  let s = run(emptySession(), { type: 'shown', card: A })
  expect('Previous is disabled at the start', !canGoBack(s, A.id))
  s = run(s, { type: 'answered', id: A.id, op: 'approve', label: 'Try again' }, { type: 'shown', card: B })
  expect('Previous is enabled from the second card', canGoBack(s, B.id))
  const before = JSON.stringify(s)
  const prev = sessionReducer(s, { type: 'previous', currentId: B.id, liveIds: [B.id, C.id] })
  expect('Previous to an answered card shows it read-only', prev.viewing?.id === A.id && prev.front === null)
  expect('Previous never re-answers: the outcome is kept', prev.history.find((h) => h.id === A.id)?.outcome?.label === 'Try again')
  expect('the reducer does not change its input', JSON.stringify(s) === before)
  expect('Undo is offered on a read-only answered card only when it is the last logged step and undoable', undoOffered(prev.viewing!, { id: A.id, undoable: true }) && !undoOffered(prev.viewing!, { id: B.id, undoable: true }) && !undoOffered(prev.viewing!, { id: A.id, undoable: false }) && !undoOffered(prev.viewing!, null))
  expect('Undo is not offered for a card with no answer', !undoOffered({ id: B.id, card: B, outcome: null }, { id: B.id, undoable: true }))
  expect('closing the read-only view returns to the live card', sessionReducer(prev, { type: 'closeView' }).viewing === null)
  expect('after an undo the card comes back first and the view closes', (() => { const u = sessionReducer(prev, { type: 'unanswered', id: A.id }); return u.front === A.id && u.viewing === null && u.history[0].outcome === null })())
  // an unanswered earlier card that is still in the queue is pulled to the front, not shown read-only
  let t = run(emptySession(), { type: 'shown', card: A }, { type: 'shown', card: B })
  const pulled = sessionReducer(t, { type: 'previous', currentId: B.id, liveIds: [A.id, B.id] })
  expect('Previous to an unanswered card still in the queue brings it to the front', pulled.front === A.id && pulled.viewing === null)
  expect('applySession puts the pulled-back card first', applySession([B, A, C], pulled).map((c) => c.id).join() === [A.id, B.id, C.id].join())
  const gone = sessionReducer(t, { type: 'previous', currentId: B.id, liveIds: [B.id] })
  expect('Previous to a card that left the queue is read-only', gone.viewing?.id === A.id)
  expect('Previous at the start of the history does nothing', sessionReducer(t, { type: 'previous', currentId: A.id, liveIds: [A.id] }) === t)
  // Skip
  const skipped = run(emptySession(), { type: 'skip', id: A.id })
  expect('Skip moves the card to the end', applySession([A, B, C], skipped).map((c) => c.id).join() === [B.id, C.id, A.id].join())
  const twice = run(skipped, { type: 'skip', id: B.id })
  expect('two skips keep their order, oldest skip first', applySession([A, B, C], twice).map((c) => c.id).join() === [C.id, A.id, B.id].join())
  expect('skipping the same card again moves it to the very end', applySession([A, B, C], run(twice, { type: 'skip', id: A.id })).map((c) => c.id).join() === [C.id, B.id, A.id].join())
  expect('Skip changes no history and no outcome (nothing is answered)', JSON.stringify(skipped.history) === '[]' && run(t, { type: 'skip', id: B.id }).history.every((h) => h.outcome === null))
  expect('a skipped card that is later answered leaves the skipped list', run(skipped, { type: 'answered', id: A.id, op: 'reject', label: 'Hold it' }).skipped.length === 0)
  expect('Skip with one card left leaves the order unchanged', applySession([A], skipped).map((c) => c.id).join() === A.id)
  expect('the skipped list reads back from session storage text', JSON.stringify(parseSkipped(JSON.stringify([A.id, 5, 'x']))) === JSON.stringify([A.id, 'x']) && parseSkipped('{bad').length === 0 && parseSkipped(null).length === 0)
  const tsx = read('components/admin/today-stack.tsx')
  const skipBody = tsx.slice(tsx.indexOf('const skip = useCallback'), tsx.indexOf('// Auto-heal: one call per card'))
  expect('the Skip handler makes no server call, no snooze and no log entry', skipBody.length > 40 && !/fetch\(|authHeaders|snooze|op: "/.test(skipBody.replace(/\/\/[^\n]*/g, '')), skipBody.slice(0, 80))

  // ---- 3. Auto-heal: caching, paused, caps, fake healers
  const NOW = new Date('2026-10-24T15:00:00Z')
  const memory = (initial: string | null = null) => {
    const st = { value: initial, writes: 0 }
    const store: HealStore = { read: async () => st.value, write: async (v) => { st.value = v; st.writes++ } }
    return { st, store }
  }
  const counted = (result: Awaited<ReturnType<Healer>>) => { const c = { n: 0, keys: [] as string[] }; const fn: Healer = async (key) => { c.n++; c.keys.push(key); return result }; return { c, fn } }

  {
    const { st, store } = memory()
    const h = counted({ state: 'fixed', message: 'Queued the post to try again.' })
    const base = { now: NOW, store, isPaused: async () => false, healers: { 'retry-failed-post': h.fn } }
    const r1 = await runCardHeal('failed-post:my-post', base)
    const r2 = await runCardHeal('failed-post:my-post', base)
    const r3 = await runCardHeal('failed-post:my-post', base)
    expect('the first press runs the healer once with the card key', r1.ok && r1.result.state === 'fixed' && h.c.n === 1 && h.c.keys[0] === 'my-post')
    expect('repeat presses the same day are free (cached, healer not called again)', h.c.n === 1 && r2.ok && r2.result.cached === true && r3.ok && r3.result.cached === true && r2.ok && r2.result.message === 'Queued the post to try again.')
    expect('only one cache write was needed', st.writes === 1)
    const next = await runCardHeal('failed-post:my-post', { ...base, now: new Date('2026-10-25T15:00:00Z') })
    expect('the next day runs it again', h.c.n === 2 && next.ok && !next.result.cached)
    const other = await runCardHeal('failed-post:other-post', base)
    expect('another card is cached separately', h.c.n === 3 && other.ok && !other.result.cached)
    expect('the cache is stored under the documented key and day', TODAY_HEAL_KEY === 'today_heal' && parseHealCache(st.value, healDay(NOW)).day === '2026-10-24')
  }
  {
    const { st, store } = memory()
    const h = counted({ state: 'fixed', message: 'x' })
    const r = await runCardHeal('failed-post:my-post', { now: NOW, store, isPaused: async () => true, healers: { 'retry-failed-post': h.fn } })
    expect('automation paused: skipped, healer never called', r.ok && r.result.state === 'skipped' && /paused/i.test(r.result.message) && h.c.n === 0)
    expect('a skipped answer is not cached (it can run once the pause ends)', st.writes === 0)
    const r2 = await runCardHeal('failed-post:my-post', { now: NOW, store, isPaused: async () => false, healers: { 'retry-failed-post': h.fn } })
    expect('after the pause the same card runs', r2.ok && r2.result.state === 'fixed' && h.c.n === 1)
    const unreadable = await runCardHeal('failed-post:my-post', { now: NOW, store: memory().store, isPaused: async () => { throw new Error('db down') }, healers: { 'retry-failed-post': h.fn } })
    expect('an unreadable kill switch counts as paused (fails closed)', unreadable.ok && unreadable.result.state === 'skipped' && h.c.n === 1)
  }
  {
    const capped = counted({ state: 'skipped', message: 'Skipped: the heal call budget is used up.' })
    const { st, store } = memory()
    const r = await runCardHeal(`guide-review:${UUID}`, { now: NOW, store, isPaused: async () => false, healers: { 'heal-guide-draft': capped.fn } })
    expect('a capped healer reports skipped and is not cached', r.ok && r.result.state === 'skipped' && st.writes === 0)
    const boom: Healer = async () => { throw new Error('model timeout') }
    const m = memory()
    const f1 = await runCardHeal(`guide-review:${UUID}`, { now: NOW, store: m.store, isPaused: async () => false, healers: { 'heal-guide-draft': boom } })
    expect('a healer that throws gives a failed answer, never an exception', f1.ok && f1.result.state === 'failed' && /model timeout/.test(f1.result.message))
    const f2 = await runCardHeal(`guide-review:${UUID}`, { now: NOW, store: m.store, isPaused: async () => false, healers: { 'heal-guide-draft': capped.fn } })
    expect('a failed answer is cached too (no repeat spend on a retry click)', f2.ok && f2.result.state === 'failed' && f2.result.cached === true)
    const un = counted({ state: 'unchanged', message: 'Tried and changed nothing.' })
    const m2 = memory()
    await runCardHeal('seo-fix:canonical', { now: NOW, store: m2.store, isPaused: async () => false, healers: { 'recheck-seo-item': un.fn } })
    const again = await runCardHeal('seo-fix:canonical', { now: NOW, store: m2.store, isPaused: async () => false, healers: { 'recheck-seo-item': un.fn } })
    expect('an unchanged answer is cached', un.c.n === 1 && again.ok && again.result.cached === true && again.result.state === 'unchanged')
  }
  {
    const h = counted({ state: 'fixed', message: 'x' })
    const deps = { now: NOW, store: memory().store, isPaused: async () => false, healers: { 'retry-failed-post': h.fn } }
    const lead = await runCardHeal(`lead-reply:${UUID}`, deps)
    const unknown = await runCardHeal('hot-lead:whatever', deps)
    const bad = await runCardHeal('failed-post:BAD ID', deps)
    const none = await runCardHeal(undefined, deps)
    expect('a card kind with no safe fix is refused (400) and the healer is not called', !lead.ok && lead.status === 400 && h.c.n === 0)
    expect('an unknown kind or a bad id is refused', !unknown.ok && !bad.ok && !none.ok)
    const missing = await runCardHeal('failed-post:ok', { ...deps, healers: {} })
    expect('a missing healer is skipped, not an error', missing.ok && missing.result.state === 'skipped')
  }
  {
    const old = JSON.stringify({ day: '2026-10-23', results: { 'failed-post:x': { state: 'fixed', message: 'm', at: '' } } })
    expect('a cache from yesterday is empty', Object.keys(parseHealCache(old, '2026-10-24').results).length === 0 && Object.keys(parseHealCache('{bad', '2026-10-24').results).length === 0)
    let c = parseHealCache(null, '2026-10-24')
    for (let i = 0; i < 200; i++) c = putHeal(c, `failed-post:p${i}`, { state: 'fixed', message: 'm', at: '' } as CardHealResult)
    expect('the cache stays small', Object.keys(c.results).length <= 120)
  }

  // ---- 4. Copy for Claude
  const SECRET = 'sk-live-ABCDEF1234567890abcdef'
  const lead = mk('lead-reply', UUID, {
    title: 'Dana asked about Cancun',
    why: `Someone asked about a trip. token: ${SECRET}`,
    facts: [{ label: 'Email', value: 'dana.private@example.com' }, { label: 'Phone', value: '+1 (416) 555-0142' }, { label: 'Came in', value: '2026-10-24' }, { label: 'Note', value: `Bearer abcdefghijklmnopqrstuvwxyz0123456789` }],
    link: { label: 'Open the lead', href: '/admin/leads' },
  })
  const p = buildCardPrompt({ now: NOW, card: lead })
  expect('the prompt carries the card title, kind, id and what it says', p.includes('Dana asked about Cancun') && p.includes(TODAY_KINDS['lead-reply'].badge) && p.includes(lead.id) && p.includes('Someone asked about a trip'))
  expect('the prompt carries the facts and the page link', p.includes('Came in: 2026-10-24') && p.includes('/admin/leads'))
  expect('the prompt names files to look at', p.includes('lib/leads.ts') && p.includes('Code to start from'))
  expect('the prompt has the safety rules and the fix/verify/report ask', /Safety rules/.test(p) && /Do not print, copy or commit any secret/.test(p) && /Commit and push only when I ask/.test(p) && /tsc --noEmit/.test(p) && /next build/.test(p) && /Report:/.test(p) && /CLAUDE\.md/.test(p))
  expect('the prompt contains no secret and no raw email or phone', !p.includes(SECRET) && !p.includes('abcdefghijklmnopqrstuvwxyz0123456789') && !p.includes('dana.private@example.com') && !p.includes('555-0142') && p.includes('d***@example.com'))
  expect('the prompt has no em or en dash', !DASH.test(p))
  expect('masking keeps dates, uuids and slugs', maskSensitive(`${UUID} 2026-10-24 a-very-long-slug-name-that-goes-on-and-on-and-on-and-on-forever`).includes('a-very-long-slug-name') && maskSensitive('2026-10-24').includes('2026-10-24') && maskSensitive(UUID) === UUID)
  const hot = buildCardPrompt({ now: NOW, card: { ...lead, kind: 'hot-lead' as unknown as TodayKindId, id: 'hot-lead:x' } })
  expect('an unknown kind still builds a prompt with the default files', hot.includes('lib/today-queue.ts') && hot.includes('Safety rules'))
  const healed = buildCardPrompt({ now: NOW, card: A, heal: { state: 'unchanged', message: 'Tried and changed nothing.' } })
  expect('a prompt says what Auto-heal already tried', healed.includes('Auto-heal was already pressed') && healed.includes('unchanged'))
  expect('the prompt builder is pure (no network, database or clock)', !/fetch\(|supabase|Date\.now|new Date\(\)/.test(read('lib/today-card-prompt.ts').replace(/\/\/[^\n]*/g, '')))

  // ---- 4b. Later menu and Open button
  expect('the Later menu offers 1 day, 3 days and 1 week, 1 day first', JSON.stringify(SNOOZE_CHOICES.map((c) => c.days)) === '[1,3,7]' && SNOOZE_CHOICES[0].label === '1 day' && SNOOZE_CHOICES[2].label === '1 week' && DEFAULT_SNOOZE_DAYS === 1)
  expect('only a listed snooze length is accepted', parseSnoozeDays(1) === 1 && parseSnoozeDays(3) === 3 && parseSnoozeDays(7) === 7 && parseSnoozeDays(2) === null && parseSnoozeDays(365) === null && parseSnoozeDays('3') === null && parseSnoozeDays(undefined) === null && parseSnoozeDays(-1) === null)
  const routeSrc = read('app/api/admin/today/route.ts')
  expect('the Today route snoozes for the chosen days through the existing snooze state', /parseSnoozeDays\(body\.days\) \?\? def\.snoozeDays/.test(routeSrc) && /addSnooze\(snoozed, id, hideDays, now\)/.test(routeSrc) && /TODAY_SNOOZE_KEY/.test(routeSrc))
  expect('a plain tap on Later sends 1 day; the menu sends the chosen days', /decide\("snooze", DEFAULT_SNOOZE_DAYS\)/.test(tsx) && /decide\("snooze", c\.days\)/.test(tsx) && /role="menu"/.test(tsx) && /aria-haspopup="menu"/.test(tsx))
  expect('the Later menu items are 44px touch targets', /role="menuitem"[\s\S]{0,200}min-h-11/.test(tsx))
  expect('the card own link wins for Open', openTargetFor({ kind: 'seo-fix', link: { label: 'x', href: '/admin/seo-manager#canonical' } })?.href === '/admin/seo-manager#canonical')
  expect('without a card link, Open uses the registry page for the kind', openTargetFor({ kind: 'lead-reply' })?.href === '/admin/leads' && openTargetFor({ kind: 'failed-post' })?.href === '/admin/distribution')
  expect('a new kind with no link has no Open button', openTargetFor({ kind: 'hot-lead' as unknown as TodayKindId }) === null && !rowTwoFor('hot-lead', { canGoBack: false, readOnly: false, hasTarget: false }).open)
  expect('an external link opens as external and a bad one is refused', openTargetFor({ kind: 'topic', link: { label: 'x', href: 'https://example.com/a' } })?.external === true && openTargetFor({ kind: 'topic', link: { label: 'x', href: '//evil.com' } }) === null && openTargetFor({ kind: 'topic', link: { label: 'x', href: 'javascript:alert(1)' } }) === null)
  expect('every kind either has an Open page that exists or none', TODAY_KIND_IDS.every((k) => {
    const t = openTargetFor({ kind: k })
    if (!t) return true
    if (!t.href.startsWith('/admin')) return false
    const path = t.href.split(/[?#]/)[0].replace(/\/$/, '')
    return path === '/admin' || existsSync(join(process.cwd(), 'app', path.slice(1), 'page.tsx'))
  }), TODAY_KIND_IDS.filter((k) => { const t = openTargetFor({ kind: k }); return t && t.href !== '/admin' && !existsSync(join(process.cwd(), 'app', t.href.split(/[?#]/)[0].slice(1), 'page.tsx')) }).map((k) => `${k}=${openTargetFor({ kind: k })?.href}`).join(','))
  expect('Open is a real link, not a script', /<Link href=\{target\.href\}/.test(tsx) && /<a href=\{target\.href\} target="_blank" rel="noopener noreferrer"/.test(tsx))

  // ---- 5. The route and the page
  const route = read('app/api/admin/today/heal/route.ts')
  const handler = route.match(/export async function POST\([^)]*\)[^{]*\{\s*\n([^\n]*\n[^\n]*\n)/)
  expect('the heal route checks isAuthorized first', !!handler && /isAuthorized\(request\)/.test(handler[1]))
  expect('the heal route runs through healTodayCard only', /healTodayCard\(/.test(route))
  const fnsSrc = read('lib/today-heal-fns.ts')
  expect('Auto-heal reuses the existing capped repairs (retry policy, guide heal with budget, kill switch)', /runRetryFailedPosts\(/.test(fnsSrc) && /healGuideRow\(/.test(fnsSrc) && /openBudget\(/.test(fnsSrc) && /isAutomationPaused\(/.test(fnsSrc) && /policyGate\(/.test(fnsSrc))
  expect('Auto-heal adds no cron and no vercel.json change', !/cron/i.test(route))
  expect('the page has the labelled second row with the conditional buttons', /aria-label="More options for this card"/.test(tsx) && /Previous/.test(tsx) && /Skip/.test(tsx) && /Auto-heal/.test(tsx) && /Copy for Claude/.test(tsx) && /Undo last/.test(tsx))
  expect('row 2 buttons are at least 44px tall', /min-h-11/.test(tsx.slice(tsx.indexOf('const ROW2_BTN'), tsx.indexOf('const ROW2_BTN') + 200)))
  expect('keyboard shortcuts P, L and S exist and are hinted', /e\.key === "p"/.test(tsx) && /e\.key === "l"/.test(tsx) && /e\.key === "s"/.test(tsx) && /P previous, L later, S skip/.test(tsx))
  expect('the two big buttons and the swipe are still there', /min-h-16/.test(tsx) && /SWIPE_PX/.test(tsx) && /bg-emerald-600/.test(tsx) && /border-red-600/.test(tsx))
  expect('the Today page stays cards-only (no strip or follow-ups block)', !/FollowUps|system-strip|SystemStrip/.test(tsx))
  expect('the result area reserves its height (no layout jump)', /min-h-\[2\.75rem\]/.test(tsx))
  for (const f of ['lib/today-card-actions.ts', 'lib/today-card-prompt.ts', 'lib/today-heal.ts', 'lib/today-heal-fns.ts', 'app/api/admin/today/heal/route.ts', 'components/admin/today-stack.tsx', 'scripts/check-today-actions.ts']) {
    const src = read(f)
    expect(`${f}: no em or en dash`, !DASH.test(src))
    expect(`${f}: no control characters`, !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(src))
  }
  expect('the new env-free change needs no .env.example entry', !/process\.env/.test(read('lib/today-heal-fns.ts') + read('lib/today-heal.ts') + read('lib/today-card-actions.ts')))

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`)
  process.exit(failures === 0 ? 0 : 1)
}
main().catch((e) => {
  console.error(e)
  process.exit(1)
})
