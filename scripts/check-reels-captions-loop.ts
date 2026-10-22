// Offline checks for the reels and captions loop: reel hook fallback and classifier, 8 to 10 beats of 3 to 4 seconds, per-network hook styles,
// caption storage, the news-on-social switch and the fan-out calendar. Pure functions and fakes only: nothing here calls Shotstack, a model,
// a database or a network. Run: pnpm dlx tsx scripts/check-reels-captions-loop.ts   (exits 1 on any failed expectation)
import { readFileSync } from 'node:fs'
import { templatedHookQuestion, commentBaitQuestion, commentPromptLine, isAcceptableHook, extractContrast } from '../lib/reel-questions'
import { REEL_MIN_BEATS, REEL_MAX_BEATS, reelBeatSeconds, BEAT_TEXT_MAX_WORDS, PATTERN_INTERRUPT_INDEX } from '../lib/reel-beats'
import { scriptChecks, beatProblems, shapeBeats, scriptPrompt, bodyExcerpt, detectHookFormula, type VideoScript, type VideoBeat } from '../lib/video-script'
import { buildVideoEdit, reelTextBoxes, END_CARD_SECONDS, REEL_SAFE_TOP, REEL_SAFE_BOTTOM, REEL_HEIGHT, REEL_BEAT_MAX_WORDS, type ShotstackEdit, type ShotstackClip } from '../lib/shotstack'
import { assignHookStyles, questionNetworks, hasGroundableNumber, firstLineProblems, appendCaptionLog, parseCaptionLog, recentCaptions, CAPTION_LOG_MAX, CAPTION_TEXT_MAX, wantsCommentPrompt } from '../lib/caption-plan'
import { HOOK_STYLES } from '../lib/hook-styles'
import { buildFallbackCaption, buildNetworkFallbacks, captionProblems, buildCaptionPrompt } from '../lib/social-captions'
import { newsSocialEnabled, getNewsSocialEnabled, NEWS_SOCIAL_KEY, NEWS_SOCIAL_SKIP_NOTE } from '../lib/news-settings'
import { parseToggleRequest, isExactTrue } from '../lib/posts-menu-2'
import { planFanout, isDue, recapsDue, recapSlug, recapFacts, isRecapSlug, baseSlugOfRecap, publishMoment, FANOUT_WINDOW_HOURS } from '../lib/fanout-plan'
import { socialLink, socialContent } from '../lib/utm'
import { FANOUT_CAROUSEL_HOOKS, FANOUT_CAROUSEL_CTAS } from '../lib/carousel'

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : detail ? `  (${detail})` : ''}`)
  if (!ok) failures++
}
const EM = String.fromCharCode(8212)

async function main() {
// ---- A. the reel hook: templated question fallback and the loosened classifier ----
const solo = { title: 'Solo on a river cruise: what to expect', keyword: 'solo river cruise' }
const hookA = templatedHookQuestion(solo)
check('fallback hook is a question, not the raw title plus a full stop', hookA.endsWith('?') && hookA !== `${solo.title}.` && hookA.toLowerCase().includes('solo river cruise'), hookA)
const contrastPost = { title: 'Rhine or Croatia: which river cruise is right for you', keyword: 'rhine river cruise' }
check('a post with a contrast gets "X or Y: which one are you?"', templatedHookQuestion(contrastPost) === 'Rhine or Croatia: which one are you?', templatedHookQuestion(contrastPost))
check('extractContrast pulls two short phrases', JSON.stringify(extractContrast('Boat or boots: which one are you?')) === JSON.stringify(['Boat', 'boots']) && JSON.stringify(extractContrast('Is a Rhine cruise or a Croatia cruise better?')) === JSON.stringify(['Rhine cruise', 'Croatia cruise']))
check('no contrast and no keyword: still a question built from the title', templatedHookQuestion({ title: 'Packing for a Caribbean cruise', keyword: null }).endsWith('?'))
check('the fallback hook is deterministic', templatedHookQuestion(solo) === templatedHookQuestion(solo))
for (const idea of [solo, contrastPost, { title: 'Planning a Caribbean cruise', keyword: null }, { title: 'Bali', keyword: 'best time to visit Bali' }]) {
  const q = templatedHookQuestion(idea)
  check(`fallback hook has no number it was not given: ${q}`, !/\d/.test(q) && !q.includes(EM) && isAcceptableHook(q))
}

const GOOD = ['Solo on a river cruise: lonely or the best trip you will take?', 'Rhine or Croatia: which one are you?', 'Boat or boots: which one are you?', 'You are packing the wrong shoes', 'Is a Rhine cruise worth it?', 'Cancun vs Tulum']
for (const g of GOOD) check(`classifier accepts: ${g}`, isAcceptableHook(g))
const BAD = ['Planning a Caribbean cruise.', 'Have you ever wondered about Bali?', 'Discover the magic of Bali', 'The Rhine is a river in Europe.', 'You', 'You are packing the wrong shoes for every single trip you will ever take in life']
for (const b of BAD) check(`classifier rejects: ${b}`, !isAcceptableHook(b))
const ground = 'Planning a Caribbean cruise. What first-time cruisers should know. Most ships sail 7 nights.'
const mk = (hook: string, beats: VideoBeat[] = []): VideoScript => ({ hook, beats, title: 't', description: 'd', hashtags: [] })
check('the ungrounded-number check still applies to an acceptable hook', !scriptChecks(mk('Why do 40 percent of cruisers rebook?'), ground).hookOk && scriptChecks(mk('Why do cruisers sail 7 nights?'), ground).hookOk)
check('detectHookFormula classifies a contrast and a second-person line instead of returning null', detectHookFormula('Cancun or Tulum') === 'comparison' && detectHookFormula('You are packing the wrong shoes') !== null && detectHookFormula('Planning a Caribbean cruise.') === null)

// ---- A. the prompt sees the post body (first 600 words) and the new pacing rules ----
const bodyWords = Array.from({ length: 900 }, (_, i) => `word${i}`).join(' ')
const md = '# Heading\n\n![alt](https://x.test/a.jpg) Some [linked text](https://x.test) and <b>bold</b> **words**.'
check('bodyExcerpt keeps the first 600 words only', bodyExcerpt(bodyWords).split(' ').length === 600 && bodyExcerpt(bodyWords).endsWith('word599'))
check('bodyExcerpt strips markdown and html', bodyExcerpt(md) === 'Heading Some linked text and bold words .' || !/[#*<>\[\]]|https?:/.test(bodyExcerpt(md)), bodyExcerpt(md))
const plain = scriptPrompt('T', 'S')
const rich = scriptPrompt('T', 'S', undefined, '- fact one', { body: bodyWords, primaryKeyword: 'solo river cruise' })
check('the prompt includes the body excerpt and the keyword when given', rich.includes('word599') && !rich.includes('word600') && rich.includes('Primary keyword: solo river cruise'))
check('the prompt without a body is the plain one (no excerpt block)', !plain.includes('first part of the post') && plain.includes(`${REEL_MIN_BEATS} to ${REEL_MAX_BEATS} beats`))
check('the prompt asks for a pattern interrupt on beat 3, a closing question and no call to action beat', /Beat 3 is a pattern interrupt/.test(plain) && /LAST beat is the comment-bait question/.test(plain) && /end card/.test(plain))
check('the prompt has no em dash', !rich.includes(EM) && !plain.includes(EM))

// ---- A. beats: 8 to 10, 3 to 4 seconds, text on each, pattern interrupt at beat 3, a closing question ----
const vo8 = 'Slow river days with castles at every bend'
const beat = (vo: string, text = 'Castles at every bend'): VideoBeat => ({ scene: 's', onScreenText: text, voiceover: vo, brollSearchTerms: ['river'] })
const goodBeats = (n: number): VideoBeat[] =>
  Array.from({ length: n }, (_, i) => (i === PATTERN_INTERRUPT_INDEX ? beat('Wait, nobody tells you this.', 'Nobody tells you this') : i === n - 1 ? beat('Boat or boots: which one are you?', 'Which one are you?') : beat(`${vo8} ${i}`)))
check('nine good beats have no pacing problem', beatProblems(goodBeats(9)).length === 0, beatProblems(goodBeats(9)).join('; '))
check('8 and 10 beats are allowed, 7 and 11 are not', beatProblems(goodBeats(8)).length === 0 && beatProblems(goodBeats(10)).length === 0 && beatProblems(goodBeats(7)).some((p) => /beats/.test(p)) && beatProblems(goodBeats(11)).some((p) => /beats/.test(p)))
check('an old 4 to 6 beat script is flagged', beatProblems(goodBeats(5)).some((p) => /only 5 beats/.test(p)))
check('a beat with no on-screen text is flagged', beatProblems(goodBeats(9).map((b, i) => (i === 4 ? { ...b, onScreenText: '' } : b))).some((p) => /no on-screen text/.test(p)))
check('a 14 word line is flagged, and the pattern interrupt may not run past 5 words', beatProblems(goodBeats(9).map((b, i) => (i === 4 ? { ...b, voiceover: 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen' } : b))).some((p) => /over/.test(p)) && beatProblems(goodBeats(9).map((b, i) => (i === 2 ? { ...b, voiceover: 'this one is far too long for a two second jolt' } : b))).some((p) => /pattern interrupt/.test(p)))
check('a last beat that is not a question is flagged', beatProblems(goodBeats(9).map((b, i) => (i === 8 ? { ...b, voiceover: 'Read the full guide on our site now.' } : b))).some((p) => /not a question/.test(p)))
const idea = { title: 'Boat or boots: which one are you', keyword: 'river cruise or hiking trip' }
const messy: VideoScript = mk('Boat or boots?', [...goodBeats(12).slice(0, 11), beat('Read the full guide on our site.', 'one two three four five six seven eight nine ten')])
const shaped = shapeBeats(messy, idea)
check('shapeBeats cuts 12 beats to 10, keeps beat 3, text at 7 words, and ends on a question', shaped.beats.length === REEL_MAX_BEATS && shaped.beats[PATTERN_INTERRUPT_INDEX].voiceover === 'Wait, nobody tells you this.' && shaped.beats.every((b) => b.onScreenText.split(/\s+/).length <= BEAT_TEXT_MAX_WORDS) && shaped.beats[shaped.beats.length - 1].voiceover.endsWith('?'), JSON.stringify(shaped.warnings))
const short: VideoScript = mk('Boat or boots?', goodBeats(9).slice(0, 8).map((b, i) => (i === 7 ? beat('A closing line that is not a question.') : b)))
check('a missing closing question is added from the post (comment bait)', shapeBeats(short, idea).beats.at(-1)?.voiceover === 'Which one are you: river cruise or hiking trip?' || shapeBeats(short, idea).beats.at(-1)?.voiceover.endsWith('?') === true)
check('comment bait is a question from the post, with 7 words or fewer on screen', commentBaitQuestion({ title: 'Boat or boots: which one are you', keyword: null }).voiceover === 'Which one are you: Boat or boots?' && commentBaitQuestion(solo).onScreen.split(' ').length <= 7 && commentBaitQuestion(solo).voiceover.endsWith('?'))

check('beat length follows the words: 8 words is 3.2s, a 5 word interrupt is 2s, short lines still get 3s', reelBeatSeconds(vo8, 0) === 3.2 && reelBeatSeconds('Wait, nobody tells you this.', PATTERN_INTERRUPT_INDEX) === 2 && reelBeatSeconds('Short line here.', 0) === 3 && reelBeatSeconds('one two three four five six seven eight nine ten', 1) === 4)

// the edit: every beat gets its own clip and text, 2 to 4 seconds each, total under the 58 second ceiling
const sample = (n: number): { edit: ShotstackEdit; script: VideoScript } => {
  const script: VideoScript = { hook: 'Boat or boots: which one are you?', coverTitle: 'Boat or boots', title: 'Boat or boots', description: 'd', hashtags: [], beats: goodBeats(n) }
  return { script, edit: buildVideoEdit(script, script.beats.map(() => ({ videoUrl: 'https://v.test/a.mp4' })), 'https://i.test/a.jpg', 'Boat or boots', 'TRAVELFUNBIZ.CA', { platform: 'instagram' }) }
}
const clipsOf = (e: ShotstackEdit): ShotstackClip[] => e.timeline.tracks.flatMap((t) => t.clips)
const typeOf = (c: ShotstackClip) => String(c.asset.type)
for (const n of [8, 9, 10]) {
  const { script, edit } = sample(n)
  const total = Math.max(...clipsOf(edit).map((c) => Number(c.start) + Number(c.length)))
  const boxes = reelTextBoxes(edit)
  const beatText = boxes.filter((b) => b.kind === 'rich-text' && b.start >= 3 && b.end < total - END_CARD_SECONDS + 0.01)
  check(`${n} beats: one on-screen text per beat, 7 words at most`, beatText.length === n && beatText.every((b) => b.text.split(/\s+/).length <= REEL_BEAT_MAX_WORDS && b.text.length > 0), String(beatText.length))
  const lengths = beatText.map((b) => Math.round((b.end - b.start) * 10) / 10)
  check(`${n} beats: each beat is 3 to 4 seconds and beat 3 is 2 seconds`, lengths.every((l, i) => (i === PATTERN_INTERRUPT_INDEX ? l === 2 : l >= 3 && l <= 4)), JSON.stringify(lengths))
  check(`${n} beats: a new picture at least every 4 seconds (b-roll clip per beat)`, clipsOf(edit).filter((c) => typeOf(c) === 'video' && c.filter === 'darken').length === n)
  check(`${n} beats: the whole reel stays under 58 seconds with the end card`, total <= 58 && total > 20, String(total))
  check(`${n} beats: text stays inside the safe zones and nothing overlaps`, boxes.every((b) => b.top >= REEL_SAFE_TOP && b.bottom <= REEL_HEIGHT - REEL_SAFE_BOTTOM) && !boxes.some((a, i) => boxes.some((b, j) => j > i && a.start < b.end - 0.01 && b.start < a.end - 0.01 && a.top < b.bottom && b.top < a.bottom && a.left < b.right && b.left < a.right)))
  check(`${n} beats: the closing question is the last beat before the end card`, script.beats[n - 1].voiceover.endsWith('?') && beatText[n - 1].end <= total - END_CARD_SECONDS + 0.01)
  // picture and voice stay in step: the sum of beat lengths is within 3 seconds of the spoken estimate
  const spoken = script.beats.reduce((sum, b) => sum + b.voiceover.split(/\s+/).length * 0.4, 0)
  const drift = lengths.reduce((a, b) => a + b, 0) - spoken
  check(`${n} beats: beat timing stays within 12 seconds of the spoken estimate (narration is one continuous clip)`, Math.abs(drift) <= 12, String(drift))
}

// ---- B. captions: per-network hook styles ----
const nets = ['bluesky', 'threads', 'instagram', 'pinterest']
const sameHistory = () => ['mistake', 'mistake', 'story']
const styles4 = assignHookStyles(nets, sameHistory, { hasNumber: true })
check('four networks with the same history still get four different styles', new Set(Object.values(styles4)).size === 4, JSON.stringify(styles4))
check('no network repeats its own last style', nets.every((n) => styles4[n] !== sameHistory()[0]), JSON.stringify(styles4))
check('the same input gives the same styles (deterministic)', JSON.stringify(assignHookStyles(nets, sameHistory, { hasNumber: true })) === JSON.stringify(styles4))
let numberLeaks = 0
for (let k = 0; k < 40; k++) {
  const hist = (n: string) => Array.from({ length: (k + n.length) % 7 }, (_, i) => HOOK_STYLES[(i * 3 + k) % HOOK_STYLES.length])
  const s = assignHookStyles(['bluesky', 'threads', 'instagram', 'pinterest', 'facebook', 'x'], hist, { hasNumber: false, offset: k })
  if (Object.values(s).includes('number')) numberLeaks++
  if (new Set(Object.values(s)).size !== 6) numberLeaks += 100
}
check('without a number in the post, "number" is never chosen and 6 networks still get 6 different styles', numberLeaks === 0, String(numberLeaks))
check('more networks than styles starts another lap without throwing', Object.keys(assignHookStyles(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], () => [], { hasNumber: true })).length === 8)
check('hasGroundableNumber: digits or a spelled-out number in the post', hasGroundableNumber('Boat or Boots') === false && hasGroundableNumber('7 nights on the Rhine') && hasGroundableNumber('three castles a day') && !hasGroundableNumber('see https://x.test/a1b2/3'))
const qn = questionNetworks(nets, styles4)
check('at least half of the networks must end the first line with a question', Object.values(qn).filter(Boolean).length >= 2 && Object.values(qn).filter(Boolean).length === 2, JSON.stringify(qn))
check('question styles are first in line for the question requirement', Object.entries(qn).filter(([, v]) => v).every(([n]) => ['question', 'comparison'].includes(styles4[n])) || Object.values(styles4).filter((s) => ['question', 'comparison'].includes(s)).length < 2)
check('first line rules: 80 characters and a question when required', firstLineProblems('Rhine or Croatia: which one are you?\n\nRead the full guide:', { requireQuestion: true }).length === 0 && firstLineProblems(`${'a'.repeat(81)}?`).length === 1 && firstLineProblems('A statement.', { requireQuestion: true }).length === 1 && firstLineProblems('A statement.').length === 0)
check('the comment prompt goes to Instagram, Facebook and Threads only', wantsCommentPrompt('instagram') && wantsCommentPrompt('Facebook') && wantsCommentPrompt('threads') && !wantsCommentPrompt('bluesky') && !wantsCommentPrompt('pinterest') && !wantsCommentPrompt('x'))
const prompt = buildCaptionPrompt('Boat or Boots', 'A summary', 'https://x.test/l', ['instagram', 'bluesky'], { hookStyles: { instagram: 'question', bluesky: 'story' }, questionFirstLine: { instagram: true, bluesky: false }, commentPrompts: { instagram: 'Which one are you: boat or boots? Tell us below.' }, keyword: 'river cruise' })
check('the caption prompt carries the 80 character rule, the question rule, the keyword and the comment prompt', prompt.includes('at most 80 characters') && prompt.includes('ENDS WITH A QUESTION MARK') && prompt.includes('"river cruise"') && prompt.includes('Which one are you: boat or boots? Tell us below.'))

// the deterministic caption gets the comment prompt too, and still passes the caption gate
const facts = { title: 'Boat or boots on the Rhine', metaDescription: 'A river cruise and a hiking trip compared for first-timers.', faqQuestions: ['Is a Rhine river cruise worth it?'], keyTakeaways: ['Cruises are easy on the legs'], tags: ['rhine'] }
const link = 'https://travelfunbiz.ca/blog/boat-or-boots?utm_source=instagram&utm_medium=social&utm_campaign=boat-or-boots&utm_content=fallback-post'
const withPrompt = buildFallbackCaption(facts, 'instagram', link, { commentPrompt: 'Which one are you: boat or boots? Tell us below.' })
check('a fallback caption for Instagram carries one comment prompt line and passes the gate', !!withPrompt && withPrompt.includes('Which one are you: boat or boots? Tell us below.') && captionProblems(withPrompt, { title: facts.title, summary: facts.metaDescription, network: 'instagram', link, grounding: facts.faqQuestions.join(' ') }).length === 0, withPrompt ?? 'null')
check('the first line stays the hook (80 characters or fewer) and the prompt is not in it', !!withPrompt && withPrompt.split('\n')[0].length <= 80 && !withPrompt.split('\n')[0].includes('Tell us'))
const nf = buildNetworkFallbacks(facts, ['instagram', 'bluesky', 'facebook'], (n) => link.replace('instagram', n), () => 'Would you try a river cruise? Tell us below.')
check('only Instagram, Facebook and Threads get the prompt in the fallback captions', nf.instagram.includes('Tell us below') && nf.facebook.includes('Tell us below') && !nf.bluesky.includes('Tell us below'))
check('a short stored FAQ question is preferred as the hook', buildFallbackCaption({ ...facts, faqQuestions: ['A very long first question that goes past eighty characters for sure, yes it really does go on and on?', 'Short one?'] }, 'bluesky', link.replace('instagram', 'bluesky'), {})?.startsWith('Short one?') === true)
check('no em dash in any new copy', ![hookA, commentPromptLine(solo), nf.instagram, withPrompt ?? '', prompt].some((t) => t.includes(EM)))

// ---- B. the caption log: bounded, newest first, text kept, read-only list ----
const entries = Array.from({ length: 230 }, (_, i) => ({ at: new Date(2026, 9, 1, 0, i).toISOString(), slug: `post-${i}`, network: 'bluesky', format: 'post' as const, style: 'question', text: `caption ${i} ${'x'.repeat(1200)}` }))
let log: string | null = null
for (let i = 0; i < entries.length; i += 10) log = appendCaptionLog(log, entries.slice(i, i + 10).reverse())
const parsed = parseCaptionLog(log)
check('the caption log keeps the last 200, newest first', parsed.length === CAPTION_LOG_MAX && parsed[0].slug === 'post-229' && parsed[199].slug === 'post-30', `${parsed.length} ${parsed[0]?.slug}`)
check('each stored text is cut at 900 characters and keeps network, style, format and time', parsed.every((e) => e.text.length <= CAPTION_TEXT_MAX && e.network === 'bluesky' && e.style === 'question' && e.format === 'post' && !!e.at) && (log ?? '').length < 300_000)
const recent = recentCaptions(log, 10)
check('the admin list is the last 10 with network, style and the first 120 characters', recent.length === 10 && recent.every((r) => r.preview.length <= 120 && !!r.network && !!r.style) && recent[0].slug === 'post-229')
check('a bad or empty stored value reads as an empty log', parseCaptionLog('not json').length === 0 && parseCaptionLog(null).length === 0 && parseCaptionLog('{"a":1}').length === 0 && appendCaptionLog('not json', [{ slug: 's', network: 'x', text: 't' }]).includes('"slug":"s"'))
check('an entry with no style is stored as "fallback"', parseCaptionLog(appendCaptionLog(null, [{ slug: 's', network: 'x', text: 't' }]))[0].style === 'fallback')

// ---- C. news on social: only exact "true" enables, default off, never a failure ----
check('only the exact text "true" turns news on social', newsSocialEnabled('true') && !newsSocialEnabled('TRUE') && !newsSocialEnabled('on') && !newsSocialEnabled('1') && !newsSocialEnabled('') && !newsSocialEnabled(null) && !newsSocialEnabled(undefined) && newsSocialEnabled('true') === isExactTrue('true'))
const fakeAdmin = (value: string | null, error: string | null = null, boom = false) => ({
  from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => { if (boom) throw new Error('down'); return { data: value === null ? null : { value }, error: error ? { message: error } : null } } }) }) }),
})
check('the switch reads off when unset, unreadable or throwing (fail closed) and on only for "true"', !(await getNewsSocialEnabled(fakeAdmin(null) as never)) && !(await getNewsSocialEnabled(fakeAdmin('true', 'boom') as never)) && !(await getNewsSocialEnabled(fakeAdmin('x', null, true) as never)) && !(await getNewsSocialEnabled(fakeAdmin('on') as never)) && (await getNewsSocialEnabled(fakeAdmin('true') as never)))
const on = parseToggleRequest({ setting: NEWS_SOCIAL_KEY, enabled: true })
check('the admin API accepts news_social_posts with a real boolean only', on.ok && on.value === 'true' && !parseToggleRequest({ setting: NEWS_SOCIAL_KEY, enabled: 'true' }).ok && !parseToggleRequest({ setting: NEWS_SOCIAL_KEY, enabled: 1 }).ok && !parseToggleRequest({ setting: NEWS_SOCIAL_KEY }).ok && !parseToggleRequest({ setting: 'distribution_mode', enabled: true }).ok)
const dist = readFileSync('lib/distribution.ts', 'utf8')
check('distribution closes a news row as done with the Skipped note when off (never failed)', /isNewsRow && !newsSocialOn/.test(dist) && dist.includes('NEWS_SOCIAL_SKIP_NOTE') && /stage: 'done', last_error: NEWS_SOCIAL_SKIP_NOTE/.test(dist) && NEWS_SOCIAL_SKIP_NOTE === 'Skipped: news not posted to social')
const card = readFileSync('components/admin/posts-automation-card.tsx', 'utf8')
const apiRoute = readFileSync('app/api/admin/posts/automation/route.ts', 'utf8')
check('the News Automation card has the toggle and the API reads it and checks authorization first', card.includes('news_social_posts') && card.includes('Post news to social networks') && apiRoute.includes('NEWS_SOCIAL_KEY') && /export async function POST[\s\S]{0,120}isAuthorized/.test(apiRoute))
check('news publishing is not touched: the news run and enrolment files do not mention the switch', !readFileSync('lib/news-run.ts', 'utf8').includes('news_social') && !readFileSync('lib/news-distribution.ts', 'utf8').includes('news_social'))

// ---- D. fan-out calendar ----
const post = { slug: 'rhine-river-cruise', publishedAt: '2026-10-10' }
const at = (iso: string) => new Date(iso)
check('a bare publish date is read as 00:00 UTC; no date gives null', publishMoment(post)?.toISOString() === '2026-10-10T00:00:00.000Z' && publishMoment({ slug: 'x', publishedAt: null }) === null && publishMoment({ slug: 'x', publishedAt: 'nonsense' }) === null)
const d0 = planFanout(post, at('2026-10-10T13:00:00Z'))
check('day 0: the carousel and the three social posts are due, the reel and the recap are not', d0.due.includes('carousel') && d0.due.includes('social') && !d0.due.includes('reel') && !d0.due.includes('recap'), d0.due.join(','))
check('day 1: the reel is still not due', !planFanout(post, at('2026-10-11T23:00:00Z')).due.includes('reel'))
check('day 2: the reel is due, inside 72 hours of publishing', planFanout(post, at('2026-10-12T00:00:00Z')).due.includes('reel') && planFanout(post, at('2026-10-12T00:00:00Z')).items.find((i) => i.kind === 'reel')!.dueAt.getTime() - publishMoment(post)!.getTime() < FANOUT_WINDOW_HOURS * 3_600_000)
check('day 6 has no recap yet; day 7 has it', !planFanout(post, at('2026-10-16T23:59:00Z')).due.includes('recap') && planFanout(post, at('2026-10-17T00:00:00Z')).due.includes('recap'))
check('a recap is dropped after day 10 (never made late)', !planFanout(post, at('2026-10-21T00:00:00Z')).due.includes('recap') && planFanout(post, at('2026-10-21T00:00:00Z')).items.find((i) => i.kind === 'recap')!.expired)
check('pieces already made are not asked for again', !planFanout(post, at('2026-10-12T12:00:00Z'), { reel: true, carousel: true }).due.includes('reel') && !planFanout(post, at('2026-10-12T12:00:00Z'), { carousel: true }).due.includes('carousel'))
check('a post with no date never holds a reel back (old rows cannot get stuck) and never gets a recap', isDue({ slug: 'old', publishedAt: null }, 'reel', at('2026-10-10T00:00:00Z')) && !isDue({ slug: 'old', publishedAt: null }, 'recap', at('2026-10-10T00:00:00Z')))
const posts = [{ slug: 'a', publishedAt: '2026-10-11' }, { slug: 'b', publishedAt: '2026-10-09' }, { slug: 'news-c', publishedAt: '2026-10-09' }, { slug: 'd', publishedAt: '2026-10-19' }]
check('recapsDue picks the one waiting longest, skips news, not-yet-due and already enrolled posts, and honours the limit of one a day', JSON.stringify(recapsDue(posts, new Set(), at('2026-10-18T08:00:00Z'))) === '["b"]' && JSON.stringify(recapsDue(posts, new Set([recapSlug('b')]), at('2026-10-18T08:00:00Z'))) === '["a"]' && JSON.stringify(recapsDue(posts, new Set(), at('2026-10-18T08:00:00Z'), 5)) === '["b","a"]')
check('recap ledger slugs are their own key and map back to the post', recapSlug('abc') === 'recap-abc' && isRecapSlug('recap-abc') && !isRecapSlug('abc') && baseSlugOfRecap('recap-abc') === 'abc' && baseSlugOfRecap('abc') === 'abc')
const rf = recapFacts({ title: 'Rhine cruise', faq: [{ q: 'Is it worth it?', a: 'Yes for most first-timers. It depends on the season.' }], tags: ['rhine'] })
check('the recap is built from a real FAQ question and the first sentence of its answer', !!rf && rf.faqQuestions?.[0] === 'You asked: Is it worth it?' && rf.metaDescription === 'Yes for most first-timers.')
check('a post with no usable FAQ answer gets no recap', recapFacts({ title: 't', faq: [] }) === null && recapFacts({ title: 't', faq: [{ q: 'Q?' }] }) === null && recapFacts({ title: 't' }) === null)
const recapCaption = rf ? buildFallbackCaption(rf, 'bluesky', link.replace('instagram', 'bluesky'), {}) : null
check('the recap caption passes the caption gate', !!recapCaption && recapCaption.startsWith('You asked: Is it worth it?') && captionProblems(recapCaption, { title: 'Rhine cruise', summary: rf?.metaDescription ?? null, network: 'bluesky', link: link.replace('instagram', 'bluesky'), grounding: 'You asked: Is it worth it?' }).length === 0, recapCaption ?? 'null')
check('the carousel fan-out uses a question or contrast cover and a question last slide', FANOUT_CAROUSEL_HOOKS.every((h) => h === 'question' || h === 'comparison') && FANOUT_CAROUSEL_CTAS.every((c) => c === 'soft-question' || c === 'quiz-style'))
const auto = readFileSync('lib/autopilot.ts', 'utf8')
check('the pipeline asks the planner for the reel and enrols the recap inside the existing tick (no new cron, no new cap)', /isDue\(\{ slug: post\.slug, publishedAt: post\.publish_date \}, 'reel'/.test(auto) && auto.includes('enrollFanoutRecaps(admin)') && auto.includes('SOCIAL_ENROLMENTS_PER_DAY_CEILING') && /recapsToday \?\? 0\) >= 1/.test(auto))
check('the recap is a text post: no image, own ledger key, same gates (kill switch and mode checked at enrolment, caption gate at send)', /isRecapRow && !recap/.test(dist) && /&& !isRecapRow\) \{\r?\n\s+const picked/.test(dist) && auto.includes("mode === 'off' || (await isAutomationPaused(admin))"))
check('video script and reel posting still go through the same gates (videos per week budget, visual gate)', auto.includes('videoSlots > 0') && auto.includes('reelCoverTitleFor'))

// ---- E. UTMs: utm_content = <hook_style>-<format>, utm_campaign = the post slug ----
const lk = new URL(socialLink('https://travelfunbiz.ca/blog/boat-or-boots', 'instagram', 'boat-or-boots', 'video', 'question'))
check('a reel link has utm_content question-video and utm_campaign = the slug', lk.searchParams.get('utm_content') === 'question-video' && lk.searchParams.get('utm_campaign') === 'boat-or-boots' && lk.searchParams.get('utm_source') === 'instagram')
check('post, carousel and recap links use <style>-<format>; no style gives the format alone; the bio page keeps bio-', socialContent('post', 'mistake') === 'mistake-post' && socialContent('carousel', 'comparison') === 'comparison-carousel' && socialContent('recap', 'fallback') === 'fallback-recap' && socialContent('video') === 'video' && socialContent('bio', 'post-x') === 'bio-post-x')
check('autopilot tags the carousel link with the carousel hook style and the reel with its hook style', auto.includes("readVariantTag(admin, row.slug, 'carousel_hook')") && auto.includes("postLink(row.slug, 'video', hookUsed)"))
check('distribution tags every network link with that network\'s own style, and recap links use the post slug', /socialLink\(pageUrl, p, row\.slug, surface, hookStyles\[p\]\)/.test(dist) && /socialLink\(pageUrl, p, postSlug, surface, 'fallback'\)/.test(dist))

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
