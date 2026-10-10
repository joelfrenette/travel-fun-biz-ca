// Quick self-check for the guide quality gate and the candidate helpers (no network, no database).
// Run: pnpm dlx tsx scripts/check-guide-gate.ts
import { guideBlockers, parseArticle, removeDashes, internalLinksIn, type ComposedGuide } from '../lib/guide-composer'
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

console.log(failed === 0 ? '\nAll checks passed.' : `\n${failed} check(s) failed.`)
process.exit(failed === 0 ? 0 : 1)
