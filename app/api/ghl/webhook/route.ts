import { NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { ghlWebhookUnauthorized } from '@/lib/ghl-webhook-auth'
import { handleOrderWrite } from '@/lib/webhook-order-result'
import { belongsToThisSite, parseGhlOrder, recordOrder } from '@/lib/purchase-ledger'

// Factory Phase 4: leads/CRM, inbound side. Dormant until GOHIGHLEVEL_WEBHOOK_SECRET is set in
// GHL's own workflow AND here - until then every call gets a 503 and nothing is written. This is
// new and additive: the existing outbound lead-forwarding code (GOHIGHLEVEL_API_KEY) is untouched.
export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  try {
    let body: Record<string, unknown> = {}
    try {
      body = await request.json()
    } catch {
      body = {}
    }

    const provided = request.headers.get('x-ghl-secret') || (body?.secret as string | undefined) || null
    const denied = ghlWebhookUnauthorized(provided)

    // Every call is logged - accepted or refused - before we act on it. A refused call logs only
    // its payload's key names, never the values (which may include the very secret it got wrong).
    let eventId: string | null = null
    try {
      const admin = getSupabaseAdmin()
      const { secret: _secret, ...loggable } = body
      const contact = body?.contact as Record<string, unknown> | undefined
      // A call that is not about this site (another business's payment in the same GoHighLevel
      // location) is logged by field names only: no email, amount or name is kept.
      const ours = !denied && belongsToThisSite(body)
      const { data } = await admin
        .from('webhook_events')
        .insert({
          source: 'ghl',
          status: denied ? denied.status : 200,
          email: ours ? (body?.email as string) || (contact?.email as string) || null : null,
          payload: ours ? loggable : { keys: Object.keys(loggable), ...(denied ? {} : { skipped: 'not this site' }) },
        })
        .select('id')
        .single()
      eventId = data?.id ?? null
    } catch {
      // logging must never block the response - and getSupabaseAdmin() throwing (no service-role
      // key configured) is just another reason there's nothing to log yet.
    }

    if (denied) return denied

    const order = belongsToThisSite(body) ? parseGhlOrder(body) : null
    if (order) {
      // A failed save answers 500 so GoHighLevel retries (the upsert on provider + provider_order_id
      // makes a retry safe), and the logged event is marked failed so Needs attention can show it.
      const outcome = await handleOrderWrite(
        async () => recordOrder(getSupabaseAdmin(), order, eventId),
        async (errorText) => {
          if (!eventId) return
          const admin = getSupabaseAdmin()
          const { data } = await admin.from('webhook_events').select('payload').eq('id', eventId).single()
          const payload = { ...((data?.payload as Record<string, unknown> | null) ?? {}), order_error: errorText }
          await admin.from('webhook_events').update({ status: 500, payload }).eq('id', eventId)
        },
      )
      if (outcome.status === 500) return NextResponse.json({ error: 'Order could not be saved' }, { status: 500 })
    }

    return NextResponse.json({ ok: true })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}
