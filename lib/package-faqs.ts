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
  [/\brefund/i, 'refund'],
  [/\bdeposit/i, 'deposit'],
  [/\bcancel/i, 'cancel'],
  [/\bvisas?\b/i, 'visa'],
  [/\bpassports?\b/i, 'passport'],
  [/\bvaccin/i, 'vaccin'],
  [/\bmedical/i, 'medical'],
  [/\binsurance/i, 'insurance'],
  [/\bfitness\b/i, 'fitness'],
  [/\bwheelchair|\baccessib/i, 'access'],
]

/** Reasons one question and answer must not go live. Empty means clean. `grounding` is the row's own text. */
export function faqBlockers(pair: PackageFaq, grounding: string): string[] {
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
  const claims = agencyClaims(pair.answer)
  if (claims.length) blockers.push(`claim about what the agency has done or does: "${claims[0].slice(0, 80)}"`)
  const names = namedThingsNotInBrief(pair.answer, grounding)
  if (names.length) blockers.push(`name not in the trip text: ${names.slice(0, 3).join(', ')}`)
  if (/https?:\/\/|\bwww\./i.test(t)) blockers.push('web address in text')
  const lower = grounding.toLowerCase()
  for (const [re, stem] of POLICY_TOPICS) if (re.test(pair.answer) && !lower.includes(stem)) blockers.push(`policy or advice topic the trip text never mentions (${stem})`)
  return blockers
}

/** Repairs dashes, drops every pair that fails the gate, and caps the list. Fewer than FAQ_MIN survivors gives
 * []. Pure: the model's raw list goes in, the list that may be published comes out. */
export function gateFaqs(raw: unknown, grounding: string): { faqs: PackageFaq[]; discarded: number; reasons: string[] } {
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
    const blockers = faqBlockers({ question: q, answer: a }, grounding)
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
8. Questions are what a real traveller would ask about THIS trip (what is included, what is not, what a typical day looks like, who it suits, how big the group is) and only those the details can answer.`

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
    const gated = gateFaqs(parsed?.faqs, context)
    if (gated.faqs.length === 0) {
      return {
        faqs: [], discarded: gated.discarded, called: true, model: r.model, usage, status: 422,
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
