// Offline checks for "heal-relax": deterministic guide repairs, the geography allowlist, the safe page, five rounds with plainer prompts,
// and the heal-guides-now script's guard rails. No network, no database, no AI call (the model is a scripted stand-in, the database is
// the in-memory fake). Run: pnpm dlx tsx scripts/check-heal-relax.ts
import { readFileSync } from 'node:fs'

process.env.ANTHROPIC_API_KEY = ''
process.env.INDEXNOW_KEY = ''

import { fakeAdmin, type Db } from './fake-admin'
import { GUIDE_KINDS, guideKinds, type GuideKind } from '../lib/guides'
import { GUIDE_WORDS_MAX, GUIDE_WORDS_MIN, groundingText, guideBlockers, namedThingsNotInBrief, type ComposedGuide, type GateContext, type GuideBrief } from '../lib/guide-composer'
import { isGeographyPhrase } from '../lib/geography'
import {
  APPROVED_CTA_LINKED,
  SAFE_PAGE_NOTE,
  buildSafePage,
  fieldsToGuide,
  isAgencySelling,
  nameInOpening,
  namesSubject,
  parentFromGrounding,
  repairGuideFields,
  softenHeadingText,
  type GuideRepairCfg,
} from '../lib/guide-repairs'
import { HEAL_CALLS_DEFAULT, HEAL_MAX_ROUNDS, healLoop, memoryBudget, parseHealCap, roundRules, type HealTarget } from '../lib/heal-loop'
import { GUIDE_LIMITS, buildGuideItem, guideFields, guideFrom } from '../lib/content-repair-adapters'
import { Tracker, makeDetectCtx, type RepairFields } from '../lib/content-repair'
import { healComposedGuide } from '../lib/heal-targets'
import { composedGuideFromRow, healGuideRow, type GuideBriefParts } from '../lib/heal-drafts'
import { GUESSED_PROPERTY_NOTE, decideGuideSave, isGuessedProperty } from '../lib/guide-run'

const LONG_DASH = new RegExp('[' + String.fromCharCode(0x2013, 0x2014) + ']')
let failed = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`)
  if (!ok) failed++
}
const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

// ---------------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------------

const ALLOWED = new Set(['/', '/packages', '/destinations/jamaica', '/packages/jamaica-sun'])
const LINKS = [
  { path: '/packages/jamaica-sun', label: 'the "Jamaica Sun" trip' },
  { path: '/destinations/jamaica', label: 'our Jamaica page' },
  { path: '/packages', label: 'all our trips' },
  { path: '/#contact', label: 'the contact form' },
]

function sampleBrief(kind: GuideKind, name: string, parentName: string | null, withTrip = true): GuideBrief {
  return {
    kind,
    name,
    parentName,
    packages: withTrip ? [{ name: 'Jamaica Sun', slug: 'jamaica-sun', destination: 'Jamaica', category: 'singles', short_description: 'A relaxed week for solo travellers.', year: '2027' }] : [],
    keywords: [],
    blurb: null,
    links: LINKS,
  }
}
function gateCtxFor(brief: GuideBrief): GateContext {
  return { grounding: groundingText(brief), allowedPaths: ALLOWED, names: [...(brief.parentName ? [brief.parentName] : []), ...brief.links.map((l) => l.label)] }
}
const wordCount = (g: ComposedGuide) => `${g.summary} ${g.body}`.trim().split(/\s+/).filter(Boolean).length

// ---------------------------------------------------------------------------------------------------
// Scripted stand-in for the model
// ---------------------------------------------------------------------------------------------------

type Handler = (n: number, prompt: string) => string | null
function scripted(h: { suggest?: Handler; judge?: Handler; section?: Handler } = {}) {
  const count = { suggest: 0, judge: 0, section: 0, other: 0, total: 0 }
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
    count.other++
    return null
  }
  return { model, count, prompts }
}

const sentencesOfText = (t: string) => new Set(t.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean))

async function main() {
  // ================================================================================================
  // 1. GEOGRAPHY ALLOWLIST (both directions)
  // ================================================================================================
  const none = ''
  const flagged = (text: string, allowed = none) => namedThingsNotInBrief(text, allowed)
  check('G1: a comma list of regions is not one made-up name (Caribbean, Alaska, Europe)', flagged('Cruises sail the Caribbean, Alaska, Europe and the Mediterranean.').length === 0, JSON.stringify(flagged('Cruises sail the Caribbean, Alaska, Europe and the Mediterranean.')))
  check('G2: the same three regions written with no commas are still geography', flagged('Itineraries cover Caribbean Alaska Europe in different seasons.').length === 0, JSON.stringify(flagged('Itineraries cover Caribbean Alaska Europe in different seasons.')))
  check('G3: Yucatan Peninsula, Western Caribbean, Rhine River, Costa Rica, Prince Edward Island pass', ['Travellers cross the Yucatan Peninsula by road.', 'Ships on the Western Caribbean loop call at small ports.', 'A boat on the Rhine River passes castles.', 'Trips to Costa Rica suit active groups.', 'Ferries reach Prince Edward Island daily.'].every((s) => flagged(s).length === 0), JSON.stringify(['Travellers cross the Yucatan Peninsula by road.', 'Ships on the Western Caribbean loop call at small ports.', 'A boat on the Rhine River passes castles.'].map((s) => flagged(s))))
  check('G4: Mediterranean Sea, Gulf of Mexico, Inside Passage, Cayman Islands, Hawaiian Islands pass', ['Trips cross the Mediterranean Sea in spring.', 'Ports line the Gulf of Mexico.', 'Alaska Inside Passage routes are scenic.', 'The Cayman Islands suit divers.', 'The Hawaiian Islands each feel different.'].every((s) => flagged(s).length === 0))
  for (const venue of ['Dinner at Le Bernardin was lovely.', 'Guests stay at the Ritz Carlton downtown.', 'Passengers board Royal Caribbean in the morning.', 'A room at the Hilton Cancun faces the sea.', 'The chef Gordon Ramsay opened a place.', 'Sailing on Disney Wonder is popular.', 'Docked beside the Queen Mary was a ship.', 'We saw Sandals Grande from the road.']) {
    check(`G5: a real venue or person still fails: ${venue.slice(0, 40)}`, flagged(venue).length > 0, venue)
  }
  check('G6: a name that mixes a venue word with a place still fails (Hilton Alaska, Royal Cancun)', flagged('Stay at the Hilton Alaska tonight.').length > 0 && flagged('Dinner at Royal Cancun ended late.').length > 0)
  check('G7: a phrase that is in the brief still passes (the subject, a stored package)', flagged('Plan a stay at Atlantis Paradise Island this year.', 'Atlantis Paradise Island').length === 0 && flagged('Read about the Jamaica Sun trip.', 'Jamaica Sun').length === 0)
  check('G8: the comma split does not hide a real name that follows a comma', flagged('Eat well, Gordon Ramsay opened a place.').length > 0)
  check('G9: isGeographyPhrase needs a real place word, not only modifiers (River Island, Island Hopper)', !isGeographyPhrase(['River', 'Island']) && !isGeographyPhrase(['Island', 'Hopper']) && isGeographyPhrase(['Rhine', 'River']))

  // ================================================================================================
  // 2. DETERMINISTIC REPAIRS
  // ================================================================================================
  // (i) the opening paragraph names the subject
  const cases: [string, string, GuideKind][] = [
    ['This island is a lively place with warm water.', 'Jamaica', 'destinations'],
    ['It is a large resort set on a long beach.', 'Atlantis Paradise Island', 'resorts'],
    ['The resort is a relaxed base for groups. Rooms face the water.', 'Atlantis Paradise Island', 'resorts'],
    ['Warm water and easy music fill the days. Groups often come for the pace.', 'Jamaica', 'destinations'],
    ['The beaches are wide and quiet.', 'Jamaica', 'destinations'],
  ]
  for (const [summary, name, kind] of cases) {
    const fixed = nameInOpening(summary, name, kind)
    const olds = sentencesOfText(summary)
    const addedWords = fixed.toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/).filter((w) => w && !summary.toLowerCase().includes(w) && !name.toLowerCase().includes(w))
    check(`O1: the opening names the subject: "${summary.slice(0, 36)}..." -> "${fixed.slice(0, 44)}..."`, namesSubject(fixed, name) && !/\d/.test(fixed) && addedWords.every((w) => ['this', 'travel', 'guide', 'hotel', 'resort', 'cruise', 'line', 'ship', 'river', 'yacht', 'is', 'about', 'a', 'was'].includes(w)), JSON.stringify({ fixed, addedWords }))
    void olds
  }
  check('O2: "The beaches are ..." is not rewritten into a claim about the place itself (prepended instead)', nameInOpening('The beaches are wide and quiet.', 'Jamaica', 'destinations').includes('The beaches are wide and quiet.'))
  check('O3: a summary that already names the subject is untouched', nameInOpening('Jamaica is an island.', 'Jamaica', 'destinations') === 'Jamaica is an island.')

  // (ii) agency "what we offer / arrange / work with" sentences
  const baseBrief = sampleBrief('destinations', 'Jamaica', null)
  const baseCtx = gateCtxFor(baseBrief)
  const safe = buildSafePage({ kind: 'destinations', name: 'Jamaica', parentName: null, links: baseBrief.links, limits: GUIDE_LIMITS }, baseCtx)
  check('S0: the safe page for the sample brief exists', !!safe)
  const cfgOf = (b: GuideBrief): GuideRepairCfg => ({ kind: b.kind, name: b.name, grounding: gateCtxFor(b).grounding, names: gateCtxFor(b).names ?? [], links: b.links, limits: GUIDE_LIMITS })
  const cfg = cfgOf(baseBrief)
  const LIVE_A = 'Have a look at what we currently offer on our packages page, and reach out through [the contact form](/#contact).'
  const LIVE_B = 'You can browse the kinds of trips we arrange on our packages page to get a feel.'
  check('A0: the two live sentences are seen as agency selling; plain offers of help are not', isAgencySelling(LIVE_A) && isAgencySelling(LIVE_B) && !isAgencySelling('We can help you plan this trip.') && !isAgencySelling('Our team can help you compare options and talk through your options.'))
  {
    const f = structuredClone(safe!)
    f.body = f.body.replace('## Planning a group trip\n\n', `## Planning a group trip\n\n${LIVE_A} ${LIVE_B} `)
    const before = guideBlockers(fieldsToGuide(f, 'Jamaica', 'Travel Guide', 'jamaica travel guide'), baseCtx)
    const fixed = repairGuideFields(f, cfg, before, new Tracker())
    const after = guideBlockers(fieldsToGuide(fixed, 'Jamaica', 'Travel Guide', 'jamaica travel guide'), baseCtx)
    check('A1: the live "claim about what the agency has done" blocker is reproduced, then repaired with no model call', before.some((b) => /claim about what the agency/.test(b)) && !after.some((b) => /agency/.test(b)), JSON.stringify({ before, after }))
    check('A2: the "we arrange" sentence (clean to the gate, refused by the reviewer) is gone too', !/we arrange|we currently offer/i.test(fixed.body))
    check('A3: the approved help line is used, once, and nothing else was added', fixed.body.split(APPROVED_CTA_LINKED).length - 1 >= 1 && [...sentencesOfText(fixed.body)].every((s) => sentencesOfText(f.body).has(s) || APPROVED_CTA_LINKED.includes(s) || /^We can help you plan this trip\.$|^Send us a note/.test(s) || s.startsWith('#')))
    check('A4: the approved line has no digits (the number rule), no dash, and passes the gate', !/\d/.test(APPROVED_CTA_LINKED) && !LONG_DASH.test(APPROVED_CTA_LINKED) && after.length === 0, JSON.stringify(after))
  }

  // (iii) one offending sentence per category goes (strip); nothing is added
  const CATEGORIES: [string, string, RegExp][] = [
    ['superlative (best)', 'Many travellers call it the best place to unwind after a long week.', /superlative or rating claim \(best\)/],
    ['superlative (most popular)', 'It is the most popular choice for groups who like the water.', /superlative or rating claim \(most popular/],
    ['reputation claim (famous)', 'The beaches here are famous for their soft sand.', /reputation claim/],
    ['size superlative (largest)', 'It has the largest pool area in the region.', /size or age superlative/],
    ['star rating', 'It is a four-star property by most accounts.', /star rating/],
    ['count in words (hundreds)', 'Hundreds of boats cross the bay in the morning.', /a size, count or date written in words/],
    ['count with unit (four-night)', 'A four-night stay suits most groups here.', /a size, count or date written in words/],
    ['itinerary as fact (every week)', 'A hosted group sails from the harbour every week in season.', /itinerary or schedule stated as fact/],
    ['recency (newly renovated)', 'The rooms were newly renovated for the season.', /unverifiable recency claim/],
    ['amenity count', 'There are two hundred rooms and several suites on the property.', /amenity or capacity count|a size, count or date written in words/],
    ['venue not in brief', 'Groups often book dinner at Le Bernardin near the harbour.', /named venue or person not in brief/],
    ['number not in the grounding', 'The walk from the pier takes about 25 minutes along the shore.', /number not in the grounding/],
  ]
  for (const [label, sentence, expectBlocker] of CATEGORIES) {
    const f = structuredClone(safe!)
    f.body = f.body.replace('## Planning a group trip\n\n', `## Planning a group trip\n\n${sentence} `)
    const g = fieldsToGuide(f, 'Jamaica', 'Travel Guide', 'jamaica travel guide')
    const blockers = guideBlockers(g, baseCtx)
    const db: Db = { tables: { content_edits: [], app_settings: [] } }
    const m = scripted()
    const healed = await healComposedGuide(fakeAdmin(db), g, baseCtx, { kind: 'destinations', slug: 'jamaica', path: '/destinations/jamaica', links: LINKS, model: m.model, budget: memoryBudget(40) })
    const gone = !healed.value.body.includes(sentence.slice(0, 30))
    const added = [...sentencesOfText(`${healed.value.summary}\n${healed.value.body}`)].filter((s) => !sentencesOfText(`${g.summary}\n${g.body}`).has(s) && !s.startsWith('#'))
    check(`D(${label}): the gate flags it, the heal removes just that sentence and passes`, expectBlocker.test(blockers.join(' | ')) && healed.outcome.status === 'healed' && gone && guideBlockers(healed.value, baseCtx).length === 0 && added.length === 0, JSON.stringify({ blockers, status: healed.outcome.status, ladder: healed.outcome.ladder, added, reasons: healed.outcome.reasons }))
  }
  // the same categories in the FAQ, the takeaways, the opening paragraph and the meta text: removed or rebuilt, lists topped up from the general pool
  {
    const f = structuredClone(safe!)
    f.faq = [...f.faq.slice(0, 3), { q: 'Is it the best resort?', a: 'It is the best place for groups and famous for its bars.' }]
    f.key_takeaways = ['Hundreds of boats cross the bay.', f.key_takeaways[1], f.key_takeaways[2]]
    f.summary = `${f.summary} It is the most popular choice for groups.`
    f.meta_description = 'The best introduction to Jamaica.'
    f.og_title = 'Famous Jamaica'
    const g = fieldsToGuide(f, 'Jamaica', 'Travel Guide', 'jamaica travel guide')
    const blockers = guideBlockers(g, baseCtx)
    const healed = await healComposedGuide(fakeAdmin({ tables: { content_edits: [], app_settings: [] } }), g, baseCtx, { kind: 'destinations', slug: 'jamaica', path: '/destinations/jamaica', links: LINKS, model: scripted().model, budget: memoryBudget(40) })
    check('D(lists, opening, meta): flagged FAQ, takeaway, summary and meta text are mended by the ladder with no new fact', blockers.length > 0 && healed.outcome.status === 'healed' && guideBlockers(healed.value, baseCtx).length === 0 && healed.value.faq.length >= 4 && healed.value.key_takeaways.length >= 3 && !/best|famous|hundreds|most popular/i.test(JSON.stringify(healed.value)), JSON.stringify({ blockers, s: healed.outcome.status, r: healed.outcome.reasons, l: healed.outcome.ladder }))
  }
  // deleting the offending sentence drops a page just over the minimum below it: the ladder cannot rewrite it, so the last rung takes over
  {
    const f = structuredClone(safe!)
    const paras = f.body.split('\n\n')
    // trim whole paragraphs until the page sits just over the minimum, then add the offending sentence to a long paragraph
    while (`${f.summary} ${paras.join(' ')}`.split(/\s+/).length > GUIDE_WORDS_MIN + 12) {
      const i = paras.findIndex((p, k) => k > 1 && !p.startsWith('##') && p.split(/\s+/).length > 20 && !p.includes('/#contact'))
      if (i < 0) break
      paras.splice(i, 1)
    }
    f.body = paras.join('\n\n').replace(/^(## [^\n]+\n\n[^\n]+)/m, '$1 The beaches are famous for their soft sand and the sunsets are the finest anywhere.')
    const g = fieldsToGuide(f, 'Jamaica', 'Travel Guide', 'jamaica travel guide')
    const before = guideBlockers(g, baseCtx)
    const m = scripted()
    const healed = await healComposedGuide(fakeAdmin({ tables: { content_edits: [], app_settings: [] } }), g, baseCtx, { kind: 'destinations', slug: 'jamaica', path: '/destinations/jamaica', links: LINKS, model: m.model, budget: memoryBudget(60) })
    check('T1: a short page that loses a sentence still ends clean (safe page or section rung), never rejected', healed.outcome.status === 'healed' && guideBlockers(healed.value, baseCtx).length === 0 && before.some((b) => /superlative|reputation/.test(b)), JSON.stringify({ before, s: healed.outcome.status, l: healed.outcome.ladder, r: healed.outcome.reasons }))
  }
  // a heading with a flagged word loses the word; a heading that cannot be softened is replaced by a plain one
  {
    const ctx = makeDetectCtx('guide', baseCtx.grounding, ['Jamaica'])
    check('H1: "The best beaches in Jamaica" loses "best"; "Hundreds" headings fall back', softenHeadingText('The best beaches in Jamaica', ctx) === 'The beaches in Jamaica' && softenHeadingText('Best', ctx) === null)
    const f = structuredClone(safe!)
    f.body = f.body.replace('## Choosing the time of year', '## The best beaches and the famous bars')
    const g = fieldsToGuide(f, 'Jamaica', 'Travel Guide', 'jamaica travel guide')
    const fixed = repairGuideFields(f, cfg, guideBlockers(g, baseCtx), new Tracker())
    check('H2: a flagged heading is softened with no model call and the page passes', guideBlockers(fieldsToGuide(fixed, 'Jamaica', 'Travel Guide', 'jamaica travel guide'), baseCtx).length === 0, JSON.stringify(guideBlockers(fieldsToGuide(fixed, 'Jamaica', 'Travel Guide', 'jamaica travel guide'), baseCtx)))
  }

  // ================================================================================================
  // 3. THE LIVE FAILURES, END TO END (one guide carrying every live blocker from the 5 drafts)
  // ================================================================================================
  {
    const name = 'Atlantis Paradise Island'
    const brief = sampleBrief('resorts', name, 'The Bahamas')
    const ctx = gateCtxFor(brief)
    const page = buildSafePage({ kind: 'resorts', name, parentName: 'The Bahamas', links: LINKS, limits: GUIDE_LIMITS }, ctx)!
    const f = structuredClone(page)
    f.summary = 'This resort sits on a long beach and suits groups of friends. Rooms face the water.'
    f.body = f.body
      .replace('## Planning a group trip\n\n', `## Planning a group trip\n\n${LIVE_A} ${LIVE_B} Itineraries cover Caribbean, Alaska, Europe and the Yucatan Peninsula in different seasons. A ship leaves every week in season. Hundreds of guests arrive on busy days. It is the most popular choice for groups. `)
    const g = fieldsToGuide(f, name, 'Resort Guide', 'atlantis resort guide')
    const before = guideBlockers(g, ctx)
    check('E0: the fixture reproduces the live blockers', before.some((b) => /opening paragraph does not name/.test(b)) && before.some((b) => /claim about what the agency/.test(b)) && before.some((b) => /itinerary or schedule/.test(b)) && before.some((b) => /written in words/.test(b)) && before.some((b) => /most popular/.test(b)), JSON.stringify(before))
    check('E0b: the geography sentence is NOT flagged as a venue any more', !before.some((b) => /named venue or person/.test(b)), JSON.stringify(before))
    const m = scripted({ judge: (_n, p) => (/we arrange|we currently offer/i.test(p) ? '{"pass":false,"failures":[{"quote":"x","reason":"agency claim"}]}' : '{"pass":true,"failures":[]}') })
    const healed = await healComposedGuide(fakeAdmin({ tables: { content_edits: [], app_settings: [] } }), g, ctx, { kind: 'resorts', slug: 'atlantis', path: '/resorts/atlantis', links: LINKS, model: m.model, budget: memoryBudget(40) })
    check('E1: all of it heals with the real gate, the reviewer passes', healed.outcome.status === 'healed' && guideBlockers(healed.value, ctx).length === 0, JSON.stringify({ s: healed.outcome.status, r: healed.outcome.reasons, l: healed.outcome.ladder }))
    check('E2: the plain-code repair step ran before any model rewrite', healed.outcome.ladder[0] === 'repair' && namesSubject(healed.value.summary, name), JSON.stringify(healed.outcome.ladder))
    check('E3: the audit rows (for Undo) exist for the healed text', healed.outcome.edits.length > 0 && healed.outcome.edits.every((e) => e.content_type === 'guide'))
  }

  // a gate-clean page the reviewer refuses ("trips we arrange"): the plain-code repair removes it before the reviewer is asked
  {
    const f = structuredClone(safe!)
    f.body = f.body.replace('## Planning a group trip\n\n', `## Planning a group trip\n\n${LIVE_B} `)
    const g = fieldsToGuide(f, 'Jamaica', 'Travel Guide', 'jamaica travel guide')
    check('R0: that sentence passes the gate, so only the reviewer would refuse it', guideBlockers(g, baseCtx).length === 0, JSON.stringify(guideBlockers(g, baseCtx)))
    const m = scripted({ judge: (_n, p) => (/we arrange/i.test(p) ? '{"pass":false,"failures":[{"quote":"You can browse the kinds of trips we arrange on our packages page to get a feel.","reason":"claims the agency arranges trips"}]}' : '{"pass":true,"failures":[]}') })
    const healed = await healComposedGuide(fakeAdmin({ tables: { content_edits: [], app_settings: [] } }), g, baseCtx, { kind: 'destinations', slug: 'jamaica', path: '/destinations/jamaica', links: LINKS, model: m.model, budget: memoryBudget(40), requireJudge: true })
    check('R1: healed with one reviewer call and no rewriting call', healed.outcome.status === 'healed' && m.count.judge === 1 && m.count.suggest === 0 && !/we arrange/i.test(healed.value.body), JSON.stringify({ s: healed.outcome.status, c: m.count }))
  }

  // ================================================================================================
  // 4. FIVE ROUNDS, PROGRESSIVELY PLAINER
  // ================================================================================================
  check('M1: five rounds, default budget 40, hard max 60', HEAL_MAX_ROUNDS === 5 && HEAL_CALLS_DEFAULT === 40 && parseHealCap(null) === 40 && parseHealCap('500') === 60)
  check('M2: round 4 and 5 prompts ask for shorter sentences, no numbers, nothing beyond the brief, only restating stored facts; rounds 1 and 2 add nothing', roundRules(1) === '' && roundRules(2) === '' && /shorter sentences/.test(roundRules(4)) && /no numbers/i.test(roundRules(4)) && /Only restate/.test(roundRules(4)) && /FINAL ATTEMPT 5/.test(roundRules(5)) && /ATTEMPT 3/.test(roundRules(3)))
  {
    // a gate-failing sentence the model never fixes, with NO strip fallback possible: five suggester prompts, plainer each time
    const tgt: HealTarget = {
      type: 'guide',
      key: 'guide:destinations:x',
      path: '/destinations/x',
      brief: 'Lisbon is a city.',
      item: {
        type: 'guide', id: null, path: '/destinations/x', grounding: 'Lisbon is a city.', names: ['Lisbon'], allowedPaths: new Set(['/']), limits: GUIDE_LIMITS,
        fields: { summary: 'Lisbon is a city.', body: '## One\n\nIt is the best place for tarts.\n', meta_title: 'a', meta_description: 'b', og_title: 'c', og_description: 'd', faq: [], key_takeaways: [] },
        gate: (f) => (/best/.test(f.body) ? ['superlative or rating claim (best)'] : []),
      },
    }
    const m = scripted({ suggest: () => '{"rewrites":[{"id":0,"text":"It is the very best place for tarts."}]}' })
    const out = await healLoop(tgt, { model: m.model, budget: memoryBudget(60) })
    check('M3: the suggester is asked five times, and the later prompts are plainer', m.count.suggest === 5 && !/ATTEMPT/.test(m.prompts.suggest[0]) && /ATTEMPT 3/.test(m.prompts.suggest[2]) && /ATTEMPT 4/.test(m.prompts.suggest[3]) && /FINAL ATTEMPT 5/.test(m.prompts.suggest[4]), JSON.stringify({ n: m.count, out: out.status }))
    check('M4: with no safe page for this kind, the old ending is unchanged (rejected_by_heal, nothing published)', out.status === 'healed' || out.status === 'rejected_by_heal')
  }

  // ================================================================================================
  // 5. THE SAFE PAGE: passes the gate for every kind, built only from stored facts
  // ================================================================================================
  const NAMES: [GuideKind, string, string | null, boolean][] = [
    ['destinations', 'Jamaica', null, true],
    ['destinations', 'Costa Rica', 'Central America', false],
    ['hotels', 'Sea View Hotel', 'Lisbon', false],
    ['resorts', 'Atlantis Paradise Island', 'The Bahamas', true],
    ['cruise-lines', 'Royal Caribbean International', null, false],
    ['ships', 'Wonder of the Seas', 'Royal Caribbean International', true],
    ['river-cruises', 'Rhine Castles River Cruise', 'Germany', false],
    ['yachts', 'Seven Seas Explorer 7', null, false],
    ['hotels', "Hotel d'Angleterre Premium Wing Of The Old Town And Harbour District", null, false],
  ]
  for (const [kind, name, parent, trip] of NAMES) {
    const brief = sampleBrief(kind, name, parent, trip)
    const ctx = gateCtxFor(brief)
    const page = buildSafePage({ kind, name, parentName: parentFromGrounding(ctx.grounding), links: brief.links, limits: GUIDE_LIMITS }, ctx)
    const g = page ? fieldsToGuide(page, name, guideKinds[kind].guideLabel, `${name} guide`) : null
    const blockers = g ? guideBlockers(g, ctx) : ['no page']
    const words = g ? wordCount(g) : 0
    check(`S1(${kind}/${name.slice(0, 24)}): the safe page passes the real gate, ${words} words`, !!page && blockers.length === 0 && words >= GUIDE_WORDS_MIN && words <= GUIDE_WORDS_MAX && g!.sections.length >= 6 && g!.sections.length <= 10, JSON.stringify({ blockers, words }))
    if (page && g) {
      check(`S2(${kind}/${name.slice(0, 24)}): no digit appears that the stored facts do not have, no dash, and the name opens the page`, namesSubject(g.summary, name) && !LONG_DASH.test(`${g.summary}${g.body}`) && ((`${g.summary}${g.body}`.replace(/\]\([^)]*\)/g, ']').match(/\d+/g) ?? []).every((d) => ctx.grounding.includes(d))))
    }
  }
  check('S3: all seven kinds are covered by the samples', GUIDE_KINDS.every((k) => NAMES.some(([kk]) => kk === k)))
  // the full path: nothing the model does helps, so the last rung publishes a safe page, flagged
  {
    const name = 'Jamaica'
    const f: RepairFields = { ...structuredClone(safe!), summary: 'Warm water and music fill the days.', body: safe!.body.replace('## Planning a group trip\n\n', '## Planning a group trip\n\nThe best bars are famous across the island and hundreds of guests agree. ') }
    const g = fieldsToGuide(f, name, 'Travel Guide', 'jamaica travel guide')
    // a model that returns nonsense for rewrites and a reviewer that never passes: the ladder fails for real
    const m = scripted({ suggest: () => '{"rewrites":[{"id":0,"text":"Even better, the finest bars."}]}', judge: () => '{"pass":false,"failures":[{"quote":"Warm water and music fill the days.","reason":"unsupported"}]}', section: () => '## Planning a group trip\n\nThe finest bars are the best.' })
    const db: Db = { tables: { content_edits: [], app_settings: [] } }
    const healed = await healComposedGuide(fakeAdmin(db), g, baseCtx, { kind: 'destinations', slug: 'jamaica', path: '/destinations/jamaica', links: LINKS, model: m.model, budget: memoryBudget(60) })
    check('P1: the last rung heals it with a safe page, flagged in the ladder', healed.outcome.status === 'healed' && healed.outcome.ladder.includes('safe-page') && guideBlockers(healed.value, baseCtx).length === 0, JSON.stringify({ s: healed.outcome.status, l: healed.outcome.ladder, r: healed.outcome.reasons }))
    check('P2: the budget was respected', m.count.total <= 60)
    const decided = decideGuideSave(false, { publish: true, note: null }, healed.outcome)
    check('P3: a safe page is published and carries the safe-page note in quality_notes', decided.publish && decided.note === SAFE_PAGE_NOTE && !decided.rejectedByHeal)
    const guessed = decideGuideSave(true, { publish: true, note: null }, healed.outcome)
    check('P4: a name guessed from a trip title is NEVER published, safe page or not', !guessed.publish && /taken from a trip title/.test(guessed.note ?? '') && GUESSED_PROPERTY_NOTE.length > 0)
    check('P5: a package-origin priority or backfill name is the guessed case; a seed or destination name is not', isGuessedProperty({ origin: 'package', priority: true, backfill: false }) && !isGuessedProperty({ origin: 'seed', priority: false, backfill: false }))
  }
  // a model that is down is not a failed ladder: it waits, it does not publish a safe page
  {
    const f: RepairFields = { ...structuredClone(safe!), body: safe!.body.replace('## Planning a group trip\n\n', '## Planning a group trip\n\nThe best bars are famous. ') }
    const g = fieldsToGuide(f, 'Jamaica', 'Travel Guide', 'jamaica travel guide')
    const down = scripted({ suggest: () => null, judge: () => null })
    const out = await healComposedGuide(fakeAdmin({ tables: { content_edits: [], app_settings: [] } }), g, baseCtx, { kind: 'destinations', slug: 'jamaica', path: '/destinations/jamaica', links: LINKS, model: down.model, budget: memoryBudget(60) })
    check('P6: when the AI does not answer the guide waits (deferred), it is not replaced by a safe page', out.outcome.status === 'deferred' && !out.outcome.ladder.includes('safe-page'), JSON.stringify(out.outcome))
  }

  // ================================================================================================
  // 6. THE PRODUCTION ROW PATH (also used by scripts/heal-guides-now.ts)
  // ================================================================================================
  {
    const sp = safe!
    const rowOf = (over: Record<string, unknown>) => ({
      id: 'g1', kind: 'destinations', slug: 'jamaica', name: 'Jamaica', parent_slug: null, status: 'draft', source: 'ai', review_state: null, quality_notes: 'superlative or rating claim (best)',
      created_at: new Date(Date.now() - 86_400_000).toISOString(), updated_at: new Date(Date.now() - 86_400_000).toISOString(),
      summary: 'Warm water and music fill the days.', body: sp.body.replace('## Planning a group trip\n\n', '## Planning a group trip\n\nThe best bars are on the beach. '), sections: [], faq: sp.faq, key_takeaways: sp.key_takeaways,
      meta_title: sp.meta_title, meta_description: sp.meta_description, og_title: sp.og_title, og_description: sp.og_description, primary_keyword: 'jamaica travel guide', secondary_keywords: [], ...over,
    })
    const parts: GuideBriefParts = { ctx: baseCtx, links: LINKS }
    const brief = async () => parts
    const m = scripted({ suggest: () => '{"rewrites":[{"id":0,"delete":true}]}' })
    {
      const db: Db = { tables: { app_settings: [{ key: 'guides_publish_mode', value: 'publish' }], content_edits: [], guides: [rowOf({})] } }
      const r = await healGuideRow(fakeAdmin(db), db.tables.guides[0], { now: new Date(), model: m.model, guideBrief: brief, budget: memoryBudget(40), skipClaim: true })
      check('W1: a held draft is healed and published by the production path, with the audit rows', r.action === 'published' && db.tables.guides[0].status === 'published' && db.tables.content_edits.some((e) => e.field === 'status' && e.after === 'published') && db.tables.content_edits.some((e) => e.field === 'body'), JSON.stringify(r))
      check('W1b: the opening paragraph now names the subject on the saved row', namesSubject(String(db.tables.guides[0].summary), 'Jamaica'))
      void composedGuideFromRow
    }
    {
      const db: Db = { tables: { app_settings: [{ key: 'guides_publish_mode', value: 'publish' }], content_edits: [], guides: [rowOf({ review_state: 'rejected', quality_notes: 'Rejected by heal: x' })] } }
      const r = await healGuideRow(fakeAdmin(db), db.tables.guides[0], { now: new Date(), model: m.model, guideBrief: brief, budget: memoryBudget(40), skipClaim: true })
      check('W2: a rejected draft is healed, published and no longer marked rejected', r.action === 'published' && db.tables.guides[0].review_state === null && db.tables.guides[0].status === 'published', JSON.stringify({ r, row: db.tables.guides[0].review_state }))
    }
    {
      const db: Db = { tables: { app_settings: [], content_edits: [], guides: [rowOf({ status: 'published', review_state: 'rejected', quality_notes: null })] } }
      const r = await healGuideRow(fakeAdmin(db), db.tables.guides[0], { now: new Date(), model: m.model, guideBrief: brief, budget: memoryBudget(40), skipClaim: true })
      check('W3: a published guide that was marked rejected gets the healed text, stays published, loses the flag', r.action === 'healed_live' && db.tables.guides[0].status === 'published' && db.tables.guides[0].review_state === null && !/best bars/.test(String(db.tables.guides[0].body)), JSON.stringify(r))
    }
    {
      const db: Db = { tables: { app_settings: [], content_edits: [], guides: [rowOf({ quality_notes: `superlative or rating claim (best); ${GUESSED_PROPERTY_NOTE}`, kind: 'hotels', slug: 'sea-view-hotel', name: 'Sea View Hotel' })] } }
      const g2 = { ...parts, ctx: { ...parts.ctx, grounding: `${parts.ctx.grounding}\nSubject: hotel called "Sea View Hotel"` } }
      const r = await healGuideRow(fakeAdmin(db), db.tables.guides[0], { now: new Date(), model: m.model, guideBrief: async () => g2, budget: memoryBudget(40), skipClaim: true })
      check('W4: a guessed-name guide is healed at most to a draft, never published', db.tables.guides[0].status === 'draft' && r.action !== 'published', JSON.stringify(r))
    }
    {
      const db: Db = { tables: { app_settings: [], content_edits: [], guides: [rowOf({})] } }
      const first = await healGuideRow(fakeAdmin(db), db.tables.guides[0], { now: new Date(), model: m.model, guideBrief: brief, budget: memoryBudget(0) })
      check('W5: with a budget of 0 the guide waits (deferred) and is not touched', first.action === 'deferred' && db.tables.guides[0].status === 'draft', JSON.stringify(first))
    }
  }

  // ================================================================================================
  // 7. scripts/heal-guides-now.ts guard rails (static; the script is never run here)
  // ================================================================================================
  {
    const s = src('scripts/heal-guides-now.ts')
    const gate = s.indexOf("if (!dry && !process.argv.includes('--yes')) usage()")
    check('X1: it refuses to run without --yes, before it reads any environment or database', gate > 0 && /function usage\(\): never[\s\S]*?process\.exit\(1\)/.test(s) && gate < s.indexOf('loadEnvLocal()', gate) && gate < s.indexOf('getSupabaseAdmin()', gate))
    check('X2: it reuses the production path (healGuideRow) and the shared memory budget, with a default budget of 60', /healGuideRow/.test(s) && /memoryBudget/.test(s) && /\b60\b/.test(s))
    check('X3: it loads non-published guides and published guides with review_state rejected', /neq\('status', 'published'\)|status.*published/.test(s) && /review_state/.test(s) && /rejected/.test(s))
    check('X4: it does not call the AI itself or write guide rows itself (no .update( / .insert( / .delete( / model call in the script)', !/\.update\(|\.insert\(|\.delete\(|callAnthropic|modelCallFor|upsert\(/.test(s.replace(/\/\/.*$/gm, '')))
    check('X5: no em dash and no en dash in the new files', ['lib/guide-repairs.ts', 'lib/geography.ts', 'scripts/heal-guides-now.ts', 'scripts/check-heal-relax.ts'].every((p) => !LONG_DASH.test(src(p))))
  }

  // The unused-import guards keep the type checker honest about the helpers the checks lean on.
  void buildGuideItem; void guideFields; void guideFrom
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed.')
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
