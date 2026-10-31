import { dateRangeText } from '@/lib/trip-kit-facts'
import { isPastTrip } from '@/lib/past-trip'
import { isTestPerson } from '@/lib/test-data'

// "Find your trip in 60 seconds": the pure half (no database, no network, no AI). Four questions, plain rules, a few trips.
//
// Everything is behind the app_settings key `trip_quiz_mode` (exactly "on" turns it on; anything else is off). In off mode
// /trip-quiz is a 404, no card is drawn anywhere and no existing page changes.
//
// The matching reads ONLY fields already stored for a published trip (name, category, tags, keywords, destination, duration,
// dates). It never invents a fact: if the stored fields do not support a match, the trip is not shown.

export const TRIP_QUIZ_MODE_KEY = 'trip_quiz_mode'
/** ONE settings key holds the funnel counters: {"<UTC day>": {"started": n, "q1": n, "q2": n, "q3": n, "q4": n, "result": n, "email": n}}. */
export const TRIP_QUIZ_COUNTS_KEY = 'trip_quiz_funnel'
export type TripQuizMode = 'off' | 'on'

/** Only the exact word "on" turns it on. Missing, empty or any other text is off. */
export function parseTripQuizMode(raw: string | null | undefined): TripQuizMode {
  return raw === 'on' ? 'on' : 'off'
}

// ─── The questions ──────────────────────────────────────────────────────────────────

export const WHO_VALUES = ['solo', 'couple', 'friends', 'family', 'group'] as const
export const STYLE_VALUES = ['river', 'ocean', 'guided', 'resort'] as const
export const WHEN_VALUES = ['3m', '6m', '12m', 'unsure'] as const
export const LENGTH_VALUES = ['week', 'two', 'flex'] as const
export type Who = (typeof WHO_VALUES)[number]
export type Style = (typeof STYLE_VALUES)[number]
export type When = (typeof WHEN_VALUES)[number]
export type Length = (typeof LENGTH_VALUES)[number]

export interface QuizAnswers {
  who: Who
  style: Style
  when: When
  length: Length
}

export const QUIZ_KEYS = ['who', 'style', 'when', 'length'] as const
export type QuizKey = (typeof QUIZ_KEYS)[number]
/** The query parameter of each question, in order. */
export const QUIZ_PARAM: Record<QuizKey, string> = { who: 'q1', style: 'q2', when: 'q3', length: 'q4' }

export interface QuizOption {
  value: string
  label: string
}

export const QUIZ_QUESTIONS: { key: QuizKey; title: string; options: QuizOption[] }[] = [
  {
    key: 'who',
    title: 'Who is travelling?',
    options: [
      { value: 'solo', label: 'Just me' },
      { value: 'couple', label: 'Two of us, as a couple' },
      { value: 'friends', label: 'A few friends' },
      { value: 'family', label: 'Family' },
      { value: 'group', label: 'A bigger group' },
    ],
  },
  {
    key: 'style',
    title: 'What kind of trip sounds right?',
    options: [
      { value: 'river', label: 'A river cruise' },
      { value: 'ocean', label: 'An ocean cruise' },
      { value: 'guided', label: 'A guided tour' },
      { value: 'resort', label: 'A resort or beach stay' },
    ],
  },
  {
    key: 'when',
    title: 'When would you like to go?',
    options: [
      { value: '3m', label: 'In the next 3 months' },
      { value: '6m', label: 'In 3 to 6 months' },
      { value: '12m', label: 'In 6 to 12 months' },
      { value: 'unsure', label: 'Not sure yet' },
    ],
  },
  {
    key: 'length',
    title: 'How long would you like to be away?',
    options: [
      { value: 'week', label: 'About a week' },
      { value: 'two', label: 'About two weeks' },
      { value: 'flex', label: 'I am flexible' },
    ],
  },
]

const VALUES: Record<QuizKey, readonly string[]> = { who: WHO_VALUES, style: STYLE_VALUES, when: WHEN_VALUES, length: LENGTH_VALUES }
const LABEL: Record<QuizKey, Record<string, string>> = {
  who: { solo: 'travelling solo', couple: 'travelling as a couple', friends: 'travelling with friends', family: 'travelling as a family', group: 'travelling in a group' },
  style: { river: 'river cruise', ocean: 'ocean cruise', guided: 'guided tour', resort: 'resort or beach' },
  when: { '3m': 'the next 3 months', '6m': '3 to 6 months from now', '12m': '6 to 12 months from now', unsure: 'not sure yet' },
  length: { week: 'about a week', two: 'about two weeks', flex: 'flexible' },
}

export function answerLabel(key: QuizKey, value: string): string {
  return QUIZ_QUESTIONS.find((q) => q.key === key)?.options.find((o) => o.value === value)?.label ?? value
}

const isIn = (key: QuizKey, v: unknown): v is string => typeof v === 'string' && VALUES[key].includes(v)

/** Reads q1..q4 from a query. An answer counts only if every earlier one is valid, so a hand edited URL can never skip a question. */
export function parseQuizAnswers(query: Record<string, string | string[] | undefined>): Partial<QuizAnswers> {
  const out: Partial<QuizAnswers> = {}
  for (const key of QUIZ_KEYS) {
    const raw = query[QUIZ_PARAM[key]]
    const v = Array.isArray(raw) ? raw[0] : raw
    if (!isIn(key, v)) break
    ;(out as Record<string, string>)[key] = v
  }
  return out
}

/** 0 to 3 = the question to ask next (0 is the first); 4 = all four answered, show the result. */
export function quizStep(a: Partial<QuizAnswers>): number {
  return QUIZ_KEYS.findIndex((k) => a[k] === undefined) === -1 ? 4 : QUIZ_KEYS.findIndex((k) => a[k] === undefined)
}

/** A strict check of a finished set of answers (the API and the lead use it). */
export function isCompleteAnswers(a: unknown): a is QuizAnswers {
  if (!a || typeof a !== 'object') return false
  const o = a as Record<string, unknown>
  return QUIZ_KEYS.every((k) => isIn(k, o[k]))
}

// ─── The trips ──────────────────────────────────────────────────────────────────────

/** The stored fields of a trip that matching may read. */
export interface QuizTripInput {
  slug: string
  name: string
  status?: string | null
  destination: string | null
  country?: string | null
  category: string | null
  tags?: string[] | null
  keywords?: string[] | null
  duration: string | null
  duration_days: number | null
  available_from: string | null
  available_to: string | null
  departure_dates: string[] | null
  recap_mode?: 'auto' | 'recap' | 'live' | null
}

const YMD = /^\d{4}-\d{2}-\d{2}$/

/** Adds whole months to a YYYY-MM-DD date (UTC), clamping the day. */
export function addMonthsYmd(ymd: string, months: number): string {
  const [y, m, d] = ymd.split('-').map(Number)
  const total = (y * 12 + (m - 1)) + months
  const ny = Math.floor(total / 12)
  const nm = total % 12
  const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate()
  return `${String(ny).padStart(4, '0')}-${String(nm + 1).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`
}

interface Span {
  start: string
  end: string
}

/** Upcoming dates only: a range or a single departure that has not ended yet. A past date is never returned. */
export function upcomingSpans(t: Pick<QuizTripInput, 'available_from' | 'available_to' | 'departure_dates'>, today: string): Span[] {
  const spans: Span[] = []
  const from = t.available_from && YMD.test(t.available_from) ? t.available_from : null
  const to = t.available_to && YMD.test(t.available_to) ? t.available_to : null
  const s = from || to
  const e = to || from
  // A range that has already started is not an upcoming date: it is never shown and never used to match the "when" answer.
  if (s && e && s >= today) spans.push({ start: s, end: e })
  for (const d of t.departure_dates ?? []) if (typeof d === 'string' && YMD.test(d) && d >= today) spans.push({ start: d, end: d })
  return spans.sort((a, b) => a.start.localeCompare(b.start))
}

/** The upcoming confirmed dates as text (at most 3), exactly as stored. Empty when none are stored. */
export function upcomingDateTexts(t: Pick<QuizTripInput, 'available_from' | 'available_to' | 'departure_dates'>, today: string): string[] {
  const out: string[] = []
  const start = t.available_from || t.available_to
  if (start && YMD.test(start) && start >= today) {
    const r = dateRangeText(t.available_from, t.available_to)
    if (r) out.push(r)
  }
  for (const d of (t.departure_dates ?? []).filter((x): x is string => typeof x === 'string' && YMD.test(x) && x >= today).sort()) {
    const r = dateRangeText(d, null)
    if (r && !out.includes(r)) out.push(r)
  }
  return out.slice(0, 3)
}

function windowFor(when: When, today: string): { start: string; end: string } | null {
  if (when === '3m') return { start: today, end: addMonthsYmd(today, 3) }
  if (when === '6m') return { start: addMonthsYmd(today, 3), end: addMonthsYmd(today, 6) }
  if (when === '12m') return { start: addMonthsYmd(today, 6), end: addMonthsYmd(today, 12) }
  return null
}

/** Days of a trip: the stored number, else a number in the stored duration text ("8 days", "7 nights" is 8 days). Null when neither is stored. */
export function tripDays(t: Pick<QuizTripInput, 'duration' | 'duration_days'>): number | null {
  if (typeof t.duration_days === 'number' && t.duration_days > 0) return t.duration_days
  const m = /(\d{1,3})\s*(day|night)/i.exec(t.duration ?? '')
  if (!m) return null
  return Number(m[1]) + (m[2].toLowerCase() === 'night' ? 1 : 0)
}

const hay = (t: QuizTripInput): string => [t.name, t.category, ...(t.tags ?? []), ...(t.keywords ?? []), t.destination].filter(Boolean).join(' | ').toLowerCase()
const hasWord = (text: string, re: RegExp): boolean => re.test(text)

const RIVER = /\b(river|rivers|riverboat|rhine|danube|douro|seine|rhone|elbe|mekong|nile|mosel|moselle)\b/
const CRUISE = /\bcruis(e|es|ing)\b/
const GUIDED_WORDS = /\b(guided|escorted|tour|tours|hosted|coach)\b/
const GUIDED_CATEGORY = /\b(cultural|adventure|safari|eco-tourism|eco tourism)\b/
const RESORT = /\b(resort|resorts|beach|beaches|all-inclusive|all inclusive|spa)\b/

/** Which styles the stored fields support. Pure. */
export function tripStyles(t: QuizTripInput): Set<Style> {
  const text = hay(t)
  const out = new Set<Style>()
  const river = hasWord(text, RIVER)
  const cruise = hasWord(text, CRUISE)
  if (cruise && river) out.add('river')
  if (cruise && !river) out.add('ocean')
  if (!cruise && river) out.add('river')
  if (!cruise && (hasWord(text, GUIDED_WORDS) || hasWord((t.category ?? '').toLowerCase(), GUIDED_CATEGORY))) out.add('guided')
  if (cruise && hasWord(text, /\b(guided|escorted)\b/)) out.add('guided')
  if (!cruise && hasWord(text, RESORT)) out.add('resort')
  return out
}

/** Who the stored name, category and tags say the trip is for. Empty means the trip says nothing (never a mismatch). */
export function tripAudience(t: QuizTripInput): Set<'solo' | 'couple' | 'family' | 'group'> {
  const text = [t.name, t.category, ...(t.tags ?? [])].filter(Boolean).join(' | ').toLowerCase()
  const out = new Set<'solo' | 'couple' | 'family' | 'group'>()
  if (/\b(singles?|solo)\b/.test(text)) out.add('solo')
  if (/\b(honeymoon|couples?|romantic)\b/.test(text)) out.add('couple')
  if (/\b(family|families|kids)\b/.test(text)) out.add('family')
  if (/\b(groups?|hosted)\b/.test(text)) out.add('group')
  return out
}

// ─── The matching ───────────────────────────────────────────────────────────────────

export interface QuizMatch {
  slug: string
  name: string
  /** One short line per matched answer, built from the stored fields ("matches your river cruise choice"). */
  reasons: string[]
  /** Upcoming confirmed dates as stored. Empty when none are stored. */
  dates: string[]
  score: number
}

export interface QuizResult {
  matches: QuizMatch[]
  /** True when no published, upcoming trip matched well enough. The page then says so plainly and offers an agent. */
  noMatch: boolean
}

export const MAX_QUIZ_MATCHES = 3

function windowText(when: When): string {
  return when === '3m' ? 'in the next 3 months' : when === '6m' ? 'between 3 and 6 months from now' : 'between 6 and 12 months from now'
}

/** Scores one trip against the answers. Null when the trip must not be shown (wrong style, a stored fact that contradicts an answer, or too weak). */
function scoreTrip(t: QuizTripInput, a: QuizAnswers, today: string): QuizMatch | null {
  // A style is required: the trip's stored fields must support the kind of trip chosen.
  if (!tripStyles(t).has(a.style)) return null
  const reasons: string[] = []
  let score = 3
  let matched = 1
  reasons.push(`matches your ${LABEL.style[a.style]} choice`)

  // Who: a stored audience only counts or contradicts for solo, couple and family trips; a trip that says nothing is neutral.
  const aud = tripAudience(t)
  const exclusive = (['solo', 'couple', 'family'] as const).filter((x) => aud.has(x))
  const wanted = a.who === 'friends' ? 'group' : a.who
  if (exclusive.length > 0 && !exclusive.includes(a.who as 'solo' | 'couple' | 'family')) return null
  if (aud.has(wanted as 'solo' | 'couple' | 'family' | 'group')) {
    score += 2
    matched++
    reasons.push(`is listed for people ${LABEL.who[a.who]}`)
  }

  // When: dates the trip really has. Dates that exist but never fall in the chosen window rule the trip out.
  const spans = upcomingSpans(t, today)
  const win = windowFor(a.when, today)
  if (win) {
    if (spans.length > 0) {
      if (!spans.some((s) => s.start <= win.end && s.end >= win.start)) return null
      score += 2
      matched++
      reasons.push(`has confirmed dates ${windowText(a.when)}`)
    }
  } else if (spans.length > 0) {
    matched++
    reasons.push('has confirmed upcoming dates')
  }

  // How long: only when the length is stored. A stored length that is clearly different rules the trip out.
  const days = tripDays(t)
  if (a.length !== 'flex' && days !== null) {
    const fits = a.length === 'week' ? days >= 5 && days <= 9 : days >= 10 && days <= 17
    if (!fits) return null
    score += 2
    matched++
    reasons.push(`runs ${(t.duration ?? '').trim() || `${days} days`}, which fits ${a.length === 'week' ? 'about a week' : 'about two weeks'}`)
  }

  // Never pad with a poor match: the style plus at least one other answer must be supported by stored fields.
  if (matched < 2) return null
  return { slug: t.slug, name: t.name, reasons, dates: upcomingDateTexts(t, today), score }
}

/** The top trips (at most 3) for the answers. Only published trips that have not already run; past dates are never used. Pure. */
export function matchTrips(answers: QuizAnswers, trips: readonly QuizTripInput[], today: string): QuizResult {
  const scored: { m: QuizMatch; start: string }[] = []
  for (const t of trips) {
    if ((t.status ?? 'published') !== 'published') continue
    if (isPastTrip({ available_to: t.available_to, recap_mode: t.recap_mode }, today)) continue
    const m = scoreTrip(t, answers, today)
    if (m) scored.push({ m, start: upcomingSpans(t, today)[0]?.start ?? '9999-12-31' })
  }
  scored.sort((x, y) => y.m.score - x.m.score || x.start.localeCompare(y.start) || x.m.name.localeCompare(y.m.name))
  const matches = scored.slice(0, MAX_QUIZ_MATCHES).map((s) => s.m)
  return { matches, noMatch: matches.length === 0 }
}

// ─── The lead text and the nudge ────────────────────────────────────────────────────

/** Written on a quiz lead's message so the Lead desk, the itinerary page and the nudge can all tell it came from the quiz. */
export const QUIZ_MARKER = '[Trip quiz]'

export function quizLeadLines(answers: QuizAnswers, slugs: readonly string[]): string[] {
  return [
    `${QUIZ_MARKER} Who: ${answerLabel('who', answers.who)}; Style: ${answerLabel('style', answers.style)}; When: ${answerLabel('when', answers.when)}; Length: ${answerLabel('length', answers.length)}`,
    `Matched trips: ${slugs.join(', ')}`,
  ]
}

export const isQuizLeadMessage = (message: string | null | undefined): boolean => (message ?? '').includes(QUIZ_MARKER)

/** Days after the request when the one nudge may go, and how long it stays eligible. */
export const NUDGE_AFTER_DAYS = 3
export const NUDGE_UNTIL_DAYS = 8

const CONSENT_LINE = 'Consent to emails: yes'

export interface NudgeLead {
  id: string
  name?: string | null
  email?: string | null
  message?: string | null
  status?: string | null
  first_contact_at?: string | null
  is_test?: boolean | null
  created_at: string
}

/** The trip slug a quiz lead asked about (the one in its message), or null. */
export function quizLeadSlug(message: string | null | undefined): string | null {
  const m = /\(\/packages\/([A-Za-z0-9][A-Za-z0-9-]*)\)/.exec(message ?? '')
  return m ? m[1] : null
}

/** Pure: may this lead get the one day 3 nudge right now? Needs quiz origin, ticked consent, no contact yet, not won or lost, not a test, and the right age. */
export function nudgeEligible(l: NudgeLead, now: Date): boolean {
  if (l.is_test === true || isTestPerson({ email: l.email, name: l.name })) return false
  if (!isQuizLeadMessage(l.message) || !(l.message ?? '').includes(CONSENT_LINE)) return false
  if (!quizLeadSlug(l.message)) return false
  if (l.first_contact_at) return false
  if (l.status === 'booked' || l.status === 'lost') return false
  if (!l.email) return false
  const created = Date.parse(l.created_at)
  if (!Number.isFinite(created)) return false
  const age = now.getTime() - created
  return age >= NUDGE_AFTER_DAYS * 86_400_000 && age < NUDGE_UNTIL_DAYS * 86_400_000
}

/** The settings key that records the nudge for one lead. It is written BEFORE the send, so a retry can never send twice. */
export const nudgeKey = (leadId: string): string => `quiz_nudge:${leadId}`

/** A recorded nudge blocks another unless it was released (nothing was sent: the daily limit or the once-a-day rule held it back). */
export function nudgeRecorded(raw: string | null | undefined): boolean {
  if (!raw) return false
  try {
    return (JSON.parse(raw) as { result?: unknown }).result !== 'released'
  } catch {
    return true
  }
}

// ─── Counters (admin sees them on System health) ────────────────────────────────────

export const QUIZ_EVENTS = ['started', 'q1', 'q2', 'q3', 'q4', 'result', 'email'] as const
export type QuizEvent = (typeof QUIZ_EVENTS)[number]
export type QuizDayCounts = Record<QuizEvent, number>
export type QuizCounts = Record<string, QuizDayCounts>

const emptyDay = (): QuizDayCounts => ({ started: 0, q1: 0, q2: 0, q3: 0, q4: 0, result: 0, email: 0 })
const KEEP_DAYS = 60

export function parseQuizCounts(raw: string | null | undefined): QuizCounts {
  try {
    const j = JSON.parse(raw ?? '') as unknown
    if (!j || typeof j !== 'object' || Array.isArray(j)) return {}
    const out: QuizCounts = {}
    for (const [day, v] of Object.entries(j as Record<string, unknown>)) {
      if (!YMD.test(day) || !v || typeof v !== 'object') continue
      const d = emptyDay()
      for (const e of QUIZ_EVENTS) {
        const n = (v as Record<string, unknown>)[e]
        if (typeof n === 'number' && n >= 0) d[e] = Math.floor(n)
      }
      out[day] = d
    }
    return out
  } catch {
    return {}
  }
}

/** One more of this event on the UTC day of `now`. Days older than 60 are dropped. */
export function bumpQuizCount(raw: string | null | undefined, event: QuizEvent, now: Date = new Date()): string {
  const counts = parseQuizCounts(raw)
  const day = now.toISOString().slice(0, 10)
  const d = counts[day] ?? emptyDay()
  d[event] += 1
  counts[day] = d
  const keep = Object.keys(counts).sort().slice(-KEEP_DAYS)
  return JSON.stringify(Object.fromEntries(keep.map((k) => [k, counts[k]])))
}

/** Totals over the last `days` UTC days up to and including today. */
export function quizTotals(counts: QuizCounts, now: Date, days: number): QuizDayCounts {
  const total = emptyDay()
  const from = new Date(now.getTime() - (days - 1) * 86_400_000).toISOString().slice(0, 10)
  for (const [day, d] of Object.entries(counts)) {
    if (day < from) continue
    for (const e of QUIZ_EVENTS) total[e] += d[e]
  }
  return total
}
