import { isAiConfigured, parseModelJson } from '@/lib/ai-verify'
import { callText, removeDashes, numbersIn, proseOf, ungroundedWordCounts, namedThingsNotInBrief, SUPERLATIVE_PATTERNS, PLACEHOLDER_PATTERNS, REFUSAL_PATTERNS, RECENCY_PATTERNS } from '@/lib/guide-composer'
import { happenedLabel } from '@/lib/past-trip'

// Writes the recap of a trip that already happened (growth loop WP14): a short past-tense summary and a few
// highlights, from Joel's OWN journal notes plus the trip page's existing text and its real dates and
// destination. "We" and "our" are allowed here because the notes are Joel's account of a trip that happened.
// ONE model call, never more. The model is not trusted: recapBlockers() checks the result in plain code, and a
// recap that fails it is saved unpublished with the reasons (lib/recap-run.ts decides).

export const RECAP_WORDS_MIN = 110
export const RECAP_WORDS_MAX = 220
export const RECAP_NOTES_MIN = 3
export const RECAP_HIGHLIGHTS_MIN = 3
export const RECAP_HIGHLIGHTS_MAX = 6

export interface RecapNote {
  date: string
  title: string
  body: string
}

export interface RecapTrip {
  name: string
  destination: string
  country?: string | null
  category?: string | null
  duration?: string | null
  available_from: string | null
  available_to: string | null
  short_description?: string | null
  full_description?: string | null
  highlights?: string[] | null
}

export interface Recap {
  summary: string
  highlights: string[]
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/** "2026-06-04" as "June 4, 2026" and "June 4": the forms a recap may use, so their digits are in the grounding. */
function dateForms(ymd: string | null | undefined): string[] {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd ?? '')
  if (!m) return []
  const month = MONTHS[Number(m[2]) - 1]
  if (!month) return []
  const day = Number(m[3])
  return [`${ymd}`, `${month} ${day}, ${m[1]}`, `${month} ${day}`, `${month} ${m[1]}`]
}

/** Notes that can be used: a date or a title or a body, with something written. */
export function usableNotes(notes: RecapNote[] | null | undefined): RecapNote[] {
  return (Array.isArray(notes) ? notes : [])
    .filter((n) => n && typeof n.body === 'string' && (n.body.trim() || (typeof n.title === 'string' && n.title.trim())))
    .map((n) => ({ date: typeof n.date === 'string' ? n.date : '', title: String(n.title ?? '').trim(), body: String(n.body ?? '').trim() }))
    .slice(0, 12)
}

/** Everything the model may use, and the only place a number, a month or a name in the recap may come from.
 * The price is left out on purpose: a recap states no prices. */
export function recapGrounding(trip: RecapTrip, notes: RecapNote[]): string {
  const lines = [`Trip: "${trip.name}"`, `Destination: ${trip.destination}${trip.country ? `, ${trip.country}` : ''}`]
  if (trip.category) lines.push(`Kind of trip: ${trip.category}`)
  if (trip.duration) lines.push(`Length: ${trip.duration}`)
  const when = happenedLabel(trip.available_from, trip.available_to)
  if (when) lines.push(`When it happened: ${when}`)
  const forms = [...new Set([...dateForms(trip.available_from), ...dateForms(trip.available_to)])]
  if (forms.length) lines.push(`Trip dates: ${forms.join('; ')}`)
  if (trip.short_description) lines.push(`Page summary: ${trip.short_description}`)
  if (trip.full_description) lines.push(`Page description: ${trip.full_description.slice(0, 3500)}`)
  if (trip.highlights?.length) lines.push(`Page highlights: ${trip.highlights.join('; ')}`)
  lines.push("Joel's own journal notes from the trip (his account; the main source):")
  for (const n of notes) {
    const forms = dateForms(n.date)
    lines.push(`- ${forms.length ? `${forms.slice(0, 3).join(' / ')}: ` : ''}${n.title ? `${n.title}. ` : ''}${n.body}`)
  }
  return lines.join('\n')
}

export function recapPrompt(trip: RecapTrip, notes: RecapNote[]): string {
  return `You are writing the recap of a trip that has already happened, for the trip page of a Canadian travel agency (TravelFunBiz.ca). The host, Joel, kept the journal notes below. Write the recap from them.

GROUNDING (the only facts you may use):
${recapGrounding(trip, notes)}

Rules:
- Write "summary": ${RECAP_WORDS_MIN + 10} to ${RECAP_WORDS_MAX - 20} words in the PAST tense, warm and plain, Canadian spelling. "We" and "our" are allowed because the notes are the host's own account. Open with one sentence that says what the trip was and where it went.
- Use only things the notes or the page text say. If a detail is not there, leave it out. Do not invent a venue, a restaurant, a person, a guest's name, a quote, a review, or what anyone said or felt. No quotation marks at all.
- Write no digits unless the exact same number is in the GROUNDING; keep amounts vague and in words only when the grounding says them. State no prices, costs, deals or discounts. Mention a month only if the GROUNDING names it.
- Do not use best, number one, award-winning, any star rating, top-rated, world-class, finest, luxury, famous, or similar claims about any place or company. Do not say the trip was brand new or recently built.
- No em dashes or en dashes anywhere; use commas or full stops. No links, no web addresses.
- Write "highlights": ${RECAP_HIGHLIGHTS_MIN} to ${RECAP_HIGHLIGHTS_MAX} short past-tense lines (each under 120 characters) naming things that really happened according to the notes.
Return ONLY minified JSON: {"summary":"...","highlights":["..."]}`
}

const wordCount = (s: string) => s.trim().split(/\s+/).filter(Boolean).length

/** Tidies what the model (or an editing admin) produced: dashes out, spaces collapsed, highlights trimmed. */
export function cleanRecap(raw: { summary?: unknown; highlights?: unknown }): Recap {
  const summary = removeDashes(typeof raw.summary === 'string' ? raw.summary : '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
  const highlights = (Array.isArray(raw.highlights) ? raw.highlights : [])
    .filter((h): h is string => typeof h === 'string' && h.trim().length > 0)
    .map((h) => removeDashes(h.trim()).replace(/\s+/g, ' '))
    .slice(0, RECAP_HIGHLIGHTS_MAX)
  return { summary, highlights }
}

const PRICE_PATTERN = /[$€£]\s?\d|\b\d[\d,.]*\s?(?:CAD|USD|dollars?|bucks)\b|\b(?:CAD|USD)\b|\bper person\b|\bprices?\b|\bpriced\b|\bdiscounts?\b|\bdeals?\b|\bon sale\b|\bonly \$/i
const TESTIMONIAL_PATTERN = /["“”]|\b(?:guests?|travell?ers|clients|everyone|everybody|participants|members) (?:said|told|raved|agreed|loved|described|called)\b|\bfive-star review/i
const MONTH_PATTERN = new RegExp(`\\b(?:${MONTHS.filter((m) => m !== 'May').join('|')})\\b|\\b(?:in|of|during|since|until|from|early|late|mid) May\\b|\\bMay \\d`, 'g')
const LINK_PATTERN = /https?:\/\/|\bwww\.|\]\(/i

/** Reasons a recap must not go live. Empty means clean. `grounding` is recapGrounding() of the same trip. */
export function recapBlockers(recap: Recap, grounding: string, tripName: string): string[] {
  const blockers: string[] = []
  const all = [recap.summary, ...recap.highlights].join('\n')
  const words = wordCount(recap.summary)
  if (words < RECAP_WORDS_MIN) blockers.push(`summary too short (${words} words, need ${RECAP_WORDS_MIN} to ${RECAP_WORDS_MAX})`)
  if (words > RECAP_WORDS_MAX) blockers.push(`summary too long (${words} words, need ${RECAP_WORDS_MIN} to ${RECAP_WORDS_MAX})`)
  if (recap.highlights.length < RECAP_HIGHLIGHTS_MIN) blockers.push(`only ${recap.highlights.length} highlights (need ${RECAP_HIGHLIGHTS_MIN} to ${RECAP_HIGHLIGHTS_MAX})`)
  if (recap.highlights.some((h) => h.length > 160)) blockers.push('a highlight is longer than 160 characters')

  // A number must come from the grounding (the notes, the page text, the real dates). Digits in links do not count.
  const allowed = new Set(numbersIn(grounding))
  const strangers = [...new Set(numbersIn(proseOf(all)).filter((n) => !allowed.has(n)))]
  if (strangers.length) blockers.push(`number not in the notes or the page: ${strangers.slice(0, 5).join(', ')}`)
  const counts = ungroundedWordCounts(all, grounding)
  if (counts.length) blockers.push(`a count written in words that the notes do not say: ${counts.slice(0, 3).join(', ')}`)

  if (PRICE_PATTERN.test(all)) blockers.push('a price, deal or discount')
  for (const [pattern, label] of SUPERLATIVE_PATTERNS) {
    if (pattern.test(proseOf(all))) blockers.push(`superlative or rating claim (${label})`)
  }
  if (RECENCY_PATTERNS.some((p) => p.test(all))) blockers.push('unverifiable recency claim')
  if (TESTIMONIAL_PATTERN.test(all)) blockers.push('a quote or what guests said (testimonials are not written by the site)')
  if (PLACEHOLDER_PATTERNS.some((p) => p.test(all))) blockers.push('placeholder text')
  if (REFUSAL_PATTERNS.some((p) => p.test(all))) blockers.push('model refusal in text')
  if (LINK_PATTERN.test(all)) blockers.push('a link or web address in the recap')
  if (new RegExp('[\\u2014\\u2013]').test(all) || /\s--\s/.test(all)) blockers.push('dash present')

  // A month the trip dates and notes never mention is a date beyond the row's.
  const groundLower = grounding.toLowerCase()
  const months = [...new Set((all.match(MONTH_PATTERN) ?? []).map((m) => (m.match(/[A-Z][a-z]+/) ?? [m])[0]))]
  const strayMonths = months.filter((m) => !groundLower.includes(m.toLowerCase()))
  if (strayMonths.length) blockers.push(`a month the trip dates do not include: ${strayMonths.join(', ')}`)

  // A restaurant, ship, person or place nobody gave us is a made-up detail until proven otherwise.
  const venues = namedThingsNotInBrief(all, `${grounding} ${tripName}`)
  if (venues.length) blockers.push(`named place or person not in the notes or the page: ${venues.slice(0, 3).join(', ')}`)
  return blockers
}

export type ComposedRecap = { ok: true; recap: Recap; blockers: string[]; grounding: string } | { ok: false; error: string }

/** The ONE model call. Returns the recap and the gate's verdict; it never writes to the database. */
export async function composeRecap(trip: RecapTrip, rawNotes: RecapNote[]): Promise<ComposedRecap> {
  const notes = usableNotes(rawNotes)
  if (notes.length < RECAP_NOTES_MIN) return { ok: false, error: `Add at least ${RECAP_NOTES_MIN} journal notes first (a date and a line about what happened). The recap is written only from your own notes.` }
  if (!isAiConfigured()) return { ok: false, error: 'AI writing is not configured (ANTHROPIC_API_KEY is not set).' }
  const grounding = recapGrounding(trip, notes)
  const out = await callText(recapPrompt(trip, notes), 1500, 60_000)
  if (!out.ok) return { ok: false, error: `writing the recap failed: ${out.error}` }
  const json = parseModelJson<{ summary?: unknown; highlights?: unknown }>(out.text)
  if (!json || typeof json !== 'object') return { ok: false, error: 'the recap came back in a form that could not be read' }
  const recap = cleanRecap(json)
  return { ok: true, recap, blockers: recapBlockers(recap, grounding, trip.name), grounding }
}
