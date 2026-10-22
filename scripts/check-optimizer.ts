// Offline checks for the Optimizer (lib/optimizer.ts). No network, no database, no model call: simulated data only.
// Run: pnpm dlx tsx scripts/check-optimizer.ts   (exits 1 if any expectation fails)
import {
  MAX_ARMS, MAX_DECISIONS, MAX_STATE_CHARS, MIN_ARM_SENDS, EXPLORE_FLOOR, UNRETIRE_AFTER_DAYS, MIN_ACTIVE_ARMS, SETTLE_DAYS,
  allowedValues, armKey, bestWindow, belowMedianCtr, decide, easternHour, emptyState, ingest, makeHookSteer, parseContent, parseState,
  serializeState, steerPick, stitchFunnel, summarize, type Arm, type FunnelRow, type OptimizerState,
} from '../lib/optimizer'
import { assignHookStyles, hasGroundableNumber, questionNetworks } from '../lib/caption-plan'
import { HOOK_STYLES } from '../lib/hook-styles'

let failures = 0
function expect(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`)
  if (!ok) failures++
}

const DAY = 86_400_000
const NOW = new Date('2026-10-22T12:00:00Z')
const daysAgo = (d: number) => new Date(NOW.getTime() - d * DAY).toISOString()

// A small seeded random generator so every run is the same.
function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
function poisson(rate: number, rand: () => number): number {
  const L = Math.exp(-rate)
  let k = 0
  let p = 1
  do {
    k++
    p *= rand()
  } while (p > L)
  return k - 1
}

function setArm(state: OptimizerState, network: string, value: string, n: number, v: number, extra: Partial<Arm> = {}, format = 'post', dim: 'hook' | 'cover' = 'hook') {
  state.arms[armKey(network, format, dim, value)] = { network, format, dim, value, n, v, l: 0, status: 'active', ...extra }
}
const STYLES = ['question', 'number', 'contrarian', 'mistake', 'story', 'comparison', 'how-to']
/** A threads group where every style has `n` sends and `rate` visits per send, except those listed in `overrides`. */
function group(network: string, n: number, rate: number, overrides: Record<string, number> = {}, state = emptyState(NOW)): OptimizerState {
  for (const s of STYLES) setArm(state, network, s, n, Math.round(n * (overrides[s] ?? rate)))
  return state
}

// ---- (a) thin data: nothing is retired, nothing is steered ----------------------------------------------------------------
{
  const s = group('threads', 10, 0.5, { number: 0 })
  const r = decide(s, NOW)
  expect('(a) 10 sends per style: nothing retired', Object.values(r.state.arms).every((a) => a.status === 'active') && r.decisions.length === 0)
  const rand = seeded(1)
  let steered = 0
  for (let i = 0; i < 500; i++) if (steerPick(r.state, 'threads', 'post', 'hook', STYLES, rand)) steered++
  expect('(a) thin data never steers (always today\'s rotation)', steered === 0)
  const nineteen = group('threads', 19, 0.5, { number: 0 })
  expect('(a) 19 sends is still not enough to retire', decide(nineteen, NOW).decisions.length === 0)
  expect('(a) summary says not enough data', summarize(r.state).needMoreData === true && summarize(null).needMoreData === true)
}

// ---- (b) a clear loser is retired at 20 sends, only one per network per week ----------------------------------------------
{
  const s = group('threads', 24, 0.5, { number: 0.04, story: 0.04 })
  const r1 = decide(s, NOW)
  const retired = Object.values(r1.state.arms).filter((a) => a.status === 'retired')
  expect('(b) one clear loser retired at 24 sends', retired.length === 1, retired.map((a) => a.value).join())
  expect('(b) the decision explains itself in plain English', /^Retired the (number|story) style on Threads: 24 sends, 1 visit; will retest in 4 weeks\.$/.test(r1.decisions[0]?.text ?? ''), r1.decisions[0]?.text)
  const r2 = decide(r1.state, new Date(NOW.getTime() + 3 * DAY))
  expect('(b) a second loser is NOT retired 3 days later (one per network per week)', Object.values(r2.state.arms).filter((a) => a.status === 'retired').length === 1)
  const r3 = decide(r2.state, new Date(NOW.getTime() + 8 * DAY))
  expect('(b) the second loser goes after the week is up', Object.values(r3.state.arms).filter((a) => a.status === 'retired').length === 2)
  // exactly 20 sends is enough, 19 is not (checked above); a different network is independent
  const two = group('threads', 24, 0.5, { number: 0.04 })
  group('bluesky', 24, 0.5, { story: 0.04 }, two)
  const r4 = decide(two, NOW)
  expect('(b) each network may retire its own one', Object.values(r4.state.arms).filter((a) => a.status === 'retired').map((a) => a.network).sort().join() === 'bluesky,threads')
  // not retired when a close call (ranges overlap)
  const close = group('threads', 24, 0.5, { number: 0.3 })
  expect('(b) a close call is left alone', decide(close, NOW).decisions.length === 0)
  // never leave fewer than MIN_ACTIVE_ARMS in a group
  const small = emptyState(NOW)
  for (const [v, vis] of [['a', 12], ['b', 12], ['c', 12], ['d', 0]] as const) setArm(small, 'threads', v, 24, vis)
  expect('(b) a 4 arm group may lose one (3 remain)', decide(small, NOW).decisions.length === 1)
  const three = emptyState(NOW)
  for (const [v, vis] of [['a', 12], ['b', 12], ['c', 0]] as const) setArm(three, 'threads', v, 24, vis)
  expect(`(b) a ${MIN_ACTIVE_ARMS} arm group keeps all its arms`, decide(three, NOW).decisions.length === 0)
  // retired arms leave the rotation
  expect('(b) a retired style is left out of the choices', !allowedValues(r1.state, 'threads', 'post', 'hook', STYLES).includes(retired[0].value as string))
  expect('(b) if everything were retired the full list comes back', allowedValues(r1.state, 'threads', 'post', 'hook', [retired[0].value]).length === 1)
}

// ---- (c) the exploration floor is kept -------------------------------------------------------------------------------------
{
  const s = group('threads', 40, 0.1, { question: 0.9 })
  const rand = seeded(7)
  let nulls = 0
  const N = 6000
  const counts: Record<string, number> = {}
  for (let i = 0; i < N; i++) {
    const p = steerPick(s, 'threads', 'post', 'hook', STYLES, rand)
    if (p === null) nulls++
    else counts[p] = (counts[p] ?? 0) + 1
  }
  const share = nulls / N
  expect(`(c) about ${EXPLORE_FLOOR * 100} percent of choices go back to the rotation`, share > 0.12 && share < 0.18, String(share))
  expect('(c) the winner is chosen most, but not always', (counts.question ?? 0) / N > 0.5 && (counts.question ?? 0) / N < 0.9, JSON.stringify(counts))
}

// ---- (d) un-retire after 4 weeks ---------------------------------------------------------------------------------------------
{
  const s = group('threads', 24, 0.5, { number: 0.04 })
  const r1 = decide(s, NOW)
  const key = armKey('threads', 'post', 'hook', 'number')
  const early = decide(r1.state, new Date(NOW.getTime() + (UNRETIRE_AFTER_DAYS - 1) * DAY))
  expect('(d) still retired after 27 days', early.state.arms[key].status === 'retired')
  const late = decide(r1.state, new Date(NOW.getTime() + UNRETIRE_AFTER_DAYS * DAY))
  const a = late.state.arms[key]
  expect('(d) back on trial after 28 days with a clean slate', a.status === 'active' && a.n === 0 && a.v === 0 && !!a.since && late.decisions.some((d) => d.kind === 'unretire'))
  const again = decide(late.state, new Date(NOW.getTime() + UNRETIRE_AFTER_DAYS * DAY + DAY))
  expect('(d) it needs a fresh 20 sends before it can be retired again', again.state.arms[key].status === 'active')
  // sends from before the fresh start are not counted for it
  const rows: FunnelRow[] = [{ slug: 'old', network: 'threads', format: 'post', hookStyle: 'number', coverTemplate: null, sends: 5, visits: 0, leads: 0, impressions: null, firstAt: daysAgo(60), lastAt: daysAgo(60), sendTimes: [daysAgo(60)] }]
  const ing = ingest({ ...late.state, settledThrough: null }, rows, new Date(NOW.getTime() + UNRETIRE_AFTER_DAYS * DAY + 2 * DAY))
  expect('(d) old sends do not count against the fresh trial', ing.state.arms[key].n === 0)
}

// ---- (e) missing data is null, never zero --------------------------------------------------------------------------------
{
  const sends = [{ at: daysAgo(20), slug: 'rhine', network: 'threads', format: 'post', style: 'question' }]
  const none = stitchFunnel({ sends, visits: null, leads: null })
  expect('(e) visits not recorded: null, not 0', none[0].visits === null && none[0].leads === null && none[0].impressions === null)
  const zero = stitchFunnel({ sends, visits: [], leads: [] })
  expect('(e) recorded but none matched: a real 0', zero[0].visits === 0 && zero[0].leads === 0)
  const ing = ingest(emptyState(NOW), none, NOW)
  expect('(e) null visits are skipped, not counted as a zero-visit send', Object.keys(ing.state.arms).length === 0 && ing.skipped === 1 && ing.state.unmeasured === 1)
  const withImp = stitchFunnel({ sends, visits: [], leads: null, impressions: { rhine: 120, other: null } })
  expect('(e) impressions pass through; unknown stays null', withImp[0].impressions === 120)
  const rows = belowMedianCtr([{ path: '/a', clicks: null, impressions: 500, position: 5 }, { path: '/b', clicks: 0, impressions: null, position: 5 }])
  expect('(e) a page with a null click or impression figure is skipped', rows.length === 0)
  expect('(e) an arm with no sends has no per-send figure', summarize({ ...emptyState(NOW), arms: { x: { network: 'x', format: 'post', dim: 'hook', value: 'q', n: 0, v: 0, l: 0, status: 'active' } } }).arms[0].perSend === null)
}

// ---- stitch details --------------------------------------------------------------------------------------------------------
{
  expect('stitch: "how-to-post" keeps the dash in the style', JSON.stringify(parseContent('how-to-post')) === JSON.stringify({ style: 'how-to', format: 'post' }))
  expect('stitch: "question-video" is a reel', parseContent('question-video').format === 'reel')
  expect('stitch: "fallback-post" has no style', parseContent('fallback-post').style === null)
  const t = daysAgo(15)
  const sends = [
    { at: t, slug: 'rhine', network: 'twitter', format: 'post', style: 'question' },
    { at: t, slug: 'rhine', network: 'instagram/facebook', format: 'carousel', style: 'comparison' },
    { at: t, slug: 'rhine', network: 'instagram', format: 'post', style: 'fallback' },
  ]
  const visits = [
    { at: daysAgo(14), source: 'x', campaign: 'rhine', content: 'question-post' },
    { at: daysAgo(14), source: 'x', campaign: 'rhine', content: 'question-post' },
    { at: daysAgo(14), source: 'carousel', campaign: 'rhine', content: 'comparison-carousel' },
    { at: daysAgo(1), source: 'x', campaign: 'rhine', content: 'question-post' }, // far too late for this send
    { at: daysAgo(14), source: 'x', campaign: 'other', content: 'question-post' },
  ]
  const rows = stitchFunnel({ sends, visits, leads: [{ at: daysAgo(14), source: 'x', campaign: 'rhine', content: 'question-post' }], covers: { rhine: { feed: 'red-block-v1', carousel: 'teal-fact' } } })
  const x = rows.find((r) => r.network === 'x')!
  const car = rows.find((r) => r.format === 'carousel')!
  const ig = rows.find((r) => r.network === 'instagram')!
  expect('stitch: twitter becomes x and its two visits and one lead are joined', x.visits === 2 && x.leads === 1 && x.hookStyle === 'question' && x.coverTemplate === 'red-block-v1' && x.format === 'post')
  expect('stitch: a carousel is one shared row, joined by its format source', car.network === 'all' && car.visits === 1 && car.hookStyle === 'comparison' && car.coverTemplate === 'teal-fact' && car.sends === 1)
  expect('stitch: a fallback caption has no hook style and no visits are invented', ig.hookStyle === null && ig.visits === 0)
}

// ---- ingest: each send counted once; posting time -------------------------------------------------------------------------
{
  const mk = (slug: string, ageDays: number, visits: number): FunnelRow => ({ slug, network: 'threads', format: 'post', hookStyle: 'question', coverTemplate: 'red-block-v1', sends: 1, visits, leads: 0, impressions: null, firstAt: daysAgo(ageDays), lastAt: daysAgo(ageDays), sendTimes: [daysAgo(ageDays)] })
  const rows = [mk('a', 10, 2), mk('b', 3, 5)]
  const one = ingest(emptyState(NOW), rows, NOW)
  expect('ingest: only settled sends (older than a week) are counted', one.counted === 1 && one.state.arms[armKey('threads', 'post', 'hook', 'question')].n === 1)
  const twice = ingest(one.state, rows, NOW)
  expect('ingest: running it again counts nothing twice', twice.counted === 0 && twice.state.arms[armKey('threads', 'post', 'hook', 'question')].n === 1)
  const later = ingest(twice.state, rows, new Date(NOW.getTime() + 5 * DAY))
  expect('ingest: the newer send is counted once it settles', later.counted === 1 && later.state.arms[armKey('threads', 'post', 'hook', 'question')].n === 2 && later.state.arms[armKey('threads', 'post', 'cover', 'red-block-v1')].n === 2)
  expect('time: 22:00 UTC in October is 18:00 Eastern', easternHour('2026-10-20T22:00:00Z') === 18 && easternHour('2026-01-20T05:00:00Z') === 0 && easternHour('bad') === null)
  expect('ingest: settle window is a week', SETTLE_DAYS === 7)
  // posting window advice
  const cells = { '1': { n: 25, v: 3 }, '2': { n: 30, v: 4 }, '4': { n: 28, v: 33 }, '5': { n: 5, v: 9 } }
  const adv = bestWindow(cells)
  expect('time: a window that clearly wins is proposed (evening)', adv?.bucket === 4 && /8 am|4 pm/.test(adv.label) === true && /Shown only/.test(adv.text), JSON.stringify(adv))
  expect('time: windows with thin data propose nothing', bestWindow({ '1': { n: 10, v: 1 }, '4': { n: 12, v: 9 } }) === null)
  expect('time: similar windows propose nothing', bestWindow({ '1': { n: 30, v: 15 }, '4': { n: 30, v: 17 } }) === null)
  const dec = decide({ ...emptyState(NOW), time: { threads: cells } }, NOW)
  expect('time: the advice is stored with a plain decision line', !!dec.state.advice.threads && dec.decisions.some((d) => d.kind === 'window'))
}

// ---- (f) state is bounded; corrupt state falls back to the rotation -------------------------------------------------
{
  const big = emptyState(NOW)
  for (let i = 0; i < 500; i++) setArm(big, `net${i % 9}`, `style${i}`, i % 50, i % 7)
  for (let i = 0; i < 200; i++) big.decisions.push({ at: NOW.toISOString(), kind: 'retire', network: 'threads', format: 'post', dim: 'hook', value: `v${i}`, text: 'x'.repeat(300) })
  const text = serializeState(big)
  const back = parseState(text)
  expect('(f) stored state stays under the size cap', text.length <= MAX_STATE_CHARS, String(text.length))
  expect('(f) at most 120 arms and 30 decisions are kept', !!back && Object.keys(back.arms).length <= MAX_ARMS && back.decisions.length <= MAX_DECISIONS)
  const keepers = emptyState(NOW)
  setArm(keepers, 'threads', 'number', 40, 0, { status: 'retired', retiredAt: NOW.toISOString() })
  const k2 = parseState(serializeState(keepers))
  expect('(f) a normal state round-trips', !!k2 && k2.arms[armKey('threads', 'post', 'hook', 'number')].status === 'retired')
  for (const bad of ['{bad json', '[]', '{"v":2}', '', null, undefined, '"text"', '{"v":1,"arms":5}x']) {
    expect(`(f) corrupt state ${JSON.stringify(bad)} reads as null`, parseState(bad as string | null | undefined) === null)
  }
  expect('(f) garbage inside a valid shell is cleaned', (() => { const p = parseState('{"v":1,"arms":{"a":{"network":"x","format":"post","dim":"hook","value":"q","n":"lots","v":-4,"status":"weird"}},"decisions":"nope","time":[],"advice":7}'); const a = p && Object.values(p.arms)[0]; return !!a && a.n === 0 && a.v === 0 && a.status === 'active' && p!.decisions.length === 0 })())
  // fail open: no state or a broken helper gives exactly today's rotation
  const nets = ['facebook', 'instagram', 'threads', 'x']
  const hist = (n: string) => (n === 'x' ? ['question', 'story'] : ['mistake'])
  const plain = assignHookStyles(nets, hist, { hasNumber: true })
  expect('(f) no state: identical to today\'s rotation', JSON.stringify(assignHookStyles(nets, hist, { hasNumber: true, steer: makeHookSteer(null, 'post') })) === JSON.stringify(plain))
  const broken = { allowed: () => { throw new Error('boom') }, pick: () => { throw new Error('boom') } }
  expect('(f) a throwing helper gives today\'s rotation', JSON.stringify(assignHookStyles(nets, hist, { hasNumber: true, steer: broken })) === JSON.stringify(plain))
  // the caption rules still hold under steering
  const retiredQuestion = group('facebook', 30, 0.4, { question: 0, comparison: 0, number: 0 })
  group('instagram', 30, 0.4, {}, retiredQuestion)
  retiredQuestion.arms[armKey('facebook', 'post', 'hook', 'question')].status = 'retired'
  retiredQuestion.arms[armKey('facebook', 'post', 'hook', 'comparison')].status = 'retired'
  const rand = seeded(11)
  let rulesOk = true
  for (let i = 0; i < 300; i++) {
    const hasNumber = i % 2 === 0
    const styles = assignHookStyles(nets, hist, { hasNumber, steer: makeHookSteer(retiredQuestion, 'post', rand) })
    if (!hasNumber && Object.values(styles).includes('number')) rulesOk = false
    if (Object.values(styles).some((s) => !HOOK_STYLES.includes(s))) rulesOk = false
    if (styles.facebook === 'question' || styles.facebook === 'comparison') rulesOk = false
    if (Object.values(questionNetworks(nets, styles)).filter(Boolean).length < Math.ceil(nets.length / 2)) rulesOk = false
  }
  expect('(f) steering keeps the rules: no number without a number, retired styles stay out, half end in a question', rulesOk)
  expect('(f) groundable number check still the caption planner\'s own', hasGroundableNumber('7 day cruise') && !hasGroundableNumber('a cruise'))
}

// ---- (g) 200 rounds converge on the better arm without starving the others --------------------------------------------
{
  const trueRate: Record<string, number> = { question: 0.12, number: 0.12, story: 0.12, comparison: 0.5 }
  const arms = Object.keys(trueRate)
  let allOk = true
  const notes: string[] = []
  for (const seed of [1, 2, 3, 4, 5]) {
    const rand = seeded(seed * 101)
    const state = emptyState(NOW)
    const picks: string[] = []
    const used: string[] = []
    for (let round = 0; round < 200; round++) {
      // today's rotation: the least used of the last 8, never the one just used
      const rot = () => {
        const recent = used.slice(-8)
        const pool = arms.filter((a) => a !== used[used.length - 1])
        return [...pool].sort((a, b) => recent.filter((r) => r === a).length - recent.filter((r) => r === b).length)[0]
      }
      const choice = steerPick(state, 'threads', 'post', 'hook', arms, rand) ?? rot()
      used.push(choice)
      picks.push(choice)
      const k = armKey('threads', 'post', 'hook', choice)
      const arm = state.arms[k] ?? (state.arms[k] = { network: 'threads', format: 'post', dim: 'hook', value: choice, n: 0, v: 0, l: 0, status: 'active' })
      arm.n += 1
      arm.v += poisson(trueRate[choice], rand)
    }
    const total = (a: string) => picks.filter((p) => p === a).length
    const lastHalf = picks.slice(100)
    const bestShare = lastHalf.filter((p) => p === 'comparison').length / lastHalf.length
    const minOther = Math.min(...arms.filter((a) => a !== 'comparison').map(total))
    if (!(bestShare > 0.5) || !(minOther >= 8)) allOk = false
    notes.push(`seed ${seed}: best share ${bestShare.toFixed(2)}, least-used other ${minOther}`)
  }
  expect('(g) 200 simulated rounds, 5 seeds: the better arm leads and every other arm keeps getting sends', allOk, notes.join(' | '))
}

// ---- title and meta candidates ------------------------------------------------------------------------------------------
{
  const page = (i: number, impressions: number, clicks: number, position = 6) => ({ path: `/blog/p${i}`, impressions, clicks, position })
  const healthy = Array.from({ length: 10 }, (_, i) => page(i, 400, 20)) // 5 percent
  expect('title: fewer than 8 qualifying pages: nothing (no reliable median)', belowMedianCtr(healthy.slice(0, 7)).length === 0)
  expect('title: pages under 100 impressions are never judged', belowMedianCtr([...healthy, page(50, 99, 0)]).every((c) => c.path !== '/blog/p50'))
  const weak = belowMedianCtr([...healthy, page(60, 300, 2)])
  expect('title: a page well under the site median is queued (300 impressions, 2 clicks)', weak.length === 1 && weak[0].path === '/blog/p60' && weak[0].expected > 0.04, JSON.stringify(weak))
  expect('title: a page near the median is left alone', belowMedianCtr([...healthy, page(61, 300, 12)]).length === 0)
  expect('title: a page ranking far down is left alone (a title cannot fix it)', belowMedianCtr([...healthy, page(62, 300, 1, 40)]).length === 0)
  expect('title: thin traffic site (about 24 impressions a day) does nothing', belowMedianCtr(Array.from({ length: 20 }, (_, i) => page(i, 30, 0))).length === 0)
}

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
