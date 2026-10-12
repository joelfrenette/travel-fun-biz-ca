// Trip length, "price on request" and host phone numbers, worked out from the SOURCE TEXT in code.
// The AI only reads; it never does this arithmetic. Pure functions, no I/O (checked by
// scripts/check-trip-duration.ts). Nothing is invented: when the text is vague or contradicts itself the
// result is empty and flagged, so the review table says "needs a human" instead of guessing.

export interface TripDuration {
  /** "3 days / 2 nights", "1 day", or null when it cannot be worked out. */
  duration: string | null
  /** Days on the trip, counting the first and last day (Fri to Sun = 3). Null when unknown. */
  duration_days: number | null
  nights: number | null
  basis: 'stated' | 'dates' | 'weekdays' | 'day-trip' | null
  /**
   * 'sure': a clear trip range (dates, or weekdays with trip words), or the only stated count with a trip word nearby.
   * 'suggest': worth showing but a person must click it (a bare count, or a range that clashes with a stated count).
   */
  confidence: 'sure' | 'suggest' | null
  /** ISO dates, only when the source writes the year. */
  startIso: string | null
  endIso: string | null
  /** True when the text hints at a length but it cannot be pinned down safely. */
  ambiguous: boolean
  /** Set when the answer disagrees with another length the source states (the answer is then only a suggestion). */
  conflict: string
  /** Plain-English explanation for the review table. */
  note: string
  /** The exact words in the source the answer came from (empty when null). */
  quote: string
}

const EMPTY: TripDuration = { duration: null, duration_days: null, nights: null, basis: null, confidence: null, startIso: null, endIso: null, ambiguous: false, conflict: '', note: '', quote: '' }

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?'
const WD_PREFIX = '(?:(?:mon|tues?|wed|thu(?:rs?)?|fri|sat|sun)[a-z]*\\.?,?\\s+)?'
// Range joiners: hyphen, en dash, em dash (input only; built from char codes so this file has no dash characters), words.
const DASHES = `-${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}`
const SEP = `(?:[${DASHES}]|\\bto\\b|\\bthrough\\b|\\bthru\\b|\\buntil\\b)`
const ORD = '(?:st|nd|rd|th)?'

const RANGE_MONTH_FIRST = new RegExp(`\\b${WD_PREFIX}${MONTH_RE}\\s+(\\d{1,2})${ORD}(?:,?\\s*(\\d{4}))?\\s*${SEP}\\s*${WD_PREFIX}(?:${MONTH_RE}\\s+)?(\\d{1,2})${ORD}(?:,?\\s*(\\d{4}))?\\b`, 'gi')
const RANGE_DAY_FIRST = new RegExp(`\\b${WD_PREFIX}(\\d{1,2})${ORD}(?:\\s+${MONTH_RE})?\\s*${SEP}\\s*${WD_PREFIX}(\\d{1,2})${ORD}\\s+${MONTH_RE}(?:,?\\s*(\\d{4}))?\\b`, 'gi')
const RANGE_ISO = new RegExp(`\\b(\\d{4})[-/.](\\d{1,2})[-/.](\\d{1,2})\\s*${SEP}\\s*(\\d{4})[-/.](\\d{1,2})[-/.](\\d{1,2})\\b`, 'g')
const RANGE_SLASH = new RegExp(`(?<![\\d/.])(\\d{1,2})[/.](\\d{1,2})[/.](\\d{4})\\s*${SEP}\\s*(\\d{1,2})[/.](\\d{1,2})[/.](\\d{4})(?![\\d/.])`, 'g')

const WD_NAME = '(mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)'
const RANGE_WEEKDAYS = new RegExp(`\\b${WD_NAME}\\b\\.?\\s*${SEP}\\s*${WD_NAME}\\b`, 'gi')

/** Words that say the text is describing a trip (so a weekday range or a bare count is about the trip). */
const TRIP_CONTEXT = /\b(trip|getaway|weekend|retreat|tour|cruise|stay|join us|depart\w*|itinerary|vacation|escape|excursion|sailing|adventure|resort|hotel)\b/i
const CONTEXT_WINDOW = 80

function tripWordNear(text: string, index: number, length: number): boolean {
  return TRIP_CONTEXT.test(text.slice(Math.max(0, index - CONTEXT_WINDOW), index + length + CONTEXT_WINDOW))
}

function monthIndex(name: string): number {
  return MONTHS.indexOf(name.slice(0, 3).toLowerCase())
}

function utcDay(y: number, m: number, d: number): number {
  return Date.UTC(y, m, d) / 86_400_000
}

function validDate(y: number, m: number, d: number): boolean {
  const t = new Date(Date.UTC(y, m, d))
  return t.getUTCFullYear() === y && t.getUTCMonth() === m && t.getUTCDate() === d
}

function iso(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, '0')}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

function label(days: number): { duration: string; nights: number } {
  const nights = Math.max(0, days - 1)
  const dayWord = `${days} ${days === 1 ? 'day' : 'days'}`
  return { duration: nights === 0 ? dayWord : `${dayWord} / ${nights} ${nights === 1 ? 'night' : 'nights'}`, nights }
}

function result(days: number, basis: NonNullable<TripDuration['basis']>, quote: string, note: string, confidence: 'sure' | 'suggest' = 'sure', startIso: string | null = null, endIso: string | null = null, conflict = ''): TripDuration {
  const l = label(days)
  return { duration: l.duration, duration_days: days, nights: l.nights, basis, confidence, startIso, endIso, ambiguous: false, conflict, note, quote: quote.replace(/\s+/g, ' ').trim().slice(0, 120) }
}

function ambiguous(note: string): TripDuration {
  return { ...EMPTY, ambiguous: true, note }
}

// ─── Stated counts ──────────────────────────────────────────────────────────────────

const NUM_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 }
const NUM = '(\\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)'

function toNum(s: string): number {
  return /^\d/.test(s) ? parseInt(s, 10) : NUM_WORDS[s.toLowerCase()]
}

/** What follows a count when it is NOT the trip length: "30 days before departure", "7-day cancellation", "2 night minimum". */
const NOT_LENGTH_AFTER = /^[\s,)]*(?:of\s+(?:booking|departure|travel|sailing|the\s+(?:trip|departure))|before|prior|in advance|ahead|ago|from now|notice|cancell?ation|cancel\w*|refund\w*|deposit|minimum|min\b|payment|due\b|late\b|after\b|per\s+week|a\s+week)/i
/** What comes just before a count when it is NOT the trip length: "within 14 days", "cancel up to 7 days", "at least 2 nights". */
const NOT_LENGTH_BEFORE = /(?:within|after|before|prior to|up to|cancel\w*|refund\w*|deposit|due|at least|minimum(?: of)?|min\.?|notice of|final payment|under|over|every)\s+(?:the\s+)?(?:last\s+)?$/i

interface Stated { days: number; quote: string; near: boolean }

function statedCounts(text: string): { list: Stated[]; lengthRange: string | null } {
  const list: Stated[] = []
  let lengthRange: string | null = null
  const rangeRe = new RegExp(`\\b${NUM}\\s*(?:[${DASHES}]|to|or)\\s*${NUM}[\\s-]*(?:nights?|days?)\\b`, 'gi')
  let work = text
  for (const m of text.matchAll(rangeRe)) lengthRange = lengthRange ?? m[0]
  work = work.replace(rangeRe, (s) => ' '.repeat(s.length))

  const ok = (index: number, matched: string): boolean => {
    const after = work.slice(index + matched.length, index + matched.length + 40)
    const before = work.slice(Math.max(0, index - 30), index)
    return !NOT_LENGTH_AFTER.test(after) && !NOT_LENGTH_BEFORE.test(before)
  }
  const pair = new RegExp(`\\b${NUM}\\s*d(?:ays?)?\\s*(?:[/&,]|and)\\s*${NUM}\\s*n(?:ights?)?\\b`, 'gi')
  for (const m of work.matchAll(pair)) {
    const d = toNum(m[1])
    const n = toNum(m[2])
    const days = d === n + 1 || d === n ? Math.max(d, n + 1) : -1 // contradictory pair forces ambiguity
    if (m.index != null && ok(m.index, m[0])) list.push({ days, quote: m[0], near: tripWordNear(text, m.index, m[0].length) })
  }
  work = work.replace(pair, (s) => ' '.repeat(s.length))
  for (const m of work.matchAll(new RegExp(`\\b${NUM}[\\s-]*nights?\\b`, 'gi'))) {
    if (m.index != null && ok(m.index, m[0])) list.push({ days: toNum(m[1]) + 1, quote: m[0], near: tripWordNear(text, m.index, m[0].length) })
  }
  for (const m of work.matchAll(new RegExp(`\\b${NUM}[\\s-]*days?\\b`, 'gi'))) {
    if (m.index != null && ok(m.index, m[0])) list.push({ days: toNum(m[1]), quote: m[0], near: tripWordNear(text, m.index, m[0].length) })
  }
  return { list: list.filter((f) => f.days === -1 || (f.days >= 1 && f.days <= 60)), lengthRange }
}

// ─── Date ranges ────────────────────────────────────────────────────────────────────

interface DateRange { days: number; startIso: string | null; endIso: string | null; quote: string; unsure: boolean }

function parseRanges(text: string): DateRange[] {
  const out: DateRange[] = []
  const push = (quote: string, sm: number, sd: number, sy: number | null, em: number, ed: number, ey: number | null) => {
    if (/^may\b/.test(quote)) return // lowercase "may 5 to 10" is a verb, not the month
    const yearKnown = sy != null || ey != null
    const baseStart = sy ?? ey ?? 2001
    let endYear = ey ?? sy ?? baseStart
    let startYear = sy ?? ey ?? baseStart
    if (sy == null && ey != null) startYear = em < sm ? ey - 1 : ey
    if (ey == null && sy != null) endYear = em < sm ? sy + 1 : sy
    if (!yearKnown) endYear = em < sm ? baseStart + 1 : baseStart
    if (!validDate(startYear, sm, sd) || !validDate(endYear, em, ed)) return
    const days = utcDay(endYear, em, ed) - utcDay(startYear, sm, sd) + 1
    if (days < 1 || days > 60) return
    // Without a year, a range that crosses the end of February could be one day longer in a leap year.
    let unsure = false
    if (!yearKnown) {
      const leapEndYear = em < sm ? 2001 : 2000
      if (validDate(2000, sm, sd) && validDate(leapEndYear, em, ed)) unsure = utcDay(leapEndYear, em, ed) - utcDay(2000, sm, sd) + 1 !== days
    }
    out.push({ days, startIso: yearKnown ? iso(startYear, sm, sd) : null, endIso: yearKnown ? iso(endYear, em, ed) : null, quote, unsure })
  }
  for (const m of text.matchAll(RANGE_MONTH_FIRST)) {
    const sm = monthIndex(m[1])
    const em = m[4] ? monthIndex(m[4]) : sm
    if (sm < 0 || em < 0) continue
    push(m[0], sm, parseInt(m[2], 10), m[3] ? parseInt(m[3], 10) : null, em, parseInt(m[5], 10), m[6] ? parseInt(m[6], 10) : null)
  }
  for (const m of text.matchAll(RANGE_DAY_FIRST)) {
    const em = monthIndex(m[4])
    const sm = m[2] ? monthIndex(m[2]) : em
    if (sm < 0 || em < 0) continue
    const y = m[5] ? parseInt(m[5], 10) : null
    push(m[0], sm, parseInt(m[1], 10), y, em, parseInt(m[3], 10), y)
  }
  for (const m of text.matchAll(RANGE_ISO)) {
    push(m[0], parseInt(m[2], 10) - 1, parseInt(m[3], 10), parseInt(m[1], 10), parseInt(m[5], 10) - 1, parseInt(m[6], 10), parseInt(m[4], 10))
  }
  for (const m of text.matchAll(RANGE_SLASH)) {
    // 1/22/2027: a part above 12 settles which is the day. Both parts 12 or under is ambiguous, so it is skipped.
    const pick = (a: number, b: number): 'md' | 'dm' | null => (a > 12 && b <= 12 ? 'dm' : b > 12 && a <= 12 ? 'md' : null)
    const o1 = pick(parseInt(m[1], 10), parseInt(m[2], 10))
    const o2 = pick(parseInt(m[4], 10), parseInt(m[5], 10))
    const order = o1 ?? o2
    if (!order || (o1 && o2 && o1 !== o2)) continue
    const at = (a: string, b: string) => (order === 'md' ? [parseInt(a, 10) - 1, parseInt(b, 10)] : [parseInt(b, 10) - 1, parseInt(a, 10)])
    const [sm, sd] = at(m[1], m[2])
    const [em, ed] = at(m[4], m[5])
    push(m[0], sm, sd, parseInt(m[3], 10), em, ed, parseInt(m[6], 10))
  }
  return out
}

/**
 * Works the trip length out of the source text. Order of trust: dates (a range the text writes), then weekdays
 * ("Fri to Sun", only with a trip word nearby), then a stated count ("3-night", "4D/3N", "Two nights").
 * A clear range that clashes with a stated count is returned as a click-only suggestion with `conflict` set.
 * Anything vague or self-contradicting returns nothing and `ambiguous` is true.
 * `isoFrom` / `isoTo` are the already-grounded available_from / available_to; used only when the text has no range
 * of its own.
 */
export function computeTripDuration(text: string, opts: { isoFrom?: string | null; isoTo?: string | null } = {}): TripDuration {
  const src = text.replace(/\s+/g, ' ')

  const { list: stated, lengthRange } = statedCounts(src)
  const statedDays = [...new Set(stated.map((s) => s.days))]
  if (statedDays.includes(-1)) return ambiguous(`The source gives a day count and a night count that do not fit together ("${stated.find((s) => s.days === -1)!.quote}"). Check the length yourself.`)

  const ranges = parseRanges(src)
  const rangeDays = [...new Set(ranges.map((r) => r.days))]

  if (rangeDays.length > 1) return ambiguous(`The source has date ranges of different lengths (${rangeDays.join(', ')} days). Check which one is this trip.`)
  if (rangeDays.length === 1) {
    const r = ranges[0]
    if (r.unsure) return ambiguous(`The dates "${r.quote}" cross the end of February with no year, so the length depends on a leap year. Add the year or type the length.`)
    const clashing = stated.find((s) => s.days !== rangeDays[0])
    const where = r.days === 1 ? 'same-day trip' : `${r.days} days counting the first and last day`
    const note = `Worked out from the dates "${r.quote}": ${where}.`
    if (clashing) {
      const conflict = `The dates "${r.quote}" make ${rangeDays[0]} days but the source also says "${clashing.quote}". The dates are suggested; check which is right.`
      return result(r.days, 'dates', r.quote, `${note} ${conflict}`, 'suggest', r.startIso, r.endIso, conflict)
    }
    return result(r.days, 'dates', r.quote, note, 'sure', r.startIso, r.endIso)
  }

  // A length range with no dates ("1-2 nights", "3-4 days") cannot be turned into one number.
  if (lengthRange) return ambiguous(`The source gives a length range ("${lengthRange}"), not one length. Type the length yourself.`)

  // A pair of already-grounded ISO dates from the extractor (the text had no range this code could read).
  if (opts.isoFrom && opts.isoTo && /^\d{4}-\d{2}-\d{2}$/.test(opts.isoFrom) && /^\d{4}-\d{2}-\d{2}$/.test(opts.isoTo)) {
    const [y1, m1, d1] = opts.isoFrom.split('-').map(Number)
    const [y2, m2, d2] = opts.isoTo.split('-').map(Number)
    if (validDate(y1, m1 - 1, d1) && validDate(y2, m2 - 1, d2)) {
      const days = utcDay(y2, m2 - 1, d2) - utcDay(y1, m1 - 1, d1) + 1
      if (days >= 1 && days <= 60) {
        const q = `${opts.isoFrom} to ${opts.isoTo}`
        const note = `Worked out from the start and end dates ${opts.isoFrom} to ${opts.isoTo}.`
        const clashing = stated.find((s) => s.days !== days)
        if (clashing) {
          const conflict = `The dates ${q} make ${days} days but the source also says "${clashing.quote}". The dates are suggested; check which is right.`
          return result(days, 'dates', q, `${note} ${conflict}`, 'suggest', opts.isoFrom, opts.isoTo, conflict)
        }
        return result(days, 'dates', q, note, 'sure', opts.isoFrom, opts.isoTo)
      }
    }
  }

  // Weekday ranges only count with a trip word nearby ("Mon to Fri 9-5" on an office-hours line is not a trip).
  const wd = [...src.matchAll(RANGE_WEEKDAYS)]
    .map((m) => ({ quote: m[0], index: m.index ?? 0, from: WEEKDAYS.indexOf(m[1].slice(0, 3).toLowerCase()), to: WEEKDAYS.indexOf(m[2].slice(0, 3).toLowerCase()) }))
    .filter((w) => w.from >= 0 && w.to >= 0 && tripWordNear(src, w.index, w.quote.length))
  const wdDays = [...new Set(wd.map((w) => ((w.to - w.from + 7) % 7) + 1))]
  if (wd.length) {
    if (wdDays.length > 1 || wd[0].from === wd[0].to) return ambiguous(`The weekdays "${wd[0].quote}" do not give one clear length. Type the length yourself.`)
    const note = `Worked out from "${wd[0].quote}": ${wdDays[0]} days counting the first and last day.`
    const clashing = stated.find((s) => s.days !== wdDays[0])
    if (clashing) {
      const conflict = `"${wd[0].quote}" makes ${wdDays[0]} days but the source also says "${clashing.quote}". The weekdays are suggested; check which is right.`
      return result(wdDays[0], 'weekdays', wd[0].quote, `${note} ${conflict}`, 'suggest', null, null, conflict)
    }
    return result(wdDays[0], 'weekdays', wd[0].quote, note, 'sure')
  }

  if (statedDays.length > 1) return ambiguous(`The source mentions different lengths (${stated.map((s) => `"${s.quote}"`).join(', ')}). Check which one is the whole trip.`)
  if (statedDays.length === 1) {
    // A bare count is only trusted automatically when it is the only candidate and a trip word is nearby.
    const sure = stated.some((s) => s.near)
    return result(statedDays[0], 'stated', stated[0].quote, `The source states the length: "${stated[0].quote}".${sure ? '' : ' No trip word is near it, so it is only a suggestion.'}`, sure ? 'sure' : 'suggest')
  }

  const dayTrip = src.match(/\b(?:same[- ]day|one[- ]day|1[- ]day|day[- ]trip|day[- ]cruise)\b/i)
  if (dayTrip) return result(1, 'day-trip', dayTrip[0], `The source calls it a ${dayTrip[0].toLowerCase()}: 1 day.`, 'sure')

  if (/\bweekend\b/i.test(src)) return ambiguous('The source says "weekend" but gives no dates or days, and a weekend can be 2 or 3 days. Type the length yourself.')
  return { ...EMPTY }
}

// ─── Price on request ───────────────────────────────────────────────────────────────

export interface PriceOnRequest {
  onRequest: boolean
  quote: string
  /** Why it was not set, when the text mentions pricing but also shows a price. */
  note: string
}

const ASK_VERB = '(?:call|calls|text|contact|email|e-mail|dm|pm|message|ask|inquire|enquire|reach out|reach us|get in touch|phone|ring|whatsapp)'
const PRICE_WORD = '(?:pric(?:e|es|ing)|rates?|cost|costs|quote|quotes)'
const ON_REQUEST_PATTERNS: RegExp[] = [
  new RegExp(`\\b${ASK_VERB}\\b[^.!?\\n]{0,60}?\\b(?:for|about|regarding|on|re)\\b[^.!?\\n]{0,25}?\\b${PRICE_WORD}\\b`, 'i'),
  new RegExp(`\\b${PRICE_WORD}\\b[^.!?\\n]{0,30}?\\b(?:on|upon|by) (?:request|inquiry|enquiry)\\b`, 'i'),
  new RegExp(`\\b${PRICE_WORD}\\b\\s*[:\\-?]\\s*${ASK_VERB}\\b`, 'i'),
  new RegExp(`\\b${PRICE_WORD}\\b[^.!?\\n]{0,20}\\b(?:available|given|provided|sent) (?:on|upon) (?:request|inquiry|enquiry)\\b`, 'i'),
  /\b(?:contact|call|text) (?:us|me|them)? ?for (?:a )?(?:price|pricing|quote)\b/i,
]

/** A price figure in the text: a currency sign with digits, or "from 1,299" / "1299 per person". */
const PRICE_FIGURE = /(?:[$€£]\s?\d[\d,]*(?:\.\d{2})?)|(?:\b\d[\d,]*(?:\.\d{2})?\s*(?:cad|usd|dollars)\b)|(?:\bfrom\s+\d[\d,]{2,})|(?:\b\d[\d,]{2,}\s*(?:per person|pp|p\/p|per couple|double occupancy)\b)/i

/**
 * True only when the text tells the reader to call, text, contact, DM or ask for pricing (or says it is on request)
 * AND shows no price figure itself. Never true otherwise.
 */
export function detectPriceOnRequest(text: string): PriceOnRequest {
  const src = text.replace(/\s+/g, ' ')
  for (const re of ON_REQUEST_PATTERNS) {
    const m = src.match(re)
    if (m) {
      if (PRICE_FIGURE.test(src)) return { onRequest: false, quote: '', note: `The source says to ask for pricing ("${m[0].slice(0, 80)}") but also shows a price figure, so price on request was not set.` }
      return { onRequest: true, quote: m[0].replace(/\s+/g, ' ').trim().slice(0, 120), note: '' }
    }
  }
  return { onRequest: false, quote: '', note: '' }
}

// ─── Phone numbers and emails (never public) ────────────────────────────────────────

export interface HostContact {
  /** "Amy 603-315-2970" when a first name sits right before the number, otherwise just the number. */
  text: string
  phone: string
}

const PHONE_CORE = '(?:\\+?1[\\s.-]?)?\\(?\\b\\d{3}\\)?[\\s.-]?\\d{3}[\\s.-]?\\d{4}\\b'
const EMAIL_CORE = '[\\w.+-]+@[\\w-]+(?:\\.[\\w-]+)+'

/** True when the text holds a phone number or an email address. Public copy must contain neither. */
export function hasContactDetails(text: string): boolean {
  return new RegExp(PHONE_CORE).test(text) || new RegExp(EMAIL_CORE).test(text)
}

/** North American phone numbers in the text. These belong to whoever wrote the post (a host), so they are shown to
 * the admin in the review table and are never printed on a public page. */
export function extractHostContacts(text: string): HostContact[] {
  const out: HostContact[] = []
  const seen = new Set<string>()
  const re = /(?:\b([A-Z][a-z]{1,20})\s*[:\-,(]*\s*)?(?:\+?1[\s.-]?)?\(?\b(\d{3})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})\b/g
  for (const m of text.matchAll(re)) {
    const digits = `${m[2]}${m[3]}${m[4]}`
    if (seen.has(digits) || /^[01]/.test(digits)) continue
    seen.add(digits)
    const phone = `${m[2]}-${m[3]}-${m[4]}`
    out.push({ text: m[1] && !/^(?:Call|Text|Phone|Tel|Cell|Email|Contact|Fax|Or|And)$/i.test(m[1]) ? `${m[1]} ${phone}` : phone, phone })
  }
  return out
}
