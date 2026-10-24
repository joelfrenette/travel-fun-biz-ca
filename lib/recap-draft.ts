import { isAiConfigured, parseModelJson, callAnthropic, anthropicText } from '@/lib/ai-verify'
import { removeDashes } from '@/lib/guide-composer'
import { site } from '@/lib/site'
import { cleanRecap, contentWords, gateRecap, recapBlockers, recapGrounding, RECAP_HIGHLIGHTS_MAX, RECAP_HIGHLIGHTS_MIN, RECAP_WORDS_MAX, RECAP_WORDS_MIN, usableNotes, type Recap, type RecapNote, type RecapTrip } from '@/lib/recap-composer'
import { firstSentence, phoneLike, type Quote } from '@/lib/recap-studio'

// The AI draft of a recap page (Recap Studio). ONE model call, admin triggered, bounded. The builder, the parser and the
// gate are pure, and the call itself is injectable, so scripts/check-recap-studio.ts runs everything with fakes.
//
// What the model writes: the recap summary and highlights, three FAQ answers (what was it like, who is it for, what to
// know for next time), a few key takeaways, a search title and description. What CODE writes, from the trip record and
// never from the model: the other three FAQs (what was included, can I join the next trip, how to book).
// Every model sentence must be backed by the notes (the same gate as the plain recap, see lib/recap-composer.ts). A draft
// that fails any check stays private with the reasons listed. The blog quality gates (lib/blog-quality.ts) are for blog posts
// and do not apply to a trip page; the guide and recap gates here are the ones that do.

export interface DraftTrip extends RecapTrip {
  slug: string
  price_includes?: string | string[] | null
  next_trip?: { name: string; slug: string } | null
}

export interface DraftInput {
  trip: DraftTrip
  /** Journal notes plus answers: the account of the trip, from Joel or an approved agent. */
  notes: RecapNote[]
  /** Approved quotes only. The page may show them; the writer is told they are not its words to use. */
  quotes: Quote[]
  /** Words from quotes that are NOT approved (pending or rejected). They must not appear in the draft. */
  unapprovedQuoteTexts?: string[]
}

export interface Faq {
  question: string
  answer: string
}

export interface RecapDraft {
  summary: string
  highlights: string[]
  /** Six in all: three written from the notes, three built from the trip record. */
  faqs: Faq[]
  takeaways: string[]
  metaTitle: string
  metaDescription: string
}

export const MODEL_FAQ_COUNT = 3
export const FAQ_TOTAL = 6
export const HELP_LINE = 'We can help you plan this trip, so reach out and we can talk through your options.'
export const DRAFT_MAX_TOKENS = 2200
export const DRAFT_PER_TRIP_PER_DAY = 5

export const MODEL_FAQ_QUESTIONS = ['What was the trip like?', 'Who is this trip for?', 'What should I know for next time?']

// ─── The prompt ─────────────────────────────────────────────────────────────────────────

export function draftGrounding(input: DraftInput): string {
  return recapGrounding(input.trip, usableNotes(input.notes))
}

export function draftPrompt(input: DraftInput): string {
  const notes = usableNotes(input.notes)
  return `You are writing the recap page of a trip that has already happened, for a Canadian travel agency (TravelFunBiz.ca). The notes below are the host's and the travel agent's own account. Write only from them.

GROUNDING (the only facts you may use):
${recapGrounding(input.trip, notes)}

Rules for every field:
- Past tense, warm and plain, Canadian spelling. "We" and "our" are fine. Reuse the notes' own words and facts. A check rejects any sentence whose words are mostly not in the notes or the page, any capitalised name that is not in them, any number or number word they do not use, any price, and any weather, crowd or "how everyone felt" claim they do not make.
- Never invent a venue, restaurant, person, guest name, quote, review, date or what anyone said or felt. No quotation marks at all. No phone numbers, emails or web addresses. No number one, award-winning, top-rated, world-class, luxury or famous. No em dashes or en dashes.

Return ONLY minified JSON:
{"summary":"...","highlights":["..."],"faqs":[{"q":"${MODEL_FAQ_QUESTIONS[0]}","a":"..."},{"q":"${MODEL_FAQ_QUESTIONS[1]}","a":"..."},{"q":"${MODEL_FAQ_QUESTIONS[2]}","a":"..."}],"takeaways":["..."],"meta_title":"...","meta_description":"..."}
- summary: ${RECAP_WORDS_MIN + 10} to ${RECAP_WORDS_MAX - 20} words. The FIRST sentence must answer "what was this trip and where did it go" on its own, because a search box may show only that sentence.
- highlights: ${RECAP_HIGHLIGHTS_MIN} to ${RECAP_HIGHLIGHTS_MAX} short lines (each under 120 characters) naming things the notes say happened.
- faqs: exactly the three questions above, each answer 25 to 70 words, from the notes only. If the notes do not say, say that the notes do not cover it and do not guess. For "Who is this trip for?" use only what the notes say about who it suits.
- takeaways: 3 or 4 short lines (under 110 characters each) a reader could remember, each from the notes.
- meta_title: under 60 characters and contains "${input.trip.name}". meta_description: under 155 characters and contains "${input.trip.name}", honest, no hype.`
}

// ─── The parts built by code ────────────────────────────────────────────────────────────

const PRICE_RE = /[$€£]\s?\d|\b\d[\d,.]*\s?(?:CAD|USD|dollars?|bucks)\b|\b(?:CAD|USD)\b|\bper person\b|\bprices?\b|\bpriced\b|\bdiscounts?\b|\bdeals?\b|\bon sale\b|\bonly \$/i

function includedList(value: string | string[] | null | undefined): string[] {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/\r?\n|;/) : []
  return raw.map((s) => (typeof s === 'string' ? s.replace(/^[\s*\-•]+/, '').trim() : '')).filter(Boolean).slice(0, 12)
}

/** The three FAQs that need no model: what was included (the trip record's own list), joining the next trip, and how to book. */
export function recordFaqs(trip: DraftTrip): Faq[] {
  const items = includedList(trip.price_includes)
  const usable = items.length > 0 && !items.some((i) => PRICE_RE.test(i))
  const included: Faq = {
    question: 'What was included in the trip?',
    answer: usable
      ? `According to the trip page, the trip included: ${items.join('; ')}. Details can change from one trip to the next, so ask us what a similar trip includes.`
      : 'The trip page does not list what was included. Ask us what a similar trip includes and we will tell you.',
  }
  const join: Faq = {
    question: 'Can I join the next trip?',
    answer: trip.next_trip
      ? `Yes, you can look at the next trip like this one, ${trip.next_trip.name}, at /packages/${trip.next_trip.slug}. You can also leave your email on this page to hear when the next trip like this one opens.`
      : 'You can leave your email on this page to hear when the next trip like this one opens. Spots are not held until you book.',
  }
  const phone = site.phone.trim()
  const book: Faq = {
    question: 'How do I book a trip like this?',
    answer: `Send us a note with the form on this page${phone ? ` or call or text ${phone}` : ''}. ${HELP_LINE}`,
  }
  return [included, join, book]
}

// ─── Parsing ────────────────────────────────────────────────────────────────────────────

interface RawDraft {
  summary?: unknown
  highlights?: unknown
  faqs?: unknown
  takeaways?: unknown
  meta_title?: unknown
  meta_description?: unknown
}

const oneLine = (v: unknown, max: number): string => removeDashes(typeof v === 'string' ? v : '').replace(/\s+/g, ' ').trim().slice(0, max)

/** Turns the model's JSON into a draft (dashes out, lengths capped) and adds the three record FAQs. null when the shape is wrong. */
export function parseDraft(raw: unknown, trip: DraftTrip): RecapDraft | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as RawDraft
  const recap = cleanRecap({ summary: r.summary, highlights: r.highlights })
  const modelFaqs: Faq[] = (Array.isArray(r.faqs) ? r.faqs : [])
    .map((f) => ({ question: oneLine((f as { q?: unknown })?.q, 140), answer: oneLine((f as { a?: unknown })?.a, 700) }))
    .filter((f) => f.question && f.answer)
    .slice(0, MODEL_FAQ_COUNT)
  const takeaways = (Array.isArray(r.takeaways) ? r.takeaways : []).map((t) => oneLine(t, 140)).filter(Boolean).slice(0, 4)
  if (!recap.summary) return null
  return { summary: recap.summary, highlights: recap.highlights, faqs: [...modelFaqs, ...recordFaqs(trip)], takeaways, metaTitle: oneLine(r.meta_title, 90), metaDescription: oneLine(r.meta_description, 220) }
}

// ─── The gate ───────────────────────────────────────────────────────────────────────────

const EMAIL_OR_LINK_RE = /[^\s@]+@[^\s@]+\.[^\s@]+|https?:\/\/|\bwww\./i

const wordsIn = (s: string) => s.trim().split(/\s+/).filter(Boolean).length

/** The recap gate's checks on loose text (FAQ answers, takeaways, meta): everything except the summary length and highlight count. */
function looseBlockers(texts: string[], grounding: string, tripName: string): string[] {
  if (texts.length === 0) return []
  return recapBlockers({ summary: texts.join('\n'), highlights: [] }, grounding, tripName).filter((b) => !/^summary too (?:short|long)/.test(b) && !/^only \d+ highlights/.test(b))
}

/** Words of a quote that nobody approved, found in the draft: any run of 5 content words in a row. */
export function usesUnapprovedQuote(draftText: string, quoteTexts: string[]): boolean {
  const d = contentWords(draftText).join(' ')
  for (const q of quoteTexts) {
    const w = contentWords(q)
    // A short quote (under 5 content words) is matched whole; a longer one by any run of 5.
    const run = Math.min(5, w.length)
    if (run < 3) continue
    for (let i = 0; i + run <= w.length; i++) if (d.includes(w.slice(i, i + run).join(' '))) return true
  }
  return false
}

/**
 * Every reason the draft must stay private. Empty means it may be shown to Joel as ready. Pure.
 * Checks: the recap gate (summary, highlights); the same sentence-level checks on the three note-based FAQs, the takeaways and the
 * meta text; six FAQs in all; a title and description of the right size; no phone number but the site's own; no email or link; no
 * words from a quote that was not approved.
 */
export function gateDraft(draft: RecapDraft, input: DraftInput): string[] {
  const notes = usableNotes(input.notes)
  const grounding = recapGrounding(input.trip, notes)
  const blockers = gateRecap({ summary: draft.summary, highlights: draft.highlights }, grounding, input.trip.name, notes)
  const modelFaqs = draft.faqs.slice(0, MODEL_FAQ_COUNT)
  if (draft.faqs.length !== FAQ_TOTAL) blockers.push(`needs ${FAQ_TOTAL} FAQs (has ${draft.faqs.length})`)
  modelFaqs.forEach((f, i) => {
    const n = wordsIn(f.answer)
    if (n < 12 || n > 90) blockers.push(`FAQ ${i + 1} answer is ${n} words (needs 12 to 90)`)
  })
  if (draft.takeaways.length < 3) blockers.push(`only ${draft.takeaways.length} key takeaways (need 3 or 4)`)
  blockers.push(...looseBlockers([...modelFaqs.map((f) => f.answer), ...draft.takeaways], grounding, input.trip.name).map((b) => `FAQs or takeaways: ${b}`))

  const name = input.trip.name.toLowerCase()
  if (draft.metaTitle.length < 10 || draft.metaTitle.length > 60) blockers.push(`search title is ${draft.metaTitle.length} characters (needs 10 to 60)`)
  if (!draft.metaTitle.toLowerCase().includes(name)) blockers.push('search title does not contain the trip name')
  if (draft.metaDescription.length < 50 || draft.metaDescription.length > 155) blockers.push(`search description is ${draft.metaDescription.length} characters (needs 50 to 155)`)
  if (!draft.metaDescription.toLowerCase().includes(name)) blockers.push('search description does not contain the trip name')
  blockers.push(...looseBlockers([draft.metaDescription], grounding, input.trip.name).map((b) => `search description: ${b}`))

  const everything = [draft.summary, ...draft.highlights, ...draft.faqs.flatMap((f) => [f.question, f.answer]), ...draft.takeaways, draft.metaTitle, draft.metaDescription].join('\n')
  const ownDigits = site.phone.replace(/\D/g, '')
  const phones = phoneLike(everything).filter((m) => m.replace(/\D/g, '') !== ownDigits)
  if (phones.length) blockers.push(`a phone number that is not the site's own: ${phones[0].trim()}`)
  if (EMAIL_OR_LINK_RE.test(everything.replace(/\/packages\/[a-z0-9-]+/gi, ''))) blockers.push('an email address or web link')
  if (usesUnapprovedQuote(everything, input.unapprovedQuoteTexts ?? [])) blockers.push('uses words from a quote that has not been approved')
  if (new RegExp('[\\u2014\\u2013]').test(everything)) blockers.push('dash present')
  return [...new Set(blockers)]
}

// ─── Tracing every sentence to its source ───────────────────────────────────────────────

export interface TraceSource {
  label: string
  text: string
}

export interface TracedSentence {
  sentence: string
  /** The source that backs it best, or null when none does. */
  source: string | null
  /** 0 to 1: the share of the sentence's content words found in that source. */
  support: number
}

/** For each sentence of `text`, the note or stored fact whose words back it best. The Studio shows this next to the draft, so
 * Joel can see where every line came from; a sentence with no source is marked and counted. */
export function traceSentences(text: string, sources: TraceSource[]): TracedSentence[] {
  const sentences = text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean)
  const stemmed = sources.map((s) => ({ label: s.label, words: new Set(contentWords(s.text)) }))
  return sentences.map((sentence) => {
    const words = contentWords(sentence)
    if (words.length === 0) return { sentence, source: null, support: 0 }
    let best: { label: string; support: number } | null = null
    for (const s of stemmed) {
      const support = words.filter((w) => s.words.has(w)).length / words.length
      if (!best || support > best.support) best = { label: s.label, support }
    }
    return best && best.support >= 0.5 ? { sentence, source: best.label, support: Math.round(best.support * 100) / 100 } : { sentence, source: null, support: best?.support ?? 0 }
  })
}

/** The sources to trace against: each note by its title, plus the trip record's own text. */
export function traceSourcesFor(input: DraftInput): TraceSource[] {
  const t = input.trip
  const sources: TraceSource[] = usableNotes(input.notes).map((n, i) => ({ label: n.title ? `Note: ${n.title}` : `Note ${i + 1}`, text: `${n.title} ${n.body}` }))
  sources.push({ label: 'Trip record', text: [t.name, t.destination, t.country, t.category, t.duration, t.short_description, t.full_description, ...(t.highlights ?? []), ...includedList(t.price_includes)].filter(Boolean).join(' ') })
  return sources
}

// ─── The call ───────────────────────────────────────────────────────────────────────────

export type CallResult = { ok: true; text: string } | { ok: false; error: string }
export type CallFn = (prompt: string, maxTokens: number, timeoutMs: number) => Promise<CallResult>

/** The real model call, through the shared wrapper (lib/ai-verify.ts), so the AI meter records it under the feature "recap-studio". */
export const defaultCall: CallFn = async (prompt, maxTokens, timeoutMs) => {
  const r = await callAnthropic({ max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }, { timeoutMs, feature: 'recap-studio' })
  if (!r) return { ok: false, error: 'the AI did not answer in time' }
  if (!r.res.ok) return { ok: false, error: `the AI request failed (HTTP ${r.res.status})` }
  const payload = await r.res.json().catch(() => null)
  if ((payload as { stop_reason?: string } | null)?.stop_reason === 'max_tokens') return { ok: false, error: 'the AI reply was cut off' }
  const text = anthropicText(payload)
  return text ? { ok: true, text } : { ok: false, error: 'the AI returned nothing' }
}

export type ComposedDraft = { ok: true; draft: RecapDraft; blockers: string[]; calls: 1 } | { ok: false; error: string; calls: 0 | 1 }

/** The ONE model call. Never writes to the database. A missing key or too few notes returns an error before any call is made. */
export async function composeDraft(input: DraftInput, deps: { call?: CallFn; configured?: boolean } = {}): Promise<ComposedDraft> {
  const notes = usableNotes(input.notes)
  if (notes.length < 3) return { ok: false, error: 'Answer at least 3 of the questions (or add 3 journal notes) first. The recap is written only from them.', calls: 0 }
  if (!(deps.configured ?? isAiConfigured())) return { ok: false, error: 'AI writing is not configured (ANTHROPIC_API_KEY is not set).', calls: 0 }
  const out = await (deps.call ?? defaultCall)(draftPrompt(input), DRAFT_MAX_TOKENS, 70_000)
  if (!out.ok) return { ok: false, error: `writing the recap failed: ${out.error}`, calls: 1 }
  const draft = parseDraft(parseModelJson<RawDraft>(out.text), input.trip)
  if (!draft) return { ok: false, error: 'the draft came back in a form that could not be read', calls: 1 }
  return { ok: true, draft, blockers: gateDraft(draft, input), calls: 1 }
}

/** The quick answer for the page: the first sentence of the recap. */
export const quickAnswerOf = (draft: Pick<RecapDraft, 'summary'>): string => firstSentence(draft.summary)

/** Recap-level view of a draft (what the existing publish path stores in recap_summary and recap_highlights). */
export const recapOf = (draft: RecapDraft): Recap => ({ summary: draft.summary, highlights: draft.highlights })
