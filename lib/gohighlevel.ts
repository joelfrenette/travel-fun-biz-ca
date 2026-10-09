// GoHighLevel (CRM) integration. Every lead and newsletter signup becomes a contact there.
import type { ContactSubmission } from '@/lib/schemas/contact'
import type { NewsletterSubmission } from '@/lib/schemas/newsletter'
import type { Attribution } from '@/lib/attribution'
import { SITE_ID } from '@/lib/site'

// Two ways in. The private-integration token (GOHIGHLEVEL_PRIVATE_TOKEN, the same one used for social
// posting) talks to GoHighLevel's current API; the older GOHIGHLEVEL_API_KEY talks to the legacy v1
// API, which GoHighLevel has retired. The token is preferred whenever it is set. The site has never
// recorded a live lead (checked 2026-10-09), so neither path has been exercised by a real visitor yet.
const V1_API = 'https://rest.gohighlevel.com/v1'
const V2_API = 'https://services.leadconnectorhq.com'
const V2_VERSION = '2021-07-28'

type Result = { ok: true; contactId?: string } | { ok: false; error: string }

function config() {
  const locationId = (process.env.GOHIGHLEVEL_LOCATION_ID || process.env.LOCATION_ID || '').trim()
  const token = process.env.GOHIGHLEVEL_PRIVATE_TOKEN?.trim()
  const legacyKey = process.env.GOHIGHLEVEL_API_KEY?.trim()
  const apiKey = token || legacyKey
  if (!apiKey || !locationId) return null
  return {
    apiKey,
    v2: !!token,
    locationId,
    pipelineId: process.env.GOHIGHLEVEL_PIPELINE_ID?.trim() || undefined,
    stageId: process.env.GOHIGHLEVEL_PIPELINE_STAGE_ID?.trim() || undefined,
  }
}

const authHeaders = (cfg: NonNullable<ReturnType<typeof config>>): Record<string, string> => ({
  Authorization: `Bearer ${cfg.apiKey}`,
  'Content-Type': 'application/json',
  Accept: 'application/json',
  ...(cfg.v2 ? { Version: V2_VERSION } : {}),
})

/** New-API opportunities need a pipeline stage. Uses the configured one, else the first stage of the pipeline. */
async function firstStageId(cfg: NonNullable<ReturnType<typeof config>>): Promise<string | null> {
  if (cfg.stageId) return cfg.stageId
  try {
    const res = await fetch(`${V2_API}/opportunities/pipelines?locationId=${encodeURIComponent(cfg.locationId)}`, { headers: authHeaders(cfg), cache: 'no-store', signal: AbortSignal.timeout(15_000) })
    if (!res.ok) return null
    const json = (await res.json().catch(() => null)) as { pipelines?: Array<{ id?: string; stages?: Array<{ id?: string; position?: number }> }> } | null
    const stages = json?.pipelines?.find((p) => p.id === cfg.pipelineId)?.stages ?? []
    return [...stages].sort((a, b) => (a.position ?? 0) - (b.position ?? 0))[0]?.id ?? null
  } catch {
    return null
  }
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

type CustomField = { key: string; value: string }

async function postContact(cfg: NonNullable<ReturnType<typeof config>>, payload: Record<string, unknown>, customFields: CustomField[]) {
  // The legacy API stores a custom field as {key, value}; the current one as {key, field_value}.
  const fields = customFields.map((f) => (cfg.v2 ? { key: f.key, field_value: f.value } : f))
  const res = await fetch(cfg.v2 ? `${V2_API}/contacts/upsert` : `${V1_API}/contacts/`, {
    method: 'POST',
    headers: authHeaders(cfg),
    body: JSON.stringify({ locationId: cfg.locationId, ...payload, ...(fields.length ? { customFields: fields } : {}) }),
    signal: AbortSignal.timeout(20_000),
  })
  const body = (await res.json().catch(() => ({}))) as { message?: string | string[]; msg?: string; contact?: { id?: string } }
  return { res, body }
}

async function upsertContact(cfg: NonNullable<ReturnType<typeof config>>, payload: Record<string, unknown> & { customFields?: CustomField[] }): Promise<Result> {
  const { customFields = [], ...rest } = payload
  let { res, body } = await postContact(cfg, rest, customFields)
  // A custom field the location does not have must never cost us the lead: send the contact again
  // without the custom fields (the tags and source still carry the key facts).
  if (!res.ok && res.status >= 400 && res.status < 500 && customFields.length) {
    console.error('[gohighlevel] contact rejected with custom fields, retrying without:', res.status)
    ;({ res, body } = await postContact(cfg, rest, []))
  }
  if (!res.ok) {
    // Log only a safe subset: GHL validation/duplicate-contact errors can echo the submitted
    // email or other PII back in the message body, so never log the raw body verbatim.
    const message = Array.isArray(body?.message) ? body.message.join('; ') : body?.message || body?.msg
    console.error('[gohighlevel] contact error:', res.status, message || '(no message)')
    const hint = res.status === 401 || res.status === 403 ? ' (the GoHighLevel token needs the contacts permission)' : ''
    return { ok: false, error: `${message || `GoHighLevel responded ${res.status}`}${hint}` }
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
      // The current API refuses an opportunity without a pipeline stage; the legacy one did not need it.
      const stageId = cfg.v2 ? await firstStageId(cfg) : null
      if (cfg.v2 && !stageId) console.error('[gohighlevel] no pipeline stage found; set GOHIGHLEVEL_PIPELINE_STAGE_ID')
      const res = cfg.v2 && !stageId
        ? new Response(JSON.stringify({ message: 'no pipeline stage' }), { status: 422 })
        : await fetch(cfg.v2 ? `${V2_API}/opportunities/` : `${V1_API}/opportunities/`, {
            method: 'POST',
            headers: authHeaders(cfg),
            body: JSON.stringify({
              locationId: cfg.locationId,
              pipelineId: cfg.pipelineId,
              ...(stageId ? { pipelineStageId: stageId } : {}),
              contactId: result.contactId,
              name: `${lead.package} - ${lead.name}`,
              status: 'open',
              source: lead.attribution?.utm_source || 'Website',
            }),
            signal: AbortSignal.timeout(20_000),
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
      tags: ['newsletter', 'email-consent', `site-${SITE_ID}`, ...values.deals.map((d) => `deals-${tagSafe(d)}`), ...attributionTags(values.attribution)],
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
