// Quick self-check for the guide quality gate and the candidate helpers (no network, no database).
// Run: pnpm dlx tsx scripts/check-guide-gate.ts
import { guideBlockers, parseArticle, removeDashes, internalLinksIn, type ComposedGuide } from '../lib/guide-composer'
import { publishDecision } from '../lib/guide-run'
import { kindFromPackageName, cleanPropertyName } from '../lib/guides'

let failed = 0
function check(label: string, ok: boolean) {
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`)
}

const filler = (n: number) => Array.from({ length: n }, (_, i) => `word${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + ((i * 7) % 26))}`).join(' ')
const section = (h: string, extra = '') => ({ heading: h, body: `${filler(190)} ${extra}`.trim() })
const sections = [
  section('Why visit Santorini', 'See [our trips](/packages/greek-isles).'),
  section('Where to stay'),
  section('What to do'),
  section('Food and drink'),
  section('When to go'),
  section('Getting around'),
  section('Who it suits'),
]
const good: ComposedGuide = {
  name: 'Santorini',
  summary: 'Santorini is a volcanic Greek island known for its cliffside villages and sunsets, and a popular stop on group trips.',
  sections,
  body: sections.map((s) => `## ${s.heading}\n\n${s.body}`).join('\n\n'),
  faq: [1, 2, 3, 4].map((i) => ({ q: `Is Santorini good for groups question ${'abcd'[i - 1]}?`, a: 'Yes, many travellers visit in groups.' })),
  key_takeaways: ['Santorini suits couples and groups', 'Plan transport early', 'Ask us about group trips'],
  meta_title: 'Santorini Travel Guide',
  meta_description: 'A plain-English guide to Santorini for group travellers.',
  og_title: 'Is Santorini right for your group?',
  og_description: 'What to expect on Santorini.',
  primary_keyword: 'santorini travel guide',
  secondary_keywords: ['santorini trips'],
  hero_query: 'santorini sunset',
}
const ctx = { grounding: 'Subject: destination called "Santorini"\n- "Greek Isles" runs in 2027', allowedPaths: new Set(['/', '/packages', '/packages/greek-isles']) }

const clone = (patch: Partial<ComposedGuide>): ComposedGuide => ({ ...good, ...patch })
const withBody = (text: string) => clone({ body: `${good.body}\n\n${text}` })

check('clean guide has no blockers', guideBlockers(good, ctx).length === 0)
check('em dash is blocked', guideBlockers(withBody('Great views \u2014 truly.'), ctx).some((b) => /em dash/.test(b)))
check('best is blocked', guideBlockers(withBody('This is the best hotel.'), ctx).some((b) => /best/.test(b)))
check('best time to visit is allowed', guideBlockers(withBody('Ask us about the best time to visit.'), ctx).length === 0)
check('award-winning is blocked', guideBlockers(withBody('An award-winning spa.'), ctx).length > 0)
check('5-star is blocked', guideBlockers(withBody('A 5-star resort.'), ctx).length > 0)
check('five star is blocked', guideBlockers(withBody('A five-star resort.'), ctx).length > 0)
check('world-class is blocked', guideBlockers(withBody('World-class dining.'), ctx).length > 0)
check('ungrounded number is blocked', guideBlockers(withBody('It has 450 rooms.'), ctx).some((b) => /number/.test(b)))
check('grounded year is allowed', guideBlockers(withBody('Our trip runs in 2027.'), ctx).length === 0)
check('amenity count in words is blocked', guideBlockers(withBody('There are twelve restaurants on board.'), ctx).length > 0)
check('dead link is blocked', guideBlockers(withBody('See [this](/packages/not-real).'), ctx).some((b) => /dead/.test(b)))
check('external link is blocked', guideBlockers(withBody('See [this](https://example.com).'), ctx).length > 0)
check('experience claim is blocked', guideBlockers(withBody('When I visited last year it was lovely.'), ctx).some((b) => /experience/.test(b)))
check('our guests loved is blocked', guideBlockers(withBody('Our guests loved it.'), ctx).length > 0)
check('placeholder is blocked', guideBlockers(withBody('Insert photo here [TODO].'), ctx).length > 0)
check('missing faq is blocked', guideBlockers(clone({ faq: [] }), ctx).some((b) => /FAQ/.test(b)))
check('missing takeaways is blocked', guideBlockers(clone({ key_takeaways: [] }), ctx).some((b) => /takeaways/.test(b)))
check('too short is blocked', guideBlockers(clone({ body: '## One\n\nshort', sections: [{ heading: 'One', body: 'short' }] }), ctx).length > 0)
check('summary must name the subject', guideBlockers(clone({ summary: 'A volcanic island with villages.' }), ctx).length > 0)
check('recency claim is blocked', guideBlockers(withBody('A newly renovated lobby.'), ctx).length > 0)

check('removeDashes replaces em dash', !removeDashes('a \u2014 b').includes('\u2014'))
check('parseArticle splits summary and sections', (parseArticle('Intro here.\n\n## A\n\nText\n\n### Sub\n\nMore\n\n## B\n\nText2') ?? { sections: [] }).sections.length === 2)
check('internalLinksIn maps contact to root', internalLinksIn('[x](/#contact) [y](/packages/a?x=1)').join(',') === '/,/packages/a')

check('resort name detected', kindFromPackageName('Sandals Royal Resort', null) === 'resorts')
check('hotel name detected', kindFromPackageName('Grand Hotel Example', null) === 'hotels')
check('river cruise detected', kindFromPackageName('Rhine River Cruise', 'cruise') === 'river-cruises')
check('ordinary trip is not a property', kindFromPackageName('Singles Getaway to Cancun', 'singles') === null)
check('trip title with digits is not a name', cleanPropertyName('Rhine River Cruise 7 Nights') === null)
check('name is cut before a colon', cleanPropertyName('Sandals Royal Resort: Group Trip') === 'Sandals Royal Resort')

// Fix round 1: unverifiable claims
const blocked = (label: string, text: string) => check(label, guideBlockers(withBody(text), ctx).length > 0)
blocked('largest is blocked', 'It is one of the largest cruise ships in the world.')
blocked('most popular is blocked', 'It is the most popular choice.')
blocked('oldest is blocked', 'The oldest in Europe.')
blocked('five-diamond is blocked', 'A five-diamond experience.')
check('butler service is allowed', guideBlockers(withBody('Some suites include butler service.'), ctx).length === 0)
blocked('named venue is blocked', 'Dinner is served at Aquavit Terrace.')
blocked('named person is blocked', 'Meals are inspired by Chef Gordon Ramsay.')
blocked('three thousand guests is blocked', 'It carries about three thousand guests.')
blocked('nineteenth century is blocked', 'Founded in the nineteenth century.')
blocked('launched recently is blocked', 'The ship launched recently.')
blocked('every week schedule is blocked', 'Sailings from Fort Lauderdale visit Cozumel every week.')
blocked('iconic is blocked', 'An iconic landmark.')
blocked('luxury is blocked', 'A luxury stay.')
blocked('leading is blocked', 'A leading cruise line.')
blocked('first ship is blocked', 'It was the first ship of its kind.')
blocked('state-of-the-art is blocked', 'State-of-the-art facilities.')
blocked('three-night word number is blocked', 'A three-night sailing.')
check('two or three days stays allowed', guideBlockers(withBody('Most people spend two or three days here.'), ctx).length === 0)
blocked('agency history is blocked', 'We host groups here every spring.')
blocked('our guests visit is blocked', 'Our guests visit the island each year.')
blocked('years of experience is blocked', 'We have years of experience with this route.')
check('offers of help are allowed', guideBlockers(withBody('Our team can help you plan. Ask us about the ferry. We can help you take the ferry.'), ctx).length === 0)
check('mixed offer and history is blocked', guideBlockers(withBody('We can help you plan, and we sailed there often.'), ctx).length > 0)
blocked('en dash is blocked', 'Plan three\u2013five days.')
check('removeDashes turns a range en dash into a hyphen', removeDashes('3\u20135 days') === '3-5 days')
check('removeDashes turns a spaced en dash into a comma', removeDashes('a \u2013 b') === 'a, b')
check('grounded names are allowed', guideBlockers(withBody('Our Greek Isles trip suits first timers.'), { ...ctx, grounding: ctx.grounding + ' Greek Isles' }).length === 0)

// Publish decision: draft mode and the named-property rule
check('draft mode holds a clean guide', !publishDecision('destinations', 'draft', 'pipeline', []).publish)
check('draft mode note says why', /guides_publish_mode=draft/.test(publishDecision('destinations', 'draft', 'admin', []).note ?? ''))
check('blockers are the note', /superlative/.test(publishDecision('destinations', 'publish', 'pipeline', ['superlative (best)']).note ?? ''))
check('publish mode lets a clean destination go live', publishDecision('destinations', 'publish', 'pipeline', []).publish)
check('publish mode lets a clean cruise line go live', publishDecision('cruise-lines', 'publish', 'pipeline', []).publish)
for (const k of ['hotels', 'resorts', 'ships', 'river-cruises', 'yachts'] as const) {
  check(k + ' never published by the pipeline', !publishDecision(k, 'publish', 'pipeline', []).publish)
}
check('admin write never publishes a clean hotel', !publishDecision('hotels', 'publish', 'admin', []).publish)
for (const k of ['hotels', 'resorts', 'ships', 'river-cruises', 'yachts'] as const) check(k + ' draft for admin source too', !publishDecision(k, 'publish', 'admin', []).publish)
blocked('we can host groups every spring is blocked', 'We can host groups every spring.')
blocked('our advisors visited is blocked', 'Our advisors visited the island.')
blocked('I have stayed is blocked', 'I have stayed nearby.')
blocked('our staff have is blocked', 'Our staff have returned often.')
check('we can help you take the ferry stays allowed', guideBlockers(withBody('We can help you take the ferry.'), ctx).length === 0)

// WP7 gate fix: a spelled-out count is excused when the grounding has the same count with the same unit.
const montego = { ...ctx, grounding: `${ctx.grounding}\n- "Montego Bay Escape" is a 4-night trip` }
check('Montego Bay: "4-night" in the grounding excuses "four-night"', guideBlockers(withBody('Our four-night escape is easy to plan.'), montego).length === 0)
blocked('Montego Bay: without it in the grounding "four-night" still blocks', 'Our four-night escape is easy to plan.')
check('grounding "4 nights" excuses "four-night"', guideBlockers(withBody('A four-night stay.'), { ...ctx, grounding: `${ctx.grounding}\n- runs 4 nights` }).length === 0)
check('grounding "four nights" excuses "four-night"', guideBlockers(withBody('A four-night stay.'), { ...ctx, grounding: `${ctx.grounding}\n- runs four nights` }).length === 0)
check('a different count is not excused ("five-night" vs 4-night)', guideBlockers(withBody('A five-night stay.'), montego).length > 0)
check('a different unit is not excused ("four-day" vs 4-night)', guideBlockers(withBody('A four-day stay.'), montego).length > 0)
check('a stray digit elsewhere does not excuse it', guideBlockers(withBody('A four-night stay.'), { ...ctx, grounding: `${ctx.grounding}\n- 4 ports of call` }).length > 0)
check('amenity counts stay blocked even with a grounded count', guideBlockers(withBody('There are four restaurants on board.'), { ...ctx, grounding: `${ctx.grounding}\n- 4 restaurants` }).length > 0)
check('hundreds is still blocked', guideBlockers(withBody('Hundreds of guests visit.'), montego).length > 0)

console.log(failed === 0 ? '\nAll checks passed.' : `\n${failed} check(s) failed.`)
process.exit(failed === 0 ? 0 : 1)
