// Offline checks for the no-AI fallback caption and hashtag cleaner. No network, no database.
// Run: pnpm dlx tsx scripts/check-fallback-caption.ts   (exits 1 on any failed expectation)
import { buildFallbackCaption, PLATFORM_CHAR_LIMITS, FALLBACK_CTA_LINE } from '../lib/social-captions'
import { normaliseHashtags, hashtagCapFor } from '../lib/hook-styles'
import { readFileSync } from 'node:fs'

let failures = 0
function expect(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`)
  if (!ok) failures++
}

const EM = String.fromCharCode(8212)
const link = 'https://travelfunbiz.ca/blog/rhine-river-cruise?utm_source=social&utm_medium=social&utm_campaign=rhine&utm_content=post-photo'
const facts = {
  title: 'Rhine River Cruise: What First Timers Should Know',
  metaDescription: 'A plain guide to a 7 day Rhine cruise for first timers, with what to pack and how to choose a cabin.',
  faqQuestions: ['Is a river cruise right for a first big trip?', 'How do I pick a cabin?'],
  keyTakeaways: ['A 7 day Rhine sailing suits first timers.'],
  tags: ['#river cruise', 'Rhine', 'rhine', 'Europe!!', 'Family Travel'],
}

const networks = Object.keys(PLATFORM_CHAR_LIMITS)
for (const n of networks) {
  const c = buildFallbackCaption(facts, n, link)
  expect(`${n}: builds a caption`, c !== null)
  if (!c) continue
  const lines = c.split('\n').filter((l) => l.trim())
  expect(`${n}: line 1 is the first FAQ question, not the title`, lines[0] === facts.faqQuestions[0] && !c.startsWith(facts.title))
  expect(`${n}: has the fixed CTA line and the link intact`, c.includes(FALLBACK_CTA_LINE) && c.includes(link))
  expect(`${n}: within the limit`, c.length <= PLATFORM_CHAR_LIMITS[n], String(c.length))
  expect(`${n}: no em dash`, !c.includes(EM))
  const tags = c.match(/#\S+/g) ?? []
  expect(`${n}: hashtags at most 3 and at most the network cap`, tags.length <= 3 && tags.length <= hashtagCapFor(n), tags.join(' '))
  expect(`${n}: hashtags deduped, no double # or spaces`, new Set(tags.map((t) => t.toLowerCase())).size === tags.length && tags.every((t) => /^#[A-Za-z0-9]+$/.test(t)), tags.join(' '))
  expect(`${n}: link comes before hashtags`, tags.length === 0 || c.indexOf(link) < c.indexOf(tags[0] ?? ""))
}

const takeawayOnly = buildFallbackCaption({ ...facts, faqQuestions: [] }, 'facebook', link)
expect('falls back to the first key takeaway as the hook', !!takeawayOnly && takeawayOnly.startsWith(facts.keyTakeaways[0] ?? '#'))
expect('no FAQ and no takeaways returns null so the caller keeps the old text', buildFallbackCaption({ ...facts, faqQuestions: [], keyTakeaways: [] }, 'facebook', link) === null)
expect('empty description still builds', !!buildFallbackCaption({ ...facts, metaDescription: null }, 'facebook', link))
expect('no tags means no hashtag', !(buildFallbackCaption({ ...facts, tags: [] }, 'facebook', link) ?? '#').includes('#'))
expect('a hook that is the title is rejected', buildFallbackCaption({ ...facts, faqQuestions: [facts.title] }, 'facebook', link) === null)
expect('a number that comes from a stored takeaway is allowed', !!buildFallbackCaption({ ...facts, faqQuestions: [], keyTakeaways: ['Most Rhine sailings run 7 nights.'] }, 'facebook', link))
expect('em dash in stored text is repaired', !(buildFallbackCaption({ ...facts, faqQuestions: [`Is it worth it ${EM} really?`] }, 'facebook', link) ?? '').includes(EM))
const tight = buildFallbackCaption(facts, 'x', link, { limit: 280 })
expect('x: tight fit keeps the link whole', !!tight && tight.includes(link) && tight.length <= 280)
const shared = buildFallbackCaption(facts, 'facebook', link, { limit: 280, hashtagCap: 1 })
expect('shared limit and hashtag cap are honoured', !!shared && shared.length <= 280 && (shared.match(/#\S+/g) ?? []).length <= 1)

// normaliseHashtags
expect('strips # and spaces, joins words', normaliseHashtags(['#river cruise']).join() === '#RiverCruise')
expect('strips punctuation', normaliseHashtags(['Europe!!', '##Italy?']).join(' ') === '#Europe #Italy')
expect('dedupes ignoring case', normaliseHashtags(['Rhine', '#rhine', 'RHINE']).length === 1)
expect('default cap is 3', normaliseHashtags(['a1', 'b2', 'c3', 'd4', 'e5']).length === 3)
expect('explicit cap is honoured', normaliseHashtags(['a1', 'b2', 'c3'], 2).length === 2)
expect('drops empty, number-only and non-string entries', normaliseHashtags(['', '###', '2026', 42, null, 'Spain']).join() === '#Spain')
expect('cap 0 gives none', normaliseHashtags(['Spain'], 0).length === 0)

// wiring
const dist = readFileSync('lib/distribution.ts', 'utf8')
const auto = readFileSync('lib/autopilot.ts', 'utf8')
const vid = readFileSync('lib/video-script.ts', 'utf8')
expect('distribution uses the fallback caption with a title+description fallback', dist.includes('buildFallbackCaption(') && dist.includes('fallbackCaption ??'))
expect('autopilot carousel uses the fallback caption and keeps fitCaptionWithLink as fallback', auto.includes('buildFallbackCaption(') && auto.includes('?? fitCaptionWithLink('))
expect('video hashtags go through normaliseHashtags', vid.includes('normaliseHashtags(parsed.hashtags)'))
for (const [name, src] of [['social-captions', readFileSync('lib/social-captions.ts', 'utf8')], ['hook-styles', readFileSync('lib/hook-styles.ts', 'utf8')]] as const) {
  expect(`${name}.ts has no em dash`, !src.includes(EM))
}

if (failures) {
  console.log(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nAll fallback caption checks passed')
