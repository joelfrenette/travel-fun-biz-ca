import { createHmac, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { attributionSchema } from '@/lib/attribution'
import { ITINERARY_MARKER } from '@/lib/lead-desk'
import { tripItinerary } from '@/lib/affiliate-text-sources'
import { dateRangeText, inclusionBlocks, isPriceText, priceConfirmedLine, withoutPriceSentences, type PriceConfirmed, type TripKit } from '@/lib/trip-kit-facts'

// "Send me the itinerary and dates": the pure half (no database, no network). The trip page offers a small form; the answer is
// a printable page built ONLY from fields already stored for the trip, behind a signed token tied to the lead.
//
// Everything is behind the app_settings key `itinerary_magnet_mode` (exactly "on" turns it on; anything else is off). In off
// mode the trip page renders nothing extra and the page and the API answer "not found".

export const ITINERARY_MODE_KEY = 'itinerary_magnet_mode'
export const ITINERARY_COUNTS_KEY = 'itinerary_requests'
export type ItineraryMode = 'off' | 'on'

/** Only the exact word "on" turns it on. Missing, empty or any other text is off. */
export function parseItineraryMode(raw: string | null | undefined): ItineraryMode {
  return raw === 'on' ? 'on' : 'off'
}

// ─── The form ───────────────────────────────────────────────────────────────────────

export const itineraryRequestSchema = z.object({
  slug: z.string().trim().min(1).max(200).regex(/^[a-z0-9][a-z0-9-]*$/i, 'Invalid trip'),
  name: z.string().trim().min(1, 'Please tell us your name').max(120),
  email: z.string().trim().email('Enter a valid email'),
  phone: z.string().trim().max(40).optional(),
  // Express consent (CASL): an unticked box the visitor ticks themselves. Refused without it, here and in the browser.
  consent: z.boolean().refine((v) => v === true, { message: 'Please tick the box so we are allowed to email you' }),
  // Honeypot (lib/abuse-guard.ts): real visitors never see or fill this field.
  company_website: z.string().optional(),
  attribution: attributionSchema.optional(),
})

export type ItineraryRequest = z.infer<typeof itineraryRequestSchema>

// The browser side check (itineraryFormProblem) lives in lib/itinerary-form.ts: this file uses node:crypto, so it stays server side.

// ─── The token ──────────────────────────────────────────────────────────────────────

export const ITINERARY_TOKEN_DAYS = 90

/** The signing secret: ITINERARY_TOKEN_SECRET, else SESSION_SECRET. Empty when neither is set (then nothing can be signed). */
export function itinerarySecret(): string {
  return process.env.ITINERARY_TOKEN_SECRET?.trim() || process.env.SESSION_SECRET?.trim() || ''
}

const b64 = (s: string | Buffer): string => Buffer.from(s).toString('base64url')

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(`itinerary-magnet:v1:${payload}`).digest('base64url')
}

/** A signed, unguessable token that names ONE lead and ONE trip. The lead id is in the signed payload, so a token for lead A can never open lead B. */
export function signItineraryToken(leadId: string, slug: string, secret: string, now: Date = new Date()): string {
  if (!secret) throw new Error('no signing secret')
  const exp = Math.floor(now.getTime() / 1000) + ITINERARY_TOKEN_DAYS * 86_400
  const payload = b64(JSON.stringify({ l: leadId, s: slug, e: exp }))
  return `${payload}.${sign(payload, secret)}`
}

export function verifyItineraryToken(token: string, secret: string, now: Date = new Date()): { leadId: string; slug: string } | null {
  try {
    if (!secret || typeof token !== 'string' || token.length > 600) return null
    const [payload, sig, extra] = token.split('.')
    if (!payload || !sig || extra !== undefined) return null
    const want = Buffer.from(sign(payload, secret))
    const got = Buffer.from(sig)
    if (want.length !== got.length || !timingSafeEqual(want, got)) return null
    const j = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { l?: unknown; s?: unknown; e?: unknown }
    if (typeof j.l !== 'string' || typeof j.s !== 'string' || typeof j.e !== 'number') return null
    if (j.e * 1000 <= now.getTime()) return null
    if (!/^[A-Za-z0-9-]{8,64}$/.test(j.l) || !/^[a-z0-9][a-z0-9-]*$/i.test(j.s)) return null
    return { leadId: j.l, slug: j.s }
  } catch {
    return null
  }
}

export const itineraryPath = (token: string): string => `/itinerary/${token}`

// ─── The lead ───────────────────────────────────────────────────────────────────────

export interface ItineraryLeadInput {
  name: string
  email: string
  phone?: string
  package: string
  message: string
  intent: 'itinerary'
  attribution: ItineraryRequest['attribution']
}

/** The lead exactly as the existing lead path takes it (lib/leads.ts saveLeadFirst). The slug is in the message and the page path. */
export function buildItineraryLead(req: Pick<ItineraryRequest, 'name' | 'email' | 'phone' | 'attribution'>, trip: { name: string; slug: string }): ItineraryLeadInput {
  const attribution = { ...req.attribution, page_path: req.attribution?.page_path || `/packages/${trip.slug}` }
  const lead: ItineraryLeadInput = {
    name: req.name.trim(),
    email: req.email.trim(),
    package: trip.name,
    message: `${ITINERARY_MARKER} Trip: ${trip.name} (/packages/${trip.slug})\nConsent to emails: yes (checkbox ticked on the itinerary form)`,
    intent: 'itinerary',
    attribution,
  }
  const phone = (req.phone ?? '').trim()
  if (phone) lead.phone = phone
  return lead
}

// What happened to the email, written onto the lead's message so the Lead desk card can say it.
const EMAIL_NOTE_RE = /\[Itinerary email: (sent|not sent[^\]]*)\]/

export const EMAIL_NOT_SENT_REASON: Record<string, string> = {
  off: 'the instant lead reply is switched off',
  test: 'this is a test lead',
  'invalid-email': 'the email address looks wrong',
  'rate-limited': 'this address was already emailed in the last 24 hours',
  'not-configured': 'the sender is not set up',
  cap: 'the daily email limit was reached',
  failed: 'the email service did not accept it',
}

export function itineraryEmailNote(result: string): string {
  return result === 'sent' ? '[Itinerary email: sent]' : `[Itinerary email: not sent - ${EMAIL_NOT_SENT_REASON[result] ?? 'the email could not be sent'}]`
}

/** "Sent" or "Not sent: reason" for the Lead desk card; null when the lead is not an itinerary request or no result was written yet. */
export function itineraryEmailStatus(message: string | null | undefined): string | null {
  const m = EMAIL_NOTE_RE.exec(message ?? '')
  if (!m) return null
  return m[1] === 'sent' ? 'Sent' : `Not sent${m[1].slice('not sent'.length).replace(/^ - /, ': ')}`
}

export const isItineraryLeadMessage = (message: string | null | undefined, slug: string): boolean =>
  (message ?? '').trimStart().startsWith(ITINERARY_MARKER) && (message ?? '').includes(`(/packages/${slug})`)

// ─── Counter (admin sees it on System health) ───────────────────────────────────────

export type ItineraryCounts = Record<string, { count: number; last: string }>

export function parseItineraryCounts(raw: string | null | undefined): ItineraryCounts {
  try {
    const j = JSON.parse(raw ?? '') as unknown
    if (!j || typeof j !== 'object' || Array.isArray(j)) return {}
    const out: ItineraryCounts = {}
    for (const [slug, v] of Object.entries(j as Record<string, unknown>)) {
      const o = v as { count?: unknown; last?: unknown } | null
      if (o && typeof o.count === 'number' && o.count >= 0 && typeof o.last === 'string') out[slug] = { count: Math.floor(o.count), last: o.last }
    }
    return out
  } catch {
    return {}
  }
}

export function bumpItineraryCount(raw: string | null | undefined, slug: string, now: Date = new Date()): string {
  const counts = parseItineraryCounts(raw)
  counts[slug] = { count: (counts[slug]?.count ?? 0) + 1, last: now.toISOString() }
  return JSON.stringify(counts)
}

// ─── The itinerary page content ─────────────────────────────────────────────────────

export interface ItineraryTripInput {
  name: string
  destination: string
  duration: string
  available_from: string | null
  available_to: string | null
  departure_dates: string[] | null
  price_includes: string | null
  not_included: string | null
  itinerary: unknown
}

export interface ItineraryView {
  title: string
  destination: string
  duration: string | null
  /** Upcoming dates that are stored, as text. Empty when none are stored. */
  dates: string[]
  datesAsk: string | null
  /** Day by day plan exactly as stored (price sentences removed). Empty when none is stored. */
  days: { label: string | null; title: string; text: string }[]
  /** Said plainly when there is no stored day by day plan. */
  noDayPlan: string | null
  /** Only when no day plan is stored: the places the trip's kit names. */
  places: { heading: string; names: string[] } | null
  included: string[]
  includedAsk: string | null
  notIncluded: string[]
  notIncludedAsk: string | null
  /** Only with the agent-confirmed price switch on, and then only its own words. */
  price: { headline: string; note: string } | null
  priceAsk: string | null
  phone: string
}

const YMD = /^\d{4}-\d{2}-\d{2}$/

/** Builds the page from stored fields only. Anything not stored becomes an "ask your agent" line; nothing is invented. Pure. */
export function buildItinerary(input: { trip: ItineraryTripInput; kit: TripKit | null; price: PriceConfirmed | null; today: string; phone: string }): ItineraryView {
  const { trip, kit, price, today, phone } = input
  const upcomingEnd = trip.available_to || trip.available_from
  const range = upcomingEnd && upcomingEnd >= today ? dateRangeText(trip.available_from, trip.available_to) : null
  const departures = (trip.departure_dates ?? []).filter((d): d is string => typeof d === 'string' && YMD.test(d) && d >= today).sort().slice(0, 6)
  const dates: string[] = []
  if (range) dates.push(range)
  for (const d of departures) {
    const t = dateRangeText(d, null)
    if (t && !dates.includes(t)) dates.push(t)
  }

  const days: ItineraryView['days'] = []
  for (const d of tripItinerary(trip)) {
    if (isPriceText(d.title)) continue
    days.push({ label: d.day != null ? `Day ${d.day}` : null, title: d.title, text: withoutPriceSentences(d.description) })
  }

  let places: ItineraryView['places'] = null
  if (days.length === 0 && kit && kit.stops.length > 0) {
    places = { heading: kit.routeKnown ? 'Stops on this trip, in the order the trip lists them' : 'The places this trip is built around', names: kit.stops.map((s) => s.name) }
  }

  const blocks = inclusionBlocks(trip, kit)
  const included = blocks.included.map((f) => f.text)
  const notIncluded = blocks.notIncluded.map((f) => f.text)

  return {
    title: trip.name,
    destination: trip.destination,
    duration: trip.duration?.trim() || null,
    dates,
    datesAsk: dates.length === 0 ? 'Your agent will confirm the next departure dates.' : null,
    days,
    noDayPlan: days.length === 0 ? 'We do not have a day by day plan stored for this trip yet. Your agent will walk you through it. Here is what we do have.' : null,
    places,
    included,
    includedAsk: included.length === 0 ? 'Your agent will confirm exactly what is included for your dates.' : null,
    notIncluded,
    notIncludedAsk: notIncluded.length === 0 ? 'Your agent will confirm what is not included.' : null,
    price: price ? priceConfirmedLine(price) : null,
    priceAsk: price ? null : 'Ask your agent for the current price and what is open.',
    phone,
  }
}
