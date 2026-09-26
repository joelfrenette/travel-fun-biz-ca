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
