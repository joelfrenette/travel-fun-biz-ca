// Offline check for the plain-code repair of "opening sentence is N words, over 25" (lib/blog-quality.ts shortenOpening), the rule that
// made the heal reject all 4 drafts it rejected between 23 and 30 Oct. The repair only removes the end of the sentence; it must keep the
// keyword, never split a link or bold marker, never drop a link, and leave every later paragraph exactly as it was.
// Pure functions and a source assertion only: no network, no database, no AI call.
// Run: pnpm dlx tsx scripts/check-opening-shorten.ts
import { readFileSync } from 'node:fs'
import { MAX_FIRST_SENTENCE_WORDS, cutFirstSentence, firstSentenceIssue, firstSentenceOf, shortenOpening } from '../lib/blog-quality'

let failed = 0
function check(label: string, ok: boolean, extra?: string) {
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && extra ? ` :: ${extra}` : ''}`)
}
const words = (s: string) => s.split(/\s+/).filter(Boolean).length
const KW = 'royalton resorts all inclusive solo travelers'
const LATER = '\n\n## What is included\n\nMeals, drinks and activities are covered at the resort, which keeps the daily budget simple.'

// 1. A long opening with commas is cut to a short one that passes the gate; later text is untouched.
{
  const long = 'Royalton resorts all inclusive packages can be a good value for solo travelers who want built-in social activities, easy meals, and a safe base, although the price depends on the season and the room type you choose.'
  const body = long + LATER
  check('setup: the long opening really fails the gate', /over 25/.test(firstSentenceIssue(body, KW) ?? ''))
  const out = shortenOpening(body, KW)
  check('a long opening is shortened', out !== null && out !== body)
  check('the result passes the opening-sentence gate', out !== null && firstSentenceIssue(out, KW) === null, out ?? 'null')
  check('the new opening is within the limit and still ends with a full stop', out !== null && words(firstSentenceOf(out)) <= MAX_FIRST_SENTENCE_WORDS && /\.$/.test(firstSentenceOf(out)))
  check('the new opening is the start of the old one (words only removed, none added)', out !== null && long.startsWith(firstSentenceOf(out).replace(/\.$/, '')))
  check('everything after the first paragraph is byte for byte the same', out !== null && out.endsWith(LATER))
}

// 2. Already fine, or not a length problem: nothing to do.
{
  const ok = 'Royalton resorts all inclusive can suit solo travelers who like company.' + LATER
  check('a short opening is left alone', shortenOpening(ok, KW) === null)
  const scene = 'Imagine waking up at a Royalton resort, with the ocean right outside your window and a long day of nothing planned ahead of you.' + LATER
  check('a scene-setter is not a length problem, so this repair leaves it for the model', shortenOpening(scene, KW) === null)
}

// 3. No safe cut: a single long run with no clause boundary stays for the model.
{
  const run = 'Royalton resorts all inclusive solo travelers will find that the whole stay is organised around easy shared evenings on the beach for guests of every age and background from many countries.' + LATER
  check('no clause boundary means no cut', shortenOpening(run, KW) === null)
}

// 4. Links and bold markers are never split, and a link in the dropped end blocks the cut.
{
  const linkInside = 'Royalton resorts all inclusive solo travelers can book a [solo friendly trip, with a host and a group](/packages/solo-trip) that handles the dinners and the daily plans for everyone.' + LATER
  const out1 = shortenOpening(linkInside, KW)
  check('a cut never lands inside a link', out1 === null || ((out1.match(/\[/g) ?? []).length === (out1.match(/\]/g) ?? []).length && (out1.match(/\(/g) ?? []).length === (out1.match(/\)/g) ?? []).length))
  const linkDropped = 'Royalton resorts all inclusive solo travelers get easy company and plenty of included meals every single day, and you can [ask us about a hosted trip](/#contact) when you are ready to plan.' + LATER
  check('a link in the dropped end blocks the cut (the link must survive)', shortenOpening(linkDropped, KW) === null)
  const bold = '**Royalton resorts all inclusive solo travelers** get easy company and plenty of included meals every single day, and the staff organise shared dinners most nights of the week as well.' + LATER
  const out2 = shortenOpening(bold, KW)
  check('bold markers stay balanced', out2 === null || ((out2.match(/\*\*/g) ?? []).length % 2 === 0))
}

// 5. A cut that would leave a dangling word is skipped (prefers an earlier clean boundary).
{
  const dangle = 'Royalton resorts all inclusive solo travelers get easy company and many included meals every day, and the, staff organise shared dinners most nights of the week for all guests who join in.' + LATER
  const out = shortenOpening(dangle, KW)
  check('the result never ends on a joining word', out === null || !/\b(?:and|the|of|to|for|with|that|which)\.$/i.test(firstSentenceOf(out)))
}

// 6. Wiring: the post heal target runs the repair, and it records the edit so Undo works.
{
  const src = readFileSync('lib/heal-targets.ts', 'utf8')
  check('the post heal target runs shortenOpening before any model call', /repair: \(f, _blockers, tracker\) => \{[\s\S]{0,400}shortenOpening\(f\.body, post\.primary_keyword\)/.test(src))
  check('the repair records the change with the tracker (so it is logged with Undo)', /tracker\.touch\('body', 'fixer', 'cut an opening sentence over 25 words/.test(src))
  const q = readFileSync('lib/blog-quality.ts', 'utf8')
  check('no long dash in the new code or comments', !/[–—]/.test(q.slice(q.indexOf('const DANGLING_END'), q.indexOf('// Links, Quick answer'))))
}

// 7. The same cut for compare and best-time page copy (first sentence over 45 words, 2026-10-30 /compare/dominican-republic-vs-germany).
{
  const copySentence = 'Dominican Republic and Germany suit very different travelers, because the first offers warm beaches, all inclusive resorts and easy flights from most Canadian cities in every season, while the second offers castles, river towns, rail travel, forest walks, regional food and a long list of museums for every kind of curious visitor who likes to learn something new on holiday.'
  const copyBody = copySentence + '\n\nSecond paragraph that stays exactly as it was.'
  const cut = cutFirstSentence(copyBody, 45, () => true)
  check('setup: the page-copy first sentence is over 45 words', words(copySentence) > 45)
  check('a first sentence over 45 words is cut to 45 or fewer', cut !== null && words(firstSentenceOf(cut)) <= 45 && /\.$/.test(firstSentenceOf(cut)))
  check('the page-copy cut removes words only and leaves the next paragraph alone', cut !== null && copySentence.startsWith(firstSentenceOf(cut).replace(/\.$/, '')) && cut.endsWith('\n\nSecond paragraph that stays exactly as it was.'))
  check('the cut is refused when the gate of the caller says no', cutFirstSentence(copyBody, 45, () => false) === null)
  const src2 = readFileSync('lib/heal-targets.ts', 'utf8')
  check('the page-copy heal target runs the cut only for the long-first-sentence blocker, and re-checks the real gate', /\/\^the first sentence is too long\/\.test\(b\)\)\) return f/.test(src2) && /pageCopyBlockers\(copyFrom\(copy,/.test(src2) && /tracker\.touch\('body', 'fixer', 'cut a first sentence over 45 words/.test(src2))
}

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed')
process.exit(failed ? 1 : 0)
