// Offline checks for the self-learning loop (lib/learn-loop.ts). No network, no database, no AI call: every function under test is pure.
// Run: pnpm dlx tsx scripts/check-learn-loop.ts
import {
  APPLY_AFTER_HITS,
  MAX_RULES_PER_PROMPT,
  MONITOR_DAYS,
  NO_REMEDY_ESCALATE_HITS,
  REMEDIES,
  activeRules,
  evolve,
  evolveAll,
  isTransient,
  normalizeFailure,
  observe,
  parseLedger,
  remedyFor,
  signatureOf,
  withLearnedRules,
  type LedgerEntry,
} from '../lib/learn-loop'

let failed = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : detail ? `  (${detail})` : ''}`)
}

const DAY = 86_400_000
const T0 = new Date('2026-10-01T12:00:00Z')
const at = (days: number): string => new Date(T0.getTime() + days * DAY).toISOString()

// --- fingerprinting -----------------------------------------------------------------------------------------------
const a = normalizeFailure('Caption for "Sun and sand in Cancun 2026" is too long (2310 over the limit) https://x.ca/blog/cancun-all-inclusive-deals')
const b = normalizeFailure('Caption for "Beach days in Mexico" is too long (1980 over the limit) https://x.ca/blog/mexico-resort-guide-2027')
check('same problem on two posts gives one fingerprint', a === b, `${a} | ${b}`)
check('surface is part of the signature', signatureOf('caption', 'too long') !== signatureOf('reel', 'too long'))
check('fingerprint is short', normalizeFailure('x'.repeat(500)).length <= 110)

// --- catalogue ----------------------------------------------------------------------------------------------------
check('a length failure maps to the caption-length rule', remedyFor(a)?.id === 'caption-length', String(remedyFor(a)?.id))
check('an em dash failure maps to the dash rule', remedyFor(normalizeFailure('Found an em dash in the caption'))?.id === 'long-dash')
check('an unknown failure maps to no rule', remedyFor(normalizeFailure('The moon is in the wrong phase')) === null)
check('every catalogue rule is plain text and targets something', REMEDIES.every((r) => r.rule.length > 10 && r.injectInto.length > 0 && r.rootCause.length > 0))
check('catalogue ids are unique', new Set(REMEDIES.map((r) => r.id)).size === REMEDIES.length)
check('a rule never loosens a limit (none says "ignore" or "skip")', REMEDIES.every((r) => !/\b(ignore|skip|disable|bypass)\b/i.test(r.rule)))

// --- transient failures stay out ----------------------------------------------------------------------------------
check('429 is transient', isTransient('Instagram returned 429 Too Many Requests'))
check('a content failure is not transient', !isTransient('Caption is too long'))

// --- observe ------------------------------------------------------------------------------------------------------
const long = (day: number) => ({ surface: 'caption' as const, text: 'Caption is too long for X (300 over the limit)', at: at(day) })
let ledger = observe([], [long(0)])
check('first sighting creates an open entry', ledger.length === 1 && ledger[0].status === 'open' && ledger[0].count === 1)
ledger = observe(ledger, [long(0)])
check('the same timestamp is not counted twice', ledger[0].count === 1)
ledger = observe(ledger, [long(0.5)])
check('a later sighting adds a hit', ledger[0].count === 2 && ledger[0].hits.length === 2)
check('an empty text is ignored', observe([], [{ surface: 'post', text: '  ', at: at(0) }]).length === 0)
check('a bad date is ignored', observe([], [{ surface: 'post', text: 'x', at: 'not a date' }]).length === 0)

// --- happy path: observe, trial, monitor, learned -----------------------------------------------------------------
let one = observe([], [long(0)])[0]
check('one sighting is below the apply threshold', APPLY_AFTER_HITS === 2 && evolve(one, T0).event === undefined)
one = observe([one], [long(0.5)])[0]
const applied = evolve(one, new Date(at(1)))
check('a repeat starts a trial rule', applied.entry.status === 'trial' && applied.event?.action === 'applied' && applied.entry.remedyId === 'caption-length')
check('the trial rule is injected into the caption prompt', activeRules([applied.entry], 'caption').length === 1)
check('and not into the reel prompt', activeRules([applied.entry], 'reel').length === 0)
const early = evolve(applied.entry, new Date(at(1 + MONITOR_DAYS - 1)))
check('no verdict before the monitor window ends', early.entry.status === 'trial' && early.event === undefined)
const learned = evolve(applied.entry, new Date(at(1 + MONITOR_DAYS)))
check('a quiet monitor window makes the rule permanent', learned.entry.status === 'rule' && learned.event?.action === 'learned')
check('a permanent rule stays in the prompt', activeRules([learned.entry], 'caption').length === 1)

// --- sad path: the rule did not work ------------------------------------------------------------------------------
const rep = observe([applied.entry], [long(1.5), long(2)])[0]
const withdrawn = evolve(rep, new Date(at(2.5)))
check('two repeats during the trial withdraw the rule', withdrawn.entry.status === 'needs-code-fix' && withdrawn.event?.action === 'withdrawn')
check('the withdrawal names the code location', /fitCaption|PLATFORM_CHAR_LIMITS/.test(withdrawn.entry.note ?? ''), String(withdrawn.entry.note))
check('a withdrawn rule leaves the prompt', activeRules([withdrawn.entry], 'caption').length === 0)
const slow = observe([applied.entry], [long(5)])[0]
check('one repeat after twice the window also withdraws', evolve(slow, new Date(at(1 + 2 * MONITOR_DAYS + 0.1))).entry.status === 'needs-code-fix')
const solo = observe([applied.entry], [long(2)])[0]
check('one early repeat keeps monitoring', evolve(solo, new Date(at(3))).entry.status === 'trial')

// --- a permanent rule that later fails ----------------------------------------------------------------------------
let perm = learned.entry
perm = observe([perm], [long(10), long(11), long(12)])[0]
const regress = evolve(perm, new Date(at(13)))
check('three failures after confirmation withdraw a permanent rule', regress.entry.status === 'needs-code-fix' && regress.event?.action === 'withdrawn')

// --- no catalogued rule: escalate, never invent one ---------------------------------------------------------------
const odd = (day: number) => ({ surface: 'video' as const, text: 'Render failed: scene 4 has no footage', at: at(day) })
let o = observe([], [odd(0), odd(0.1)])[0]
check('two unknown failures wait', evolve(o, T0).event === undefined)
o = observe([o], [odd(0.2)])[0]
const esc = evolve(o, T0)
check(`${NO_REMEDY_ESCALATE_HITS} unknown failures escalate to a code fix`, esc.entry.status === 'needs-code-fix' && esc.event?.action === 'escalated')
check('an escalated entry adds no prompt rule', activeRules([esc.entry], 'reel').length === 0)
const net = observe([], [{ surface: 'post', text: 'fetch failed: ECONNRESET', at: at(0) }, { surface: 'post', text: 'fetch failed: ECONNRESET', at: at(1) }, { surface: 'post', text: 'fetch failed: ECONNRESET', at: at(2) }])[0]
check('a network blip never escalates', evolve(net, T0).entry.status === 'transient' && evolve(net, T0).event === undefined)

// --- a person switched a rule off ---------------------------------------------------------------------------------
const off: LedgerEntry = { ...learned.entry, status: 'disabled' }
check('a disabled entry gives no rule and does not move', activeRules([off], 'caption').length === 0 && evolve(off, new Date(at(30))).entry.status === 'disabled')

// --- evolveAll cap, prompt, parse ---------------------------------------------------------------------------------
const many = Array.from({ length: 4 }, (_, i) => ({ ...applied.entry, sig: `caption|x${i}`, status: 'trial' as const, appliedAt: at(0), hits: [at(-1)], count: 2 }))
const cap = evolveAll(many, new Date(at(10)), 2)
check('evolveAll respects the per-pass event cap', cap.events.length === 2)
const six = REMEDIES.map((r, i) => ({ ...learned.entry, sig: `caption|r${i}`, remedyId: r.id, status: 'rule' as const }))
check('the prompt never carries more than the cap', activeRules(six, 'caption').length <= MAX_RULES_PER_PROMPT)
check('duplicate rules appear once', activeRules([learned.entry, { ...learned.entry, sig: 'caption|other' }], 'caption').length === 1)
check('no rules leaves the prompt untouched', withLearnedRules('PROMPT', []) === 'PROMPT')
check('rules are appended after the prompt', withLearnedRules('PROMPT', ['Do A']).startsWith('PROMPT') && withLearnedRules('PROMPT', ['Do A']).includes('- Do A'))
check('a broken ledger parses to empty', parseLedger('{nope').length === 0 && parseLedger('{"a":1}').length === 0 && parseLedger(null).length === 0)
check('a good ledger round-trips', parseLedger(JSON.stringify([learned.entry]))[0]?.sig === learned.entry.sig)
check('evolve does not mutate its input', (() => { const copy = JSON.stringify(one); evolve(one, new Date(at(1))); return JSON.stringify(one) === copy })())

console.log(failed === 0 ? '\nAll learn-loop checks passed.' : `\n${failed} check(s) FAILED.`)
process.exit(failed === 0 ? 0 : 1)
