// Offline self-check for hub WP5: question-style, buyer-intent and long-query buckets, the FAQ question picker, the prompt
// block, and the backwards-compatible mining state. No network, no database.
// Run: pnpm dlx tsx scripts/check-question-intel.ts
import { bucketQueries, classifyQuery, cleanQuestion, emptyIntel, isBuyerIntent, isLongQuery, isQuestionQuery, ownQuestionsFromPosts, parseIntel, pickFaqQuestions, questionsPromptBlock } from '../lib/question-intel'
import { composerPrompt, type ComposerContext } from '../lib/blog-composer'
import { mine, parseMiningState, emptyMiningState } from '../lib/gsc-mining'

let failed = 0
function check(label: string, ok: boolean, extra?: unknown) {
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && extra !== undefined ? ` -> ${JSON.stringify(extra)}` : ''}`)
}

// ---- buckets ----
check('question: starts with a question word', isQuestionQuery('how long is a rhine river cruise'))
check('question: ends with ?', isQuestionQuery('rhine cruise worth it?'))
check('question: two words starting with "is" is not enough', !isQuestionQuery('is rhine'))
check('question: plain keyword is not a question', !isQuestionQuery('rhine river cruise 2027'))
check('question: "what\'s" counts', isQuestionQuery("what's included in a river cruise"))
check('buyer: price', isBuyerIntent('rhine river cruise price'))
check('buyer: book', isBuyerIntent('book group trip to portugal'))
check('buyer: how much', isBuyerIntent('how much is a singles cruise'))
check('buyer: pure information is not buyer', !isBuyerIntent('history of the rhine river'))
check('long: 7 words', isLongQuery('what should i pack for a week long river cruise'))
check('long: 6 words is not long', !isLongQuery('what should i pack for cruise'))
const f = classifyQuery('how much does a group river cruise for singles cost in canada')
check('classify: one query can sit in all three', f.question && f.buyer && f.long, f)

const rows = [
  { query: 'how long is a rhine cruise', impressions: 40, position: 9.4 },
  { query: 'rhine cruise price', impressions: 25, position: 12 },
  { query: 'what should i pack for a week long river cruise with friends', impressions: 6, position: 22 },
  { query: 'travelfunbiz', impressions: 90, position: 1 },
  { query: 'rhine river cruise', impressions: 0, position: 5 },
]
const intel = bucketQueries(rows)
check('bucket: question count', intel.question.count === 2, intel.question)
check('bucket: buyer count', intel.buyer.count === 1 && intel.buyer.top[0].query === 'rhine cruise price', intel.buyer)
check('bucket: long count', intel.long.count === 1, intel.long)
check('bucket: impressions summed', intel.question.impressions === 46, intel.question.impressions)
check('bucket: zero-impression rows are ignored', !JSON.stringify(intel).includes('"rhine river cruise"'))
check('bucket: no rows gives the empty shape', JSON.stringify(bucketQueries([])) === JSON.stringify(emptyIntel()))
check('parseIntel: garbage reads as empty', JSON.stringify(parseIntel('nope')) === JSON.stringify(emptyIntel()) && JSON.stringify(parseIntel(undefined)) === JSON.stringify(emptyIntel()))
check('parseIntel: round trip', JSON.stringify(parseIntel(JSON.parse(JSON.stringify(intel)))) === JSON.stringify(intel))

// ---- clean question ----
check('clean: capitalised with ?', cleanQuestion('how long is a rhine cruise') === 'How long is a rhine cruise?')
check('clean: digits rejected (the composer forbids numbers)', cleanQuestion('how much is a 7 night rhine cruise') === null)
check('clean: superlative rejected', cleanQuestion('what is the best rhine river cruise') === null)
check('clean: web address rejected', cleanQuestion('where is www.example.com rhine cruise') === null)
check('clean: not a question rejected', cleanQuestion('rhine river cruise for singles') === null)
check('clean: too short rejected', cleanQuestion('how long') === null)

// ---- picker ----
const searches = [
  { query: 'how long is a rhine cruise', impressions: 40, position: 9 },
  { query: 'how long is a rhine river cruise', impressions: 12, position: 11 },
  { query: 'what is included in a river cruise', impressions: 30, position: 14 },
  { query: 'is portugal safe for solo women', impressions: 70, position: 8 },
  { query: 'rhine cruise price', impressions: 99, position: 3 },
]
const picked = pickFaqQuestions({ keywords: ['rhine river cruise', 'river cruise for singles'], searches })
check('picker: relevant question comes from the list', picked.includes('How long is a rhine cruise?'), picked)
check('picker: unrelated question is not offered', !picked.some((q) => /portugal/i.test(q)), picked)
check('picker: near-duplicate removed', picked.filter((q) => /how long/i.test(q)).length === 1, picked)
check('picker: non-question search is not offered', !picked.some((q) => /price/i.test(q)), picked)
check('picker: highest impressions first', picked[0] === 'What is included in a river cruise?' || picked[0] === 'How long is a rhine cruise?', picked)
check('picker: no data gives an empty list (nothing invented)', pickFaqQuestions({ keywords: ['rhine river cruise'] }).length === 0)
check('picker: no keywords gives an empty list', pickFaqQuestions({ keywords: [], searches }).length === 0)
check('picker: capped', pickFaqQuestions({ keywords: ['river cruise'], searches: Array.from({ length: 30 }, (_, i) => ({ query: `how does river cruise number${String.fromCharCode(97 + (i % 26))}${'x'.repeat(i)} work`, impressions: 10, position: 5 })), max: 3 }).length <= 3)
const own = ownQuestionsFromPosts([{ body: '## Is a river cruise good for solo travellers?\ntext\n## Packing list\n### What does a river cruise include' }, { body: null, faq: [{ q: 'Do river cruises have wifi?' }] }])
check('own posts: question headings and FAQ questions only', own.length === 3 && own.includes('Packing list') === false, own)
const fromOwn = pickFaqQuestions({ keywords: ['river cruise solo travellers'], own })
check('picker: own-post question is offered when relevant', fromOwn.some((q) => /solo travellers/i.test(q)), fromOwn)

// ---- prompt ----
const ctx: ComposerContext = { angle: 'a', keywords: ['rhine river cruise'], seedSecondary: [], idea: 'i', description: 'd', allowedLinks: [], body: 'Body.', title: 'T' }
const base = composerPrompt('enrich', ctx)
check('prompt: empty list leaves the enrich prompt unchanged', composerPrompt('enrich', { ...ctx, questions: [] }) === base)
check('prompt: block is empty for none', questionsPromptBlock([]) === '' && questionsPromptBlock(undefined) === '')
const withQ = composerPrompt('enrich', { ...ctx, questions: ['How long is a rhine cruise?'] })
check('prompt: question appears when given', withQ.includes('How long is a rhine cruise?') && withQ !== base)
check('prompt: answers still follow the existing rules (no digits, no links)', withQ.includes('No prices, dates, availability, digits, number words or counts of any kind, and no links'))
check('prompt: only-if-answered wording', /ONLY when the post above genuinely answers it/.test(withQ))

// ---- mining state stays backwards compatible ----
const core = mine({ pairs: [], stored: [{ query: 'how long is a rhine cruise', clicks: 1, impressions: 40, position: 9 }], pages: [] }, new Date('2026-10-24T00:00:00Z'))
check('mine: output carries intel', !!core.intel && core.intel.question.count === 1, core.intel)
check('mine: existing fields unchanged', core.source === 'stored' && core.rowCount === 1 && Array.isArray(core.proposals) && Array.isArray(core.refresh))
const old = JSON.stringify({ at: '2026-10-01T00:00:00Z', source: 'live', rowCount: 3, proposals: [], refresh: [], pushed: [], note: '' })
const parsedOld = parseMiningState(old)
check('state: an older stored result (no intel) still reads, with no intel key', parsedOld.at === '2026-10-01T00:00:00Z' && parsedOld.intel === undefined)
const parsedNew = parseMiningState(JSON.stringify({ ...core, pushed: [] }))
check('state: a new result keeps its intel', parsedNew.intel?.question.count === 1)
check('state: empty state unchanged shape', JSON.stringify(Object.keys(emptyMiningState()).sort()) === JSON.stringify(['at', 'note', 'proposals', 'pushed', 'refresh', 'rowCount', 'source']))
check('mine: no rows still gives a valid empty intel', mine({ pairs: [], stored: [], pages: [] }).intel?.question.count === 0)

console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed')
process.exit(failed ? 1 : 0)
