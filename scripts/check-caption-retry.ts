// Offline checks for the caption retry loop and the per-network hashtag ceilings. No network, no database, no model.
// Run: corepack pnpm dlx tsx scripts/check-caption-retry.ts   (exits 1 on any failed expectation)
import { generatePlatformCaptions, buildCaptionRetryPrompt, captionProblems, finalizeCaption, buildVideoCaption, buildFallbackCaption, PLATFORM_CHAR_LIMITS, CAPTION_MAX_ATTEMPTS } from '../lib/social-captions'
import { hashtagMaxFor, countHashtags, trimHashtagsToMax, hashtagCapFor, HASHTAG_MAX } from '../lib/hook-styles'
import { parseCaptionLog, appendCaptionLog } from '../lib/caption-plan'

let failures = 0
function expect(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`)
  if (!ok) failures++
}

const EM = String.fromCharCode(8212)
const title = 'Rhine River Cruise: What First Timers Should Know'
const summary = 'A plain guide to a 7 day Rhine cruise for first timers.'
const link = 'https://travelfunbiz.ca/blog/rhine?utm_source=facebook&utm_medium=social'
const base = { title, summary, link }

;(async () => {
  // ---- hashtag ceilings ----
  expect('every platform with a character limit has a hashtag ceiling', Object.keys(PLATFORM_CHAR_LIMITS).every((n) => n in HASHTAG_MAX))
  expect('linkedin ceiling is 0, x and bluesky 2, tiktok 3', hashtagMaxFor('linkedin') === 0 && hashtagMaxFor('x') === 2 && hashtagMaxFor('bluesky') === 2 && hashtagMaxFor('tiktok') === 3)
  expect('no-AI fallback cap never exceeds the ceiling', Object.keys(HASHTAG_MAX).every((n) => hashtagCapFor(n) <= hashtagMaxFor(n)))
  const liFallback = buildFallbackCaption({ title, metaDescription: summary, faqQuestions: ['Is a Rhine cruise right for a first big trip?'], tags: ['rhine', 'europe'] }, 'linkedin', link)
  expect('linkedin fallback caption carries no hashtag', !!liFallback && countHashtags(liFallback) === 0, String(liFallback))

  const tagged = `Cancun or Tulum?\n\nA plain guide for first timers.\n\nRead the full guide:\n${link}\n\n#a #b #c #d`
  expect('gate flags too many hashtags on x', captionProblems(tagged, { ...base, network: 'x' }).some((p) => p.startsWith('too many hashtags for x')))
  expect('gate flags any hashtag on linkedin', captionProblems(tagged, { ...base, network: 'linkedin' }).some((p) => p.startsWith('too many hashtags for linkedin')))
  expect('gate accepts hashtags within the ceiling on instagram', !captionProblems(tagged.replace('#c #d', ''), { ...base, network: 'instagram' }).some((p) => p.includes('hashtags')))
  expect('trimHashtagsToMax cuts from the end and is idempotent', trimHashtagsToMax('Hi\n\n#a #b #c #d', 2) === 'Hi\n\n#a #b' && trimHashtagsToMax('Hi\n\n#a #b', 2) === 'Hi\n\n#a #b')
  expect('trimHashtagsToMax to 0 removes the tag line', !trimHashtagsToMax('Hi\n\n#a #b', 0).includes('#'))
  const fin = finalizeCaption(tagged, 'x', { ...base })
  expect('finalizeCaption repairs extra hashtags instead of rejecting', countHashtags(fin.draft) <= 2 && !fin.problems.some((p) => p.includes('hashtags')), fin.problems.join('; '))
  expect('reel caption keeps at most 3 hashtags', countHashtags(buildVideoCaption({ title: 'Rhine in a minute', hashtags: ['#a', '#b', '#c', '#d', '#e'] }, link, 2200)) <= 3)

  // ---- retry loop ----
  const good = `Rhine or Danube?\n\nA plain look at a 7 day sailing for first timers.\n\nRead the full guide:\n${link}`
  const weak = `Discover the Rhine ${EM} 12 stops\n\nRead the full guide:\n${link}`
  const prompts: string[] = []
  const dropped: Record<string, string[]> = {}
  const out = await generatePlatformCaptions(title, summary, link, ['facebook', 'threads'], {
    dropped,
    caller: async (prompt): Promise<Record<string, string>> => {
      prompts.push(prompt)
      return prompts.length === 1 ? { facebook: good, threads: weak } : { threads: good }
    },
  })
  expect('first answer has one rejected network, so exactly one retry is made', prompts.length === 2, String(prompts.length))
  expect('retry prompt names only the rejected network and gives the reason', prompts[1]?.includes('- threads: your draft was rejected because') && !prompts[1].includes('- facebook: under') && /weak opener/.test(prompts[1] ?? ''))
  expect('retry prompt repeats the honesty rules (no invented numbers, no urgency)', /do not add a number/.test(prompts[1] ?? '') && /no urgency/.test(prompts[1] ?? ''))
  expect('the retried caption is used', out?.threads === good && out?.facebook === good)
  expect('nothing left over to report', Object.keys(dropped).length === 0)

  // still rejected after the retry: dropped, reason reported, attempts bounded
  let calls = 0
  const stuck = `Discover the Rhine\n\nRead the full guide:\n${link}`
  const dropped2: Record<string, string[]> = {}
  const out2 = await generatePlatformCaptions(title, summary, link, ['facebook', 'threads'], {
    dropped: dropped2,
    caller: async () => {
      calls++
      return { facebook: good, threads: stuck }
    },
  })
  expect(`attempts are bounded at ${CAPTION_MAX_ATTEMPTS}`, calls === CAPTION_MAX_ATTEMPTS, String(calls))
  expect('a network still rejected is left out (falls back to the no-AI caption)', out2?.facebook === good && out2?.threads === undefined)
  expect('its reason is reported', (dropped2.threads ?? []).some((p) => p.includes('weak opener')), JSON.stringify(dropped2))

  // honesty gates are not weakened by the retry: an invented number and an urgent claim-free fix still has to pass
  const invented = `Rhine or Danube?\n\n99 percent of guests rebook.\n\nRead the full guide:\n${link}`
  let n3 = 0
  const dropped3: Record<string, string[]> = {}
  const out3 = await generatePlatformCaptions(title, summary, link, ['facebook'], { dropped: dropped3, caller: async () => (n3++, { facebook: invented }) })
  expect('an invented number is never accepted, even on the retry', out3 === null && (dropped3.facebook ?? []).some((p) => p.startsWith('number not in the post')), JSON.stringify(dropped3))
  const dashed = await generatePlatformCaptions(title, summary, link, ['facebook'], { caller: async () => ({ facebook: good.replace('plain look', `plain ${EM} look`) }) })
  expect('an em dash is repaired, never sent', !!dashed && !dashed.facebook.includes(EM))

  // a model call that fails or returns nothing stops the loop without throwing
  let n4 = 0
  const out4 = await generatePlatformCaptions(title, summary, link, ['facebook'], { caller: async () => (n4++, null) })
  expect('a failed model call returns null after one try', out4 === null && n4 === 1)

  // retry prompt builder is pure and lists every rejected network
  const rp = buildCaptionRetryPrompt(title, summary, link, { x: { draft: 'Draft one', problems: ['over the 280 character limit (300)'] } })
  expect('retry prompt carries the draft and the exact reason', rp.includes('| Draft one') && rp.includes('over the 280 character limit (300)'))

  // caption log keeps the drop reason
  const logged = parseCaptionLog(appendCaptionLog(null, [{ slug: 's', network: 'x', text: 't', note: 'weak opener "discover"' }]))
  expect('caption log stores the drop reason as a note', logged[0]?.note === 'weak opener "discover"')

  if (failures) {
    console.error(`\n${failures} check(s) failed`)
    process.exit(1)
  }
  console.log('\nAll caption retry checks passed')
})()
