import type { SupabaseClient } from '@supabase/supabase-js'
import { classifyVisit } from '@/lib/traffic-source'

// Ported from Nomad Escape Plan's lib/purchase-ledger.ts (Factory Phase 4: leads/CRM, inbound
// side), trimmed to what this site actually sells. Dropped Nomad's product taxonomy entirely
// (product_kind "toolkit"|"kit"|"vault", fast_track/fast_track_cents) - this site sells travel
// packages, so a purchase references travel_packages by slug instead, and there's no fast-track
// upsell concept. Kept the parts that are genuinely generic: the transaction-id dedup, the
// email/tag test-purchase detection, and attribution enrichment via lib/traffic-source.ts's
// classifier (Phase 3) when GHL's own custom data carries UTM tags.
export interface OrderItem {
  id?: string
  title: string
  price_cents: number
  quantity: number
  line_cents: number
}

export interface OrderInput {
  provider: string
  provider_order_id: string
  email: string | null
  ghl_contact_id: string | null
  status: 'paid' | 'refunded'
  is_test: boolean
  amount_cents: number
  subtotal_cents: number | null
  discount_cents: number | null
  tax_cents: number | null
  currency: string
  coupon_code: string | null
  gateway: string | null
  payment_source: string | null
  package_slug: string | null
  items: OrderItem[]
  paid_at: string | null
  ghl_attribution: {
    utm_source?: string
    utm_medium?: string
    utm_campaign?: string
    utm_content?: string
  }
}

/** "49.99" or 49.99 -> 4999. Never NaN - malformed input is 0, not a crash. */
export function toCents(v: unknown): number {
  const n = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : NaN
  return Number.isFinite(n) ? Math.round(n * 100) : 0
}

const TEST_COUPON_CODES = new Set(['TEST', 'TESTPURCHASE'])

function tagTokens(tags: unknown): string[] {
  const list = Array.isArray(tags) ? tags : String(tags ?? '').split(',')
  return list.map((t) => String(t).trim().toLowerCase()).filter(Boolean)
}

/** GHL's raw webhook payload -> a normalized order, or null if this ping wasn't a purchase at
 * all (GHL sends the same webhook shape for other contact events too - a payload only counts once
 * it carries a real transaction id). Pure - never touches the database. */
export function parseGhlOrder(body: Record<string, unknown>): OrderInput | null {
  const payment = body?.payment as Record<string, unknown> | undefined
  const transactionId = payment?.transaction_id
  if (!transactionId) return null

  const contact = body?.contact as Record<string, unknown> | undefined
  const email = String(body?.email ?? contact?.email ?? body?.customer_email ?? '').trim().toLowerCase() || null
  const couponCode = (payment?.coupon_code as string | undefined) || null
  const amount_cents = toCents(payment?.total_amount)
  const isTestCoupon = !!couponCode && TEST_COUPON_CODES.has(couponCode.toUpperCase())
  const isTestTag = tagTokens(body?.tags).includes('test-purchase')

  const items: OrderItem[] = Array.isArray(payment?.line_items)
    ? (payment!.line_items as Record<string, unknown>[]).map((li) => ({
        id: li?.id != null ? String(li.id) : undefined,
        title: String(li?.title ?? li?.name ?? ''),
        price_cents: toCents(li?.price),
        quantity: Number(li?.quantity) || 1,
        line_cents: toCents(li?.line_price ?? li?.price),
      }))
    : []

  const customData = (body?.customData as Record<string, unknown>) || {}

  return {
    provider: 'ghl',
    provider_order_id: String(transactionId),
    email,
    ghl_contact_id: (body?.contact_id as string) || (contact?.id as string) || null,
    status: 'paid',
    is_test: isTestCoupon || (amount_cents === 0 && isTestTag),
    amount_cents,
    subtotal_cents: payment?.sub_total_amount != null ? toCents(payment.sub_total_amount) : null,
    discount_cents: payment?.discount_amount != null ? toCents(payment.discount_amount) : null,
    tax_cents: payment?.tax_amount != null ? toCents(payment.tax_amount) : null,
    currency: String(payment?.currency_code ?? 'USD').toUpperCase(),
    coupon_code: couponCode,
    gateway: (payment?.gateway as string) || null,
    payment_source: (payment?.source as string) || null,
    package_slug: (customData?.package_slug as string) || null,
    items,
    paid_at: (payment?.created_at as string) || null,
    ghl_attribution: {
      utm_source: customData?.utm_source as string | undefined,
      utm_medium: customData?.utm_medium as string | undefined,
      utm_campaign: customData?.utm_campaign as string | undefined,
      utm_content: customData?.utm_content as string | undefined,
    },
  }
}

/** Write (or update, if this transaction id was already seen) one order row. Attribution:
 * classify GHL's own custom-data UTM tags with the Phase 3 traffic-source engine. A real
 * lead-first-touch lookup (matching by email against a leads table with a first-touch cookie)
 * would be stronger, but no such table exists in this project yet - that's tracking-foundation
 * territory (Decision 8, still blocked on Joel's consent wording), not something to invent here. */
export async function recordOrder(admin: SupabaseClient, input: OrderInput, webhookEventId: string | null): Promise<{ error?: string }> {
  const utm = input.ghl_attribution
  let channel: string | null = null
  let channelSource: string | null = null
  let attributionBasis = 'none'

  if (utm.utm_source || utm.utm_medium) {
    const classified = classifyVisit({ utmSource: utm.utm_source, utmMedium: utm.utm_medium })
    channel = classified.channel
    channelSource = classified.source
    attributionBasis = 'ghl_custom_data'
  }

  const row = {
    provider: input.provider,
    provider_order_id: input.provider_order_id,
    webhook_event_id: webhookEventId,
    email: input.email,
    ghl_contact_id: input.ghl_contact_id,
    status: input.status,
    is_test: input.is_test,
    amount_cents: input.amount_cents,
    subtotal_cents: input.subtotal_cents,
    discount_cents: input.discount_cents,
    tax_cents: input.tax_cents,
    currency: input.currency,
    coupon_code: input.coupon_code,
    gateway: input.gateway,
    payment_source: input.payment_source,
    package_slug: input.package_slug,
    items: input.items,
    channel,
    channel_source: channelSource,
    utm_source: utm.utm_source || null,
    utm_medium: utm.utm_medium || null,
    utm_campaign: utm.utm_campaign || null,
    utm_content: utm.utm_content || null,
    attribution_basis: attributionBasis,
    paid_at: input.paid_at,
  }

  const { error } = await admin.from('orders').upsert(row, { onConflict: 'provider,provider_order_id' })
  return error ? { error: error.message } : {}
}
