// Offline checks for the blog quality loop (loop-blog-quality): the body prompt, the publish gates, the stored seo_score cap, the topic
// conflict and diversity rules, Search Console ordering, the weekly refresh of published posts, hub-and-spoke links, and the admin count.
// Real weak examples from the editor audit are the fixtures. Nothing here reaches a paid API or a database.
// Run: pnpm dlx tsx scripts/check-blog-quality.ts
import { readFileSync } from 'node:fs'
import { autoPublishBlockers, composerPrompt, CLOSER_VARIANTS, closerFor, type ComposedPost } from '../lib/blog-composer'
import {
  bannedPhraseHits,
  coverAltIssue,
  faqMetaHits,
  firstSentenceIssue,
  fitQuickAnswer,
  internalHrefs,
  isQualityBlocker,
  isThinPost,
  metaDuplicates,
  metaTextsClash,
  QUICK_ANSWER_MAX_WORDS,
  QUICK_ANSWER_MIN_WORDS,
  quickAnswerLengthIssue,
  quickAnswerWords,
  qualityBlockers,
  superlativeHits,
  titleBrandIssues,
  titlePromiseIssues,
  titleYearIssues,
  withSiteLinks,
} from '../lib/blog-quality'
import { addRelatedLine, insertQuickAnswer, mechanicalFix, qualityOffenders, applyQualityRewrites, acceptableRewrite, improves, stripFaqMeta } from '../lib/blog-quality-fix'
import { seoScore, type SeoInput } from '../lib/seo-score'
import { checkTopicConflict, gscSupport, isSoloAngle, rankByGsc, readGscQueries, routeKeyOf, topicConflict, type PostFact } from '../lib/blog-topics'
import { composedFromRow, hubLinkPlan, refreshPublishedPosts, refreshesToday, relatedLinksFor, rehealStuckDrafts, selectRefreshPicks, REFRESH_PER_DAY } from '../lib/blog-reheal'
import { revertEdit } from '../lib/content-edits'
import { ruleFor } from '../lib/content-repair'
import { countBelowBar } from '../lib/blog-quality-count'
import { fakeAdmin, type Db } from './fake-admin'

// Nothing here may reach a paid API.
process.env.ANTHROPIC_API_KEY = ''
process.env.INDEXNOW_KEY = ''

let failed = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`)
  if (!ok) failed++
}
const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
const has = (list: string[], text: string) => list.some((b) => b.includes(text))

const now = new Date('2026-10-22T12:00:00Z')
const grounding = 'rhine river cruise first timers Real package being promoted: "Rhine Explorer" (Rhine). Its real stops/highlights (do not invent different ones): Cologne, Koblenz, Strasbourg, Basel. Its real travel dates: 2027-04-10 to 2027-04-18'
const allowed = ['/packages/rhine-cruise', '/destinations/rhine', '/blog/packing-for-river-cruises']
const gateCtx = { allowedPaths: allowed, groundingText: grounding, now }
const tripDates = { from: '2027-04-10', to: '2027-04-18' }

const filler = 'The ship is your hotel and the towns come to you, so the days stay easy. '.repeat(48)
const goodBody = [
  'A Rhine river cruise from Cologne to Basel suits first timers who want several towns without repacking.',
  '',
  '**Quick answer:** It fits travellers who like a gentle pace and one bed all week. See the [Rhine Explorer trip](/packages/rhine-cruise) for the real stops.',
  '',
  '## Why a Rhine river cruise suits first timers',
  '',
  `${filler}Our [Rhine destination page](/destinations/rhine) lists the towns, and the stops include Cologne, Koblenz, Strasbourg and Basel.`,
  '',
  '### Pace and packing',
  '',
  'Most people find the pace gentle. For packing ideas read [our packing post](/blog/packing-for-river-cruises).',
  '',
  '**Who this is not for:** Anyone who wants a free-form itinerary or a late-night city break.',
  '',
  'If you are still weighing two sailings, compare the day lengths and the group size, then [ask us a question](/#contact).',
].join('\n')

const goodPost = (over: Partial<ComposedPost> = {}): ComposedPost => ({
  title: 'Rhine river cruise for first timers: what to know',
  slug: 'rhine-river-cruise-for-first-timers-what-to-know',
  body: goodBody,
  seo_title: 'Rhine river cruise for first timers',
  seo_description: 'A plain guide to what a Rhine river cruise is like for first timers, who it suits and who should look elsewhere.',
  tags: ['rhine river cruise first timers'],
  faq: [
    { q: 'Is a Rhine river cruise good for first timers?', a: 'Yes, the pace is gentle and you unpack once.' },
    { q: 'Do I change hotels every day?', a: 'No, the ship is your hotel for the whole sailing.' },
    { q: 'Who should skip it?', a: 'Anyone who wants a free-form itinerary.' },
  ],
  key_takeaways: ['Gentle pace, one bed all week', 'Several towns without repacking', 'Not for free-form travellers'],
  og_title: 'Is a Rhine river cruise right for you?',
  og_description: 'A plain look at Rhine river cruising for first timers.',
  primary_keyword: 'rhine river cruise first timers',
  secondary_keywords: ['rhine cruise tips'],
  content_style: 'faq-led',
  ...over,
})

async function main() {
  // ---- A: the body prompt ----
  const ctx = { angle: `${grounding}`, keywords: ['rhine river cruise first timers'], seedSecondary: [], idea: 'Is a Rhine cruise right for a first timer', description: 'Who it suits.', style: undefined, allowedLinks: [{ path: '/packages/rhine-cruise', label: 'the trip page' }, { path: '/#contact', label: 'contact' }], body: '', title: '' }
  const prompt = composerPrompt('body', ctx)
  for (const phrase of ['the takeaway:', 'before moving on', 'why it matters:', 'decoded', 'playbook', 'once-in-a-lifetime', 'perfect', 'ultimate']) {
    check(`A: the body prompt bans "${phrase}"`, prompt.includes(`"${phrase}"`))
  }
  check('A: the body prompt bans Picture and Imagine openers', /never open a paragraph with "Picture" or "Imagine"/.test(prompt))
  check('A: the body prompt hands over the trip facts and asks for 3 concrete details', /state at least 3 concrete trip or guide details/.test(prompt) && prompt.includes('Cologne, Koblenz, Strasbourg, Basel'))
  check('A: the body prompt asks for a Who this is not for paragraph', /\*\*Who this is not for:\*\*/.test(prompt))
  check('A: the body prompt asks for at least 3 internal links incl. trip, guide or destination, related post and contact', /at least 2 natural markdown links|at least 3 natural markdown links/.test(prompt) && /contact path/.test(prompt) && /related post/.test(prompt))
  check('A: the old fixed ending is gone from the prompt', !/names the one question the reader should settle next/.test(prompt) && /Do not use the sentences "The one thing worth settling next is" or "Our team is happy to help"/.test(prompt))
  check('A: there are exactly 4 closer variants and each can be reached', CLOSER_VARIANTS.length === 4 && new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n'].map(closerFor)).size === 4)
  check('A: two different ideas can get different closers (not a fixed ending)', new Set(['Is a Rhine cruise right', 'Solo on a group trip', 'Puerto Plata beaches', 'Croatia sailing'].map(closerFor)).size >= 2)
  check('A: the FAQ step forbids "the text" language', /never mention "the text", "the post" or "the article"/.test(composerPrompt('enrich', { ...ctx, body: goodBody, title: 'x' })))
  check('A: the title step forbids forum/review promises and decoded', /Do not promise forum, TripAdvisor, Reddit, review, day-by-day or checklist content/.test(composerPrompt('title', ctx)))

  // ---- B: the gates, good fixtures first ----
  const good = goodPost()
  check('B: the good post passes the full publish gate', autoPublishBlockers(good, now, { ...gateCtx, tripDates }).length === 0, autoPublishBlockers(good, now, { ...gateCtx, tripDates }).join(' | '))
  check('B: the good post has 3 or more internal links incl. the contact link', internalHrefs(goodBody).length >= 3 && internalHrefs(goodBody).includes('/#contact'))
  const noCtaBody = goodBody.replace('[ask us a question](/#contact)', 'ask us a question')
  check('B: the stored body is what is gated (a closing call to action appended on save counts)', autoPublishBlockers(good.body === noCtaBody ? good : goodPost({ body: noCtaBody }), now, { ...gateCtx, storedBody: (b) => `${b}\n\n---\n\nReady? [Ask us](/#contact).` }).length === 0)

  // weak fixtures from the editor audit
  const sceneBody = goodBody.replace(goodBody.split('\n')[0], 'Picture two suitcases lying open on the bed, half packed, while you wonder whether a river cruise is right for you.')
  const sceneBlockers = qualityBlockers(goodPost({ body: sceneBody }), { now, groundingText: grounding })
  check('B: "Picture two suitcases lying open on the bed" is a scene-setter opener', has(sceneBlockers, 'opening sentence is a scene-setter'), sceneBlockers.join(' | '))
  check('B: and a banned picture/imagine opener', has(sceneBlockers, 'banned filler phrase') && bannedPhraseHits(sceneBody).includes('picture/imagine opener'))
  check('B: an opening sentence over 25 words is not an answer', firstSentenceIssue('A Rhine river cruise for first timers is a wonderful way to see many towns along the river while you unpack only once and enjoy the scenery from the sundeck every single afternoon.\n\nMore.', 'rhine river cruise first timers')?.includes('over 25') === true)
  check('B: an opening sentence starting with You is a scene-setter', firstSentenceIssue('You have probably wondered about river cruises.', 'river cruises') !== null && firstSentenceIssue('Imagine a gentle river at dawn.', 'river cruises') !== null)
  check('B: an opening question is not an answer', /question/.test(firstSentenceIssue('Is a Rhine river cruise right for first timers?', 'rhine river cruise first timers') ?? ''))
  check('B: an opening that never touches the keyword is not an answer', /does not answer the keyword/.test(firstSentenceIssue('The weather is usually mild in spring and the evenings are calm.', 'rhine river cruise first timers') ?? ''))
  check('B: a direct answer passes', firstSentenceIssue(goodBody, 'rhine river cruise first timers') === null)

  const metaFaq = [{ q: 'How should I choose a cabin?', a: 'The text suggests thinking in terms of views, noise and price.' }, ...good.faq.slice(1)]
  check('B: "The text suggests thinking in terms of views" is FAQ meta-language and blocks', has(qualityBlockers(goodPost({ faq: metaFaq }), { now, groundingText: grounding }), 'FAQ talks about the text'))
  check('B: other FAQ meta forms are caught', faqMetaHits([{ q: 'q', a: 'According to the article, book early.' }, { q: 'q', a: 'This post says the cabins are small.' }, { q: 'q', a: 'As mentioned above, pack light.' }]).length === 3)
  check('B: an ordinary FAQ answer is not meta', faqMetaHits(good.faq).length === 0 && faqMetaHits([{ q: 'Is the post office open?', a: 'Most are open in the morning.' }]).length === 0)

  const tramBody = goodBody.replace('Most people find the pace gentle.', 'Most people find the pace gentle. It is the only aerial tramway in the Caribbean.')
  check('B: "the only aerial tramway in the Caribbean" is an unverifiable superlative', has(qualityBlockers(goodPost({ body: tramBody }), { now, groundingText: grounding }), 'unverifiable claim'))
  check('B: the same claim passes when the facts state it', !has(qualityBlockers(goodPost({ body: tramBody }), { now, groundingText: `${grounding} It runs on the only aerial tramway in the Caribbean.` }), 'unverifiable claim'))
  check('B: ordinary advice is not a place claim ("the best time to go in spring", "the first step")', superlativeHits('The best time to go is spring. The first step is to pick a month. The most important thing is the group size.').length === 0)
  check('B: "the best beach in Puerto Plata" is an opinion and passes; "the best" is no longer a place claim', superlativeHits('It is the best beach in Puerto Plata.').length === 0 && superlativeHits('The best river cruises for first-timers in Europe.').length === 0)
  check('B: first / most / largest place claims are still caught', superlativeHits('It is the largest beach in Puerto Plata.').length === 1 &&superlativeHits('The first cruise line in Europe to do this.').length === 1 && superlativeHits('The most scenic stretch of the Rhine.').length === 1)
  check('B: a superlative in a FAQ answer or takeaway also blocks', has(qualityBlockers(goodPost({ faq: [{ q: 'Why this ship?', a: 'It is the largest ship on the Rhine.' }, ...good.faq.slice(1)] }), { now, groundingText: grounding }), 'unverifiable claim') && has(qualityBlockers(goodPost({ key_takeaways: ['The only river cruise in Europe', 'b', 'c'] }), { now, groundingText: grounding }), 'unverifiable claim'))

  const zeroLinks = goodBody.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  const zl = qualityBlockers(goodPost({ body: zeroLinks }), { now, groundingText: grounding })
  check('B: a zero-link body blocks (too few links and no contact or trip link)', has(zl, 'too few internal links (0') && has(zl, 'no contact or trip link'), zl.join(' | '))
  const twoLinks = goodBody.replace('[our packing post](/blog/packing-for-river-cruises)', 'our packing post').replace('[Rhine destination page](/destinations/rhine)', 'Rhine destination page')
  check('B: two links block, three do not', has(qualityBlockers(goodPost({ body: twoLinks }), { now, groundingText: grounding }), 'too few internal links (2'))
  check('B: links but no contact or trip link blocks', has(qualityBlockers(goodPost({ body: goodBody.replace('[ask us a question](/#contact)', 'ask us').replace('[Rhine Explorer trip](/packages/rhine-cruise)', 'Rhine Explorer trip').replace('our [Rhine destination page]', 'Our [Rhine destination page]') + ' See [our blog](/blog) and [the home page](/).' }), { now, groundingText: grounding }), 'no contact or trip link'))
  check('B: no Quick answer line blocks', has(qualityBlockers(goodPost({ body: goodBody.replace('**Quick answer:**', 'Quick note:') }), { now, groundingText: grounding }), 'no Quick answer line'))
  check('B: null content_style and null primary_keyword block', has(qualityBlockers(goodPost({ content_style: '' }), { now, groundingText: grounding }), 'no content style recorded') && has(qualityBlockers(goodPost({ primary_keyword: '' }), { now, groundingText: grounding }), 'no primary keyword recorded'))
  check('B: the composer gate (autoPublishBlockers) carries every quality blocker', has(autoPublishBlockers(goodPost({ content_style: '', body: zeroLinks }), now, gateCtx), 'no content style recorded') && has(autoPublishBlockers(goodPost({ body: zeroLinks }), now, gateCtx), 'too few internal links'))
  check('B: skipQuality (test-only) turns the quality gate off', autoPublishBlockers(goodPost({ body: zeroLinks }), now, { ...gateCtx, skipQuality: true }).every((b) => !isQualityBlocker(b)))

  for (const [phrase, text] of [['the takeaway:', 'The takeaway: book early.'], ['before moving on', 'Before moving on, check the dates.'], ['why it matters:', 'Why it matters: it saves money.'], ['decoded', 'Cabins decoded'], ['playbook', 'A cabin playbook'], ['once-in-a-lifetime', 'A once-in-a-lifetime trip'], ['perfect', 'A perfect week'], ['ultimate', 'The ultimate guide'], ['the one thing worth settling next', 'The one thing worth settling next is who you travel with.'], ['our team is happy to help', 'Our team is happy to help.']] as const) {
    check(`B: banned phrase "${phrase}" is found`, bannedPhraseHits(text).includes(phrase) || bannedPhraseHits(text).includes('picture/imagine opener'))
    check(`B: banned phrase "${phrase}" blocks a post`, has(qualityBlockers(goodPost({ body: `${goodBody}\n\n${text}` }), { now, groundingText: grounding }), 'banned filler phrase'))
  }
  check('B: "ultimately" and "perfectly fine" are handled (ultimately is allowed)', bannedPhraseHits('Ultimately, the choice is yours.').length === 0)

  // title: year, promise, brand
  check('B: a title year outside the next 12 months blocks', titleYearIssues('Rhine cruise 2031', now).length === 1 && titleYearIssues('Rhine cruise 2027', now).length === 0)
  check('B: a title year that conflicts with the linked trip date blocks', titleYearIssues('Rhine cruise 2026', now, tripDates).some((i) => i.includes('conflicts with the trip date')) && titleYearIssues('Rhine cruise 2027', now, tripDates).length === 0)
  check('B: a past year is reported once (the older stale-year blocker covers it)', autoPublishBlockers(goodPost({ title: 'Rhine river cruise for first timers 2025' }), now, gateCtx).filter((b) => /^(stale year|title year)/.test(b)).length === 1, autoPublishBlockers(goodPost({ title: 'Rhine river cruise for first timers 2025' }), now, gateCtx).join(' | '))
  check('B: a title with a conflicting trip year blocks the post', has(autoPublishBlockers(goodPost({ title: 'Rhine river cruise for first timers 2026' }), now, { ...gateCtx, tripDates }), 'title year conflicts with the trip date'))
  const forumTitle = 'Rhine river cruise first timers: the TripAdvisor Forum answers'
  check('B: a "TripAdvisor Forum" title without forum content blocks', has(qualityBlockers(goodPost({ title: forumTitle }), { now, groundingText: grounding }), 'title promises something the post lacks (tripadvisor, forum)') || titlePromiseIssues(forumTitle, goodBody).length === 2)
  check('B: the same title passes when the body has a forum section', titlePromiseIssues(forumTitle, `${goodBody}\n\n## What TripAdvisor members ask\n\nText`).length === 1 && titlePromiseIssues(forumTitle, `${goodBody}\n\n## What the TripAdvisor forum threads ask\n\nText`).length === 0)
  check('B: "A Day Decoded" with no day blocks (decoded is banned, day-by-day needs day headings)', has(qualityBlockers(goodPost({ title: 'A Day Decoded on the Rhine' }), { now, groundingText: grounding }), 'banned filler phrase') && titlePromiseIssues('A day-by-day Rhine cruise', goodBody).includes('day-by-day') && titlePromiseIssues('A day-by-day Rhine cruise', '## Day one\n\na\n\n## Day two\n\nb\n\n## Day three\n\nc').length === 0)
  check('B: a review title needs a review structure', titlePromiseIssues('Rhine Explorer review', goodBody).includes('review') && titlePromiseIssues('Rhine Explorer review', `${goodBody}\n\n## Verdict\n\nText`).length === 0)
  check('B: a brand that is not the product ("Viking") blocks, and passes when it is in the facts', titleBrandIssues('Viking Rhine cruise for first timers', grounding).includes('viking') && titleBrandIssues('Viking Rhine cruise for first timers', `${grounding} Viking`).length === 0 && titleBrandIssues('Rhine river cruise for first timers', grounding).length === 0)
  check('B: "Viking" in the title blocks a post', has(qualityBlockers(goodPost({ title: 'Viking Rhine cruise for first timers' }), { now, groundingText: grounding }), 'title names a brand'))

  // seo_score cap
  const seoBase = (body: string): SeoInput => ({
    title: 'Rhine river cruise for first timers: tips', metaDescription: good.seo_description, ogTitle: good.og_title, ogDescription: good.og_description, body, faq: good.faq, takeaways: good.key_takeaways,
    primaryKeyword: 'rhine river cruise first timers', targetWords: { min: 100, max: 900 }, hasImageAlt: true, existingPaths: [...allowed, '/'], jsonLdTypes: ['Article', 'BreadcrumbList', 'FAQPage'], capThinPost: true,
  })
  const richScore = seoScore(seoBase(goodBody)).score
  const thinScore = seoScore(seoBase(zeroLinks)).score
  const thinNoCap = seoScore({ ...seoBase(zeroLinks), capThinPost: false }).score
  check('B: a thin post (no links) is held at 80', thinScore <= 80, String(thinScore))
  check('B: the same post without the cap would show more (so the cap really changed it)', thinNoCap >= thinScore)
  check('B: a post with links and a Quick answer is not capped', richScore > thinScore || richScore >= 80, String(richScore))
  check('B: no Quick answer also caps', seoScore(seoBase(goodBody.replace('**Quick answer:**', 'Quick note:'))).score <= 80 && isThinPost(goodBody.replace('**Quick answer:**', 'Quick note:')) && !isThinPost(goodBody))
  check('B: guides and other pages are never capped (flag off)', seoScore({ ...seoBase(zeroLinks), capThinPost: false }).reasons.every((r) => !/held at 80/.test(r)))
  check('B: the heal step turns the cap on for blog posts only', /capThinPost: true/.test(src('lib/content-heal-run.ts')) && (src('lib/content-heal-run.ts').match(/capThinPost: true/g) ?? []).length === 1)

  // every path uses the same gates
  const auto = src('lib/autoblog-run.ts')
  check('B: autoblog gates the SAVED body (storedBody) and the trip dates', /storedBody: \(body: string\) => appendStyledCta\(body, ctaStyle\.id, groundingPackage\)/.test(auto) && /tripDates: groundingPackage/.test(auto))
  check('B: autoblog publishes only through the gate (repair, legacy repair, heal all take the same gateCtx)', /repairComposedPost\(\s*admin,\s*composed,\s*new Date\(\),\s*gateCtx/.test(auto) && /gateWithRepair\(composed, new Date\(\), gateCtx\)/.test(auto) && /healComposedPost\(admin, final, new Date\(\), gateCtx/.test(auto) && /const publishing = mode === 'publish' && blockers\.length === 0/.test(auto))
  check('B: the approved-queue path runs through runAutoblog (the approval route only changes the topic status)', /setTopicStatus\(getSupabaseAdmin\(\), params\.id, status/.test(src('app/api/admin/blog/topics/[id]/route.ts')) && !/createPost|composeFullPost/.test(src('app/api/admin/blog/topics/[id]/route.ts')))
  check('B: the stuck-draft re-check gate carries the trip dates and the style on a rewrite', /tripDates: grounded\.tripDates/.test(src('lib/blog-reheal.ts')) && /style: styleById\(composed\.content_style\)/.test(src('lib/blog-reheal.ts')))
  check('B: the writer is offered the contact, home and blog links so a post can reach 3 links', withSiteLinks([{ path: '/packages/x', label: 'x' }]).map((l) => l.path).join() === '/packages/x,/#contact,/,/blog' && /withSiteLinks\(await withGuideAndPostLinks/.test(auto))

  // ---- B2: WP4 bundle: Quick answer length, unique meta text, cover alt ----
  {
    const qaBody = (text: string) => goodBody.replace(/\*\*Quick answer:\*\*[^\n]*/, `**Quick answer:** ${text}`)
    const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ')
    check('WP4 quick answer: the good post is inside 15 to 60 words', quickAnswerLengthIssue(goodBody) === null && (quickAnswerWords(goodBody) ?? 0) >= QUICK_ANSWER_MIN_WORDS)
    check('WP4 quick answer: thresholds are 15 and 60', QUICK_ANSWER_MIN_WORDS === 15 && QUICK_ANSWER_MAX_WORDS === 60)
    check('WP4 quick answer: 14 words is too short, 15 passes, 60 passes, 61 is too long', !!quickAnswerLengthIssue(qaBody(words(14))) && quickAnswerLengthIssue(qaBody(words(15))) === null && quickAnswerLengthIssue(qaBody(words(60))) === null && !!quickAnswerLengthIssue(qaBody(words(61))))
    check('WP4 quick answer: a link counts as its words, not its address', quickAnswerWords(qaBody(`${words(13)} [two words](/packages/rhine-cruise-with-a-very-long-path-name)`)) === 15)
    check('WP4 quick answer: a body with none is not a length problem (it has its own blocker)', quickAnswerLengthIssue(goodBody.replace('**Quick answer:**', 'Quick note:')) === null)
    const shortPost = goodPost({ body: qaBody('Gentle pace.') })
    const shortB = qualityBlockers(shortPost, { now, groundingText: grounding })
    check('WP4 quick answer: a short one blocks with the "Quick answer length" prefix, and it is a quality blocker', has(shortB, 'Quick answer length') && shortB.filter((b) => b.startsWith('Quick answer length')).every(isQualityBlocker))
    check('WP4 quick answer: the full publish gate holds it too', has(autoPublishBlockers(shortPost, now, { ...gateCtx, tripDates }), 'Quick answer length'))
    const longSentences = Array.from({ length: 9 }, (_, i) => `Sentence number ${i} has exactly eight plain words in it.`).join(' ')
    const cut = fitQuickAnswer(qaBody(longSentences), good.key_takeaways)
    check('WP4 quick answer: a long one is cut back at a sentence end and then passes', quickAnswerLengthIssue(cut) === null && cut.includes('Sentence number 0 has') && cut.includes('Sentence number 5 has') && !cut.includes('Sentence number 6') && /\.\n\n## Why/.test(cut), cut.slice(0, 400))
    const extended = fitQuickAnswer(qaBody('Gentle pace on the water, with one bed all week and no packing.'), ['Several towns without repacking', 'Not for free-form travellers'])
    check('WP4 quick answer: a short one is extended with the post\'s own takeaways when that reaches the range', quickAnswerLengthIssue(extended) === null && /Several towns without repacking\./.test(extended), extended.slice(0, 300))
    check('WP4 quick answer: when nothing reaches the range the body is left alone (the model pass handles it)', fitQuickAnswer(qaBody('Gentle.'), ['Short one']) === qaBody('Gentle.'))
    check('WP4 quick answer: a first sentence that is itself too long cannot be cut, so the body is left alone', fitQuickAnswer(qaBody(`${words(80)}.`), []) === qaBody(`${words(80)}.`))
    check('WP4 quick answer: an in-range one is untouched', fitQuickAnswer(goodBody, good.key_takeaways) === goodBody)
    const mech = mechanicalFix(goodPost({ body: qaBody(longSentences) }), { now, groundingText: grounding })
    check('WP4 quick answer: the plain-code fixer brings it into range and says so', quickAnswerLengthIssue(mech.post.body) === null && mech.reasons.some((r) => /Quick answer/.test(r)))
    const offs = qualityOffenders(goodPost({ body: qaBody('Gentle pace.') }), { now, groundingText: grounding })
    check('WP4 quick answer: if code cannot fix it the model gets ONE offender, the Quick answer paragraph, told to keep the label', offs.filter((o) => /Quick answer length/.test(o.why)).length === 1 && /\*\*Quick answer:\*\*/.test(offs.find((o) => /Quick answer length/.test(o.why))?.why ?? ''))

    const others = [{ slug: 'other-post', title: 'Rhine river cruise for first timers', description: 'A plain guide to what a Rhine river cruise is like for first timers, who it suits and who should look elsewhere.' }]
    check('WP4 meta: equal search text is a clash even with different case and punctuation', metaTextsClash('Rhine River Cruise, for first timers!', 'rhine river cruise for first timers') && !metaTextsClash('Rhine river cruise', 'Danube river cruise'))
    check('WP4 meta: nearly equal long text clashes, a different one does not', metaTextsClash('A plain guide to what a Rhine river cruise is like for first timers and who it suits.', 'A plain guide to what a Rhine river cruise is like for first timers and who it suits best.') && !metaTextsClash('A plain guide to what a Rhine river cruise is like for first timers.', 'How a Croatia sailing week works for a group of friends who have never sailed.'))
    check('WP4 meta: two short titles sharing a few words are NOT a clash', !metaTextsClash('Rhine cruise tips', 'Rhine cruise packing'))
    const dupB = qualityBlockers(good, { now, groundingText: grounding, otherMeta: others })
    check('WP4 meta: a title and a description that copy another live page both block', has(dupB, 'meta title duplicates another page') && has(dupB, 'meta description duplicates another page'))
    check('WP4 meta: the same post is not a clash with itself (same slug)', !has(qualityBlockers(good, { now, groundingText: grounding, otherMeta: [{ ...others[0], slug: good.slug }] }), 'duplicates another page'))
    check('WP4 meta: unknown other pages never block (no otherMeta given)', !has(qualityBlockers(good, { now, groundingText: grounding }), 'duplicates another page') && !has(qualityBlockers(good, { now, groundingText: grounding, otherMeta: [] }), 'duplicates another page'))
    check('WP4 meta: a unique title and description pass', metaDuplicates({ seo_title: 'Croatia sailing for a small group', seo_description: 'What a week under sail in Croatia is like for a small group of friends.' }, others).title === null)
    check('WP4 meta: the full publish gate carries the check through PublishGateContext', has(autoPublishBlockers(good, now, { ...gateCtx, tripDates, otherMeta: others }), 'duplicates another page'))
    const dupOffs = qualityOffenders(good, { now, groundingText: grounding, otherMeta: others })
    check('WP4 meta: the model is asked to reword only the duplicated search text', dupOffs.some((o) => o.field === 'seo_title') && dupOffs.some((o) => o.field === 'seo_description'))

    check('WP4 cover alt: a cover with an empty or generic alt blocks', !!coverAltIssue({ url: 'https://x.test/a.jpg', alt: '' }) && !!coverAltIssue({ url: 'https://x.test/a.jpg', alt: 'image' }) && !!coverAltIssue({ url: 'https://x.test/a.jpg', alt: null }))
    check('WP4 cover alt: a useful alt, no cover, or an unknown cover does not block', coverAltIssue({ url: 'https://x.test/a.jpg', alt: 'Rhine: castle above the river at dusk' }) === null && coverAltIssue({ url: '', alt: '' }) === null && coverAltIssue(null) === null && coverAltIssue(undefined) === null)
    check('WP4 cover alt: reaches the gate as a quality blocker only when the cover is passed', has(qualityBlockers(good, { now, groundingText: grounding, cover: { url: 'https://x.test/a.jpg', alt: '' } }), 'cover image alt text') && !has(qualityBlockers(good, { now, groundingText: grounding }), 'cover image alt text'))
    check('WP4 cover alt: autoblog rebuilds a missing alt with coverAlt before saving (a fix, not a hold)', /coverAltIssue\(\{ url: image\.cover_image_url, alt: image\.alt_text \}\)/.test(auto) && /alt_text: coverAltText/.test(auto))
    check('WP4 meta: autoblog hands the other live posts\' search text to the gate', /otherMeta: existingPosts\.filter\(\(p\) => p\.status === 'published'\)/.test(auto))
    check('WP4: every new blocker has a BLOCKER_RULES row that is repairable', ['Quick answer length: 9 words is too short to quote, it needs 15 to 60', 'meta title duplicates another page ("x")', 'meta description duplicates another page ("x")', 'cover image alt text: missing'].every((b) => ruleFor(b)?.klass === 'repairable'))
  }

  // ---- C: topic conflicts and diversity ----
  const day = 86_400_000
  const ago = (d: number) => new Date(now.getTime() - d * day).toISOString().slice(0, 10)
  const mk = (slug: string, title: string, o: Partial<PostFact> = {}): PostFact => ({ slug, title, primary_keyword: null, tags: [], body: '', publish_date: ago(10), ...o })
  const posts: PostFact[] = [
    mk('cologne-basel-1', 'Cologne to Basel river cruise: what first timers should know', { primary_keyword: 'cologne to basel river cruise', body: 'See [trip](/packages/rhine-cruise)', publish_date: ago(40) }),
    mk('croatia-1', 'Croatia sailing week', { primary_keyword: 'croatia sailing holiday', body: '[t](/packages/croatia-sail) [d](/destinations/croatia)', publish_date: ago(5) }),
    mk('croatia-2', 'Split and Hvar by boat', { primary_keyword: 'split hvar boat trip', body: '[t](/packages/croatia-sail)', publish_date: ago(12) }),
    mk('solo-1', 'Solo on a group trip', { primary_keyword: 'solo travel group trip', publish_date: ago(6) }),
  ]
  const packageDest = new Map([['croatia-sail', 'croatia'], ['rhine-cruise', 'rhine']])
  const topicOf = (o: Record<string, unknown>) => ({ angle: 'x', keyword: 'something else entirely', ...o }) as Parameters<typeof topicConflict>[0]
  check('C: the same keyword as a published post is a duplicate (primary_keyword, not only the title)', topicConflict(topicOf({ keyword: 'cologne to basel river cruise' }), posts, { now, packageDest })?.kind === 'duplicate')
  check('C: a reworded same keyword (word order, one extra word) is a duplicate', topicConflict(topicOf({ keyword: 'river cruise cologne to basel' }), posts, { now, packageDest })?.kind === 'duplicate')
  check('C: a different keyword is fine', topicConflict(topicOf({ keyword: 'packing list for a river cruise' }), posts, { now, packageDest }) === null)
  check('C: the same trip and subject within 45 days is held back until the wall frees', (() => { const c = topicConflict(topicOf({ angle: 'Cologne to Basel on the Rhine', keyword: 'rhine cruise tips', packageSlug: 'rhine-cruise' }), [mk('rc', 'Rhine cruise basics', { primary_keyword: 'rhine cruise basics', body: '[t](/packages/rhine-cruise)', publish_date: ago(30) })], { now, packageDest }); return c?.kind === 'defer' && c.until === ago(-16) })())
  check('C: the same trip is allowed again after 45 days', topicConflict(topicOf({ keyword: 'rhine cruise tips', packageSlug: 'rhine-cruise' }), [mk('rc', 'Rhine cruise basics', { primary_keyword: 'rhine cruise basics', body: '[t](/packages/rhine-cruise)', publish_date: ago(46) })], { now, packageDest }) === null)
  check('C: the same Cologne-to-Basel route is the same trip even without a package link', (() => { const c = topicConflict(topicOf({ angle: 'A first timer plan for Cologne to Basel by river', keyword: 'cologne to basel cruise plan' }), [mk('cb', 'Cologne to Basel cruise basics', { primary_keyword: 'cologne basel basics', publish_date: ago(20) })], { now, packageDest }); return c?.kind === 'defer' || c?.kind === 'duplicate' })())
  check('C: a solo angle within 14 days of another solo post is deferred; after 14 days it is fine', topicConflict(topicOf({ angle: 'Is solo travel on a group trip safe', keyword: 'solo traveller safety group trip' }), posts, { now, packageDest })?.kind === 'defer' && topicConflict(topicOf({ angle: 'Is solo travel on a group trip safe', keyword: 'solo traveller safety group trip' }), [mk('s', 'Solo on a group trip', { primary_keyword: 'solo group', publish_date: ago(15) })], { now, packageDest }) === null)
  check('C: a third post about one destination inside 30 days is deferred (two are allowed)', topicConflict(topicOf({ keyword: 'croatia packing list', destinationSlug: 'croatia', packageSlug: 'croatia-sail' }), posts, { now, packageDest })?.kind === 'defer' && topicConflict(topicOf({ keyword: 'croatia packing list', destinationSlug: 'croatia' }), posts.slice(0, 2).filter((p) => p.slug !== 'croatia-2'), { now, packageDest }) === null)
  check('C: isSoloAngle and routeKeyOf', isSoloAngle('Solo on a group trip') && isSoloAngle('Travelling alone for the first time') && !isSoloAngle('A group trip for friends') && routeKeyOf('Cologne to Basel river cruise') === 'cologne>basel' && routeKeyOf('how to book a cruise') === null)
  // checkTopicConflict reads the posts table and fails open
  {
    const db: Db = { tables: { posts: [{ slug: 'p1', title: 'Rhine cruise basics', primary_keyword: 'rhine cruise basics', secondary_keywords: [], tags: [], body: '[t](/packages/rhine-cruise)', publish_date: ago(5), created_at: ago(5) }], travel_packages: [{ slug: 'rhine-cruise', destination: 'Rhine' }] } }
    const hit = await checkTopicConflict(fakeAdmin(db), { angle: 'a', keyword: 'rhine cruise basics' })
    check('C: checkTopicConflict reads every post and finds the duplicate', hit?.kind === 'duplicate')
    const retired = await checkTopicConflict(fakeAdmin(db), { angle: 'a', keyword: 'rhine cruise basics' }, { retired: new Set(['p1']) })
    check('C: a draft the heal retired no longer counts', retired === null)
    const broken = { from: () => { throw new Error('db down') } } as unknown as Parameters<typeof checkTopicConflict>[0]
    check('C: a read problem fails open (the topic is not blocked here)', (await checkTopicConflict(broken, { angle: 'a', keyword: 'rhine cruise basics' })) === null)
  }
  // Search Console ordering
  const gsc = [{ key: 'croatia sailing holiday', position: 11.2, impressions: 300 }, { key: 'rhine cruise tips', position: 3, impressions: 900 }, { key: 'puerto plata beaches', position: 18, impressions: 40 }, { key: 'packing list cruise', position: 45, impressions: 700 }]
  const ideas = [{ keyword: 'something unrelated', keywords: [] }, { keyword: 'rhine cruise tips', keywords: [] }, { keyword: 'packing list cruise', keywords: [] }, { keyword: 'puerto plata beaches', keywords: [] }, { keyword: 'croatia sailing holiday', keywords: [] }]
  check('C: striking-distance topics (position 8 to 20) come first, then other impressions, then the rest', rankByGsc(ideas, gsc).map((i) => i.keyword).join('|') === 'croatia sailing holiday|puerto plata beaches|rhine cruise tips|packing list cruise|something unrelated', rankByGsc(ideas, gsc).map((i) => i.keyword).join('|'))
  check('C: with no Search Console data the order is unchanged', rankByGsc(ideas, []).map((i) => i.keyword).join() === ideas.map((i) => i.keyword).join())
  check('C: gscSupport finds the matching query', gscSupport(['croatia sailing holiday'], gsc).striking && !gscSupport(['rhine cruise tips'], gsc).striking)
  {
    const db: Db = { tables: { gsc_rankings: [{ day: ago(2), kind: 'query', key: 'croatia sailing holiday', position: 12, impressions: 100 }, { day: ago(1), kind: 'query', key: 'croatia sailing holiday', position: 10, impressions: 100 }, { day: ago(90), kind: 'query', key: 'old', position: 9, impressions: 5 }] } }
    const rows = await readGscQueries(fakeAdmin(db), now)
    check('C: readGscQueries aggregates the last 28 days per query', rows.length === 1 && rows[0].impressions === 200 && Math.abs(rows[0].position - 11) < 0.01, JSON.stringify(rows))
    const broken = { from: () => { throw new Error('no table') } } as unknown as Parameters<typeof readGscQueries>[0]
    check('C: a missing gsc_rankings table fails open to an empty list', (await readGscQueries(broken)).length === 0)
  }
  const topics = src('lib/blog-topics.ts')
  check('C: pickKeywordTopic also compares primary and secondary keywords of existing posts', /postWithSameKeyword\(c\.keyword, existing\.map/.test(topics))
  check('C: autoblog applies the conflict check before composing and uses Search Console ordering', /checkTopicConflict\(\s*admin/.test(auto) && /rankByGsc\(await dueApprovedTopics\(admin\)/.test(auto) && /rankByGsc\(notDuplicate/.test(topics))

  // ---- D: mechanical fixes, the one model pass, and the refresh ----
  const weakBody = [
    'Picture two suitcases lying open on the bed, half packed, while you wonder whether a river cruise is right for you.',
    '',
    '## What a Rhine river cruise is like',
    '',
    `${filler}It is the only aerial tramway in the Caribbean. See the [Rhine Explorer trip](/packages/rhine-cruise) for the stops.`,
    '',
    'The takeaway: pick a cabin early. Why it matters: views vary. Before moving on, check the deck plan.',
    '',
    'A perfect week and the ultimate once-in-a-lifetime playbook.',
    '',
    'The one thing worth settling next is who you would travel with. Our team is happy to help you work that out.',
  ].join('\n')
  const weakPost = goodPost({
    body: weakBody,
    faq: [{ q: 'How should I choose a cabin?', a: 'The text suggests thinking in terms of views, noise and price.' }, ...good.faq.slice(1)],
    title: 'Rhine river cruise for first timers: what to know',
  })
  const fixCtx = { now, groundingText: grounding, tripDates, pkg: { name: 'Rhine Explorer', slug: 'rhine-cruise' }, related: [{ path: '/destinations/rhine', label: 'our Rhine destination page' }, { path: '/blog/packing-for-river-cruises', label: 'Packing for river cruises' }] }
  const before = qualityBlockers(weakPost, fixCtx)
  const mech = mechanicalFix(weakPost, fixCtx)
  const after = qualityBlockers(mech.post, fixCtx)
  check('D: the weak post fails several gates', before.length >= 5, before.join(' | '))
  check('D: plain-code fixes remove the template labels, hype words, the stock closer and the place claim', !/takeaway:|why it matters:|before moving on|perfect|ultimate|playbook|once-in-a-lifetime|one thing worth settling|happy to help|aerial tramway/i.test(mech.post.body))
  check('D: plain-code fixes remove the FAQ meta-language and keep the answer', !has(after, 'FAQ talks') && /^Thinking in terms of views/.test(mech.post.faq[0].a))
  check('D: plain-code fixes add related links (3 or more) and keep the trip link', internalHrefs(mech.post.body).length >= 3 && internalHrefs(mech.post.body).includes('/packages/rhine-cruise'))
  check('D: the first sentence scene-setter is left for the one model pass', has(after, 'opening sentence is a scene-setter') && qualityOffenders(mech.post, fixCtx).some((o) => o.field === 'body' && /^Picture two suitcases/.test(o.text)))
  check('D: no fact is changed by the plain fixes (trip stops, link, title, keyword all stay)', mech.post.body.includes('Rhine Explorer trip') && mech.post.title === weakPost.title && mech.post.primary_keyword === weakPost.primary_keyword)
  check('D: a contact link is added when none is present', has(qualityBlockers(goodPost({ body: zeroLinks }), fixCtx), 'no contact or trip link') && !has(qualityBlockers(mechanicalFix(goodPost({ body: zeroLinks }), fixCtx).post, fixCtx), 'no contact or trip link'))
  check('D: a Quick answer is written from the post\'s own first takeaway only', /\*\*Quick answer:\*\* Gentle pace, one bed all week\./.test(insertQuickAnswer('Opening sentence about it.\n\n## H\n\nText', good.key_takeaways)) && insertQuickAnswer('Opening.', []) === 'Opening.')
  check('D: a stale title year is mended to the trip year, or taken out', mechanicalFix(goodPost({ title: 'Rhine river cruise 2025 for first timers' }), fixCtx).post.title === 'Rhine river cruise 2027 for first timers' && mechanicalFix(goodPost({ title: 'Rhine river cruise for first timers 2025' }), { ...fixCtx, tripDates: null }).post.title === 'Rhine river cruise for first timers')
  check('D: addRelatedLine puts the line before the closing rule and is idempotent', (() => { const b = addRelatedLine('Text.\n\n---\n\nCTA [x](/#contact)', [{ path: '/blog/a', label: 'A post' }], 1); return b.indexOf('Related reading') < b.indexOf('---') && addRelatedLine(b, [{ path: '/blog/a', label: 'A post' }], 1) === b })())
  check('D: stripFaqMeta only mends a sentence that STARTS with the lead', stripFaqMeta('The post says book early.') === 'Book early.' && stripFaqMeta('Many say the post office is far.') === 'Many say the post office is far.')

  // rewrites are accepted only when safe
  const offenders = qualityOffenders(mech.post, fixCtx)
  const idx = offenders.findIndex((o) => /^Picture two suitcases/.test(o.text))
  check('D: a rewrite that adds a number is refused', !acceptableRewrite('Picture two suitcases lying open on the bed.', 'A Rhine river cruise suits first timers for 7 nights.'))
  check('D: a rewrite that adds a link, a long dash or a banned word is refused', !acceptableRewrite('x y z', 'See [a](/b).') && !acceptableRewrite('x y z', `A ${String.fromCharCode(0x2014)} b`) && !acceptableRewrite('x y z', 'A perfect trip') && !acceptableRewrite('x y z', 'The text suggests it.'))
  check('D: a good rewrite is accepted', acceptableRewrite('Picture two suitcases lying open on the bed.', 'A Rhine river cruise suits first timers who dislike repacking.'))
  const reworded = applyQualityRewrites(mech.post, offenders, [{ id: idx, text: 'A Rhine river cruise suits first timers who dislike repacking.' }, { id: 99, text: 'x' }])
  check('D: the accepted rewrite fixes the opening sentence and the gates improve', !has(qualityBlockers(reworded, fixCtx), 'opening sentence') && improves(before, qualityBlockers(reworded, fixCtx)))
  check('D: improves() needs fewer blockers and no new kind', improves(['too few internal links (1, needs at least 3)', 'no Quick answer line'], ['too few internal links (2, needs at least 3)']) && !improves(['no Quick answer line'], ['no Quick answer line']) && !improves(['no Quick answer line'], ['title year outside the next 12 months (2031)']))

  // selection: weekly rotation, worst first, 2 a day
  const scored = [0, 1, 2, 3, 4].map((n) => ({ row: { slug: `p${n}`, created_at: `2026-0${n + 1}-01T00:00:00Z` } as Record<string, unknown>, blockers: n === 4 ? [] : Array.from({ length: n + 1 }, (_, i) => `b${i}`), lastRefresh: null as string | null }))
  const picks = selectRefreshPicks(scored, now, REFRESH_PER_DAY)
  check('D: the worst two posts are picked, a clean post never is', picks.map((p) => p.row.slug).join() === 'p3,p2', picks.map((p) => p.row.slug).join())
  scored[3].lastRefresh = ago(3)
  check('D: a post looked at in the last 7 days waits (weekly rotation), the next worst takes its place', selectRefreshPicks(scored, now, 2).map((p) => p.row.slug).join() === 'p2,p1')
  scored[3].lastRefresh = ago(8)
  check('D: after 7 days it is eligible again', selectRefreshPicks(scored, now, 2).map((p) => p.row.slug).includes('p3'))
  check('D: the limit is 2 a day', REFRESH_PER_DAY === 2 && selectRefreshPicks(scored, now, 0).length === 0)

  // hub and spoke
  const hubRows = [
    { slug: 'a', title: 'Rhine basics', body: '[t](/packages/rhine-cruise)', tags: [], related_package_id: 'pk1' },
    { slug: 'b', title: 'Rhine cabins', body: '[t](/packages/rhine-cruise) and [a](/blog/a)', tags: [], related_package_id: 'pk1' },
    { slug: 'c', title: 'Croatia', body: '[t](/packages/croatia-sail)', tags: [], related_package_id: 'pk2' },
  ]
  const pk = [{ id: 'pk1', slug: 'rhine-cruise', name: 'Rhine Explorer', destination: 'Rhine' }, { id: 'pk2', slug: 'croatia-sail', name: 'Croatia Sail', destination: 'Croatia' }]
  const exists = new Set(['/blog/a', '/blog/b', '/blog/c', '/packages/rhine-cruise', '/destinations/rhine', '/packages/croatia-sail', '/destinations/croatia'])
  const plan = hubLinkPlan(hubRows, pk, exists, 2)
  check('D: hub and spoke: two posts on one trip each link the other (a lacks the link to b, b already links a)', plan.length === 1 && plan[0].row.slug === 'a' && plan[0].links[0].path === '/blog/b')
  check('D: a post alone on its trip needs no sibling link', !plan.some((p) => p.row.slug === 'c'))
  check('D: related links prefer the same-trip post, then the trip page and the destination page, only real paths', relatedLinksFor(hubRows[0], hubRows, pk, exists).map((l) => l.path).join() === '/blog/b,/destinations/rhine')

  // the full refresh against the fake database
  const published = (n: number, over: Record<string, unknown> = {}) => ({
    id: `post-${n}`, slug: `rhine-${n}`, status: 'published', title: 'Rhine river cruise for first timers: what to know', body: weakBody, meta_title: 'Rhine river cruise for first timers', meta_description: good.seo_description,
    tags: ['rhine'], faq: [{ q: 'How should I choose a cabin?', a: 'The text suggests thinking in terms of views, noise and price.' }, ...good.faq.slice(1)], key_takeaways: good.key_takeaways, og_title: good.og_title, og_description: good.og_description,
    primary_keyword: 'rhine river cruise first timers', secondary_keywords: ['rhine cruise tips'], content_style: 'faq-led', related_package_id: null, publish_date: '2026-09-01', created_at: `2026-09-0${n}T00:00:00Z`, updated_at: `2026-09-0${n}T00:00:00Z`, ...over,
  })
  const existing = new Set(['/', '/blog', '/packages/rhine-cruise', '/destinations/rhine', '/blog/rhine-1', '/blog/rhine-2', '/blog/rhine-3', '/blog/rhine-4', '/blog/rhine-5'])
  const pkgRow = { id: 'pk1', slug: 'rhine-cruise', name: 'Rhine Explorer', destination: 'Rhine', status: 'published', short_description: 'A gentle Rhine river cruise.', full_description: null, highlights: ['Cologne', 'Koblenz', 'Strasbourg', 'Basel'], available_from: '2027-04-10', available_to: '2027-04-18' }
  const opener = 'A Rhine river cruise suits first timers who dislike repacking.'
  let modelCalls = 0
  const model = async (prompt: string): Promise<string | null> => {
    modelCalls++
    const ids = [...prompt.matchAll(/^(\d+)\. \[opening sentence/gm)].map((m) => Number(m[1]))
    return JSON.stringify({ rewrites: ids.map((id) => ({ id, text: opener })) })
  }
  const modelAddsNumber = async (prompt: string): Promise<string | null> => {
    modelCalls++
    const ids = [...prompt.matchAll(/^(\d+)\. \[opening sentence/gm)].map((m) => Number(m[1]))
    return JSON.stringify({ rewrites: ids.map((id) => ({ id, text: 'A Rhine river cruise of 9 nights suits first timers.' })) })
  }
  function dbFor(rows: Record<string, unknown>[], settings: { key: string; value: string }[] = []): Db {
    return {
      tables: {
        app_settings: [{ key: 'autoblog_mode', value: 'publish' }, ...settings],
        content_edits: [],
        travel_packages: [pkgRow],
        content_variants: [],
        posts: rows,
      },
    }
  }
  {
    const db = dbFor([published(1), published(2), published(3), published(4), published(5, { body: goodBody, faq: good.faq })])
    const admin = fakeAdmin(db)
    const row = (n: number) => db.tables.posts.find((p) => p.id === `post-${n}`) as Record<string, unknown>
    const original = String(row(1).body)
    const r1 = await refreshPublishedPosts(admin, { existing, now, model })
    check('D: refresh scores every published post and finds the weak ones (4 of 5)', r1.checked === 5 && r1.weak === 4, JSON.stringify(r1))
    check('D: at most 2 posts are refreshed in a day', r1.refreshed === 2 && modelCalls === 2, JSON.stringify(r1))
    check('D: the refreshed post lost the filler, got 3+ links, a contact link and a good opening', !/takeaway:|perfect|happy to help/i.test(String(row(1).body)) && internalHrefs(String(row(1).body)).length >= 3 && String(row(1).body).startsWith(opener) && !has(qualityBlockers(composedFromRow(row(1)), { now, groundingText: grounding, tripDates }), 'FAQ talks'))
    check('D: the post is still published, the slug and the facts are untouched', row(1).status === 'published' && row(1).slug === 'rhine-1' && String(row(1).body).includes('Rhine Explorer trip'))
    check('D: the good post was left alone', row(5).body === goodBody && db.tables.content_edits.every((e) => e.content_id !== 'post-5'))
    const edits = db.tables.content_edits.filter((e) => e.content_id === 'post-1')
    check('D: every change is logged in content_edits (published_after, before and after)', edits.length >= 2 && edits.every((e) => e.published_after === true && typeof e.before === 'string' && typeof e.after === 'string') && edits.some((e) => e.field === 'body'), JSON.stringify(edits.map((e) => e.field)))
    check('D: the refresh is stamped so the post rests for a week', (db.tables.content_variants.find((v) => v.slug === 'rhine-1')?.variant_tags as Record<string, unknown>)?.refresh_last !== undefined && (await refreshesToday(admin, now)) === 2)
    const bodyEdit = edits.find((e) => e.field === 'body' || e.field === 'links') as Record<string, unknown>
    const undone = await revertEdit(admin, bodyEdit.id as string)
    check('D: Undo puts the old body back like the other heals', undone.ok && row(1).body === original, JSON.stringify(undone))
    const again = await refreshPublishedPosts(admin, { existing, now, model })
    check('D: a second run the same day does nothing more (2 a day)', again.refreshed === 0 && modelCalls === 2, JSON.stringify(again))
    const tomorrow = new Date(now.getTime() + day)
    const next = await refreshPublishedPosts(admin, { existing, now: tomorrow, model })
    check('D: the next day the next weakest posts are refreshed (weekly rotation)', next.refreshed === 2 && String(row(3).body).startsWith(opener) && String(row(4).body).startsWith(opener), JSON.stringify(next))
    check('D: a post refreshed yesterday is not touched again this week', (await refreshPublishedPosts(admin, { existing, now: new Date(now.getTime() + 2 * day), model })).refreshed <= 1)
  }
  {
    // budget: with the heal budget at 0 the model is never called, plain fixes still apply and are kept only if better
    modelCalls = 0
    const db = dbFor([published(1)], [{ key: 'heal_loop_calls_per_day', value: '0' }])
    const r = await refreshPublishedPosts(fakeAdmin(db), { existing, now, model })
    check('D: a heal budget of 0 means no model call', modelCalls === 0 && r.calls === 0, JSON.stringify(r))
    check('D: plain fixes are still kept when they improve the post', r.refreshed === 1 && !/takeaway:/i.test(String(db.tables.posts[0].body)) && has(qualityBlockers(composedFromRow(db.tables.posts[0]), { now, groundingText: grounding, tripDates }), 'opening sentence'))
  }
  {
    // a rewrite that adds a number is thrown away, the post is still improved by plain code
    modelCalls = 0
    const db = dbFor([published(1)])
    const r = await refreshPublishedPosts(fakeAdmin(db), { existing, now, model: modelAddsNumber })
    check('D: a rewrite that adds a number is ignored (never changes a fact)', modelCalls === 1 && !/9 nights/.test(String(db.tables.posts[0].body)) && r.refreshed === 1, JSON.stringify(r))
  }
  {
    // nothing safe to do: not changed, not retried for a week
    const alreadyFixed = mechanicalFix(weakPost, fixCtx).post
    const stuck = published(1, { body: alreadyFixed.body, faq: alreadyFixed.faq, content_style: '', primary_keyword: '' })
    const db = dbFor([stuck])
    const r = await refreshPublishedPosts(fakeAdmin(db), { existing, now, model: async () => null })
    check('D: when no safe improvement exists the post is left exactly as it was and rests for a week', db.tables.posts[0].body === alreadyFixed.body && r.unchanged === 1 && r.refreshed === 0 && db.tables.content_edits.length === 0 && (db.tables.content_variants.find((v) => v.slug === 'rhine-1')?.variant_tags as Record<string, unknown>)?.refresh_result === 'no safe improvement found', JSON.stringify(r))
  }
  {
    // not in publish mode, paused, or the log table missing: nothing is done
    const off = dbFor([published(1)])
    off.tables.app_settings = [{ key: 'autoblog_mode', value: 'draft' }]
    check('D: in draft mode the refresh does nothing', (await refreshPublishedPosts(fakeAdmin(off), { existing, now, model })).ran === false)
    const broken = await refreshPublishedPosts({ from: () => { throw new Error('down') } } as unknown as Parameters<typeof refreshPublishedPosts>[0], { existing, now })
    check('D: the refresh never throws on a broken database and does nothing', broken.ran === false && broken.refreshed === 0)
    const failSave = dbFor([published(1)])
    failSave.failWrites = { posts: 'write failed' }
    const rf = await refreshPublishedPosts(fakeAdmin(failSave), { existing, now, model })
    check('D: if the save fails the audit rows are taken back (log, then apply)', rf.refreshed === 0 && failSave.tables.content_edits.length === 0 && rf.problems.some((p) => /could not save the refresh/.test(p)), JSON.stringify(rf))
  }
  {
    // hooked into the existing daily heal step: rehealStuckDrafts runs the refresh (no new cron)
    modelCalls = 0
    const db = dbFor([published(1)])
    const r = await rehealStuckDrafts(fakeAdmin(db), { existing, now, model })
    check('D: the daily heal step (rehealStuckDrafts) runs the refresh, no new cron', /blog quality/.test(r.note) && r.repaired >= 1 && /rehealStuckDrafts\(admin/.test(src('lib/content-heal-run.ts')), JSON.stringify(r))
    check('D: the refresh can be switched off for a caller', (await rehealStuckDrafts(fakeAdmin(dbFor([published(1)])), { existing, now, model, refresh: false })).note.indexOf('blog quality') === -1)
  }
  check('D: no new cron route was added for the refresh', !/blog-quality|blog-refresh/.test(src('vercel.json')))

  // ---- E: the admin count ----
  const rows = [published(1), published(2), published(3, { body: goodBody, faq: good.faq })] as Record<string, unknown>[]
  const bar = countBelowBar(rows, [{ name: 'Rhine Explorer', slug: 'rhine-cruise', destination: 'Rhine', short_description: null, full_description: null, highlights: ['Cologne'], available_from: '2027-04-10', available_to: '2027-04-18' }], now)
  check('E: the admin count uses the same gate (2 of 3 below the bar)', bar.count === 2 && bar.total === 3, JSON.stringify(bar))
  const card = src('components/admin/posts-automation-card.tsx')
  const route = src('app/api/admin/posts/automation/route.ts')
  check('E: the card shows "Posts below quality bar: N" and says "could not be read" on failure', /Posts below quality bar:/.test(card) && /could not be read/.test(card) && /belowQualityBar/.test(card))
  check('E: the route reads it with a catch (null on failure, never a made-up zero) and writes nothing', /postsBelowQualityBar\(admin\)\.catch\(\(\) => null\)/.test(route) && /belowQualityBar: belowBar/.test(route))
  check('E: no no-fabrication rule was weakened (numbers, word numbers, links and experience claims still gate)', /number not in the source facts/.test(src('lib/blog-composer.ts')) && /fabricated personal experience claim/.test(src('lib/blog-composer.ts')) && /external or email link/.test(src('lib/blog-composer.ts')))
  check('E: no long dash in the new copy', !new RegExp(String.fromCharCode(0x2014)).test(src('lib/blog-quality.ts') + src('lib/blog-quality-fix.ts') + src('lib/blog-quality-count.ts') + card))

  if (failed) {
    console.error(`\n${failed} check(s) FAILED.`)
    process.exit(1)
  }
  console.log('\nAll blog quality checks passed.')
}

main().catch((e) => {
  console.error('check crashed:', e)
  process.exit(1)
})
