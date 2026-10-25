// Offline check: the "same meaning" topic layer (lib/topic-meaning.ts). Pure: no network, no database, fake travel data only.
// Run: pnpm dlx tsx scripts/check-topic-meaning.ts   (exit 1 on a failure)
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  BORDERLINE_THRESHOLD, SAME_THRESHOLD, conceptsOf, duplicateReason, findSameMeaning, meaningScore, refreshHint, stem,
  type MeaningDoc,
} from '../lib/topic-meaning'

let failed = 0
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : detail ? `  -> ${detail}` : ''}`)
}

// ---- 1. pairs that MEAN the same thing (every one must score at or above SAME_THRESHOLD) ------------------------------------------
const SAME: [string, string][] = [
  ['Best time to visit Santorini', 'When should you go to Santorini'],
  ['Santorini travel guide for first timers', 'First-time visitor guide to Santorini'],
  ['What to pack for a Caribbean cruise', 'Caribbean cruise packing list'],
  ['How much does a trip to Iceland cost', 'Iceland trip cost and budget'],
  ['Is Mexico City safe for tourists', 'Mexico City safety tips for travelers'],
  ['Best time of year to visit Croatia', 'When to go to Croatia'],
  ['Rhine river cruise tips', 'Tips for a Rhine river cruise'],
  ['Is a Danube river cruise worth it', 'Is a Danube cruise worth the money? Worth it?'],
  ['Cheap flights to Lisbon', 'Affordable flights to Lisbon'],
  ['Solo travel in Portugal', 'Travelling alone in Portugal'],
  ['Honeymoon in Bali', 'Romantic honeymoon trip to Bali'],
  ['Family vacation in Orlando', 'Orlando holiday with kids'],
  ['Weather in Greece in October', 'Greek weather in October'],
  ['What to wear in Iceland in winter', 'Iceland winter packing guide'],
  ['Where to stay in Rome', 'Best hotels in Rome'],
  ['Itinerary for 7 days in Italy', 'A 7 day Italy itinerary'],
  ['Amsterdam to Basel river cruise', 'River cruise from Amsterdam to Basel'],
  ['Do I need a visa for Thailand', 'Thailand visa requirements'],
  ['Travel insurance for cruises', 'Do you need cruise travel insurance'],
  ['Best food in Tokyo', 'What to eat in Tokyo'],
  ['Train travel through Switzerland tips', 'Tips for riding trains in Switzerland'],
  ['Top things to do in Dubrovnik', 'Things to see in Dubrovnik'],
  ['Alaska cruise in May', 'Cruising Alaska in May'],
  ['Budget tips for visiting Paris', 'Cheap trip to Paris on a budget'],
  ['Hawaii vacation in the spring', 'Visiting Hawaii in spring'],
  ['Singles getaway in Jamaica', 'Jamaica getaway for single travelers'],
]
let sameMissed = 0
for (const [a, b] of SAME) {
  const s = meaningScore(a, b)
  const s2 = meaningScore(b, a)
  const ok = s.score >= SAME_THRESHOLD && Math.abs(s.score - s2.score) < 0.001
  if (!ok) sameMissed++
  check(`same meaning: "${a}" ~ "${b}"`, ok, `score ${s.score} / ${s2.score} (cosine ${s.cosine}, jaccard ${s.jaccard}, facetConflict ${s.facetConflict})`)
}
check(`at least 20 same-meaning pairs are covered (${SAME.length})`, SAME.length >= 20)

// ---- 2. pairs that are DIFFERENT (every one must score under SAME_THRESHOLD; most under BORDERLINE_THRESHOLD) -----------------------
const DIFFERENT: [string, string][] = [
  ['Best time to visit Santorini', 'Best time to visit Iceland'],
  ['Santorini weather in March', 'Santorini budget for a week'],
  ['What to pack for a Caribbean cruise', 'Is a Caribbean cruise worth it'],
  ['Rhine river cruise tips', 'Danube river cruise tips'],
  ['Solo travel in Portugal', 'Family vacation in Portugal'],
  ['Honeymoon in Bali', 'Honeymoon in the Maldives'],
  ['Is Mexico City safe for tourists', 'Where to stay in Mexico City'],
  ['Cheap flights to Lisbon', 'Cheap hotels in Lisbon'],
  ['Alaska cruise in May', 'Alaska cruise in September'],
  ['Do I need a visa for Thailand', 'What to eat in Thailand'],
  ['Train travel through Switzerland tips', 'Driving through Switzerland tips'],
  ['River cruise vs ocean cruise', 'River cruise packing list'],
  ['Travel insurance for cruises', 'Travel insurance for Mexico'],
  ['Best food in Tokyo', 'Best food in Kyoto'],
  ['Singles getaway in Jamaica', 'Family getaway in Jamaica'],
  ['Weather in Greece in October', 'Weather in Greece in July'],
  ['Where to stay in Rome', 'Where to stay in Florence'],
  ['Itinerary for 7 days in Italy', 'Itinerary for 7 days in Spain'],
  ['Amsterdam to Basel river cruise', 'Cologne to Basel river cruise'],
  ['How much does a trip to Iceland cost', 'What to pack for Iceland'],
  ['Hawaii vacation in the spring', 'Hawaii vacation in the winter'],
  ['Top things to do in Dubrovnik', 'Is Dubrovnik safe'],
  ['Group trip packing list', 'Group trip planning with friends'],
  ['Danube river cruise packing list', 'Danube river cruise cost'],
  ['Honeymoon in Bali', 'Family vacation in Bali'],
  ['Caribbean cruise for couples', 'Caribbean cruise for families'],
  ['Best time to visit Croatia', 'Croatia ferry tips'],
  ['Travel tips', 'Travel guide'],
]
for (const [a, b] of DIFFERENT) {
  const s = meaningScore(a, b)
  check(`different meaning: "${a}" / "${b}"`, s.score < SAME_THRESHOLD, `score ${s.score} (cosine ${s.cosine}, jaccard ${s.jaccard})`)
}
check(`at least 20 different-meaning pairs are covered (${DIFFERENT.length})`, DIFFERENT.length >= 20)
const slipping = DIFFERENT.filter(([a, b]) => meaningScore(a, b).score >= SAME_THRESHOLD).length
check('no different-meaning pair reaches the duplicate band', slipping === 0, `${slipping} did`)
check('none of the same-meaning pairs fell under the threshold', sameMissed === 0, `${sameMissed} did`)

// ---- 3. building blocks ---------------------------------------------------------------------------------------------------------
check('stem folds plurals and -ing/-ed', stem('cruises') === stem('cruise') && stem('packing') === stem('packed') && stem('cities') === 'city', `${stem('cruises')} ${stem('packing')} ${stem('packed')}`)
check('stem leaves short words and years alone', stem('go') === 'go' && stem('2026') === '2026')
check('synonyms fold to one concept (go / visit / trip)', (() => { const k = (s: string) => [...conceptsOf(s).tokens].sort().join(); return k('go to Rome') === k('visit Rome') && k('Rome trip') === k('visit Rome') })())
check('country adjectives fold to the country', conceptsOf('Greek islands').tokens.includes('greece'))
check('a year in a title is ignored', conceptsOf('Santorini guide 2026').tokens.join() === conceptsOf('Santorini guide').tokens.join())
check('first-time and first timers fold together', conceptsOf('first-time visitor').tokens.includes('first') && conceptsOf('first timers').tokens.includes('first'))
check('score is symmetric and bounded', (() => { const s = meaningScore('Rome food tour', 'Eat in Rome'); const t = meaningScore('Eat in Rome', 'Rome food tour'); return s.score === t.score && s.score >= 0 && s.score <= 1 })())
check('empty text scores 0', meaningScore('', 'Rome').score === 0 && meaningScore('the a of', 'Rome').score === 0)
check('identical text scores 1', meaningScore('Rhine river cruise tips', 'Rhine river cruise tips').score === 1)
check('thresholds are ordered', BORDERLINE_THRESHOLD < SAME_THRESHOLD && BORDERLINE_THRESHOLD > 0.3)
check('different questions about one place are a facet conflict', meaningScore('Santorini weather', 'Santorini budget').facetConflict)

// ---- 4. matching against what exists --------------------------------------------------------------------------------------------
const now = new Date('2026-10-24T12:00:00Z')
const docs: MeaningDoc[] = [
  { kind: 'post', slug: 'when-to-visit-santorini', title: 'The best time to visit Santorini', keyword: 'best time to visit santorini', body_chars: 9000, date: '2026-09-01' },
  { kind: 'post', slug: 'iceland-ring-road-guide', title: 'Iceland ring road in a week', keyword: 'iceland ring road', body_chars: 1200, date: '2026-08-01' },
  { kind: 'post', slug: 'rhine-cruise-faq', title: 'Rhine river cruise questions answered', keyword: 'rhine river cruise', body_chars: 8000, date: '2024-01-15' },
  { kind: 'rejected', slug: 'lisbon food crawl', title: 'Eating your way through Lisbon', keyword: 'lisbon food crawl', id: 'r1' },
  { kind: 'queued', slug: 'croatia ferry tips', title: 'How to use ferries in Croatia', keyword: 'croatia ferry tips', id: 'q1' },
]
const r1 = findSameMeaning({ keyword: 'when should you go to santorini', angle: 'A post for people deciding which month to visit Santorini' }, docs)
check('a topic matches an existing post by meaning', r1.band === 'same' && r1.best?.doc.slug === 'when-to-visit-santorini', JSON.stringify(r1.best && { s: r1.best.score, d: r1.best.doc.slug }))
const r2 = findSameMeaning({ keyword: 'santorini budget for a week' }, docs)
check('a different question about the same place is not a duplicate', r2.band !== 'same', `${r2.band} ${r2.best?.score}`)
const r3 = findSameMeaning({ keyword: 'tasting food in lisbon' }, docs)
check('a topic matches a recent rejected topic', r3.band === 'same' && r3.best?.doc.kind === 'rejected', `${r3.band} ${r3.best?.score} ${r3.best?.doc.kind}`)
const r4 = findSameMeaning({ keyword: 'croatia ferry tips', angle: 'x' }, docs, { excludeId: 'q1' })
check('a queue row never matches itself', r4.best?.doc.id !== 'q1')
const r5 = findSameMeaning({ keyword: 'packing for patagonia hiking' }, docs)
check('an unrelated topic is different', r5.band === 'different', `${r5.band} ${r5.best?.score}`)
check('no documents means different', findSameMeaning({ keyword: 'anything about rome' }, []).band === 'different')
check('a topic with no text means different', findSameMeaning({ keyword: '' }, docs).band === 'different')
// A borderline band exists between the two thresholds (this is where the optional AI tie-break would be asked).
const gap = [meaningScore('Lisbon tram 28 guide', 'Lisbon walking tour').score, meaningScore('Rome in autumn', 'Rome autumn festivals').score]
check('the borderline band is real (some pair lands in it)', gap.some((s) => s >= BORDERLINE_THRESHOLD && s < SAME_THRESHOLD) || meaningScore('Rhine cruise for couples', 'Rhine cruise tips').score >= BORDERLINE_THRESHOLD, JSON.stringify(gap))

// ---- 5. reasons and the refresh hint --------------------------------------------------------------------------------------------
const thin = docs[1]
const old = docs[2]
const fresh = docs[0]
check('refresh hint for a thin page', (refreshHint(thin, now) ?? '').startsWith('refresh iceland-ring-road-guide instead'))
check('refresh hint for an old page', (refreshHint(old, now) ?? '').startsWith('refresh rhine-cruise-faq instead'))
check('no refresh hint for a fresh, full page', refreshHint(fresh, now) === null)
check('no refresh hint for a topic', refreshHint(docs[3], now) === null)
const reason = duplicateReason({ doc: thin, score: 0.81, via: 'keyword vs title' }, 'deterministic', now)
check('reason names the slug, says duplicate, and carries the suggestion', reason.startsWith('duplicate of iceland-ring-road-guide') && reason.includes('refresh iceland-ring-road-guide instead'), reason)
check('reason for a rejected topic says so', duplicateReason({ doc: docs[3], score: 0.9, via: '' }, 'ai', now).startsWith('duplicate of rejected topic lisbon food crawl'))

// ---- 6. wiring (source checks: the layer is called from every path, off-switches have the right defaults) --------------------------
const root = join(__dirname, '..')
const src = (p: string) => readFileSync(join(root, p), 'utf8').replace(/\r\n/g, '\n')
const run = src('lib/topic-meaning-run.ts')
const topics = src('lib/blog-topics.ts')
const auto = src('lib/autoblog-run.ts')
const dec = src('lib/auto-decisions.ts')
check('deterministic layer defaults ON (policyEnabled: only exactly off disables it)', /policyEnabled\(await getSetting\(admin, TOPIC_MEANING_SWITCH\)\)/.test(run))
check('AI layer defaults OFF (only exactly "on" enables it)', /raw === 'on'/.test(run) && /TOPIC_MEANING_AI_SWITCH = 'topic_meaning_ai'/.test(run))
check('AI layer has a hard daily cap checked before the call', /AI_DAILY_CAP = \d+/.test(run) && run.indexOf('used >= AI_DAILY_CAP') < run.indexOf('callAnthropic('))
check('AI layer is asked only for the borderline band', /r\.band === 'same'/.test(run) && run.indexOf("r.band === 'same'") < run.indexOf('aiSaysSame(admin, topic'))
check('the approved-queue pick runs the check and moves on', /meaningRejection\(admin, \{ keyword: row\.keyword[\s\S]*?\)\) continue/.test(auto))
check('the keyword-research pick runs the check', /meaningRejection\(admin, \{ keyword: c\.keyword \}/.test(topics))
check('the AI-freeform pick runs the check over every ranked idea', /for \(const idea of rankByGsc\(notDuplicate/.test(topics))
check('queued suggestions are stored as rejected with the reason, not dropped', /r\.status = 'rejected'/.test(topics) && /topic-restore/.test(topics))
check('a duplicate gets an Undo that restores it', /UNDO_KINDS[^\n]*'topic-restore'/.test(dec) && /undo\.kind === 'topic-restore'/.test(dec))
check('a skipped topic is written to the decisions log', /appendDecisions\(admin, \[decision\('topic_meaning'/.test(run))
check('the layer never throws into the run (fails open)', (run.match(/catch \{/g) ?? []).length >= 4)
check('no network or database import in the pure module', !/from '@\/lib\/(supabase|ai-verify|app-settings)/.test(src('lib/topic-meaning.ts')) && !/fetch\(/.test(src('lib/topic-meaning.ts')))
check('new switches are documented in .env.example', /auto_policy_topic_meaning/.test(src('.env.example')) && /topic_meaning_ai/.test(src('.env.example')))

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
