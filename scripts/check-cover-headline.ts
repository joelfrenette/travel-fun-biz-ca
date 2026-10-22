// Offline checks for the Instagram cover headline rules, the deterministic fallback, the cover retry
// flow, slide types and the cover hook rotation. No database, no network.
// Run: pnpm dlx tsx scripts/check-cover-headline.ts
import { validateCoverHeadline, fallbackCoverHeadline, titlePhrases, shortestWholePhrase, BANNED_ENDINGS } from '../lib/cover-headline'
import { finalizeCoverHeadline, normaliseSlides, resolveSlideType, type CarouselSlide } from '../lib/carousel-slide'
import { coverTitleFor, type VideoScript } from '../lib/video-script'
import { COVER_HOOK_STYLES, HOOK_STYLES, rotateStyle } from '../lib/hook-styles'

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : detail ? `  (${detail})` : ''}`)
  if (!ok) failures++
}
const ok = (h: string, src = '') => validateCoverHeadline(h, src).ok
const why = (h: string, src = '') => validateCoverHeadline(h, src).reasons.join(' | ')

// ---- Accepted: one of every allowed hook pattern ----
check('question', ok('Cancun or Tulum, which wins?'), why('Cancun or Tulum, which wins?'))
check('short question', ok('Is Tulum worth it?'), why('Is Tulum worth it?'))
check('X or Y', ok('Cancun or Tulum'), why('Cancun or Tulum'))
check('X vs Y', ok('Penang vs Phuket'), why('Penang vs Phuket'))
check('A to B by C', ok('Miami to Cozumel by ship'), why('Miami to Cozumel by ship'))
check('X plus Y', ok('Cozumel plus Costa Maya'), why('Cozumel plus Costa Maya'))
check('comma list of 3', ok('Tulum, Cancun, Holbox'), why('Tulum, Cancun, Holbox'))
check('comma list of 4', ok('Rome, Nice, Lisbon, Cadiz'), why('Rome, Nice, Lisbon, Cadiz'))
check('decoded', ok('Cruise cabins decoded'), why('Cruise cabins decoded'))
check('quiz CTA', ok('Take the cruise quiz'), why('Take the cruise quiz'))
check('grounded number', ok('7 nights, 3 ports', 'a 7 night cruise with 3 ports'), why('7 nights, 3 ports', 'a 7 night cruise with 3 ports'))
check('grounded number alone', ok('Seven days in Rome', 'seven days in Rome'), why('Seven days in Rome', 'seven days in Rome'))

// ---- Rejected ----
check('ungrounded number rejected', !ok('9 nights, 3 ports', 'a 7 night cruise with 3 ports'))
check('number with no source rejected', !ok('Top 10 beaches'))
check('2 words rejected', !ok('Beach days?'))
check('7 words rejected', !ok('Is Tulum worth the trip this winter?'))
check('over 36 chars rejected', !ok('Cozumel or Costa Maya or Roatan today') && 'Cozumel or Costa Maya or Roatan today'.length > 36)
check('word over 12 chars rejected', !ok('Is Internationalization worth it?'))
for (const w of BANNED_ENDINGS) check(`ends on "${w}" rejected`, !ok(`Which beach is better ${w}`) && !ok(`Cancun or Tulum ${w}`))
check('em dash rejected', !ok('Cancun \u2014 or Tulum'))
check('en dash rejected', !ok('Cancun \u2013 or Tulum'))
check('emoji rejected', !ok('Cancun or Tulum \u{1F334}'))
check('colon subtitle rejected', !ok('Cancun or Tulum: the verdict'))
check('trailing period rejected', !ok('Cancun or Tulum.'))
for (const bad of ['Discover Cancun or Tulum', 'Explore Tulum, Cancun, Holbox', 'Welcome to Cancun or Tulum', 'Introducing Cancun or Tulum', 'Ultimate guide Cancun or Tulum', 'Everything you need to know?', 'Tips for Cancun or Tulum', 'Guide to Cancun or Tulum', 'Why you should pick Tulum?', 'Have you ever wondered why?']) {
  check(`opener rejected: ${bad}`, !ok(bad), why(bad))
}
check('no hook pattern rejected', !ok('Puerto Plata cruise port'), why('Puerto Plata cruise port'))
check('empty rejected', !ok(''))

// ---- Fallback: whole phrases only, never a word slice ----
const fb1 = fallbackCoverHeadline('Puerto Plata Cruise Port Guide: Things To Do And See')
check('fallback is valid', fb1 !== null && ok(fb1), String(fb1))
check('fallback is a whole title phrase', fb1 === 'Puerto Plata Cruise Port Guide decoded' || fb1 === 'Things To Do And See' || fb1 === null || /decoded$/.test(fb1), String(fb1))
check('fallback never ends on a banned word', !fb1 || !(BANNED_ENDINGS as readonly string[]).includes(fb1.split(' ').pop()!.toLowerCase()))
check('fallback never an old-style fragment', !/\bTRIP AND$/i.test(fb1 ?? '') && !/^ERTO/i.test(fb1 ?? ''))
check('7-word question title is not kept or sliced', fallbackCoverHeadline('Is Puerto Plata worth a cruise stop?') === null)
check('short question title kept', fallbackCoverHeadline('Is Tulum worth it?') === 'Is Tulum worth it?')
check('label title gets decoded', fallbackCoverHeadline('Cruise Cabin Types') === 'Cruise Cabin Types decoded')
check('hopeless title gives null', fallbackCoverHeadline('The Complete And Utterly Exhaustive Handbook About Everything Cruise Related') === null)
check('titlePhrases splits at colon and bar', titlePhrases('Rome Port Guide: What To Eat | Travel').includes('What To Eat'))
check('shortestWholePhrase is whole', shortestWholePhrase('Rome Port Guide: What To Eat') === 'What To Eat' || shortestWholePhrase('Rome Port Guide: What To Eat') === 'Rome Port Guide')

// ---- coverTitleFor ----
const script = (coverTitle?: string): VideoScript => ({ hook: 'h', coverTitle, beats: [], title: 'Puerto Plata Trip', description: '', hashtags: [] }) as unknown as VideoScript
check('coverTitleFor keeps a valid model title', coverTitleFor(script('Cancun or Tulum'), 'Cancun vs Tulum cruise ports') === 'Cancun or Tulum')
check('coverTitleFor replaces an invalid model title with a whole phrase', coverTitleFor(script('The best cruise ports and'), 'Cruise Cabin Types') === 'Cruise Cabin Types decoded')
const long = coverTitleFor(script(), 'Puerto Plata Trip And Everything About The Amber Coast Cruise Port')
check('coverTitleFor never returns a 7-word slice', long.split(' ').length !== 7 || long === 'Puerto Plata Trip And Everything About The Amber Coast Cruise Port', long)
check('coverTitleFor, no model title, label title', coverTitleFor(script(), 'Rome Cruise Port') === 'Rome Cruise Port decoded')

// ---- finalizeCoverHeadline ----
const deck = (cover: string): CarouselSlide[] => [{ headline: cover, body: 'b1' }, { headline: 'Two', body: 'b2' }]
async function flow() {
  let calls = 0
  const good = await finalizeCoverHeadline(deck('Cancun or Tulum'), 'Cancun vs Tulum', '', async () => { calls++; return null })
  check('valid cover: no retry', calls === 0 && good?.[0].headline === 'Cancun or Tulum' && good?.[0].type === 'cover')

  calls = 0
  let instruction = ''
  const retried = await finalizeCoverHeadline(deck('Your Ultimate Guide To The Best Cruise Ports In Mexico Right Now'), 'Mexico cruise ports', '', async (i) => { calls++; instruction = i; return 'Cozumel or Costa Maya' })
  check('bad cover: exactly one retry, retry result used', calls === 1 && retried?.[0].headline === 'Cozumel or Costa Maya')
  check('retry instruction carries the banned lists', /Never end it with:/.test(instruction) && /Never start it with:/.test(instruction) && /discover/i.test(instruction))

  calls = 0
  const fell = await finalizeCoverHeadline(deck('Your Ultimate Guide To The Best Cruise Ports In Mexico Right Now'), 'Cruise Cabin Types', '', async () => { calls++; return 'Still far too long to be a headline' })
  check('bad retry: one call then deterministic fallback', calls === 1 && fell?.[0].headline === 'Cruise Cabin Types decoded', JSON.stringify(fell?.[0]))

  const none = await finalizeCoverHeadline(deck('Your Ultimate Guide To The Best Cruise Ports In Mexico Right Now'), 'The Complete And Utterly Exhaustive Handbook About Everything Cruise Related', '', async () => { throw new Error('boom') })
  check('no valid hook: deck degrades to a whole-phrase cover, not null', none !== null && none[0].type === 'cover' && none[0].headline.split(' ').length >= 3 && none[0].headline.split(' ').length <= 6, JSON.stringify(none?.[0]))
  const nothing = await finalizeCoverHeadline(deck('x y z'), '', '', async () => null)
  check('empty title: still fails', nothing === null)
  const carib = await finalizeCoverHeadline(deck('Your Ultimate Guide To The Best Cruise Ports In Mexico Right Now'), 'Is a Caribbean Cruise Worth It in 2026?', '', async () => null)
  check('long question title gives a usable cover', carib !== null && carib[0].headline.length > 0 && carib[0].headline.length <= 36, JSON.stringify(carib?.[0]))
  const bali = await finalizeCoverHeadline(deck('Your Ultimate Guide To The Best Cruise Ports In Mexico Right Now'), 'Best time for Bali', '', async () => null)
  check('Best time for Bali gives a usable cover', bali !== null && /^best time for bali/i.test(bali[0].headline), JSON.stringify(bali?.[0]))
  check('later slides untouched', good?.[1].headline === 'Two')

  const dotted = await finalizeCoverHeadline(deck('Cancun or Tulum.'), 'x', '', async () => null)
  check('trailing period tidied before validation', dotted?.[0].headline === 'Cancun or Tulum')
}

// ---- Slide types: schema, parser, backward compatibility ----
const parsed = normaliseSlides([
  { type: 'cover', headline: 'Cancun or Tulum', body: 'x' },
  { type: 'fact', headline: 'Penang runs 3,900 dollars cheaper per year', body: '' },
  { headline: 'Old deck slide', body: 'old body' },
  { type: 'weird', headline: 'Unknown type', body: 'b' },
  { type: 'photo', headline: 'No body', body: '' },
  null,
])
check('parser keeps a fact slide with an empty body', parsed.some((s) => s.type === 'fact' && s.body === ''))
check('parser drops a photo slide with no body', !parsed.some((s) => s.headline === 'No body'))
check('parser drops unknown types but keeps the slide', parsed.find((s) => s.headline === 'Unknown type')?.type === undefined)
check('old stored deck (no type) loads', parsed.find((s) => s.headline === 'Old deck slide')?.type === undefined)
check('slide 1 always draws as cover', resolveSlideType({ headline: 'x' }, 0) === 'cover')
check('untyped inner slide draws as photo', resolveSlideType({ headline: 'x' }, 3) === 'photo')
check('fact slide draws as fact', resolveSlideType({ type: 'fact', headline: 'Short claim here' }, 2) === 'fact')
check('fact claim over 14 words falls back to photo', resolveSlideType({ type: 'fact', headline: 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen' }, 2) === 'photo')
check('normaliseSlides tolerates garbage', normaliseSlides('nope').length === 0 && normaliseSlides(undefined).length === 0)

// ---- Cover hook rotation ----
check('cover hooks exclude story, mistake and how-to', !COVER_HOOK_STYLES.some((s) => (['story', 'mistake', 'how-to'] as string[]).includes(s)))
check('cover hooks keep question, contrarian, number, comparison', (['question', 'contrarian', 'number', 'comparison'] as string[]).every((s) => (COVER_HOOK_STYLES as readonly string[]).includes(s)))
check('caption HOOK_STYLES unchanged (still 7)', HOOK_STYLES.length === 7)
const seen = new Set<string>()
let recent: string[] = []
for (let i = 0; i < 12; i++) {
  const s = rotateStyle(recent, COVER_HOOK_STYLES)
  seen.add(s)
  recent = [s, ...recent]
}
check('rotation visits every cover style', seen.size === COVER_HOOK_STYLES.length)

flow().then(() => {
  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
})
