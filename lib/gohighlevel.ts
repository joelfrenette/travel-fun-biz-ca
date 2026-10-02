// GoHighLevel (CRM) integration. Every lead and newsletter signup becomes a contact there.
import type { ContactSubmission } from '@/lib/schemas/contact'
import type { NewsletterSubmission } from '@/lib/schemas/newsletter'
import type { Attribution } from '@/lib/attribution'
import { SITE_ID } from '@/lib/site'

const API = 'https://rest.gohighlevel.com/v1'

type Result = { ok: true; contactId?: string } | { ok: false; error: string }

function config() {
  const apiKey = process.env.GOHIGHLEVEL_API_KEY
  const locationId = process.env.GOHIGHLEVEL_LOCATION_ID
  if (!apiKey || !locationId) return null
  return { apiKey, locationId, pipelineId: process.env.GOHIGHLEVEL_PIPELINE_ID }
}

function splitName(full: string): { firstName: string; lastName: string } {
  const parts = full.trim().split(/\s+/)
  return { firstName: parts[0] || '', lastName: parts.slice(1).join(' ') }
}

function tagSafe(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60)
}

// Custom field keys must exist in the GoHighLevel location (Settings > Custom Fields) to be stored;
// unknown keys are ignored by the API, so missing fields never fail a lead.
function attributionFields(a: Attribution | undefined): { key: string; value: string }[] {
  if (!a) return []
  const entries: [string, string | undefined][] = [
    ['utm_source', a.utm_source],
    ['utm_medium', a.utm_medium],
    ['utm_campaign', a.utm_campaign],
    ['utm_term', a.utm_term],
    ['utm_content', a.utm_content],
    ['referrer', a.referrer],
    ['landing_page', a.landing_path],
    ['page_url', a.page_path],
    ['first_seen', a.first_seen],
  ]
  return entries.filter((e): e is [string, string] => !!e[1]).map(([key, value]) => ({ key, value }))
}

function attributionTags(a: Attribution | undefined): string[] {
  const tags: string[] = []
  const src = a?.utm_source ? tagSafe(a.utm_source) : ''
  const campaign = a?.utm_campaign ? tagSafe(a.utm_campaign) : ''
  if (src) tags.push(`src-${src}`)
  if (campaign) tags.push(`campaign-${campaign}`)
  return tags
}

async function upsertContact(cfg: NonNullable<ReturnType<typeof config>>, payload: Record<string, unknown>): Promise<Result> {
  const res = await fetch(`${API}/contacts/`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ locationId: cfg.locationId, ...payload }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    // Log only a safe subset: GHL validation/duplicate-contact errors can echo the submitted
    // email or other PII back in the message body, so never log the raw body verbatim.
    console.error('[gohighlevel] contact error:', res.status, body?.message || body?.msg || '(no message)')
    return { ok: false, error: body?.message || body?.msg || `GoHighLevel responded ${res.status}` }
  }
  return { ok: true, contactId: body.contact?.id }
}

export async function submitLeadToGoHighLevel(lead: ContactSubmission): Promise<Result> {
  const cfg = config()
  if (!cfg) return { ok: false, error: 'GoHighLevel is not configured' }

  try {
    const result = await upsertContact(cfg, {
      ...splitName(lead.name),
      email: lead.email,
      phone: lead.phone || '',
      source: 'Website Contact Form',
      tags: ['travel-lead', `site-${SITE_ID}`, tagSafe(lead.package), ...attributionTags(lead.attribution)],
      customFields: [
        { key: 'package_interest', value: lead.package },
        { key: 'travel_date', value: lead.travelDate || '' },
        { key: 'number_of_travelers', value: lead.travelers || '' },
        { key: 'message', value: lead.message || '' },
        { key: 'lead_source', value: 'Website Contact Form' },
        ...attributionFields(lead.attribution),
      ],
    })
    if (!result.ok) return result

    if (cfg.pipelineId && result.contactId) {
      const res = await fetch(`${API}/opportunities/`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          locationId: cfg.locationId,
          pipelineId: cfg.pipelineId,
          contactId: result.contactId,
          name: `${lead.package} - ${lead.name}`,
          status: 'open',
          source: lead.attribution?.utm_source || 'Website',
        }),
      })
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}) as Record<string, unknown>)
        console.error(
          '[gohighlevel] opportunity error:',
          res.status,
          (errBody as { message?: string; msg?: string })?.message ||
            (errBody as { message?: string; msg?: string })?.msg ||
            '(no message)'
        )
      }
    }
    return result
  } catch (error) {
    console.error('[gohighlevel] submit failed:', error)
    return { ok: false, error: 'Could not reach GoHighLevel' }
  }
}

export async function subscribeNewsletterToGoHighLevel(values: NewsletterSubmission): Promise<Result> {
  const cfg = config()
  if (!cfg) return { ok: false, error: 'GoHighLevel is not configured' }

  try {
    return await upsertContact(cfg, {
      ...splitName(values.fullName),
      email: values.email,
      phone: values.phone,
      source: 'Website Newsletter',
      tags: ['newsletter', `site-${SITE_ID}`, ...values.deals.map((d) => `deals-${tagSafe(d)}`), ...attributionTags(values.attribution)],
      customFields: [
        { key: 'deal_interests', value: values.deals.join(', ') },
        { key: 'lead_source', value: 'Website Newsletter' },
        ...attributionFields(values.attribution),
      ],
    })
  } catch (error) {
    console.error('[gohighlevel] newsletter failed:', error)
    return { ok: false, error: 'Could not reach GoHighLevel' }
  }
}
