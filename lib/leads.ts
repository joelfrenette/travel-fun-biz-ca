import { getSupabaseAdmin } from '@/lib/supabase-admin'
import type { ContactSubmission } from '@/lib/schemas/contact'

// Factory Phase 10: leads/CRM glue. A local backup of every real contact-form submission,
// independent of whether GoHighLevel accepted it. Never throws - a lost backup write must never
// turn into a lost lead on top of it; the visitor still gets whatever the GHL call's own result was.
export async function recordLead(lead: ContactSubmission, forwarded: { ok: boolean; error?: string }): Promise<void> {
  try {
    await getSupabaseAdmin().from('leads').insert({
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
    })
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
  attribution?: ContactSubmission['attribution']
}

const PENDING_NOTE = 'Saved here first; the send to GoHighLevel did not finish.'

/** Saves the lead BEFORE GoHighLevel is called, marked "not sent yet", so a slow or hanging GoHighLevel
 * can never lose it. Returns the row id, or null when even this save failed (the caller then falls back
 * to recordLead after the send, as before). Never throws. */
export async function saveLeadFirst(lead: LeadBackup): Promise<string | null> {
  try {
    const { data, error } = await getSupabaseAdmin()
      .from('leads')
      .insert({
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
      })
      .select('id')
      .single()
    return error ? null : ((data as { id?: string } | null)?.id ?? null)
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
  created_at: string
}
