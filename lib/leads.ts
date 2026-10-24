import { getSupabaseAdmin } from '@/lib/supabase-admin'
import type { ContactSubmission } from '@/lib/schemas/contact'
import { isTestPerson } from '@/lib/test-data'
import { notifyNewLead } from '@/lib/alerts'
import { touchFromAttribution, insertWithTouchFallback } from '@/lib/lead-touch'
import { isHotLead, normalizeIntent, type LeadIntent } from '@/lib/lead-desk'
import { announceHotLead } from '@/lib/lead-desk-store'
import { isGaClientId } from '@/lib/ga4-lead'
import { sendLeadToMeasurementProtocol } from '@/lib/ga4-mp'

interface DeskFacts {
  hot: boolean
  intent: LeadIntent | null
  message: string | null
}

function deskFacts(l: { intent?: unknown; phone?: string | null; message?: string | null; package?: string | null }): DeskFacts {
  return { hot: isHotLead(l), intent: normalizeIntent(l.intent), message: l.message ?? null }
}

// Marks the saved row as hot (and records the intent), then alerts the lead desk once. The columns come from migration 0055;
// before it is applied the update fails quietly and the alert still goes out. Nobody is assigned here: the office decides.
async function markAndAnnounceHot(id: string, isTest: boolean, a: ContactSubmission['attribution'], pkg: string | null | undefined, desk: DeskFacts): Promise<void> {
  try {
    await getSupabaseAdmin().from('leads').update({ hot: desk.hot, intent: desk.intent }).eq('id', id)
  } catch {
    // the desk columns are optional until the migration is applied
  }
  if (!desk.hot) return
  await announceHotLead({ id, isTest, intent: desk.intent, package: pkg, pagePath: a?.page_path, utmSource: a?.utm_source, message: desk.message })
}

// Stores the GA4 client id on the saved row (migration 0056) and sends the server-side GA4 generate_lead. Both are best-effort:
// before the migration is applied the update fails quietly, and without GA4_MEASUREMENT_PROTOCOL_SECRET nothing is sent.
// Nothing here is awaited by the form, and a test lead is stored but never sent to GA4.
async function recordGaClientId(id: string, isTest: boolean, a: ContactSubmission['attribution'], pkg: string | null | undefined, intent: string | null | undefined): Promise<void> {
  const clientId = a?.ga_client_id
  if (!isGaClientId(clientId)) return
  try {
    await getSupabaseAdmin().from('leads').update({ ga_client_id: clientId }).eq('id', id)
  } catch {
    // the column is optional until the migration is applied
  }
  await sendLeadToMeasurementProtocol({ clientId, isTest, tripName: pkg, source: a?.utm_source, intent })
}

// Fire-and-forget: the new lead email can never fail or slow the form (it catches everything itself).
function announceLead(id: string | undefined | null, isTest: boolean, a: ContactSubmission['attribution'], pkg?: string | null, desk?: DeskFacts): void {
  try {
    if (!id) return
    void recordGaClientId(id, isTest, a, pkg, desk?.intent).catch(() => undefined)
    if (desk && (desk.hot || desk.intent)) void markAndAnnounceHot(id, isTest, a, pkg, desk).catch(() => undefined)
    // A hot lead gets the lead desk alert (email to Joel, Shelby and Leslie, plus a text) instead of the plain new lead email.
    if (desk?.hot) return
    void notifyNewLead({ id, isTest, package: pkg, pagePath: a?.page_path, utmSource: a?.utm_source }).catch(() => undefined)
  } catch {
    // never the visitor's problem
  }
}

// Factory Phase 10: leads/CRM glue. A local backup of every real contact-form submission,
// independent of whether GoHighLevel accepted it. Never throws - a lost backup write must never
// turn into a lost lead on top of it; the visitor still gets whatever the GHL call's own result was.
export async function recordLead(lead: ContactSubmission, forwarded: { ok: boolean; error?: string }): Promise<void> {
  try {
    const isTest = isTestPerson(lead)
    const base = {
      name: lead.name,
      email: lead.email,
      phone: lead.phone || null,
      package: lead.package || null,
      travel_date: lead.travelDate || null,
      travelers: lead.travelers || null,
      message: lead.message || null,
      utm_source: lead.attribution?.utm_source || null,
      utm_medium: lead.attribution?.utm_medium || null,
      utm_campaign: lead.attribution?.utm_campaign || null,
      utm_content: lead.attribution?.utm_content || null,
      page_path: lead.attribution?.page_path || null,
      forwarded_to_ghl: forwarded.ok,
      ghl_error: forwarded.ok ? null : (forwarded.error ?? null),
      is_test: isTest,
    }
    // Referrer host, landing path and utm_term: only present in the payload when the visitor accepted analytics.
    const { data, error } = await insertWithTouchFallback(base, touchFromAttribution(lead.attribution), (row) =>
      getSupabaseAdmin().from('leads').insert(row).select('id').single(),
    )
    if (!error) announceLead((data as { id?: string } | null)?.id, isTest, lead.attribution, lead.package, deskFacts(lead))
  } catch {
    // the backup itself failing is never the visitor's problem
  }
}

/** Same facts as a contact-form lead; a newsletter signup is stored in the same table (package says so). */
export interface LeadBackup {
  name: string
  email: string
  phone?: string
  package?: string
  travelDate?: string
  travelers?: string
  message?: string
  /** callback | quote | info, from a hidden field on the form (lib/lead-desk.ts). */
  intent?: string
  attribution?: ContactSubmission['attribution']
}

const PENDING_NOTE = 'Saved here first; the send to GoHighLevel did not finish.'

/** Saves the lead BEFORE GoHighLevel is called, marked "not sent yet", so a slow or hanging GoHighLevel
 * can never lose it. Returns the row id, or null when even this save failed (the caller then falls back
 * to recordLead after the send, as before). Never throws. */
export async function saveLeadFirst(lead: LeadBackup): Promise<string | null> {
  try {
    const isTest = isTestPerson(lead)
    const base = {
      name: lead.name,
      email: lead.email,
      phone: lead.phone || null,
      package: lead.package || null,
      travel_date: lead.travelDate || null,
      travelers: lead.travelers || null,
      message: lead.message || null,
      utm_source: lead.attribution?.utm_source || null,
      utm_medium: lead.attribution?.utm_medium || null,
      utm_campaign: lead.attribution?.utm_campaign || null,
      utm_content: lead.attribution?.utm_content || null,
      page_path: lead.attribution?.page_path || null,
      forwarded_to_ghl: false,
      ghl_error: PENDING_NOTE,
      is_test: isTest,
    }
    // Referrer host, landing path and utm_term: only present in the payload when the visitor accepted analytics.
    const { data, error } = await insertWithTouchFallback(base, touchFromAttribution(lead.attribution), (row) =>
      getSupabaseAdmin().from('leads').insert(row).select('id').single(),
    )
    const id = error ? null : ((data as { id?: string } | null)?.id ?? null)
    announceLead(id, isTest, lead.attribution, lead.package, deskFacts(lead))
    return id
  } catch {
    return null
  }
}

/** Records how the GoHighLevel send ended on the row saveLeadFirst made. Never throws. */
export async function markLeadSent(id: string, result: { ok: boolean; error?: string }): Promise<void> {
  try {
    await getSupabaseAdmin().from('leads').update({ forwarded_to_ghl: result.ok, ghl_error: result.ok ? null : (result.error ?? 'GoHighLevel did not accept it') }).eq('id', id)
  } catch {
    // the row stays "not sent yet", which the Needs attention list shows; never the visitor's problem
  }
}

export interface LeadRow {
  id: string
  name: string
  email: string
  phone: string | null
  package: string | null
  forwarded_to_ghl: boolean
  ghl_error: string | null
  /** A made-up person used to try the forms; never counted in any report (lib/test-data.ts). */
  is_test?: boolean
  /** Consent-gated source fields (migration 0051); null when the visitor did not accept analytics or the column is not there yet. */
  referrer?: string | null
  landing_path?: string | null
  utm_term?: string | null
  utm_source?: string | null
  utm_medium?: string | null
  utm_campaign?: string | null
  utm_content?: string | null
  /** The page the form was on. Stored even without analytics consent. */
  page_path?: string | null
  /** Lead desk (migration 0055). hot = a call-back request or a form with a phone number. Absent before the migration is applied. */
  hot?: boolean
  intent?: string | null
  status?: string | null
  assigned_agent_id?: string | null
  assigned_agent_name?: string | null
  assigned_at?: string | null
  assigned_by?: string | null
  first_contact_at?: string | null
  desk_note?: string | null
  /** True when the lead carries a GA4 client id (migration 0056). The id itself is never sent to the admin screen. */
  has_ga_client_id?: boolean
  created_at: string
}
