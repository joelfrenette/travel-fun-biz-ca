// Offline checks for the WP2 caption gate and style rotation. No network, no database.
// Run: pnpm dlx tsx scripts/check-captions.ts   (exits 1 on the first failed expectation)
import { captionProblems, repairCaptionCta, buildVideoCaption, WORD_OF_MOUTH_LINE, FALLBACK_CTA_LINE, BIO_CTA_LINE, VIDEO_CTA_LINE } from '../lib/social-captions'
import { socialLink, socialContent, canonicalNetwork, type SocialSurface } from '../lib/utm'
import { rotateStyle, HOOK_STYLES, valuesFromRows, ungroundedNumbers } from '../lib/hook-styles'

let failures = 0
function expect(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`)
  if (!ok) failures++
}

const link = 'https://travelfunbiz.ca/blog/rhine-river-cruise?utm_source=x&utm_medium=social&utm_campaign=rhine&utm_content=question'
const base = { title: 'Rhine River Cruise: What First Timers Should Know', summary: 'A plain guide to a 7 day Rhine cruise.', network: 'facebook', link, grounding: null as string | null }
const good = `Is a river cruise right for your first big trip?\n\nThis guide walks through what a 7 day Rhine sailing is like for a first timer.\n\nRead the full guide:\n${link}`

expect('clean caption has no problems', captionProblems(good, base).length === 0, captionProblems(good, base).join('; '))
expect('over limit flagged', captionProblems(good + ' x'.repeat(200), { ...base, network: 'x' }).some((p) => p.includes('limit')))
expect('title as first line flagged', captionProblems(`${base.title}\n\nSomething else that is long enough to count.\n${link}`, base).some((p) => p.includes('title')))
expect('title as prefix of first line flagged', captionProblems(`${base.title} and more words here\n\nBody text that is long enough.\n${link}`, base).some((p) => p.includes('title')))
expect('invented digit flagged', captionProblems(good.replace('first timer', 'first timer in 14 days'), base).some((p) => p.includes('14')))
expect('digit from summary is fine', captionProblems(good, base).every((p) => !p.includes('number')))
expect('spelled number flagged', captionProblems(good.replace('what a 7 day', 'what a three day'), base).some((p) => p.includes('3')))
expect('spelled number present in source is fine', ungroundedNumbers('three days', 'it takes three days').length === 0)
expect('digit matches source word', ungroundedNumbers('3 days', 'it takes three days').length === 0)
expect('hashtag digits and a 2026 year are ignored', ungroundedNumbers('Plan for 2026 #Rhine2031x', 'nothing here').length === 0)
expect('year outside 2025-2030 is flagged', ungroundedNumbers('Back in 2019', 'nothing here').join() === '2019')
expect('"Day 3 100 people" is not joined', ungroundedNumbers('Day 3 100 people', 'day 3 and 100 people').length === 0)
expect('comma grouping still joins', ungroundedNumbers('1,200 guests', 'about 1200 guests').length === 0)
expect('"one" is ignored', ungroundedNumbers('one of the best', 'nothing here').length === 0)
expect('missing link flagged on facebook', captionProblems(good.replace(link, ''), base).some((p) => p.includes('link')))
expect('missing link fine on instagram', captionProblems(good.replace(link, ''), { ...base, network: 'instagram' }).every((p) => !p.includes('link is missing')))
expect('link only flagged', captionProblems(link, { ...base, network: 'x' }).some((p) => p.includes('no text besides')))
expect('link plus hashtags only flagged', captionProblems(`#a #b\n${link}`, { ...base, network: 'x' }).some((p) => p.includes('no text besides')))
expect('em dash flagged', captionProblems(good.replace('walks', `walks ${String.fromCharCode(8212)}`), base).some((p) => p.includes('em dash')))

// Rotation
const seq: string[] = []
let recent: string[] = []
for (let i = 0; i < 21; i++) {
  const s = rotateStyle(recent, HOOK_STYLES)
  seq.push(s)
  recent = [s, ...recent].slice(0, 12)
}
expect('never repeats the previous style', seq.every((s, i) => i === 0 || s !== seq[i - 1]))
expect('all 7 styles used within 14 posts', new Set(seq.slice(0, 14)).size === 7)
expect('most recent is never chosen', rotateStyle(['story'], HOOK_STYLES) !== 'story')
expect('deterministic', rotateStyle(['story', 'mistake'], HOOK_STYLES) === rotateStyle(['story', 'mistake'], HOOK_STYLES))
const firsts = [0, 1, 2, 3].map((i) => rotateStyle([], HOOK_STYLES, i))
expect('empty history differs per network offset', new Set(firsts).size === 4, firsts.join(','))
expect('single-entry catalogue works', rotateStyle(['a'], ['a'] as const) === 'a')

// History ordering: the hook_style_at stamp wins over updated_at
const rows = [
  { variant_tags: { 'hook_style:x': 'old' }, updated_at: '2026-10-09T10:00:00Z' },
  { variant_tags: { 'hook_style:x': 'new', hook_style_at: '2026-10-09T09:00:00Z' }, updated_at: '2026-10-09T08:00:00Z' },
  { variant_tags: { 'hook_style:x': 'older', hook_style_at: '2026-10-01T09:00:00Z' }, updated_at: '2026-10-09T11:00:00Z' },
]
expect('stamp orders history, newest first', valuesFromRows(rows, 'hook_style:x', 3).join(',') === 'old,new,older', valuesFromRows(rows, 'hook_style:x', 3).join(','))

// Hooks in content: shape rules added to captionProblems
const shape = (c: string) => captionProblems(c, base).join('; ')
expect('weak opener caption flagged', shape(`Discover the Rhine\n\nPlain words about the river trip.\n${link}`).includes('weak opener'))
expect('three emojis flagged', shape(good.replace('first big trip', 'first big trip \u{1F30A}\u{1F6F3}\u{2600}\u{FE0F}')).includes('too many emojis'))
expect('hashtag spam flagged', shape(`${good}\n${Array.from({ length: 11 }, (_, i) => `#t${String.fromCharCode(97 + i)}`).join(' ')}`).includes('hashtag spam'))
expect('four lines without a break flagged', shape(`Is it for you?\nOne.\nTwo.\nThree.\n\nRead the full guide:\n${link}`).includes('paragraph wall'))

// ---- Call to action and link per platform (docs/factory/SOCIAL-QUALITY-LOOP.md part 2) ----
const SITE = 'https://travelfunbiz.ca/blog/rhine-river-cruise'
const NETWORKS = ['instagram', 'tiktok', 'facebook', 'linkedin', 'threads', 'bluesky', 'pinterest', 'x', 'youtube']
const linkOf = (n: string, surface: SocialSurface = 'post', variant = 'question') => socialLink(SITE, n, 'rhine-river-cruise', surface, variant)
const bodyOnly = 'Is a river cruise right for your first big trip?\n\nThis guide walks through what a 7 day Rhine sailing is like for a first timer.'
for (const n of NETWORKS) {
  const l = linkOf(n)
  const ctx = { title: base.title, summary: base.summary, network: n, link: l, grounding: null as string | null }
  const bare = bodyOnly
  const flagged = captionProblems(bare, ctx)
  expect(`${n}: a caption with no link and no CTA is flagged`, flagged.some((p) => p === 'call to action is missing' || p === 'link is missing'), flagged.join('; '))
  const fixed = repairCaptionCta(bare, { network: n, link: l })
  expect(`${n}: repair appends the CTA and leaves no problem`, captionProblems(fixed, ctx).length === 0, `${captionProblems(fixed, ctx).join('; ')} :: ${fixed}`)
  expect(`${n}: repair is idempotent`, repairCaptionCta(fixed, { network: n, link: l }) === fixed)
  expect(`${n}: first line is still the hook`, fixed.split('\n')[0] === bodyOnly.split('\n')[0])
  if (n === 'instagram' || n === 'tiktok') {
    expect(`${n}: says link in bio, adds the short line, no clickable URL`, /link in (our )?bio/i.test(fixed) && fixed.includes(WORD_OF_MOUTH_LINE) && !/https?:\/\//.test(fixed))
  } else {
    expect(`${n}: carries its own UTM link (utm_source=${canonicalNetwork(n)})`, fixed.includes(l) && l.includes(`utm_source=${canonicalNetwork(n)}`) && l.includes('utm_medium=social') && l.includes('utm_campaign=rhine-river-cruise'))
  }
}
const withTags = `${bodyOnly}\n\n#Rhine #Cruise`
const repairedTags = repairCaptionCta(withTags, { network: 'facebook', link: linkOf('facebook') })
expect('repair puts the CTA and link before the hashtags', repairedTags.indexOf(linkOf('facebook')) < repairedTags.indexOf('#Rhine') && repairedTags.endsWith('#Rhine #Cruise'))
const tightIg = repairCaptionCta(`${bodyOnly} ${'More words here. '.repeat(200)}`, { network: 'instagram', link: linkOf('instagram'), limit: 2200 })
expect('a long caption is cut, never the bio line', tightIg.length <= 2200 && /link in (our )?bio/i.test(tightIg) && tightIg.includes(WORD_OF_MOUTH_LINE))
const tightX = repairCaptionCta(`${bodyOnly} ${'More words here. '.repeat(50)}`, { network: 'x', link: linkOf('x'), limit: 280 })
expect('x: a long caption is cut, the link stays whole', tightX.length <= 280 && tightX.includes(linkOf('x')))
expect('the standard CTA lines contain no em dash', ![FALLBACK_CTA_LINE, BIO_CTA_LINE, WORD_OF_MOUTH_LINE, VIDEO_CTA_LINE].some((s) => s.includes(String.fromCharCode(8212))))

// Distinct utm_content per post surface and per variant; one utm_source per network
const contents = (['post', 'guide', 'trip', 'news', 'carousel', 'video', 'bio'] as SocialSurface[]).map((s) => socialContent(s, 'question'))
expect('every surface has its own utm_content', new Set(contents).size === contents.length, contents.join(','))
expect('variants differ within a surface', socialContent('post', 'story') !== socialContent('post', 'question') && socialContent('post', 'fallback') !== socialContent('post', 'story'))
expect('twitter is tagged as x', linkOf('twitter').includes('utm_source=x&'))
expect('two posts never share utm_campaign', socialLink(SITE, 'facebook', 'a', 'post', 'x') !== socialLink(SITE, 'facebook', 'b', 'post', 'x'))

// Pinterest: the caption is the pin text. The pin title is its first line (100 characters at most) and the destination is the UTM page URL.
const pin = repairCaptionCta(bodyOnly, { network: 'pinterest', link: linkOf('pinterest', 'post', 'fallback') })
expect('pinterest: pin title (first line) fits 100 characters and the destination has utm_source=pinterest', pin.split('\n')[0].length <= 100 && pin.includes('utm_source=pinterest') && pin.includes('utm_content=fallback-post'))

// The shared reel caption: bio words, then the tagged link, hashtags last, and a long description never cuts either.
const vcap = buildVideoCaption({ title: 'Cancun or Tulum', description: 'x '.repeat(400), hashtags: ['#Cancun', '#Tulum'] }, linkOf('video', 'video', 'question'), 2200)
expect('reel caption carries link in bio, the UTM link and fits 2200', vcap.length <= 2200 && vcap.includes(VIDEO_CTA_LINE) && vcap.includes(linkOf('video', 'video', 'question')))
const vcap2 = buildVideoCaption({ title: 'Cancun or Tulum', description: 'Beaches or ruins.', hashtags: ['#Cancun'] }, linkOf('video', 'video', 'question'), 2200)
expect('reel caption puts hashtags last', vcap2.endsWith('#Cancun') && vcap2.indexOf(VIDEO_CTA_LINE) < vcap2.indexOf('#Cancun'))

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
