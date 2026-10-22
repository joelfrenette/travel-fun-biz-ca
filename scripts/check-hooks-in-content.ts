// Offline checks for "hooks in content": the title step, the caption prompt and checks, the topic prompt and the
// stored cover headline. No network, no database.
// Run: pnpm dlx tsx scripts/check-hooks-in-content.ts   (exits 1 on any failed expectation)
import { captionProblems, buildCaptionPrompt } from '../lib/social-captions'
import { weakOpenerOf, countEmojis, captionShapeProblems, titleHookInstruction, coverHeadlineInstruction, captionFormatRules, TOPIC_PATTERN_TEXT, cleanCoverHeadline, coverHeadlineKey, WEAK_OPENERS } from '../lib/hook-rules'
import { validateCoverHeadline } from '../lib/cover-headline'
import { coverHeadlineFor } from '../lib/social-cover'
import { HASHTAG_RULES } from '../lib/hook-styles'

let failures = 0
function expect(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`)
  if (!ok) failures++
}

// ---- Good and bad cover headlines taken from the owner's Instagram examples ----
const goodCovers = ['Cultural or beach? Take the quiz', 'Cologne to Basel by river', 'Cancun or Tulum?', 'Reef, outback, cities, fjords', 'Cozumel plus Costa Maya', 'Cruise cabins decoded']
for (const h of goodCovers) expect(`good cover: ${h}`, validateCoverHeadline(h).ok, validateCoverHeadline(h).reasons.join('|'))
expect('grounded number cover', validateCoverHeadline('US$3,900 cheaper per year', 'it costs US$3,900 less per year').ok, validateCoverHeadline('US$3,900 cheaper per year', 'it costs US$3,900 less per year').reasons.join('|'))
expect('ungrounded number cover rejected', !validateCoverHeadline('US$3,900 cheaper per year', 'no figures here').ok)
const badCovers = ['Discover the best cruise deals', 'Explore Cancun with us', 'Welcome to your dream trip', 'The ultimate guide to Rhine river cruising for first timers', 'Best time to']
for (const h of badCovers) expect(`bad cover rejected: ${h}`, !validateCoverHeadline(h).ok)

// ---- cleanCoverHeadline (what the title step output goes through) ----
expect('clean keeps a valid headline', cleanCoverHeadline('Cancun or Tulum?', 'x') === 'Cancun or Tulum?')
expect('clean strips quotes', cleanCoverHeadline('"Cancun or Tulum?"', 'x') === 'Cancun or Tulum?')
expect('clean drops an invalid headline', cleanCoverHeadline('Discover Cancun today', 'x') === null)
expect('clean drops a trailing preposition', cleanCoverHeadline('Cancun or Tulum for', 'x') === null)
expect('clean drops non-string', cleanCoverHeadline(42, 'x') === null && cleanCoverHeadline(undefined, 'x') === null)
expect('stored key', coverHeadlineKey('my-post') === 'cover_headline:my-post')
expect('stored headline wins, in capitals', coverHeadlineFor('Cancun or Tulum?', 'A long generic title about Mexico trips') === 'CANCUN OR TULUM?')
expect('no stored headline falls back to the shortener', coverHeadlineFor(null, 'River Cruise Basics') === 'RIVER CRUISE BASICS')

// ---- Weak openers ----
for (const o of WEAK_OPENERS) expect(`weak opener detected: ${o}`, weakOpenerOf(`${o} the Rhine today`) === o)
expect('strong opener is not weak', weakOpenerOf('Cancun or Tulum?') === null)
expect('"Exploration" is not "Explore"', weakOpenerOf('Exploration tips') === null)

// ---- Prompt content: title step ----
const ti = titleHookInstruction('rhine river cruise')
expect('title prompt keeps keyword first', ti.includes('rhine river cruise') && ti.includes('first or very near the start'))
expect('title prompt names hook shapes', ['question', '"X or Y"', '"A to B by C"', 'comma list'].every((t) => ti.includes(t)))
expect('title prompt bans weak openers', ['Discover', 'Explore', 'Welcome', 'Ultimate guide', 'Everything you need'].every((t) => ti.includes(t)))
const ci = coverHeadlineInstruction()
expect('cover prompt asks 3 to 6 words, 36 chars', ci.includes('3 to 6 words') && ci.includes('36 characters') && ci.includes('cover_headline'))
expect('cover prompt bans trailing prepositions', ci.includes('never ending on'))

// ---- Prompt content: captions ----
const link = 'https://travelfunbiz.ca/blog/rhine-river-cruise?utm_source=instagram'
const prompt = buildCaptionPrompt('Rhine River Cruise', 'A plain guide.', 'https://travelfunbiz.ca/blog/rhine-river-cruise', ['instagram', 'linkedin'], { links: { instagram: link } })
expect('caption prompt: hook line first, 90 chars, no emoji', prompt.includes('Line 1 is the hook') && prompt.includes('90 characters') && prompt.includes('no emoji on it'))
expect('caption prompt: at most 2 emojis', prompt.includes('At most 2 emojis'))
expect('caption prompt: grade 6', prompt.includes('grade 6'))
expect('caption prompt: no unsupported superlatives', prompt.includes('superlatives'))
expect('caption prompt: no invented numbers', prompt.includes('No number that is not in the title, summary or facts'))
expect('caption prompt: link in bio', prompt.includes('link in bio'))
expect('caption prompt: instagram 5 to 8 hashtags', HASHTAG_RULES.instagram.startsWith('5 to 8') && prompt.includes('5 to 8 relevant hashtags'))
expect('caption prompt: linkedin no hashtags', HASHTAG_RULES.linkedin === 'no hashtags' && prompt.includes('Hashtags: no hashtags'))
expect('caption prompt: weak openers banned', prompt.includes('Discover') && prompt.includes('Everything you need'))
expect('caption prompt: format rules text is in', prompt.includes(captionFormatRules()))
expect('caption prompt keeps the per-network link', prompt.includes(link))

// ---- Prompt content: topics ----
expect('topic prompt text maps winning patterns', ['"X or Y"'.replace('X or Y', 'Cancun or Tulum'), 'Cologne to Basel by river', 'decoded', 'quiz'].every((t) => TOPIC_PATTERN_TEXT.includes(t)))
expect('topic prompt only grounded numbers', TOPIC_PATTERN_TEXT.includes('written in the material above'))

// ---- Caption checks on good and bad samples ----
const base = { title: 'Rhine River Cruise: What First Timers Should Know', summary: 'A plain guide to a Rhine cruise from Cologne to Basel.', network: 'instagram', link, grounding: null as string | null }
const tags = '#RhineCruise #RiverCruise #Cologne #Basel #TravelPlanning #GroupTravel'
const good = `Cologne to Basel by river?\n\nA Rhine cruise is easy to plan.\nPick your pace and your cabin.\nWe explain both in plain words.\n\nFull guide: link in our bio.\n\n${tags}`
expect('good instagram caption passes', captionProblems(good, base).length === 0, captionProblems(good, base).join('; '))
const has = (c: string, text: string, ctx = base) => captionProblems(c, ctx).some((p) => p.includes(text))
expect('weak opener flagged', has(good.replace('Cologne to Basel by river?', 'Discover the Rhine by river'), 'weak opener'))
expect('missing hook line flagged (link first)', has(`${link}\n\nSome plain words about the river trip.`, 'missing hook'))
expect('missing hook line flagged (hashtags first)', has(`${tags}\n\nSome plain words about the river trip.`, 'missing hook'))
expect('emoji in hook flagged', has(good.replace('Cologne to Basel by river?', '\u{1F30A} Cologne to Basel by river?'), 'emoji in the hook'))
expect('three emojis flagged', has(good.replace('plain words', 'plain words \u{1F30A}\u{1F6F3}\u{2600}\u{FE0F}'), 'too many emojis'))
expect('two emojis allowed', !has(good.replace('plain words', 'plain words \u{1F30A}\u{1F6F3}'), 'emojis'))
expect('hashtag spam flagged', has(`${good} #a #b #c #d #e #f`, 'hashtag spam'))
expect('ten hashtags allowed', !has(good + ' #a #b #c #d', 'hashtag spam'))
expect('all caps line flagged', has(good.replace('Pick your pace and your cabin.', 'PICK YOUR PACE AND YOUR CABIN'), 'all capitals'))
expect('caps hashtags are not shouting', !has(good.replace('#RhineCruise', '#RHINECRUISE'), 'all capitals'))
expect('paragraph wall flagged', has(`Cologne to Basel by river?\nLine two is here.\nLine three is here.\nLine four is here.\n\nFull guide: link in our bio.`, 'paragraph wall'))
expect('three lines in a row allowed', !has(`Cologne to Basel by river?\nLine two is here.\nLine three is here.\n\nFull guide: link in our bio.`, 'paragraph wall'))
expect('one very long line is a wall', has(`Cologne to Basel by river?\n\n${'word '.repeat(80)}\n\nFull guide: link in our bio.`, 'paragraph wall'))
expect('shape helper empty for a fine caption', captionShapeProblems(good, 'instagram').length === 0)
expect('countEmojis counts', countEmojis('a \u{1F30A} b \u{1F6F3}') === 2 && countEmojis('none') === 0)
expect('number guard still works', has(good.replace('plain words', '14 plain words'), 'number not in the post'))
expect('em dash guard still works', has(good.replace('easy', `easy ${String.fromCharCode(8212)}`), 'em dash'))

// A LinkedIn caption has a real link and no hashtags
const li = { ...base, network: 'linkedin' }
const liGood = `Cancun or Tulum?\n\nThe Rhine cruise guide compares the options.\nIt keeps the words plain.\n\nRead the full guide:\n${link}`
expect('good linkedin caption passes', captionProblems(liGood, li).length === 0, captionProblems(liGood, li).join('; '))

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
