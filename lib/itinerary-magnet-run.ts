import { isHoneypotFilled } from '@/lib/abuse-guard'
import { isPastTrip } from '@/lib/past-trip'
import { isTestPerson } from '@/lib/test-data'
import type { LeadAckInput } from '@/lib/lead-ack'
import { buildItineraryLead, itineraryEmailNote, itineraryPath, itineraryRequestSchema, signItineraryToken, type ItineraryLeadInput, type ItineraryMode } from '@/lib/itinerary-magnet'

// The request handler for "Send me the itinerary and dates", with every outside thing passed in (deps) so
// scripts/check-itinerary-magnet.ts can run the whole flow offline. app/api/itinerary-request/route.ts wires the real ones.
//
// The order, and why:
//   1. honeypot, then the mode: off means "not found" and NOTHING else runs (no lead, no counter, no email).
//   2. the form (consent must be true), then the per-IP throttle.
//   3. the trip must be published and not already past.
//   4. the lead is saved through the SAME functions the trip callback form uses (lib/leads.ts), BEFORE GoHighLevel is called.
//   5. the signed link is made, the email goes through the existing lead reply path (lib/lead-ack.ts) and its result is written
//      onto the lead so the Lead desk card says whether the email went. The on-screen itinerary never depends on the email.

export interface ItineraryTrip {
  name: string
  slug: string
  available_to: string | null
  recap_mode?: 'auto' | 'recap' | 'live' | null
}

export interface ItineraryRunDeps {
  getMode: () => Promise<ItineraryMode>
  allow: () => Promise<boolean>
  getTrip: (slug: string) => Promise<ItineraryTrip | null>
  /** lib/leads.ts saveLeadFirst. Returns the new row id, or null when the save failed. */
  saveLead: (lead: ItineraryLeadInput) => Promise<string | null>
  /** lib/gohighlevel.ts submitLeadToGoHighLevel. */
  forward: (lead: ItineraryLeadInput & { submittedAt: string }) => Promise<{ ok: boolean; error?: string }>
  markSent: (id: string, result: { ok: boolean; error?: string }) => Promise<void>
  /** lib/lead-ack.ts sendLeadAck. */
  sendAck: (input: LeadAckInput) => Promise<string>
  /** Writes the email result onto the lead (its message), best effort. */
  noteEmail: (id: string, message: string) => Promise<void>
  bumpCount: (slug: string) => Promise<void>
  secret: () => string
  now: () => Date
  /** Site origin, no trailing slash, for the link in the email. */
  origin: string
}

export interface ItineraryRunResult {
  status: number
  body: Record<string, unknown>
}

export async function handleItineraryRequest(json: unknown, deps: ItineraryRunDeps): Promise<ItineraryRunResult> {
  if (isHoneypotFilled(json)) return { status: 200, body: { success: true } }

  // Off (the default): the feature does not exist. Nothing below this line runs.
  if ((await deps.getMode()) !== 'on') return { status: 404, body: { error: 'Not found' } }

  const parsed = itineraryRequestSchema.safeParse(json)
  if (!parsed.success) return { status: 400, body: { error: 'Invalid data', message: parsed.error.issues[0]?.message ?? 'Please check your details and tick the box.' } }
  const req = parsed.data

  if (!(await deps.allow())) return { status: 429, body: { error: 'Too many submissions - please try again shortly' } }

  const trip = await deps.getTrip(req.slug)
  if (!trip) return { status: 404, body: { error: 'Trip not found' } }
  if (isPastTrip({ available_to: trip.available_to, recap_mode: trip.recap_mode })) return { status: 404, body: { error: 'This trip has already run' } }

  // No secret means no link can be signed: say so before a lead is created that could not be answered.
  const secret = deps.secret()
  if (!secret) return { status: 503, body: { error: 'This is not available just now. Please call us instead.' } }

  const lead = buildItineraryLead(req, trip)
  const leadId = await deps.saveLead(lead)
  if (!leadId) return { status: 500, body: { error: 'We could not save your request just now. Please try again in a few minutes.' } }

  const result = await deps.forward({ ...lead, submittedAt: deps.now().toISOString() }).catch((e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : 'send failed' }))
  await deps.markSent(leadId, result).catch(() => undefined)

  const path = itineraryPath(signItineraryToken(leadId, trip.slug, secret, deps.now()))
  // The existing lead reply path decides everything: its switch, daily cap, once per address per day, sender settings, test rows.
  const ack = await deps.sendAck({ email: lead.email, name: lead.name, isTest: isTestPerson(lead), itinerary: { url: `${deps.origin}${path}`, tripName: trip.name } }).catch(() => 'failed')
  await deps.noteEmail(leadId, `${lead.message}\n${itineraryEmailNote(ack)}`).catch(() => undefined)
  await deps.bumpCount(trip.slug).catch(() => undefined)

  return { status: 200, body: { success: true, url: path, emailed: ack === 'sent' } }
}
