import { callAnthropic, anthropicText, parseModelJson, isAiConfigured } from '@/lib/ai-verify'
import type { ModelUsage } from '@/lib/package-extract'
import {
  removeDashes,
  agencyClaims,
  namedThingsNotInBrief,
  ungroundedWordCounts,
  numbersIn,
  proseOf,
  PLACEHOLDER_PATTERNS,
  REFUSAL_PATTERNS,
  EXPERIENCE_CLAIM_PATTERNS,
  SUPERLATIVE_PATTERNS,
  RECENCY_PATTERNS,
  COUNT_CLAIM,
  SCHEDULE_PATTERN,
} from '@/lib/guide-composer'

// Trip page FAQs (growth loop WP12). ONE model call, grounded ONLY in the trip row's own text, then every
// question and answer is held to the same mechanical gate as the guide pages (no number that is not in the row,
// no superlative, no claim about the agency, no experience claim, no policy topic the row never mentions, dashes
// repaired). The model is never trusted: a pair that fails the gate is dropped, and fewer than FAQ_MIN survivors
// means no FAQs at all. Used by the admin "Generate FAQs" button, by applyEnrichment (after a description lands)
// and by the daily heal (a published trip with a long description and no FAQs).
//
// History: the admin route used to invent a cancellation policy (found 2026-10-03). The grounding rules below
// are why that cannot come back.

export interface PackageFaq {
  question: string
  answer: string
}

export const FAQ_MIN = 4
export const FAQ_MAX = 6
/** Shortest description worth writing FAQs from (words). Under this the row does not say enough. */
export const FAQ_DESCRIPTION_MIN_WORDS = 150

/** The row fields the FAQ writer reads (a DbPackage satisfies this; the admin form sends the same names). */
export interface FaqInput {
  name?: string | null
  destination?: string | null
  duration?: string | null
  short_description?: string | null
  full_description?: string | null
  highlights?: string[] | string | null
  price_includes?: string[] | string | null
  not_included?: string[] | string | null
  itinerary?: unknown
  min_people?: number | string | null
  max_people?: number | string | null
}

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : v != null && typeof v !== 'object' ? String(v) : '')
const listText = (v: unknown): string => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).join('\n') : text(v))

/** Titles of itinerary stops, one per line (the stop descriptions are not used). */
export function itineraryTitles(itinerary: unknown): string[] {
  if (!Array.isArray(itinerary)) return []
  return itinerary
    .map((d) => (d && typeof d === 'object' && typeof (d as { title?: unknown }).title === 'string' ? (d as { title: string }).title.trim() : ''))
    .filter(Boolean)
}

/** The labelled block the model sees. Also the ONLY place a number or a name in an answer may come from. Price is
 * left out on purpose: a price in an FAQ goes stale on its own; the booking page shows the live one. */
export function faqContext(pkg: FaqInput): string {
  const rows: [string, string][] = [
    ['Package name', text(pkg.name)],
    ['Destination', text(pkg.destination)],
    ['Duration', text(pkg.duration)],
    ['Short description', text(pkg.short_description)],
    ['Full description', text(pkg.full_description)],
    ['Highlights', listText(pkg.highlights)],
    ['Included', listText(pkg.price_includes)],
    ['Not included', listText(pkg.not_included)],
    ['Itinerary stops', itineraryTitles(pkg.itinerary).join('\n')],
    [
      'Group size',
      (() => {
        const min = text(pkg.min_people)
        const max = text(pkg.max_people)
        return min || max ? `${min || '?'}-${max || '?'} travelers` : ''
      })(),
    ],
  ]
  return rows.filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join('\n')
}

/** True when the row says enough to write from: a description of FAQ_DESCRIPTION_MIN_WORDS or more. */
export function hasFaqSource(pkg: FaqInput): boolean {
  return text(pkg.full_description).split(/\s+/).filter(Boolean).length >= FAQ_DESCRIPTION_MIN_WORDS
}

export function hasFaqs(faqs: unknown): boolean {
  return Array.isArray(faqs) && faqs.some((f) => f && typeof (f as PackageFaq).question === 'string' && typeof (f as PackageFaq).answer === 'string' && (f as PackageFaq).question.trim() && (f as PackageFaq).answer.trim())
}

// ─── The gate ───────────────────────────────────────────────────────────────────────

/** An en dash or an em dash, built from code points so no dash character sits in this file. */
const LONG_DASH = new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`)

function normNumber(n: string): string {
  const c = n.replace(/,/g, '').replace(/\.+$/, '')
  const f = Number(c)
  return Number.isFinite(f) ? String(f) : c
}

/** Topics that are legal, money or health advice. An answer may mention one only when the row itself does. */
const POLICY_TOPICS: [RegExp, string][] = [
  [/\brefund(?:s|ed|able|ing)?\b/i, 'refund'],
  [/\bdeposits?\b/i, 'deposit'],
  [/\bcancel(?:s|ed|led|ling|ing|lation|lations)?\b/i, 'cancel'],
  [/\bvisas?\b/i, 'visa'],
  [/\bpassports?\b/i, 'passport'],
  [/\bvaccin(?:e|es|ated|ation|ations)\b/i, 'vaccin'],
  [/\bmedical(?:ly)?\b/i, 'medical'],
  [/\binsurance\b/i, 'insurance'],
  [/\bfitness\b/i, 'fitness'],
  [/\bwheelchairs?\b|\baccessib(?:le|ility)\b/i, 'access'],
]

// ─── Word-level grounding (WP12 fix round 1) ────────────────────────────────────────

const STOP_WORDS = new Set(
  ('a about above after again all also am an and any are as at be because been before being below between both but by can could did do does doing down during each few for from further had has have having he her here hers him his how i if in into is it its itself just me more most my no nor not now of off on once only or other our out over own same she should so some such than that the their theirs them then there these they this those through to too under until up very was we were what when where which while who whom why will with would you your yours yes may might many much often usually every get gets getting go goes going let lets one ones way ways time times well'
  ).split(/\s+/),
)

/** A light stem: plural, past and -ing endings off. Two words match when their stems share the first five letters. */
export function stemWord(w: string): string {
  let s = w.toLowerCase()
  if (s.length > 4 && s.endsWith('ies')) s = `${s.slice(0, -3)}y`
  else if (s.length > 5 && s.endsWith('ing')) s = s.slice(0, -3)
  else if (s.length > 4 && s.endsWith('ed')) s = s.slice(0, -2)
  else if (s.length > 4 && s.endsWith('es')) s = s.slice(0, -2)
  else if (s.length > 3 && s.endsWith('s') && !s.endsWith('ss')) s = s.slice(0, -1)
  return s
}
const stemKey = (w: string) => stemWord(w).slice(0, 5)

const wordsOf = (t: string): string[] => t.toLowerCase().match(/[a-z]+(?:'[a-z]+)?/g) ?? []
const contentWords = (t: string): string[] => wordsOf(t).filter((w) => w.length >= 3 && !STOP_WORDS.has(w))

/** Share of an answer's content words that occur (by light stem) in the row text, 0 to 1. */
export function groundedShare(answer: string, grounding: string): number {
  const known = new Set(contentWords(grounding).map(stemKey))
  // Short words and a small set of ordinary advice and filler words are not counted either way: they carry no fact.
  const words = contentWords(answer).filter((w) => w.length >= 4 && !SHARE_FILLER.has(w))
  if (words.length === 0) return 1
  return words.filter((w) => known.has(stemKey(w))).length / words.length
}
const SHARE_FILLER = new Set(['budget', 'separately', 'plan', 'extra', 'pay', 'onboard', 'bring', 'pack', 'evenings', 'mornings', 'usually', 'often', 'before', 'after', 'during', 'aboard', 'getaway'])
export const GROUNDED_SHARE_MIN = 0.7

/** Capitalised words in an answer that are not the first word of a sentence and do not appear in the row text. */
export function capitalisedStrangers(answer: string, grounding: string): string[] {
  const known = new Set(wordsOf(grounding).map((w) => w.replace(/'s$/, '')))
  const out: string[] = []
  for (const sentence of answer.split(/(?<=[.!?])\s+|\n+/)) {
    const tokens = sentence.match(/[\p{L}][\p{L}'’-]*/gu) ?? []
    tokens.forEach((tok, i) => {
      if (i === 0 || tok === 'I' || !/^\p{Lu}/u.test(tok)) return
      const bare = tok.toLowerCase().replace(/['’]s$/, '')
      if (!known.has(bare)) out.push(tok)
    })
  }
  return [...new Set(out)]
}

const INCLUDE_TRIGGER = /\b(?:included?|includes|including|covered|covers?|free|complimentary|gratuities|gratuity|tips?|tipping)\b/i
/** The trigger words that are not things themselves; tips, tipping and gratuities ARE things and must be listed. */
const INCLUDE_FILLER = /^(?:included?|includes|including|covered|covers?|free|complimentary)$/i
const NEGATION = /\b(?:not|no|never|without|excluded?|excludes|isn't|aren't|doesn't|don't|extra)\b|n't\b/i
/** Words in an "included" sentence that are not things (time words, filler, trip words). */
const GENERIC_NOUNS = new Set(['trip', 'trips', 'tour', 'tours', 'journey', 'package', 'price', 'prices', 'morning', 'mornings', 'evening', 'evenings', 'day', 'days', 'night', 'nights', 'week', 'cost', 'costs', 'travel', 'traveller', 'travellers', 'traveler', 'travelers', 'group', 'guests', 'guest', 'people', 'details', 'detail', 'part', 'items', 'item', 'things', 'thing', 'else', 'rest', 'listed', 'stated', 'below', 'above', 'anything', 'everything', 'something', 'cost', 'charge', 'charges', 'fee', 'fees', 'booking', 'page'])

/** Triggers whose object follows them ("includes breakfast", "free wifi"); a passive "is included" has none. */
const ACTIVE_TRIGGER = /^(?:includes?|including|covers?|free|complimentary)$/i

/** For each clause that says something is included, covered, free or tipped: the things it CLAIMS must be in the
 * row's included list (or, for a negated clause, its not-included list). The claim nouns are the nouns before the
 * trigger word, plus the object nouns after an active one ("includes breakfast"); the rest of the clause ("budget for
 * them separately", "on the first night") is not checked here. Returns the claim words that are not listed. */
export function includedClaimStrangers(answer: string, lists: { includes: string; excludes: string }): string[] {
  const out: string[] = []
  for (const clause of answer.split(/(?<=[.!?])\s+|\n+|;/)) {
    const trigger = INCLUDE_TRIGGER.exec(clause)
    if (!trigger) continue
    const list = NEGATION.test(clause) ? lists.excludes : lists.includes
    const known = new Set(contentWords(list).map(stemKey))
    const before = clause.slice(0, trigger.index)
    const after = ACTIVE_TRIGGER.test(trigger[0]) ? clause.slice(trigger.index + trigger[0].length) : ''
    // The trigger itself counts when it is a thing (tips, tipping, gratuities).
    const claim = `${before} ${/^(?:tips?|tipping|gratuit(?:y|ies))$/i.test(trigger[0]) ? trigger[0] : ''} ${after}`
    for (const w of contentWords(claim)) {
      if (w.length < 4 || INCLUDE_FILLER.test(w) || GENERIC_NOUNS.has(w) || NEGATION.test(w)) continue
      if (/(?:ed|ing|ly)$/.test(w) && w !== 'tipping') continue // verbs and adverbs, not things
      if (!known.has(stemKey(w))) out.push(w)
    }
  }
  return [...new Set(out)]
}

const AGENCY_SUBJECT_FAQ = /\b(?:we|our (?:team|hosts?|guides?|advisors?|agents?|staff|company|agency))\b/i
const AGENCY_VERB_FAQ = /\b(?:include[sd]?|provide[sd]?|arrange[sd]?|organi[sz]e[sd]?|handle[sd]?|cover[sd]?|guarantee[sd]?|offer(?:s|ed)?|host(?:s|ed)?|run|runs|ran)\b/i
/** A sentence where the agency says it does, arranges or guarantees something. Only "we can help" and "our team can help" are allowed. */
export function agencyDoes(answer: string): string[] {
  const out: string[] = []
  for (const sentence of answer.split(/(?<=[.!?])\s+|\n+/)) {
    const rest = sentence.replace(/\b(?:we|our team) can help\b/gi, ' ')
    const m = AGENCY_SUBJECT_FAQ.exec(rest)
    if (m && AGENCY_VERB_FAQ.test(rest.slice(m.index + m[0].length))) out.push(sentence.trim())
  }
  return out
}

const NUMBER_WORDS = 'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|dozen'
const PEOPLE_COUNT = new RegExp(`\\b(${NUMBER_WORDS}|\\d+)(?:[- ](?:${NUMBER_WORDS}))?\\s+(?:guests|travell?ers|people|passengers|participants|singles)\\b`, 'gi')
const TENS_WORD = /\b(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|hundreds|thousand|thousands|dozens?)\b/gi

/** Counts of people, and tens or hundreds written as words, that the row text does not itself contain. */
export function peopleCountClaims(answer: string, grounding: string): string[] {
  const lower = grounding.toLowerCase()
  const out: string[] = []
  for (const m of answer.matchAll(PEOPLE_COUNT)) {
    const phrase = m[0].toLowerCase()
    if (!lower.includes(phrase)) out.push(m[0])
  }
  for (const m of answer.matchAll(TENS_WORD)) if (!new RegExp(`\\b${m[0]}\\b`, 'i').test(grounding)) out.push(m[0])
  return [...new Set(out)]
}

export interface FaqLists {
  includes: string
  excludes: string
}

/** Reasons one question and answer must not go live. Empty means clean. `grounding` is the row's own text; `lists`
 * are its included and not-included lists (default: the whole grounding, which is weaker). */
export function faqBlockers(pair: PackageFaq, grounding: string, lists: FaqLists = { includes: grounding, excludes: grounding }): string[] {
  const blockers: string[] = []
  const t = `${pair.question}\n${pair.answer}`
  if (!pair.question.trim() || !pair.answer.trim()) return ['empty']
  if (pair.question.trim().length < 12 || pair.answer.trim().split(/\s+/).length < 5) blockers.push('too short')
  if (pair.answer.trim().split(/\s+/).length > 120) blockers.push('answer too long')
  const prose = proseOf(t)

  const allowed = new Set(numbersIn(grounding).map(normNumber))
  const strangers = [...new Set(numbersIn(prose).map(normNumber).filter((n) => !allowed.has(n)))]
  if (strangers.length) blockers.push(`number not in the trip text: ${strangers.slice(0, 4).join(', ')}`)

  if (LONG_DASH.test(t) || /\s--\s/.test(t)) blockers.push('dash present')
  if (PLACEHOLDER_PATTERNS.some((p) => p.test(t))) blockers.push('placeholder text')
  if (REFUSAL_PATTERNS.some((p) => p.test(t))) blockers.push('model refusal in text')
  // The voice rules read the ANSWER only: a traveller's question says "I" ("How do I book?") and that is fine.
  if (EXPERIENCE_CLAIM_PATTERNS.some((p) => p.test(pair.answer))) blockers.push('claim of personal experience')
  for (const [pattern, label] of SUPERLATIVE_PATTERNS) if (pattern.test(prose)) blockers.push(`superlative or rating claim (${label})`)
  if (RECENCY_PATTERNS.some((p) => p.test(t))) blockers.push('unverifiable recency claim')
  if (COUNT_CLAIM.test(t) || ungroundedWordCounts(t, grounding).length) blockers.push('a count or size not in the trip text')
  if (SCHEDULE_PATTERN.test(t)) blockers.push('schedule stated as fact')
  const claims = [...agencyClaims(pair.answer), ...agencyDoes(pair.answer)]
  if (claims.length) blockers.push(`claim about what the agency has done or does: "${claims[0].slice(0, 80)}"`)
  const names = namedThingsNotInBrief(pair.answer, grounding)
  if (names.length) blockers.push(`name not in the trip text: ${names.slice(0, 3).join(', ')}`)
  const caps = capitalisedStrangers(pair.answer, grounding)
  if (caps.length) blockers.push(`capitalised word not in the trip text: ${caps.slice(0, 3).join(', ')}`)
  const people = peopleCountClaims(pair.answer, grounding)
  if (people.length) blockers.push(`a count of people not in the trip text: ${people.slice(0, 2).join(', ')}`)
  if (/https?:\/\/|\bwww\./i.test(t)) blockers.push('web address in text')
  const lower = grounding.toLowerCase()
  const both = `${pair.question} ${pair.answer}`
  for (const [re, stem] of POLICY_TOPICS) if (re.test(both) && !lower.includes(stem)) blockers.push(`policy or advice topic the trip text never mentions (${stem})`)
  const share = groundedShare(pair.answer, grounding)
  if (share < GROUNDED_SHARE_MIN) blockers.push(`only ${Math.round(share * 100)}% of the answer's words are in the trip text (needs ${Math.round(GROUNDED_SHARE_MIN * 100)}%)`)
  const things = includedClaimStrangers(pair.answer, lists)
  if (things.length) blockers.push(`says something is included, covered or free that the included list does not name: ${things.slice(0, 3).join(', ')}`)
  return blockers
}

/** Repairs dashes, drops every pair that fails the gate, and caps the list. Fewer than FAQ_MIN survivors gives
 * []. Pure: the model's raw list goes in, the list that may be published comes out. */
export function gateFaqs(raw: unknown, grounding: string, lists?: FaqLists): { faqs: PackageFaq[]; discarded: number; reasons: string[] } {
  const list = Array.isArray(raw) ? raw : []
  const faqs: PackageFaq[] = []
  const reasons: string[] = []
  const seen = new Set<string>()
  let discarded = 0
  for (const item of list) {
    const q = typeof (item as PackageFaq)?.question === 'string' ? removeDashes((item as PackageFaq).question.trim()) : ''
    const a = typeof (item as PackageFaq)?.answer === 'string' ? removeDashes((item as PackageFaq).answer.trim()) : ''
    const key = q.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
    if (!q || !a || seen.has(key)) {
      discarded++
      continue
    }
    const blockers = faqBlockers({ question: q, answer: a }, grounding, lists)
    if (blockers.length) {
      discarded++
      reasons.push(...blockers.slice(0, 1))
      continue
    }
    seen.add(key)
    faqs.push({ question: q, answer: a })
    if (faqs.length >= FAQ_MAX) break
  }
  if (faqs.length < FAQ_MIN) return { faqs: [], discarded: Math.max(discarded, list.length), reasons }
  return { faqs, discarded, reasons }
}

// ─── The model call ─────────────────────────────────────────────────────────────────

const RULES = `You are writing FAQ answers for ONE trip page on TravelFunBiz.ca, a Canadian travel agency (hosted group trips, river and ocean cruises, singles getaways).

HARD RULES:
1. Use ONLY facts stated in the TRIP DETAILS below. If the details do not say something, leave that question out. Never guess, round, or add typical details.
2. Write NO digits (0-9) unless the exact same number appears in the TRIP DETAILS. Keep other amounts vague, in words.
3. Never mention refunds, deposits, cancellation, visas, passports, vaccines, medical or insurance matters, fitness or access needs unless the TRIP DETAILS state them. For anything like that, do not write a question at all.
4. Never use: best, number one, award-winning, 5-star, top-rated, world-class, finest, luxury, iconic, famous, renowned, legendary, must-see, brand new, largest, most popular, unforgettable, once in a lifetime.
5. Never claim personal experience or a past trip, never say what the agency or its hosts have done or always do. You may say "we can help you plan" and speak to the reader as "you".
6. Name no hotel, ship, restaurant, person or place that is not in the TRIP DETAILS.
7. No dashes of any kind, no web addresses, no markdown. Canadian spelling, warm, plain English, each answer 1 to 3 sentences.
8. Reuse the wording of the TRIP DETAILS: at least 70 percent of the words in an answer must come from them. Say something is included, covered, free or tipped only if it is named in the Included list, and not included only if it is named in the Not included list. Never say "we include", "we provide", "we arrange" or "we handle".
9. Questions are what a real traveller would ask about THIS trip (what is included, what is not, what a typical day looks like, who it suits, how big the group is) and only those the details can answer.`

function prompt(context: string): string {
  return `${RULES}\n\nWrite ${FAQ_MIN + 1} to ${FAQ_MAX} questions with answers. Return ONLY minified JSON of this exact shape: {"faqs":[{"question":"...","answer":"..."}]}\n\nTRIP DETAILS:\n${context}`
}

export interface FaqResult {
  faqs: PackageFaq[]
  /** The model that answered, when one did. */
  model?: string
  usage?: ModelUsage
  /** Questions the gate threw away. */
  discarded: number
  /** Plain English: why there are no FAQs, when there are none. */
  error?: string
  /** HTTP status for the admin route when there is an error. */
  status?: number
  /** True when a model call was made (it may have been billed even if every pair was dropped). */
  called: boolean
  /** True when the model answered but nothing passed the gate (the heal then waits 7 days before trying again). */
  answered?: boolean
}

/** Full result, for callers that show why nothing came back. Never throws. */
export async function generatePackageFaqsDetailed(pkg: FaqInput): Promise<FaqResult> {
  const context = faqContext(pkg)
  if (!text(pkg.name) && !text(pkg.destination)) return { faqs: [], discarded: 0, called: false, status: 400, error: 'Fill in at least the package name or destination first, so the FAQ has something real to answer about.' }
  if (!isAiConfigured()) return { faqs: [], discarded: 0, called: false, status: 503, error: 'AI writing is not configured: set ANTHROPIC_API_KEY.' }
  try {
    const r = await callAnthropic({ max_tokens: 2500, messages: [{ role: 'user', content: prompt(context) }] }, { timeoutMs: 50_000 })
    if (!r) return { faqs: [], discarded: 0, called: true, status: 504, error: 'The AI did not answer in time. Try again.' }
    if (!r.res.ok) return { faqs: [], discarded: 0, called: true, model: r.model, status: 502, error: `AI request failed (HTTP ${r.res.status}).` }
    const payload = await r.res.json().catch(() => null)
    const u = (payload as { usage?: { input_tokens?: number; output_tokens?: number } } | null)?.usage
    const usage = { input: u?.input_tokens ?? 0, output: u?.output_tokens ?? 0 }
    const parsed = parseModelJson<{ faqs?: unknown }>(anthropicText(payload))
    const gated = gateFaqs(parsed?.faqs, context, { includes: listText(pkg.price_includes), excludes: listText(pkg.not_included) })
    if (gated.faqs.length === 0) {
      return {
        faqs: [], discarded: gated.discarded, called: true, answered: true, model: r.model, usage, status: 422,
        error: gated.discarded > 0
          ? `The AI draft did not pass the quality check (${gated.reasons[0] ?? 'too few usable answers'}), so no FAQs were added. Add more detail to the trip and try again.`
          : 'The package details do not say enough to write honest FAQs yet. Add more detail and try again.',
      }
    }
    return { faqs: gated.faqs, discarded: gated.discarded, called: true, model: r.model, usage }
  } catch (e) {
    return { faqs: [], discarded: 0, called: true, status: 500, error: e instanceof Error ? e.message : 'Generation failed' }
  }
}

/** 4 to 6 grounded, gated FAQs for a trip, or [] on any failure. One model call. */
export async function generatePackageFaqs(pkg: FaqInput): Promise<PackageFaq[]> {
  return (await generatePackageFaqsDetailed(pkg)).faqs
}
