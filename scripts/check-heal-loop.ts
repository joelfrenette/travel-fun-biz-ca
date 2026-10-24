// Offline checks for WP19 (self-healing loops, never hold for a person). No network, no database, no AI call.
// The model is a scripted stand-in, the database is the in-memory fake (scripts/fake-admin.ts).
// Run: pnpm dlx tsx scripts/check-heal-loop.ts
import { readFileSync } from 'node:fs'

// Make sure nothing in this file can reach a paid API, whatever the shell has set.
process.env.ANTHROPIC_API_KEY = ''
process.env.INDEXNOW_KEY = ''

import { fakeAdmin, type Db } from './fake-admin'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  HEAL_CALLS_DEFAULT,
  HEAL_CALLS_HARD_MAX,
  HEAL_LOG_MAX,
  HEAL_MAX_ROUNDS,
  MAX_REJECTS_PER_DAY,
  WHOLE_REGEN_CALLS,
  appendHealLog,
  deleteParagraph,
  freedBySince,
  hardOffenders,
  healItem,
  healLoop,
  healLoopCard,
  locateQuote,
  markRejected,
  openBudget,
  parseHealCap,
  readHealLog,
  readRejected,
  rejectLimitReached,
  setHealCap,
  validateRegeneratedUnit,
  judgeText,
  type HealBudget,
  type HealTarget,
} from '../lib/heal-loop'
import { healComposedPost } from '../lib/heal-targets'
import { GUIDE_LIMITS, buildPostItem } from '../lib/content-repair-adapters'
import { makeDetectCtx, validateRewrite, type RepairFields, type RepairItem } from '../lib/content-repair'
import { revertEdit } from '../lib/content-edits'
import { autoPublishBlockers, type ComposedPost } from '../lib/blog-composer'
import { composedFromRow, rehealStuckDrafts, rejectedPostSlugs, type RehealTags } from '../lib/blog-reheal'
import { guideBlockers } from '../lib/guide-composer'
import { pageCopyBlockers } from '../lib/page-copy-composer'
import { checkCadence, guideLimits } from '../lib/publish-cadence'
import { composedCopyFromRow, composedGuideFromRow, healGuideRow, healHeldCopy, healHeldGuides, isHealDraftCandidate, REJECTED_PREFIX, type CopyBriefParts, type GuideBriefParts } from '../lib/heal-drafts'
import { GUESSED_PROPERTY_NOTE, decideGuideSave, isGuessedProperty, isGuessedPropertyNote, readCapUsage } from '../lib/guide-run'
import { readCopyCapUsage } from '../lib/page-copy-run'
import { healLinesOf } from '../lib/debrief'

const LONG_DASH = new RegExp('[' + String.fromCharCode(0x2013, 0x2014) + ']')
let failed = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`)
  if (!ok) failed++
}
const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

// ---------------------------------------------------------------------------------------------------
// Scripted stand-ins
// ---------------------------------------------------------------------------------------------------

type Handler = (n: number, prompt: string) => string | null
interface Scripted {
  model: (prompt: string, maxTokens: number, timeoutMs: number) => Promise<string | null>
  count: { suggest: number; judge: number; section: number; extras: number; other: number; total: number }
  prompts: { judge: string[]; suggest: string[] }
}
function scripted(h: { suggest?: Handler; judge?: Handler; section?: Handler; extras?: Handler }): Scripted {
  const count = { suggest: 0, judge: 0, section: 0, extras: 0, other: 0, total: 0 }
  const prompts = { judge: [] as string[], suggest: [] as string[] }
  const model = async (prompt: string): Promise<string | null> => {
    count.total++
    if (/independent quality reviewer/.test(prompt)) {
      count.judge++
      prompts.judge.push(prompt)
      return (h.judge ?? (() => '{"pass":true,"failures":[]}'))(count.judge, prompt)
    }
    if (/repairing sentences/.test(prompt)) {
      count.suggest++
      prompts.suggest.push(prompt)
      return (h.suggest ?? (() => '{"rewrites":[]}'))(count.suggest, prompt)
    }
    if (/Rewrite one section/.test(prompt)) {
      count.section++
      return (h.section ?? (() => null))(count.section, prompt)
    }
    if (/Write ONLY the fields listed/.test(prompt)) {
      count.extras++
      return (h.extras ?? (() => '{}'))(count.extras, prompt)
    }
    count.other++
    return null
  }
  return { model, count, prompts }
}

/** A budget that lives in memory: the loop logic without a database. */
function memBudget(cap: number): HealBudget {
  const b: HealBudget = {
    cap,
    used: 0,
    readable: true,
    remaining: () => Math.max(0, cap - b.used),
    take: async (n = 1) => {
      if (b.used + n > cap) return false
      b.used += n
      return true
    },
  }
  return b
}

/** Wraps the fake so every read of one table fails (to prove the fail-closed paths). */
function failReads(inner: SupabaseClient, table: string): SupabaseClient {
  const failing: Record<string, unknown> = new Proxy({}, { get: (_t, prop) => (prop === 'then' ? (resolve: (v: unknown) => unknown) => resolve({ data: null, error: { message: 'boom' }, count: null }) : prop === 'maybeSingle' || prop === 'single' ? async () => ({ data: null, error: { message: 'boom' } }) : () => failing) })
  return { from: (t: string) => (t === table ? failing : inner.from(t)), rpc: inner.rpc.bind(inner) } as unknown as SupabaseClient
}

// ---------------------------------------------------------------------------------------------------
// A synthetic page (a custom deterministic gate that uses the real blocker wording)
// ---------------------------------------------------------------------------------------------------

const SUMMARY = 'Lisbon is a hilly coastal city that rewards slow walking and long lunches.'
const GROUNDING = 'Lisbon is a city in Portugal. Travellers walk the hills and ride the trams.'
const bodyOf = (oldTown: string, food = 'Grilled fish and custard tarts are common. Most places serve lunch at a relaxed pace.') =>
  [
    '## Getting around', '', 'Trams and funiculars climb the hills. Walking shoes with grip help on the stone streets. A day pass keeps things simple.', '',
    '## The old town', '', oldTown, '',
    '## Food', '', food, '',
    '## Day trips', '', 'Coastal towns sit a short train ride away. Many travellers add one on a free day.',
  ].join('\n')
const OLD_TOWN_FAMOUS = 'The famous old town is a pleasant place to wander. Narrow lanes open onto small squares. Cafes fill with locals at midday.'

const synthGate = (f: RepairFields): string[] => {
  const all = [f.summary ?? '', f.body].join('\n')
  const out: string[] = []
  const words = all.split(/\s+/).filter(Boolean).length
  if (words < 50) out.push(`too short (${words} words)`)
  if (/\b(famous|best|luxury)\b/i.test(all)) out.push('superlative or rating claim (reputation claim)')
  if (/\bwe (visited|stayed)\b/i.test(all)) out.push('fabricated experience claim')
  if (/\b180\b/.test(all)) out.push('number not in the grounding: 180')
  return out
}

function synthTarget(body: string, opts: { gate?: (f: RepairFields) => string[]; regenerateWhole?: HealTarget['regenerateWhole'] } = {}): HealTarget {
  const fields: RepairFields = {
    summary: SUMMARY,
    body,
    meta_title: 'Lisbon travel guide',
    meta_description: 'A plain guide to Lisbon for travellers who like to walk.',
    og_title: 'Lisbon travel guide',
    og_description: 'A plain guide to Lisbon.',
    faq: [{ q: 'Is Lisbon hilly?', a: 'Yes, the streets climb.' }, { q: 'Can I walk?', a: 'Yes, with grip shoes.' }, { q: 'Are there trams?', a: 'Yes.' }, { q: 'Is lunch long?', a: 'It can be.' }],
    key_takeaways: ['Hilly city', 'Walk with grip', 'Ride the trams'],
  }
  const item: RepairItem = { type: 'guide', id: null, path: '/destinations/lisbon', fields, grounding: GROUNDING, names: ['Lisbon', 'Portugal'], allowedPaths: new Set(['/', '/packages']), limits: GUIDE_LIMITS, gate: opts.gate ?? synthGate }
  return { type: 'guide', key: 'guide:destinations:lisbon', path: '/destinations/lisbon', item, brief: GROUNDING, regenerateWhole: opts.regenerateWhole }
}

const deleteFirst: Handler = () => '{"rewrites":[{"id":0,"delete":true}]}'
const allText = (f: RepairFields) => `${f.summary ?? ''}\n${f.body}`

async function main() {
  // ---- parse and the pure pieces ----
  // heal-relax: the code default moved from 20 to 40 and the round limit from 3 to 5 (fixtures updated here).
  check('1: the default daily cap is 40 and the hard max is 60', HEAL_CALLS_DEFAULT === 40 && HEAL_CALLS_HARD_MAX === 60)
  check('1: an unset or unreadable setting means 40, a big number is cut to 60, 0 means off', parseHealCap(null) === 40 && parseHealCap('') === 40 && parseHealCap('abc') === 40 && parseHealCap('-3') === 40 && parseHealCap('2.5') === 40 && parseHealCap('35') === 35 && parseHealCap('500') === 60 && parseHealCap('0') === 0)
  check('1: five rounds is the per-item limit', HEAL_MAX_ROUNDS === 5)

  // ---- A: the loop passes on round 2 (judge adds a failure, suggester fixes it, judge passes) ----
  {
    const m = scripted({
      suggest: (n) => (n === 1 ? '{"rewrites":[{"id":0,"text":"The old town is a pleasant place to wander."}]}' : deleteFirst(n, '')),
      judge: (n) => (n === 1 ? '{"pass":false,"failures":[{"quote":"Cafes fill with locals at midday.","rule":8,"reason":"a claim the facts do not support"}]}' : '{"pass":true,"failures":[]}'),
    })
    const out = await healLoop(synthTarget(bodyOf(OLD_TOWN_FAMOUS)), { model: m.model, budget: memBudget(20) })
    check('A: healed on round 2', out.status === 'healed' && out.rounds === 2, JSON.stringify({ s: out.status, r: out.rounds, reasons: out.reasons }))
    check('A: the famous claim is reworded and the reviewer sentence is gone', !/famous/i.test(allText(out.fields)) && !/Cafes fill/.test(allText(out.fields)) && /old town is a pleasant place/.test(allText(out.fields)))
    check('A: round 2 gave the suggester the QA reviewer reason', /Cafes fill with locals/.test(m.prompts.suggest[1] ?? '') && /QA reviewer/.test(m.prompts.suggest[1] ?? ''))
    check('A: the judge ran twice, the suggester twice', m.count.judge === 2 && m.count.suggest === 2)
    check('A: the final text passes the deterministic gate', synthGate(out.fields).length === 0)
    check('A: the healed text is logged as content_edits rows with before and after', out.edits.length >= 1 && out.edits.every((e) => e.before !== e.after) && out.edits.some((e) => e.field === 'body'))
    check('A: every model call is bounded by the budget (4 calls used)', out.calls === 4)
  }

  // ---- B: ladder order (a) strip, (b) section, (c) whole ----
  {
    // (a): the suggester only sends refused rewrites (they add a number); deleting the sentence fixes it.
    const m = scripted({ suggest: () => '{"rewrites":[{"id":0,"text":"The old town, with 200 narrow lanes, is a pleasant place to wander."}]}' })
    const out = await healLoop(synthTarget(bodyOf(OLD_TOWN_FAMOUS)), { model: m.model, budget: memBudget(20) })
    check('B(a): after three refused rounds the ladder strips the sentence and the judge passes', out.status === 'healed' && out.ladder.join() === 'suggest,strip' && m.count.suggest === HEAL_MAX_ROUNDS, JSON.stringify({ s: out.status, l: out.ladder, n: m.count.suggest }))
    check('B(a): nothing the suggester tried to add survived (no 200)', !/200/.test(allText(out.fields)) && !/famous/i.test(allText(out.fields)))
  }
  {
    // (b): the only paragraph of a section is flagged, so a deletion would empty the section: the section is rewritten from the brief.
    const body = bodyOf(OLD_TOWN_FAMOUS, 'The famous grilled fish is served at lunch.')
    const section = '## Food\n\nGrilled fish and custard tarts are common at lunch. Most places serve meals at a relaxed pace.'
    const m = scripted({ section: () => section })
    const out = await healLoop(synthTarget(body), { model: m.model, budget: memBudget(20) })
    check('B(b): the offending section is rewritten from the brief after the strip', out.ladder.join() === 'suggest,strip,section' && out.status === 'healed', JSON.stringify({ s: out.status, l: out.ladder, r: out.reasons }))
    check('B(b): the rewritten section is in the text and the superlative is gone', /custard tarts are common at lunch/.test(out.fields.body) && !/\bbest\b/i.test(out.fields.body))
    check('B(b): a paragraph that is the only text of its section is never deleted by the strip', deleteParagraph({ ...synthTarget(body).item.fields }, { field: 'body', text: 'The famous grilled fish is served at lunch.', why: 'x', prefix: '' }) === null)
  }
  {
    // (c): the section rewrite is refused too (it still says best), so the whole post is written again.
    const body = bodyOf(OLD_TOWN_FAMOUS, 'The famous grilled fish is served at lunch.')
    const whole: RepairFields = { ...synthTarget(body).item.fields, body: bodyOf('The old town is a pleasant place to wander. Narrow lanes open onto small squares.') }
    const m = scripted({ section: () => '## Food\n\nThe famous grilled fish is served at lunch every day.' })
    const budget = memBudget(20)
    const out = await healLoop(synthTarget(body, { regenerateWhole: async () => whole }), { model: m.model, budget })
    const order = out.ladder
    check('C: the ladder order is suggest, strip, section, whole', order.join() === 'suggest,strip,section,whole' && out.status === 'healed', JSON.stringify({ s: out.status, l: order, r: out.reasons }))
    check('C: a whole-post rewrite is charged as five calls against the daily budget', budget.used >= WHOLE_REGEN_CALLS)
    check('C: the section rewrite that kept the problem was thrown away', !/every day/.test(out.fields.body))
  }

  // ---- D: never publishes on a gate failure; the judge cannot override the gate ----
  {
    const m = scripted({ judge: () => '{"pass":true,"failures":[]}', section: () => '## Food\n\nThe famous grilled fish is served at lunch every day.' })
    const out = await healLoop(synthTarget(bodyOf(OLD_TOWN_FAMOUS, 'The famous grilled fish is served at lunch.')), { model: m.model, budget: memBudget(20) })
    check('D: when the ladder cannot clear the gate the item is rejected_by_heal, not published', out.status === 'rejected_by_heal' && out.edits.length === 0, JSON.stringify({ s: out.status, r: out.reasons }))
    check('D: a rejected item comes back with exactly the fields that went in', out.fields.body === synthTarget(bodyOf(OLD_TOWN_FAMOUS, 'The famous grilled fish is served at lunch.')).item.fields.body)
    check('D: the judge is never asked about text that fails the gate', m.count.judge === 0, `judge calls ${m.count.judge}`)
  }
  {
    const m = scripted({ judge: () => '{"pass":true,"failures":[]}' })
    const out = await healLoop(synthTarget(bodyOf(OLD_TOWN_FAMOUS), { gate: () => ['placeholder text'] }), { model: m.model, budget: memBudget(20) })
    check('D: a gate that can never pass is never overridden by a judge that always says pass', out.status === 'rejected_by_heal' && m.count.judge === 0, JSON.stringify({ s: out.status, j: m.count.judge }))
  }
  {
    // "pass": true with a failure listed is a fail: the judge can only add failures.
    const m = scripted({ suggest: deleteFirst, judge: () => '{"pass":true,"failures":[{"quote":"Narrow lanes open onto small squares.","reason":"unsupported"}]}' })
    const out = await healLoop(synthTarget(bodyOf(OLD_TOWN_FAMOUS)), { model: m.model, budget: memBudget(20) })
    check('D: "pass" with a failure listed counts as a fail', out.status !== 'healed', JSON.stringify({ s: out.status }))
  }
  {
    // A text that passed the gate on its own but is then changed behind the loop's back must not be reported healed.
    let toggle = 0
    const flaky = (f: RepairFields) => (toggle++ > 40 ? [] : synthGate(f))
    const m = scripted({ suggest: deleteFirst })
    const out = await healLoop(synthTarget(bodyOf(OLD_TOWN_FAMOUS), { gate: flaky }), { model: m.model, budget: memBudget(20) })
    check('D: the last wall re-runs the gate on the final fields before reporting healed', out.status === 'healed' ? synthGate(out.fields).length === 0 : true)
  }

  // ---- E: hard reasons are healed by removal, not left for a person; additions are refused ----
  {
    const body = bodyOf('We stayed at a small hotel near the old town and loved it. Narrow lanes open onto small squares. Cafes fill with locals at midday.')
    check('E: an experience claim sentence is found behind the blocker', hardOffenders({ ...synthTarget(body).item.fields }, ['fabricated experience claim']).some((o) => /We stayed/.test(o.text)))
    const m = scripted({ suggest: deleteFirst })
    const out = await healLoop(synthTarget(body), { model: m.model, budget: memBudget(20) })
    check('E: a first-person experience claim is removed and the draft heals', out.status === 'healed' && !/We stayed/.test(allText(out.fields)), JSON.stringify({ s: out.status, r: out.reasons }))
    const m2 = scripted({ suggest: () => 'not json' })
    const out2 = await healLoop(synthTarget(body), { model: m2.model, budget: memBudget(20) })
    check('E: even with a useless suggester the strip removes the claim (healing only deletes)', out2.status === 'healed' && !/We stayed/.test(allText(out2.fields)) && out2.ladder.includes('strip'))
    const m3 = scripted({ suggest: () => '{"rewrites":[{"id":0,"text":"The old town was loved by our guests for years."}]}' })
    const out3 = await healLoop(synthTarget(body), { model: m3.model, budget: memBudget(20) })
    check('E: a rewrite that brings new words (a claim) is thrown away', !/our guests/.test(allText(out3.fields)))
  }
  check('E: a regenerated section with a price, a person, an experience claim or an outside link is refused',
    ['It costs $450 per person.', 'Dr. Silva said the walk is easy.', 'We stayed at the hotel and loved it.', 'See https://example.com for more.', 'Read [more](https://example.com/x).'].every((t) =>
      validateRegeneratedUnit({ text: '## Food\n\nA short sentence here about lunch.', heading: '## Food' }, `## Food\n\n${t} Lunch is relaxed.`, makeDetectCtx('guide', GROUNDING, ['Lisbon']), new Set(['/', '/packages'])) !== null))
  check('E: a clean regenerated section is accepted', validateRegeneratedUnit({ text: '## Food\n\nA short sentence here about lunch.', heading: '## Food' }, '## Food\n\nGrilled fish is common. Lunch is relaxed here.', makeDetectCtx('guide', GROUNDING, ['Lisbon']), new Set(['/', '/packages'])) === null)
  check('E: locateQuote finds a sentence through link syntax', locateQuote({ ...synthTarget(bodyOf('See [the trip](/packages) soon. Another sentence follows it.')).item.fields }, { quote: 'See the trip soon.', reason: 'x' }) !== null)

  // ---- F: the AI is down: waits, does not reject ----
  {
    const m = scripted({ suggest: () => null, judge: () => null })
    const out = await healLoop(synthTarget(bodyOf(OLD_TOWN_FAMOUS)), { model: m.model, budget: memBudget(20) })
    check('F: with the AI down the item is deferred (not rejected) and little budget is burnt', out.status === 'deferred' && m.count.total <= 2, JSON.stringify({ s: out.status, n: m.count.total, r: out.reasons }))
  }

  // ---- G: the daily cap and the fail-closed counter (with the fake database) ----
  const today = new Date()
  const tomorrow = new Date(today.getTime() + 86_400_000)
  {
    const db: Db = { tables: { app_settings: [{ key: 'heal_loop_calls_per_day', value: '3' }], content_edits: [] } }
    const admin = fakeAdmin(db)
    // judge keeps failing and the suggester keeps deleting: this item will use every call it can get
    const m = scripted({ suggest: deleteFirst, judge: () => '{"pass":false,"failures":[{"quote":"Narrow lanes open onto small squares.","reason":"unsupported"}]}' })
    const run = await healItem(admin, synthTarget(bodyOf(OLD_TOWN_FAMOUS)), { model: m.model, now: today })
    check('G: with a cap of 3 at most 3 model calls are made and the item waits (deferred)', m.count.total <= 3 && run.outcome.status === 'deferred', JSON.stringify({ n: m.count.total, s: run.outcome.status, r: run.outcome.reasons }))
    const slots = db.tables.app_settings.filter((r) => String(r.key).startsWith('heal_loop_call:'))
    check('G: each call takes its own slot row in app_settings before it is made', slots.length === m.count.total, JSON.stringify(slots.map((r) => r.key)))
    const m2 = scripted({ suggest: deleteFirst })
    const second = await healItem(admin, synthTarget(bodyOf(OLD_TOWN_FAMOUS)), { model: m2.model, now: today })
    check('G: a second item the same day sees the used count: no call, waits for tomorrow', m2.count.total === 0 && second.outcome.status === 'deferred' && /limit/.test(second.outcome.reasons.join(' ')), JSON.stringify({ n: m2.count.total, r: second.outcome.reasons }))
    const m3 = scripted({ suggest: deleteFirst })
    const third = await healItem(admin, synthTarget(bodyOf(OLD_TOWN_FAMOUS)), { model: m3.model, now: tomorrow })
    check('G: the next day the budget is fresh again', m3.count.total > 0 && third.outcome.status === 'healed', JSON.stringify({ n: m3.count.total, s: third.outcome.status }))
    const card = await healLoopCard(admin, today)
    check('G: the Autopilot card says plainly that the limit is used up (not an error)', /used up/.test(card.waiting) && /Nothing is wrong/.test(card.waiting) && card.cap === 3 && card.readable)
  }
  {
    const db: Db = { tables: { app_settings: [{ key: 'heal_loop_calls_per_day', value: '0' }], content_edits: [] } }
    const m = scripted({ suggest: deleteFirst })
    const run = await healItem(fakeAdmin(db), synthTarget(bodyOf(OLD_TOWN_FAMOUS)), { model: m.model, now: today })
    check('G: a cap of 0 switches the loop off: no call, deferred', m.count.total === 0 && run.outcome.status === 'deferred')
  }
  {
    const db: Db = { tables: { app_settings: [{ key: 'heal_loop_calls_per_day', value: '500' }], content_edits: [] } }
    const b = await openBudget(fakeAdmin(db), today)
    check('G: a stored cap above the hard max is cut to 60', b.cap === 60 && b.readable)
    const set = await setHealCap(fakeAdmin(db), 61)
    check('G: the setter refuses a number above 60', !!set.error)
  }
  {
    const db: Db = { tables: { app_settings: [], content_edits: [] } }
    const m = scripted({ suggest: deleteFirst })
    const run = await healItem(failReads(fakeAdmin(db), 'app_settings'), synthTarget(bodyOf(OLD_TOWN_FAMOUS)), { model: m.model, now: today })
    check('G: FAIL CLOSED: a counter that cannot be read means no model call at all', m.count.total === 0 && run.outcome.status === 'deferred' && /could not read/.test(run.outcome.reasons.join(' ')), JSON.stringify(run.outcome.reasons))
    const b = await openBudget(failReads(fakeAdmin(db), 'app_settings'), today)
    check('G: FAIL CLOSED: an unreadable budget has a cap of 0 and refuses to take a call', !b.readable && b.cap === 0 && (await b.take()) === false)
    const card = await healLoopCard(failReads(fakeAdmin(db), 'app_settings'), today)
    check('G: the card shows the unreadable counter in plain words', !card.readable && /could not be read/.test(card.waiting))
  }
  {
    // two overlapping runs (the pipeline and Heal now) that both read "0 used" can never exceed the cap together
    const db: Db = { tables: { app_settings: [{ key: 'heal_loop_calls_per_day', value: '3' }], content_edits: [] } }
    const admin = fakeAdmin(db)
    const a = await openBudget(admin, today)
    const b = await openBudget(admin, today)
    const gotA = await a.take(2)
    const gotB = await b.take(2)
    const rows = db.tables.app_settings.filter((r) => String(r.key).startsWith('heal_loop_call:')).length
    check('G: two runs that read the same count cannot spend past the cap (atomic slot rows)', gotA && !gotB && rows === 3 && b.remaining() === 0, JSON.stringify({ gotA, gotB, rows }))
  }
  {
    const db: Db = { tables: { app_settings: [], content_edits: [] }, failWrites: { app_settings: 'read only' } }
    const m = scripted({ suggest: deleteFirst })
    const run = await healItem(fakeAdmin(db), synthTarget(bodyOf(OLD_TOWN_FAMOUS)), { model: m.model, now: today })
    check('G: FAIL CLOSED: if the used count cannot be saved no call is made', m.count.total === 0 && run.outcome.status !== 'healed')
  }
  {
    const db: Db = { tables: { app_settings: [] } }
    const m = scripted({ suggest: deleteFirst })
    const run = await healItem(failReads(fakeAdmin(db), 'content_edits'), synthTarget(bodyOf(OLD_TOWN_FAMOUS)), { model: m.model, now: today })
    check('G: without the edit log table (migration 0033) nothing is healed or spent', m.count.total === 0 && run.outcome.status === 'deferred' && /0033/.test(run.outcome.note))
  }
  {
    const db: Db = { tables: { app_settings: [], content_edits: [] }, rejectInsert: (t) => (t === 'content_edits' ? 'cannot write' : null) }
    const m = scripted({ suggest: deleteFirst })
    const run = await healItem(fakeAdmin(db), synthTarget(bodyOf(OLD_TOWN_FAMOUS)), { model: m.model, now: today })
    check('G: log, then apply: if the audit rows cannot be written the healed text is not used', run.outcome.status === 'deferred' && /allow|audit/.test(run.outcome.note) && run.outcome.fields.body === synthTarget(bodyOf(OLD_TOWN_FAMOUS)).item.fields.body)
  }

  // ---- H: rejected_by_heal frees the slot and the pipeline moves on ----
  {
    const db: Db = { tables: { app_settings: [], content_edits: [] } }
    const admin = fakeAdmin(db)
    const m = scripted({ section: () => '## Food\n\nThe famous grilled fish is served at lunch every day.' })
    const run = await healItem(admin, synthTarget(bodyOf(OLD_TOWN_FAMOUS, 'The famous grilled fish is served at lunch.')), { model: m.model, now: today })
    check('H: a rejected item is recorded in the rejected list with its reasons', run.outcome.status === 'rejected_by_heal' && !!(await readRejected(admin))?.['guide:destinations:lisbon']?.reasons.length)
    const log = await readHealLog(admin)
    check('H: the compact log has one line with status, rounds, calls and a reason', log.length === 1 && log[0].status === 'rejected_by_heal' && log[0].rounds >= 1 && log[0].calls >= 1 && log[0].reason.length > 0, JSON.stringify(log))
    for (let i = 0; i < HEAL_LOG_MAX + 5; i++) await appendHealLog(admin, { at: today.toISOString(), type: 'post', path: `/blog/x${i}`, status: 'healed', rounds: 1, calls: 2, ladder: ['suggest'], reason: 'ok' })
    check('H: the log keeps the last 100 only', (await readHealLog(admin)).length === HEAL_LOG_MAX)
    check('H: after 3 rejections today new writing waits (a bounded spend)', (await rejectLimitReached(admin, today)).reached === false)
    for (const k of ['a', 'b']) await markRejected(admin, `guide:destinations:${k}`, { at: today.toISOString(), type: 'guide', path: `/destinations/${k}`, reasons: ['x'], rounds: 3 })
    const lim = await rejectLimitReached(admin, today)
    check('H: MAX_REJECTS_PER_DAY rejections stop new writing for the day, plainly', MAX_REJECTS_PER_DAY === 3 && lim.reached && !lim.unreadable && /tomorrow/.test(lim.note))
    const bad = await rejectLimitReached(failReads(fakeAdmin({ tables: {} }), 'app_settings'), today)
    check('H: an unreadable rejected list stops writing (fail closed) and says so', bad.reached && bad.unreadable)
  }
  {
    // the guide and page-copy daily counts: a rejected row does not use its slot
    const stamp = new Date().toISOString()
    const db: Db = {
      tables: {
        guides: [{ id: 'g1', kind: 'hotels', slug: 'sea-view', created_at: stamp }, { id: 'g2', kind: 'hotels', slug: 'other', created_at: stamp }],
        page_copy: [{ id: 'p1', path: '/compare/a-vs-b', created_at: stamp }],
        app_settings: [
          { key: 'heal_rejected:guide:hotels:sea-view', value: JSON.stringify({ at: stamp, type: 'guide', path: '/hotels/sea-view', reasons: ['x'], rounds: 3 }) },
          { key: 'heal_rejected:page_copy:/compare/a-vs-b', value: JSON.stringify({ at: stamp, type: 'page_copy', path: '/compare/a-vs-b', reasons: ['x'], rounds: 3 }) },
        ],
      },
    }
    const admin = fakeAdmin(db)
    const guides = await readCapUsage(admin)
    check('H: a guide rejected by the heal no longer counts for the day or the week (one slot back)', guides.today === 1 && guides.week === 1, JSON.stringify(guides))
    const copy = await readCopyCapUsage(admin)
    check('H: page copy rejected by the heal no longer counts either', copy.today === 0 && copy.week === 0, JSON.stringify(copy))
    const blind = await readCapUsage(failReads(admin, 'app_settings'))
    check('H: if the rejected list cannot be read nothing is freed (the count stays whole)', blind.today === 2, JSON.stringify(blind))
    // an EARLIER rejection must not free a LATER page written for the same name
    const old = new Date(Date.now() - 3 * 86_400_000).toISOString()
    const db2: Db = { tables: { guides: [{ id: 'g9', kind: 'hotels', slug: 'sea-view', created_at: stamp }], app_settings: [{ key: 'heal_rejected:guide:hotels:sea-view', value: JSON.stringify({ at: old, type: 'guide', path: '/hotels/sea-view', reasons: ['x'], rounds: 3 }) }] } }
    check('H: a rejection from days ago does not free a page written later for the same name', (await readCapUsage(fakeAdmin(db2))).today === 1)
    check('H: freedBySince frees nothing without a list', (await freedBySince(failReads(admin, 'app_settings'), { table: 'guides', type: 'guide', columns: 'kind, slug', keyOf: (r) => `guide:${String(r.kind)}:${String(r.slug)}` }, '2000-01-01')) === 0)
  }

  // ---- I: blog drafts ----
  const goodBody = ['A river cruise is a relaxed way to see several towns without repacking.', '', '**Quick answer:** A river cruise suits first timers who want an easy pace, one bed all week and several towns without repacking.', '', '## Why a river cruise works for first timers', '', 'It is a floating hotel. See [the Rhine trip](/packages/rhine-cruise) for the real details, ask us in [the contact section](/#contact) or browse [our trips](/). ' + 'word '.repeat(460), '', '### Pace', '', 'Most people find the pace gentle. It is easy to settle in. You unpack once.', '', 'Have a think about who you would travel with, and our team can help you work that out.'].join('\n')
  const mkPost = (extra: string): ComposedPost => ({
    title: 'River cruise for first timers', slug: 'river-cruise-heal', body: goodBody.replace('You unpack once.', `You unpack once.${extra}`),
    seo_title: 'River cruise for first timers', seo_description: 'A plain guide for first-time river cruisers.', tags: ['river cruise first timers'],
    faq: [{ q: 'Is a river cruise good for first timers?', a: 'Yes, the pace is gentle.' }, { q: 'Do I unpack every day?', a: 'No, you unpack once.' }, { q: 'Who is it for?', a: 'Anyone who likes an easy pace.' }],
    key_takeaways: ['Gentle pace', 'Unpack once', 'Good for first timers'], og_title: 'Is a river cruise right for you?', og_description: 'A plain-English look at river cruising for first timers.',
    primary_keyword: 'river cruise first timers', secondary_keywords: ['river cruise tips'], content_style: 'faq-led',
  })
  const postCtx = { allowedPaths: ['/packages/rhine-cruise'], groundingText: 'river cruise first timers' }
  const now = new Date()
  {
    const bad = mkPost(' The ship holds 180 guests. Our guests loved the Rhine last year.')
    check('I: the post fixture is blocked for a number and an experience claim', autoPublishBlockers(bad, now, postCtx).length >= 2, JSON.stringify(autoPublishBlockers(bad, now, postCtx)))
    const db: Db = { tables: { app_settings: [], content_edits: [] } }
    const m = scripted({ suggest: deleteFirst })
    const healed = await healComposedPost(fakeAdmin(db), bad, now, postCtx, { model: m.model })
    check('I: a post held for a number AND an experience claim is healed and passes the real post gate', healed.outcome.status === 'healed' && autoPublishBlockers(healed.value, now, postCtx).length === 0 && !/Our guests loved/.test(healed.value.body) && !/180/.test(healed.value.body), JSON.stringify({ s: healed.outcome.status, r: healed.outcome.reasons }))
    check('I: every edit is in content_edits (log, then apply) so Undo works', db.tables.content_edits.length >= 1 && healed.logIds.length === db.tables.content_edits.length)
    const noFaq = { ...mkPost(''), faq: [], key_takeaways: [] }
    const m2 = scripted({ extras: () => '{}' })
    const rejected = await healComposedPost(fakeAdmin({ tables: { app_settings: [], content_edits: [] } }), noFaq, now, postCtx, { model: m2.model })
    check('I: a post the loop cannot fix is rejected_by_heal, returned unchanged', rejected.outcome.status === 'rejected_by_heal' && rejected.value === noFaq)
    const whole = mkPost('')
    const m3 = scripted({ extras: () => '{}' })
    const viaWhole = await healComposedPost(fakeAdmin({ tables: { app_settings: [], content_edits: [] } }), noFaq, now, postCtx, { model: m3.model, regenerate: async () => whole })
    check('I: for a blog post the last step writes the whole post again once', viaWhole.outcome.status === 'healed' && viaWhole.outcome.ladder.includes('whole') && autoPublishBlockers(viaWhole.value, now, postCtx).length === 0, JSON.stringify({ s: viaWhole.outcome.status, l: viaWhole.outcome.ladder, r: viaWhole.outcome.reasons }))
    const kept = await healComposedPost(fakeAdmin({ tables: { app_settings: [], content_edits: [] } }), noFaq, now, postCtx, { model: scripted({ extras: () => '{}' }).model, regenerate: async () => ({ ...whole, title: 'A whole new title' }), keepSlug: true })
    check('I: a saved draft keeps its web address when the title is rewritten', kept.value.slug === noFaq.slug)
    check('I: buildPostItem still exposes the real gate', buildPostItem(bad, now, postCtx).gate(buildPostItem(bad, now, postCtx).fields).length >= 2)
  }
  {
    // the daily re-check: a draft the loop cannot fix is rejected at once and frees its slot; a HARD one is now picked
    const row = (n: number, over: Record<string, unknown> = {}) => ({
      id: `post-${n}`, slug: `river-cruise-${n}`, status: 'draft', title: 'River cruise for first timers', body: mkPost('').body, meta_title: 'River cruise for first timers',
      meta_description: 'A plain guide for first-time river cruisers.', tags: ['river cruise first timers'], faq: mkPost('').faq, key_takeaways: mkPost('').key_takeaways, og_title: 'Is a river cruise right for you?',
      og_description: 'A plain-English look at river cruising for first timers.', primary_keyword: 'river cruise first timers', secondary_keywords: ['river cruise tips'], content_style: 'faq-led', seo_score: null,
      created_at: new Date(Date.now() - 86_400_000).toISOString(), ...over,
    })
    const tag = (n: number, held: string) => ({ slug: `river-cruise-${n}`, variant_tags: { cta_style: 'soft-question', held_reasons: held } })
    const db: Db = {
      tables: {
        app_settings: [{ key: 'autoblog_mode', value: 'publish' }],
        content_edits: [],
        posts: [row(1, { body: mkPost(' Our guests loved the Rhine last year.').body }), row(2, { faq: [], key_takeaways: [] })],
        content_variants: [tag(1, 'fabricated personal experience claim'), tag(2, 'missing FAQ (needs at least 3 questions)')],
      },
    }
    const admin = fakeAdmin(db)
    const m = scripted({ suggest: deleteFirst, extras: () => '{}' })
    const r = await rehealStuckDrafts(admin, { existing: new Set(['/', '/packages/rhine-cruise']), now, model: m.model })
    const post = (n: number) => db.tables.posts.find((p) => p.id === `post-${n}`) as Record<string, unknown>
    const variant = (n: number) => (db.tables.content_variants.find((v) => v.slug === `river-cruise-${n}`)?.variant_tags ?? {}) as RehealTags
    check('J: a draft held for an experience claim (a HARD reason) is healed and published, not left for a person', post(1).status === 'published' && !/Our guests loved/.test(String(post(1).body)) && r.published === 1, JSON.stringify(r))
    check('J: the publish is logged as a status edit', db.tables.content_edits.some((e) => e.content_id === 'post-1' && e.field === 'status' && e.after === 'published'))
    check('J: a draft the loop cannot fix is rejected at once (not after more tries) and keeps its reasons', variant(2).reheal_state === 'rejected' && /Rejected by heal/.test(String((variant(2) as { held_reasons?: string }).held_reasons)) && r.rejected === 1, JSON.stringify(variant(2)))
    check('J: the rejected draft no longer counts towards the day or its trip (the slot is free)', (await rejectedPostSlugs(admin)).has('river-cruise-2'))
    const status = db.tables.content_edits.find((e) => e.content_id === 'post-1' && e.field === 'status') as Record<string, unknown>
    const undone = await revertEdit(admin, status.id as string)
    check('J: Undo of the heal publish puts the post back to a draft', undone.ok && post(1).status === 'draft', JSON.stringify(undone))
  }

  // ---- K: held guides and page copy, Undo, guessed properties ----
  const SENT = [
    'Walking shoes with good grip help on the stone streets.', 'Trams and funiculars climb the steep hills.', 'A day pass keeps getting around simple.', 'Cafes fill with locals at midday.',
    'Grilled fish and custard tarts are common here.', 'Most places serve lunch at a relaxed pace.', 'Coastal towns sit a short train ride away.', 'Narrow lanes open onto small squares.',
    'Evenings suit a slow stroll by the river.', 'Small shops sell tiles, tins and cork goods.', 'Travellers often plan the day around one main stop.', 'Museums are easy to reach on foot or by tram.',
    'A relaxed pace makes the hills feel gentler.', 'Local markets are a good place to browse.', 'Viewpoints reward a short climb.', 'Guides can help plan a loose route.',
    'Comfortable shoes matter more than a long list of stops.', 'Lunch stretches into the afternoon for many visitors.',
  ]
  const HEADINGS = ['Getting around', 'The old town', 'Food and drink', 'Day trips', 'Neighbourhoods', 'Planning your days', 'Local tips', 'Before you go']
  const makeSections = (famousIn = 1) =>
    HEADINGS.map((heading, i) => {
      const sentences = Array.from({ length: 17 }, (_x, k) => SENT[(i * 3 + k) % SENT.length])
      if (i === famousIn) sentences[2] = 'The famous old town is a pleasant place to wander.'
      if (i === 0) sentences[3] = 'Read about [all our trips](/packages) for more ideas.'
      return { heading, body: sentences.join(' ') }
    })
  const guideRow = (over: Record<string, unknown> = {}, famousIn = 1) => {
    const sections = makeSections(famousIn)
    return {
      id: 'g1', kind: 'destinations', slug: 'lisbon', name: 'Lisbon', parent_slug: null, status: 'draft', source: 'ai', review_state: null,
      quality_notes: 'superlative or rating claim (reputation claim)', created_at: new Date(Date.now() - 86_400_000).toISOString(),
      summary: SUMMARY, body: sections.map((s) => `## ${s.heading}\n\n${s.body}`).join('\n\n'), sections,
      faq: [{ q: 'Is Lisbon hilly?', a: 'Yes, the streets climb.' }, { q: 'Can I walk?', a: 'Yes, with grip shoes.' }, { q: 'Are there trams?', a: 'Yes, in the old streets.' }, { q: 'Is lunch long?', a: 'It can be.' }],
      key_takeaways: ['Hilly city', 'Walk with grip', 'Ride the trams'], meta_title: 'Lisbon travel guide', meta_description: 'A plain guide to Lisbon for travellers who like to walk.', og_title: 'Lisbon travel guide', og_description: 'A plain guide to Lisbon.',
      primary_keyword: 'lisbon travel guide', secondary_keywords: [], ...over,
    }
  }
  const guideParts: GuideBriefParts = { ctx: { grounding: GROUNDING, allowedPaths: new Set(['/', '/packages']), names: ['Portugal', 'all our trips'] }, links: [{ path: '/packages', label: 'all our trips' }] }
  const guideBrief = async () => guideParts
  check('K: the guide fixture is clean without the famous sentence and blocked with it', guideBlockers(composedGuideFromRow(guideRow({}, -1)), guideParts.ctx).length === 0 && guideBlockers(composedGuideFromRow(guideRow()), guideParts.ctx).some((b) => /superlative/.test(b)), JSON.stringify(guideBlockers(composedGuideFromRow(guideRow({}, -1)), guideParts.ctx)))
  {
    const db: Db = { tables: { app_settings: [{ key: 'guides_publish_mode', value: 'publish' }], content_edits: [], guides: [guideRow()] } }
    const admin = fakeAdmin(db)
    const m = scripted({ suggest: () => '{"rewrites":[{"id":0,"text":"The old town is a pleasant place to wander."}]}' })
    const r = await healHeldGuides(admin, { now, model: m.model, guideBrief })
    const row = db.tables.guides[0]
    check('K: a held guide is healed and published by itself', r.published === 1 && row.status === 'published' && row.quality_notes === null && !/famous/i.test(String(row.body)) && guideBlockers(composedGuideFromRow(row), guideParts.ctx).length === 0, JSON.stringify({ r, notes: row.quality_notes }))
    const edits = db.tables.content_edits
    check('K: the text edit and the publish are both logged for the guide', edits.some((e) => e.content_type === 'guide' && e.field === 'body' && e.published_after === true && e.content_id === 'g1') && edits.some((e) => e.content_type === 'guide' && e.field === 'status' && e.before === 'draft' && e.after === 'published'))
    const statusEdit = edits.find((e) => e.field === 'status') as Record<string, unknown>
    const bodyEdit = edits.find((e) => e.field === 'body') as Record<string, unknown>
    const undoStatus = await revertEdit(admin, statusEdit.id as string)
    check('K: Undo of the publish puts the guide back to a draft', undoStatus.ok && row.status === 'draft', JSON.stringify(undoStatus))
    const undoBody = await revertEdit(admin, bodyEdit.id as string)
    check('K: Undo of the text edit puts the original sentence back', undoBody.ok && /famous/i.test(String(row.body)), JSON.stringify(undoBody))
    check('K: a candidate the heal already rejected, or a clean mode hold, is not picked', !isHealDraftCandidate({ ...guideRow(), quality_notes: `${REJECTED_PREFIX} x` }, now, []) && !isHealDraftCandidate({ ...guideRow(), review_state: 'rejected' }, now, []) && !isHealDraftCandidate({ ...guideRow(), quality_notes: 'held for review (guides_publish_mode=draft)' }, now, ['held for review (guides_publish_mode=draft)']) && isHealDraftCandidate(guideRow(), now, []))
  }
  {
    // The shared publishing limiter (lib/publish-cadence.ts): two held guides, guides_per_day 3, but at least 90 minutes between publishes.
    const db: Db = { tables: { app_settings: [{ key: 'guides_publish_mode', value: 'publish' }, { key: 'guides_per_day', value: '3' }, { key: 'guides_per_week', value: '14' }], content_edits: [], guides: [guideRow({ id: 'g1', slug: 'lisbon' }), guideRow({ id: 'g2', slug: 'lisbon-two' })] } }
    const admin = fakeAdmin(db)
    const m = scripted({ suggest: () => '{"rewrites":[{"id":0,"text":"The old town is a pleasant place to wander."}]}' })
    const r1 = await healHeldGuides(admin, { now, model: m.model, guideBrief })
    const status = (id: string) => db.tables.guides.find((g) => g.id === id)?.status
    check('K: limiter: of two held guides only the first goes live in one run (the 90 minute gap), the second waits as a draft', r1.published === 1 && status('g1') === 'published' && status('g2') === 'draft' && r1.deferred >= 1, JSON.stringify(r1))
    check('K: limiter: the waiting guide is deferred, not rejected: no rejected flag, no daily claim used, no AI call spent on it', db.tables.guides[1].review_state === null && !db.tables.app_settings.some((s) => String(s.key).includes('heal:guide:destinations:lisbon-two')) && m.count.total <= 2, JSON.stringify({ calls: m.count.total, r1 }))
    const later = new Date(now.getTime() + 2 * 3_600_000)
    const r2 = await healHeldGuides(admin, { now: later, model: m.model, guideBrief })
    check('K: limiter: two hours later the waiting guide is retried and published (deferred items are retried by the next run)', r2.published === 1 && status('g2') === 'published', JSON.stringify(r2))
  }
  {
    // guides_per_day 1 (the code default): a second held guide waits for the 24 hour window, not just the gap
    const db: Db = { tables: { app_settings: [{ key: 'guides_publish_mode', value: 'publish' }], content_edits: [], guides: [guideRow({ id: 'g1', slug: 'lisbon' }), guideRow({ id: 'g2', slug: 'lisbon-two' })] } }
    const m = scripted({ suggest: () => '{"rewrites":[{"id":0,"text":"The old town is a pleasant place to wander."}]}' })
    const admin = fakeAdmin(db)
    await healHeldGuides(admin, { now, model: m.model, guideBrief })
    const r2 = await healHeldGuides(admin, { now: new Date(now.getTime() + 5 * 3_600_000), model: m.model, guideBrief })
    check('K: limiter: with the default 1 guide a day, five hours later the second held guide still waits', r2.published === 0 && db.tables.guides[1].status === 'draft', JSON.stringify(r2))
    const r3 = await healHeldGuides(admin, { now: new Date(now.getTime() + 25 * 3_600_000), model: m.model, guideBrief })
    check('K: limiter: after 24 hours it goes live', r3.published === 1 && db.tables.guides[1].status === 'published', JSON.stringify(r3))
  }
  {
    // A guide that is ALREADY live and is healed (marked rejected, then healed) is not a publish: it does not use a slot
    const live = guideRow({ id: 'gl', slug: 'lisbon', status: 'published', review_state: 'rejected', quality_notes: null, created_at: new Date(now.getTime() - 40 * 86_400_000).toISOString(), updated_at: new Date(now.getTime() - 40 * 86_400_000).toISOString() })
    const db: Db = { tables: { app_settings: [{ key: 'guides_publish_mode', value: 'publish' }], content_edits: [], guides: [live] } }
    const admin = fakeAdmin(db)
    const m = scripted({ suggest: () => '{"rewrites":[{"id":0,"text":"The old town is a pleasant place to wander."}]}' })
    const out = await healGuideRow(admin, live, { now, model: m.model, guideBrief, skipClaim: true })
    const slot = await checkCadence(admin, 'guide', guideLimits({ perDay: 1, perWeek: 5 }), now)
    check('K: limiter: healing a guide that is already live is not counted as a publish (the slot stays free)', out.action === 'healed_live' && slot.allowed === true && !db.tables.app_settings.some((s) => s.key === 'publish_cadence_log'), JSON.stringify({ out: out.action, slot }))
  }
  {
    // fail closed without migration 0043: the publish cannot be logged, so nothing is published (the text repair is kept)
    const db: Db = {
      tables: { app_settings: [{ key: 'guides_publish_mode', value: 'publish' }], content_edits: [], guides: [guideRow()] },
      rejectInsert: (t, row) => (t === 'content_edits' && row.field === 'status' ? 'violates check constraint content_edits_field_check' : null),
    }
    const m = scripted({ suggest: () => '{"rewrites":[{"id":0,"text":"The old town is a pleasant place to wander."}]}' })
    const r = await healHeldGuides(fakeAdmin(db), { now, model: m.model, guideBrief })
    check('K: without migration 0043 a healed guide is NOT published and the step says to apply it', db.tables.guides[0].status === 'draft' && r.published === 0 && r.problems.some((p) => /0043/.test(p)), JSON.stringify(r))
    check('K: the healed text is still kept on the draft', !/famous/i.test(String(db.tables.guides[0].body)))
  }
  {
    // GUESSED PROPERTY (WP15/WP16): the text may be healed, the guide is NEVER published
    const note = `superlative or rating claim (reputation claim); ${GUESSED_PROPERTY_NOTE}`
    const db: Db = { tables: { app_settings: [{ key: 'guides_publish_mode', value: 'publish' }], content_edits: [], guides: [guideRow({ kind: 'hotels', slug: 'sea-view-hotel', name: 'Sea View Hotel', quality_notes: note })] } }
    const admin = fakeAdmin(db)
    const m = scripted({ suggest: () => '{"rewrites":[{"id":0,"text":"The old town is a pleasant place to wander."}]}' })
    const parts: GuideBriefParts = { ...guideParts, ctx: { ...guideParts.ctx, grounding: `${GROUNDING} Sea View Hotel.`, names: [...(guideParts.ctx.names ?? []), 'Sea View Hotel'] } }
    const sea = guideRow({ kind: 'hotels', slug: 'sea-view-hotel', name: 'Sea View Hotel', quality_notes: note, summary: 'Sea View Hotel is a quiet stay close to the old streets and the river for travellers who like to walk.' })
    db.tables.guides = [sea]
    const r = await healHeldGuides(admin, { now, model: m.model, guideBrief: async () => parts })
    const row = db.tables.guides[0]
    check('K: a guessed-property guide has its text healed', !/famous/i.test(String(row.body)) && r.healedDraft === 1, JSON.stringify(r))
    check('K: a guessed-property guide is NEVER published by the heal, whatever the mode', row.status === 'draft' && r.published === 0 && !db.tables.content_edits.some((e) => e.field === 'status'))
    check('K: it keeps the "check it is a real property" note for a person', row.quality_notes === GUESSED_PROPERTY_NOTE && isGuessedPropertyNote(String(row.quality_notes)))
    check('K: the next day it is not picked again (nothing is left to heal)', !isHealDraftCandidate(row, now, []))
  }
  {
    const cand = { origin: 'package' as const, priority: true, backfill: false }
    const guessed = isGuessedProperty(cand)
    const heal = (status: 'healed' | 'rejected_by_heal' | 'deferred') => ({ status, fields: {} as RepairFields, blockers: [], reasons: ['why'], rounds: 3, ladder: [], calls: 4, judgeRuns: 1, edits: [], log: [], note: 'n' })
    check('K: a package-origin priority guide is a guessed property', guessed && isGuessedProperty({ origin: 'package', priority: false, backfill: true }) && !isGuessedProperty({ origin: 'seed', priority: true, backfill: false }))
    check('K: decideGuideSave: a guessed property is a draft even when the heal fully healed it', decideGuideSave(true, { publish: true, note: null }, heal('healed')).publish === false)
    check('K: decideGuideSave: a clean, healed, ordinary guide follows the publish decision', decideGuideSave(false, { publish: true, note: null }, heal('healed')).publish === true)
    const rej = decideGuideSave(false, { publish: false, note: 'x' }, heal('rejected_by_heal'))
    check('K: decideGuideSave: rejected_by_heal is a rejected draft with the reasons', !rej.publish && rej.rejectedByHeal && /^Rejected by heal:/.test(rej.note ?? ''))
    const def = decideGuideSave(false, { publish: false, note: 'number not in the grounding: 5' }, heal('deferred'))
    check('K: decideGuideSave: a deferral keeps the blockers and says the heal will try again', !def.publish && !def.rejectedByHeal && /number not in the grounding/.test(def.note ?? '') && /heal waiting/.test(def.note ?? ''))
  }
  {
    // page copy
    const words = ['Lisbon is a coastal city with a gentle pace for travellers who like to walk.', 'The hills reward comfortable shoes and a loose plan.', 'Trams and funiculars help on the steep streets.', 'See [the Lisbon trip](/packages/lisbon-trip) for the details of the trip we list.', 'Narrow lanes open onto small squares.', 'Grilled fish and custard tarts are common at lunch.', 'Coastal towns sit a short train ride away.', 'Viewpoints reward a short climb.', 'Small shops sell tiles, tins and cork goods.', 'Evenings suit a slow stroll by the river.', 'Museums are easy to reach on foot or by tram.', 'Local markets are a good place to browse.', 'Guides can help plan a loose route.', 'Comfortable shoes matter more than a long list of stops.', 'Lunch stretches into the afternoon for many visitors.', 'Travellers often plan the day around one main stop.', 'A relaxed pace makes the hills feel gentler.', 'Cafes fill with locals at midday.']
    const intro = (extra = '') => `${words.join(' ')}${extra}`
    const copyRow = (over: Record<string, unknown> = {}) => ({
      id: 'c1', path: '/best-time-to-visit/lisbon', page_type: 'best-time', status: 'draft', source: 'ai', quality_notes: 'superlative or rating claim (reputation claim)', created_at: new Date(Date.now() - 86_400_000).toISOString(),
      intro: intro(' The famous old town is a pleasant place to wander.'), faq: [{ q: 'Is Lisbon hilly?', a: 'Yes, the streets climb.' }, { q: 'Can I walk?', a: 'Yes, with grip shoes.' }, { q: 'Are there trams?', a: 'Yes, in the old streets.' }],
      key_takeaways: ['Hilly city', 'Walk with grip', 'Ride the trams'], meta_title: 'Lisbon travel pages', meta_description: 'A plain page about Lisbon for travellers who like to walk.', og_title: 'Lisbon travel pages', og_description: 'A plain page about Lisbon.', primary_keyword: 'lisbon travel', linked_slugs: ['lisbon-trip'], ...over,
    })
    const parts: CopyBriefParts = { ctx: { grounding: 'Lisbon is a city in Portugal. The Lisbon trip is listed.', destinations: ['Lisbon'], names: ['the "Lisbon trip" trip', 'our Lisbon page', 'Portugal'], allowedPaths: new Set(['/packages/lisbon-trip', '/destinations/lisbon']) }, links: [{ path: '/packages/lisbon-trip', label: 'the "Lisbon trip" trip' }] }
    const clean = copyRow({ intro: intro() })
    const cleanBlockers = pageCopyBlockers(composedCopyFromRow(clean), parts.ctx)
    check('K: the page copy fixture is clean without the famous sentence and blocked with it', cleanBlockers.length === 0 && pageCopyBlockers(composedCopyFromRow(copyRow()), parts.ctx).some((b) => /superlative/.test(b)), JSON.stringify(cleanBlockers))
    const db: Db = { tables: { app_settings: [{ key: 'page_copy_publish_mode', value: 'publish' }], content_edits: [], page_copy: [copyRow()] } }
    const admin = fakeAdmin(db)
    const m = scripted({ suggest: () => '{"rewrites":[{"id":0,"text":"The old town is a pleasant place to wander."}]}' })
    const r = await healHeldCopy(admin, { now, model: m.model, copyBrief: async () => parts })
    const row = db.tables.page_copy[0]
    check('K: held page copy is healed and published by itself', r.published === 1 && row.status === 'published' && !/famous/i.test(String(row.intro)) && row.quality_notes === null, JSON.stringify({ r, row: row.status }))
    const statusEdit = db.tables.content_edits.find((e) => e.field === 'status' && e.content_type === 'page_copy') as Record<string, unknown>
    const undo = await revertEdit(admin, statusEdit.id as string)
    check('K: Undo of a page copy publish puts it back to a draft', undo.ok && row.status === 'draft', JSON.stringify(undo))
    // an unfixable one is rejected and recorded
    const db2: Db = { tables: { app_settings: [{ key: 'page_copy_publish_mode', value: 'publish' }], content_edits: [], page_copy: [copyRow({ faq: [], key_takeaways: [] })] } }
    const admin2 = fakeAdmin(db2)
    const r2 = await healHeldCopy(admin2, { now, model: scripted({ suggest: deleteFirst, extras: () => '{}' }).model, copyBrief: async () => parts })
    check('K: page copy the loop cannot fix is rejected_by_heal with its reasons, and stays a draft', r2.rejected === 1 && db2.tables.page_copy[0].status === 'draft' && /^Rejected by heal:/.test(String(db2.tables.page_copy[0].quality_notes)) && !!(await readRejected(admin2))?.['page_copy:/best-time-to-visit/lisbon'])
    const r3 = await healHeldCopy(admin2, { now: new Date(now.getTime() + 86_400_000), model: scripted({}).model, copyBrief: async () => parts })
    check('K: a rejected page copy is not tried again', r3.tried === 0)
    const off = await healHeldCopy(fakeAdmin({ tables: { app_settings: [{ key: 'page_copy_publish_mode', value: 'draft' }], content_edits: [], page_copy: [copyRow()] } }), { now, model: scripted({}).model, copyBrief: async () => parts })
    check('K: in draft mode nothing is touched', off.tried === 0)
  }

  // ---- M: QA round 2 fixes ----
  {
    // M2: a text-only Undo on a heal-published guide also takes the page back to a draft
    const db: Db = { tables: { app_settings: [{ key: 'guides_publish_mode', value: 'publish' }], content_edits: [], guides: [guideRow()] } }
    const admin = fakeAdmin(db)
    await healHeldGuides(admin, { now, model: scripted({ suggest: () => '{"rewrites":[{"id":0,"text":"The old town is a pleasant place to wander."}]}' }).model, guideBrief })
    const bodyEdit = db.tables.content_edits.find((e) => e.field === 'body') as Record<string, unknown>
    const undone = await revertEdit(admin, bodyEdit.id as string)
    const sib = db.tables.content_edits.find((e) => e.field === 'status') as Record<string, unknown>
    check('M2: undoing the text of a heal-published page also unpublishes it, never showing the old text live', undone.ok && db.tables.guides[0].status === 'draft' && /famous/i.test(String(db.tables.guides[0].body)) && !!sib.reverted_at, JSON.stringify(undone))
    check('M2: the content-edits page groups the rows of one page and says Undo also drafts it', /groupEdits\(edits\)/.test(src('app/admin/content-edits/page.tsx')) && /Undo also takes the page back to a draft/.test(src('app/admin/content-edits/page.tsx')))
  }
  {
    // M3: an admin edit made while the loop works is never overwritten
    const db: Db = { tables: { app_settings: [{ key: 'guides_publish_mode', value: 'publish' }], content_edits: [], guides: [guideRow()] } }
    const m = scripted({ suggest: () => { db.tables.guides[0].updated_at = '2030-01-01T00:00:00Z'; return '{"rewrites":[{"id":0,"text":"The old town is a pleasant place to wander."}]}' } })
    const r = await healHeldGuides(fakeAdmin(db), { now, model: m.model, guideBrief })
    check('M3: a guide an admin touched during the loop is left alone and its audit rows are taken back', db.tables.guides[0].status === 'draft' && /famous/i.test(String(db.tables.guides[0].body)) && db.tables.content_edits.length === 0 && r.published === 0 && r.problems.some((p) => /someone else/.test(p)), JSON.stringify({ r, edits: db.tables.content_edits.length }))
    const row = (n: number) => ({ id: `post-${n}`, slug: `river-heal-${n}`, status: 'draft', title: 'River cruise for first timers', body: mkPost(' Our guests loved the Rhine last year.').body, meta_title: 'River cruise for first timers', meta_description: 'A plain guide for first-time river cruisers.', tags: ['river cruise first timers'], faq: mkPost('').faq, key_takeaways: mkPost('').key_takeaways, og_title: 'Is a river cruise right for you?', og_description: 'A plain-English look at river cruising for first timers.', primary_keyword: 'river cruise first timers', secondary_keywords: ['river cruise tips'], content_style: 'faq-led', seo_score: null, created_at: new Date(Date.now() - 86_400_000).toISOString(), updated_at: '2026-01-01T00:00:00Z' })
    const pdb: Db = { tables: { app_settings: [{ key: 'autoblog_mode', value: 'publish' }], content_edits: [], posts: [row(1)], content_variants: [{ slug: 'river-heal-1', variant_tags: { cta_style: 'soft-question', held_reasons: 'fabricated personal experience claim' } }] } }
    const pm = scripted({ suggest: () => { pdb.tables.posts[0].updated_at = '2030-01-01T00:00:00Z'; return '{"rewrites":[{"id":0,"delete":true}]}' } })
    const pr = await rehealStuckDrafts(fakeAdmin(pdb), { existing: new Set(['/', '/packages/rhine-cruise']), now, model: pm.model })
    check('M3: a blog draft an admin touched during the loop is not published or overwritten', pdb.tables.posts[0].status === 'draft' && pr.published === 0 && /Our guests loved/.test(String(pdb.tables.posts[0].body)) && !pdb.tables.content_edits.some((e) => e.field === 'status'), JSON.stringify(pr))
  }
  {
    // M4: a held row whose gate is now clean still needs the independent judge, and a row an admin touched later is skipped
    const cleanRow = (over: Record<string, unknown> = {}) => guideRow({ quality_notes: 'number not in the grounding: 180', ...over }, -1)
    const base = (): Db => ({ tables: { app_settings: [{ key: 'guides_publish_mode', value: 'publish' }], content_edits: [], guides: [cleanRow()] } })
    const down = scripted({ judge: () => null })
    const d1 = base()
    const r1 = await healHeldGuides(fakeAdmin(d1), { now, model: down.model, guideBrief })
    check('M4: with the judge unreachable a gate-clean held guide is NOT published', d1.tables.guides[0].status === 'draft' && r1.published === 0 && r1.deferred === 1 && down.count.judge >= 1, JSON.stringify(r1))
    const ok = scripted({})
    const d2 = base()
    const r2 = await healHeldGuides(fakeAdmin(d2), { now, model: ok.model, guideBrief })
    check('M4: a gate-clean held guide is published only after the judge passes it', d2.tables.guides[0].status === 'published' && r2.published === 1 && ok.count.judge === 1, JSON.stringify(r2))
    const bad = scripted({ judge: () => '{"pass":false,"failures":[{"quote":"Narrow lanes open onto small squares.","reason":"unsupported"}]}', suggest: deleteFirst })
    const d3 = base()
    const r3 = await healHeldGuides(fakeAdmin(d3), { now, model: bad.model, guideBrief })
    // heal-relax: the text the judge keeps refusing still never goes live. The last rung replaces it with a safe page built only from
    // stored facts (flagged in quality_notes), which is what is published.
    const row3 = d3.tables.guides[0]
    check('M4: a judge that keeps failing a gate-clean guide never lets THAT TEXT go live (a flagged safe page replaces it)', !String(row3.body).includes('Narrow lanes open onto small squares.') && (row3.status === 'draft' || (row3.status === 'published' && String(row3.quality_notes).startsWith('safe-page:') && r3.published === 1)), JSON.stringify({ r3, notes: row3.quality_notes }))
    const created = new Date(Date.now() - 86_400_000)
    const parked = cleanRow({ created_at: created.toISOString(), updated_at: new Date(created.getTime() + 3_600_000).toISOString() })
    check('M4: a row an admin touched after the writer saved it is skipped', !isHealDraftCandidate(parked, now, []) && isHealDraftCandidate(cleanRow({ created_at: created.toISOString(), updated_at: new Date(created.getTime() + 5_000).toISOString() }), now, []))
  }
  {
    // M5, M6, M7: the judge reply, the judged text, negations
    const noQuote = scripted({ suggest: deleteFirst, judge: () => '{"pass":true,"failures":[{"reason":"unsupported"}]}' })
    const o5 = await healLoop(synthTarget(bodyOf(OLD_TOWN_FAMOUS)), { model: noQuote.model, budget: memBudget(30) })
    check('M5: "pass" with a failure that has no usable quote is still a fail (the raw array is tested)', o5.status !== 'healed', o5.status)
    const huge = synthTarget(bodyOf(OLD_TOWN_FAMOUS) + '\n\n## More\n\n' + 'Trams climb the hills here. '.repeat(1600))
    const m6 = scripted({ suggest: deleteFirst })
    const o6 = await healLoop(huge, { model: m6.model, budget: memBudget(30) })
    check('M6: a page too long for the judge to read whole is never approved (fails closed, not cut)', o6.status === 'rejected_by_heal' && /too long/.test(o6.reasons.join(' ')) && m6.count.judge === 0, JSON.stringify({ s: o6.status, r: o6.reasons }))
    check('M6: judgeText refuses rather than truncates', judgeText({ ...huge.item.fields }) === null && (judgeText({ ...synthTarget(bodyOf(OLD_TOWN_FAMOUS)).item.fields }) ?? '').includes('Cafes fill with locals'))
    const vctx = makeDetectCtx('guide', GROUNDING, ['Lisbon'])
    check('M7: a rewrite that drops "not", "no", "never", "without" or "n\'t" is refused', ['Do not swim here without a guide.', 'No dogs are allowed on the tram.', 'Visitors never need a ticket.', 'The tram doesn\'t run late.'].every((t, i) => validateRewrite(t, ['Swim here without a guide.', 'Dogs are allowed on the tram.', 'Visitors need a ticket.', 'The tram runs late.'][i], vctx) !== null) && validateRewrite('Do not swim here after dark.', 'Do not swim here.', vctx) === null)
  }
  {
    // M1, M9, M11, M13: wiring
    const auto = src('lib/autoblog-run.ts')
    check('M1: the blog write step ends its heal before the pipeline hard stop', /hardStop = Math\.min\(runStart \+ 285_000, opts\.deadlineMs/.test(auto) && /healDeadline = Math\.min\(runStart \+ 270_000, hardStop\)/.test(auto) && /runAutoblog\(\{ scheduled: !opts\.force, deadlineMs: startedAt \+ 280_000 \}\)/.test(src('lib/pipeline.ts')))
    check('M1: the cover image is inside the try that takes the audit rows back', /try \{\s*\/\/ A draft the heal rejected[\s\S]*?attachAutoblogCoverImage[\s\S]*?createPost\(/.test(auto) && /deleteEdits\(admin, repairLogIds\)/.test(auto))
    check('M11: the cover image is filed under the final slug', /attachAutoblogCoverImage\(admin, imageSearchTerm, final\.slug[,)]/.test(auto))
    check('M9: a blank cap is refused by the route and ignored by the card', /String\(body\.value\)\.trim\(\) === ''/.test(src('app/api/admin/content-edits/route.ts')) && /e\.target\.value\.trim\(\) === ""/.test(src('components/admin/self-healing-card.tsx')))
    check('M13: an unreadable reject list fails the write step; a reached limit is a plain note', /limit\.unreadable \? \{ failed: true \}/.test(auto) && /ok: !result\.failed/.test(src('lib/pipeline.ts')))
  }

  // ---- L: the daily brief line, wiring and hygiene ----
  {
    const lines = healLinesOf([
      { at: now.toISOString(), type: 'post', path: '/blog/a', status: 'healed', reason: 'ok' },
      { at: now.toISOString(), type: 'guide', path: '/hotels/b', status: 'rejected_by_heal', reason: 'a superlative could not be removed' },
      { at: now.toISOString(), type: 'guide', path: '/hotels/c', status: 'deferred', reason: 'limit' },
      { at: new Date(now.getTime() - 3 * 86_400_000).toISOString(), type: 'guide', path: '/hotels/old', status: 'rejected_by_heal', reason: 'old' },
    ], now)
    check('L: the brief says what the heal did in the last day, rejected items as information only', lines.length === 3 && /rewrote and published 1/.test(lines[0]) && /nothing for you to do/.test(lines[1]) && !lines.some((l) => /old/.test(l)) && /tomorrow/.test(lines[2]), JSON.stringify(lines))
  }
  const read = (p: string) => src(p)
  check('L: the blog writer runs the heal loop before it decides to publish', /healComposedPost\(admin, final/.test(src('lib/autoblog-run.ts')) && /rejectLimitReached\(admin\)/.test(src('lib/autoblog-run.ts')) && /reheal_state: 'rejected'/.test(src('lib/autoblog-run.ts')))
  check('L: the guide writer runs the heal loop and the guessed-property rule decides the publish', /healComposedGuide\(admin, guide/.test(src('lib/guide-run.ts')) && /decideGuideSave\(isGuessedProperty\(cand\)/.test(src('lib/guide-run.ts')))
  check('L: the page copy writer runs the heal loop', /healComposedCopy\(admin, copy/.test(src('lib/page-copy-run.ts')))
  check('L: the daily heal runs the held guides, the held page copy and the stuck blog drafts', /healHeldGuides\(admin/.test(src('lib/content-heal-run.ts')) && /healHeldCopy\(admin/.test(src('lib/content-heal-run.ts')) && /rehealStuckDrafts\(admin/.test(src('lib/content-heal-run.ts')))
  check('L: there is no new cron: the pipeline passes its deadline to the existing heal step', /runHealContentIfDue\(admin, \{ deadlineMs: startedAt \+ 280_000 \}\)/.test(src('lib/pipeline.ts')) && !/heal-loop|heal-drafts/.test(src('vercel.json')))
  check('L: the heal never publishes a guessed property (comment and code in heal-drafts)', /if \(guessed\) \{/.test(src('lib/heal-drafts.ts')) && /NEVER published/.test(src('lib/heal-drafts.ts')) && /isGuessedProperty/.test(src('lib/heal-loop.ts')))
  check('L: the Needs attention list no longer asks a person to check held drafts', !/id: HARD_WAITING_ISSUE_ID/.test(src('lib/issues.ts')) && /HEAL_LOOP_ISSUE_ID/.test(src('lib/issues.ts')))
  for (const f of ['lib/heal-loop.ts', 'lib/heal-targets.ts', 'lib/heal-drafts.ts', 'scripts/check-heal-loop.ts']) {
    const text = read(f)
    check(`L: ${f} has no long dash and no control characters`, !LONG_DASH.test(text) && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text))
  }
  check('L: every model call goes through the one bounded wrapper (no direct callAnthropic in the loop)', !/callAnthropic\(/.test(src('lib/heal-loop.ts')))

  console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed.')
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
