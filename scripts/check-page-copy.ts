// Quick self-check for the compare and best-time page copy gate and the candidate rotation (no network, no database).
// Run: pnpm dlx tsx scripts/check-page-copy.ts
import { copyGroundingText, copyPublishDecision, monthRange, normalizePageCopy, pageCopyBlockers, ungroundedWordCounts, type ComposedPageCopy, type PageCopyBrief, type CopyGateContext } from '../lib/page-copy-composer'
import { pickNextCopyCandidate, pageTypeOfPath, type PageCopyCandidate } from '../lib/page-copy'

let failed = 0
function check(label: string, ok: boolean) {
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`)
}

const filler = (n: number) => Array.from({ length: n }, (_, i) => `word${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + ((i * 7) % 26))}`).join(' ')

function makeBrief(shortDescription = 'A relaxed 7-night trip through the old town and the coast.'): PageCopyBrief {
  return {
    type: 'compare',
    title: 'Italy vs Tahiti',
    destinations: [
      { name: 'Italy', slug: 'italy', blurb: null, guideSummary: null, packages: [{ name: 'Rome Highlights', slug: 'rome-highlights', destination: 'Italy', category: 'Cultural', short_description: shortDescription, months: 'April to June' }] },
      { name: 'Tahiti', slug: 'tahiti', blurb: 'A string of islands in the South Pacific.', guideSummary: null, packages: [{ name: 'Tahiti Escape', slug: 'tahiti-escape', destination: 'Tahiti', category: 'Beach & Resort', short_description: null, months: 'September' }] },
    ],
    links: [
      { path: '/packages/rome-highlights', label: 'the "Rome Highlights" trip' },
      { path: '/packages/tahiti-escape', label: 'the "Tahiti Escape" trip' },
      { path: '/destinations/italy', label: 'our Italy page' },
      { path: '/destinations/tahiti', label: 'our Tahiti page' },
    ],
  }
}

const brief = makeBrief()
const ctxFor = (b: PageCopyBrief): CopyGateContext => ({ grounding: copyGroundingText(b), destinations: b.destinations.map((d) => d.name), names: b.links.map((l) => l.label), allowedPaths: new Set(b.links.map((l) => l.path)) })
const ctx = ctxFor(brief)

const goodIntro = `Italy and Tahiti suit different kinds of trips, and the trips we list for each show how. ${filler(150)} You can look at [the Rome Highlights trip](/packages/rome-highlights) for Italy or [our Tahiti page](/destinations/tahiti) for the islands.`
const good: ComposedPageCopy = {
  intro: goodIntro,
  faq: [
    { q: 'Which trips do you list for Italy?', a: 'We list the Rome Highlights trip right now.' },
    { q: 'When does the Tahiti Escape run?', a: 'It runs in September.' },
    { q: 'Can I see both on one page?', a: 'Yes, the trips for both destinations are listed below.' },
  ],
  key_takeaways: ['Italy and Tahiti suit different trips.', 'Each trip below is one we list now.', 'Ask us if you want help choosing.'],
  meta_title: 'Italy vs Tahiti Trips',
  meta_description: 'See the real Italy and Tahiti trips we list side by side.',
  og_title: 'Italy or Tahiti? See the trips',
  og_description: 'Two destinations, two kinds of trip.',
  primary_keyword: 'italy vs tahiti trips',
}
const blockersOf = (patch: Partial<ComposedPageCopy>, c = ctx) => pageCopyBlockers({ ...good, ...patch }, c)
const has = (list: string[], re: RegExp) => list.some((b) => re.test(b))

// --- the baseline passes ---
const base = pageCopyBlockers(good, ctx)
check(`clean copy has no blockers (${base.join('; ') || 'none'})`, base.length === 0)
check('clean copy publishes', copyPublishDecision(base).publish === true)

// --- numbers ---
check('grounded digit (7-night) is allowed', blockersOf({ intro: goodIntro.replace('for the islands', 'for a 7-night trip') }).length === 0)
check('ungrounded digit (12) is blocked', has(blockersOf({ intro: goodIntro.replace('for the islands', 'for 12 days') }), /number not in the grounding: 12/))
check('ungrounded digit in the FAQ is blocked', has(blockersOf({ faq: [...good.faq.slice(0, 2), { q: 'How long?', a: 'About 9 days.' }] }), /number not in the grounding/))
check('digits inside link targets are not counted', blockersOf({ intro: goodIntro.replace('rome-highlights', 'rome-highlights-2') }, { ...ctx, allowedPaths: new Set([...ctx.allowedPaths, '/packages/rome-highlights-2']) }).length === 0)
check('"four-night" is blocked when the grounding has no 4-night', has(blockersOf({ intro: goodIntro.replace('for the islands', 'for a four-night stay') }), /count written in words/))
const brief4 = makeBrief('A relaxed 4-night trip through the old town.')
check('"four-night" is excused when the grounding has "4-night"', blockersOf({ intro: goodIntro.replace('for the islands', 'for a four-night stay') }, ctxFor(brief4)).length === 0)
check('"seven-night" is excused when the grounding has "7-night"', ungroundedWordCounts('a seven-night trip', copyGroundingText(brief)).length === 0)
check('"or three days" is excused as a vague range', ungroundedWordCounts('most people spend two or three days', copyGroundingText(brief)).length === 0)
check('"hundreds of" is blocked', has(blockersOf({ intro: goodIntro.replace('for the islands', 'with hundreds of options') }), /written in words/))

// --- claims ---
check('superlative "best resort" is blocked', has(blockersOf({ intro: goodIntro.replace('for the islands', 'for the best resort') }), /superlative/))
check('"best time to visit" is allowed', blockersOf({ intro: goodIntro.replace('for the islands', 'for the best time to visit') }).length === 0)
check('"luxury" is blocked', has(blockersOf({ intro: goodIntro.replace('for the islands', 'for luxury') }), /superlative/))
check('a verdict ("is the better choice") is blocked', has(blockersOf({ intro: goodIntro.replace('for the islands', 'because Italy is the better choice') }), /verdict/))
check('weather tied to a month is blocked', has(blockersOf({ intro: `${goodIntro} April is warm and dry there.` }), /weather, crowd or season/))
check('"rainy season" is blocked', has(blockersOf({ faq: [...good.faq.slice(0, 2), { q: 'When is the rainy season?', a: 'It depends on the season.' }] }), /weather, crowd or season/))
check('an agency history claim is blocked', has(blockersOf({ intro: `${goodIntro} We have hosted groups here every year.` }), /claim about what the agency/))
check('an experience claim is blocked', has(blockersOf({ intro: `${goodIntro} When we visited, it rained.` }), /experience claim/))
check('a named venue not in the brief is blocked', has(blockersOf({ intro: `${goodIntro} Dinner at Luigi Trattoria is nice.` }), /named venue/))
check('a named hotel not in the brief is blocked', has(blockersOf({ intro: `${goodIntro} Stay at Grand Palace Resort.` }), /named venue/))
check('a web address is blocked', has(blockersOf({ intro: `${goodIntro} Visit https://example.com today.` }), /web address/))

// --- links ---
check('a dead internal link is blocked', has(blockersOf({ intro: goodIntro.replace('/destinations/tahiti', '/destinations/atlantis') }), /dead internal link: \/destinations\/atlantis/))
check('an intro with no link is blocked', has(blockersOf({ intro: goodIntro.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') }), /no internal link/))
check('more than 3 links is blocked', has(blockersOf({ intro: `${goodIntro} Also [a](/destinations/italy) and [b](/packages/tahiti-escape).` }), /links in the intro, at most 3/))
check('a link inside the FAQ is blocked', has(blockersOf({ faq: [...good.faq.slice(0, 2), { q: 'Where?', a: 'See [here](/destinations/italy).' }] }), /link inside FAQ/))

// --- dashes: repaired first, blocked if they remain ---
const EM = String.fromCharCode(0x2014)
const EN = String.fromCharCode(0x2013)
const repaired = normalizePageCopy({ ...good, intro: goodIntro.replace('Italy and Tahiti suit', `Italy and Tahiti ${EM} suit`), faq: [{ q: `Why ${EM} now?`, a: `Because it ${EM} works.` }, ...good.faq.slice(0, 2)], key_takeaways: [`One ${EN} two.`, 'Two.', 'Three.'] }, brief)
const repairedJson = JSON.stringify(repaired)
check('em and en dashes are repaired by normalizePageCopy', !repairedJson.includes(EM) && !repairedJson.includes(EN))
check('repaired copy passes the dash checks', !has(pageCopyBlockers(repaired, ctx), /dash/))
check('a raw em dash is still blocked by the gate', has(blockersOf({ intro: `${goodIntro} Italy ${EM} great.` }), /em dash present/))

// --- shape ---
check('FAQ with 2 questions is blocked', has(blockersOf({ faq: good.faq.slice(0, 2) }), /2 FAQ questions, need 3 to 5/))
check('FAQ with 6 questions is blocked', has(blockersOf({ faq: [...good.faq, ...good.faq] }), /6 FAQ questions/))
check('takeaways with 2 items are blocked', has(blockersOf({ key_takeaways: ['One.', 'Two.'] }), /2 key takeaways/))
check('an intro that is too short is blocked', has(blockersOf({ intro: 'Italy and Tahiti differ. See [our Tahiti page](/destinations/tahiti).' }), /too short/))
check('an intro that is too long is blocked', has(blockersOf({ intro: `${goodIntro} ${filler(200)}` }), /too long/))
check('a heading in the intro is blocked', has(blockersOf({ intro: `${goodIntro}\n\n## Heading` }), /heading/))
check('a first sentence that is a question is blocked', has(blockersOf({ intro: goodIntro.replace('Italy and Tahiti suit different kinds of trips, and the trips we list for each show how.', 'Italy or Tahiti?') }), /question/))
check('an intro that does not name a destination is blocked', has(blockersOf({ intro: goodIntro.replace(/Italy/g, 'Rome') }, ctx), /does not name Italy/))
check('OG title over 60 characters is blocked by the gate', has(blockersOf({ og_title: 'x'.repeat(61) }), /OG title over 60/))
const longOg = normalizePageCopy({ ...good, og_title: 'Italy or Tahiti, which trip fits you best this year, a long honest look', og_description: `${'Two destinations and two kinds of trip. '.repeat(5)}` }, brief)
check('OG lengths are repaired (title <= 60, description <= 110)', longOg.og_title.length <= 60 && longOg.og_description.length <= 110 && longOg.og_title.length > 0)
check('meta title is replaced when it does not name the destination', normalizePageCopy({ ...good, meta_title: 'Travel with us' }, brief).meta_title === 'Italy vs Tahiti')
check('a held copy is a draft with notes', (() => { const d = copyPublishDecision(['em dash present']); return d.publish === false && d.note === 'em dash present' })())

// --- helpers ---
check('monthRange: one month', monthRange('2027-04-10', '2027-04-17') === 'April')
check('monthRange: two months', monthRange('2027-04-10', '2027-06-17') === 'April to June')
check('monthRange: one side missing', monthRange('2027-09-01', null) === 'September')
check('monthRange: nothing', monthRange(null, null) === null)
check('pageTypeOfPath', pageTypeOfPath('/compare/a-vs-b') === 'compare' && pageTypeOfPath('/best-time-to-visit/italy') === 'best-time' && pageTypeOfPath('/blog/x') === null)

// --- candidate rotation (fake data) ---
const cand = (path: string, type: PageCopyCandidate['type'], hasRow = false): PageCopyCandidate => ({ path, type, label: path, hasRow, rowStatus: hasRow ? 'draft' : null })
const list = [
  cand('/compare/b-vs-c', 'compare'),
  cand('/compare/a-vs-b', 'compare'),
  cand('/compare/a-vs-c', 'compare'),
  cand('/best-time-to-visit/tahiti', 'best-time'),
  cand('/best-time-to-visit/italy', 'best-time'),
]
check('with no rows at all, compare goes first (ties follow the type order), alphabetical inside', pickNextCopyCandidate(list, {}, {}, 2)?.path === '/compare/a-vs-b')
check('the type whose newest row is oldest goes next (best-time here)', pickNextCopyCandidate(list, { compare: '2026-10-09T10:00:00Z', 'best-time': '2026-10-01T10:00:00Z' }, {}, 2)?.path === '/best-time-to-visit/italy')
check('then it flips to the other type (compare here)', pickNextCopyCandidate(list, { compare: '2026-10-09T10:00:00Z', 'best-time': '2026-10-10T10:00:00Z' }, {}, 2)?.path === '/compare/a-vs-b')
check('a type with no rows goes before a type with rows', pickNextCopyCandidate(list, { compare: '2026-10-09T10:00:00Z' }, {}, 2)?.path === '/best-time-to-visit/italy')
check('pages that already have a row are skipped', pickNextCopyCandidate([cand('/compare/a-vs-b', 'compare', true), cand('/compare/a-vs-c', 'compare')], {}, {}, 2)?.path === '/compare/a-vs-c')
check('pages that failed twice are skipped', pickNextCopyCandidate(list, {}, { '/compare/a-vs-b': 2 }, 2)?.path === '/compare/a-vs-c')
check('one failure still gets another try', pickNextCopyCandidate(list, {}, { '/compare/a-vs-b': 1 }, 2)?.path === '/compare/a-vs-b')
check('when one type is exhausted the other is used', pickNextCopyCandidate([cand('/compare/a-vs-b', 'compare', true), cand('/best-time-to-visit/italy', 'best-time')], { 'best-time': '2026-10-09T10:00:00Z' }, {}, 2)?.path === '/best-time-to-visit/italy')
check('nothing left returns null', pickNextCopyCandidate([cand('/compare/a-vs-b', 'compare', true)], {}, {}, 2) === null)

console.log(failed === 0 ? '\nAll checks passed.' : `\n${failed} check(s) FAILED.`)
process.exit(failed === 0 ? 0 : 1)
