import { NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { ghlWebhookUnauthorized } from '@/lib/ghl-webhook-auth'
import { parseGhlOrder, recordOrder } from '@/lib/purchase-ledger'

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
      const { data } = await admin
        .from('webhook_events')
        .insert({
          source: 'ghl',
          status: denied ? denied.status : 200,
          email: (body?.email as string) || (contact?.email as string) || null,
          payload: denied ? { keys: Object.keys(loggable) } : loggable,
        })
        .select('id')
        .single()
      eventId = data?.id ?? null
    } catch {
      // logging must never block the response - and getSupabaseAdmin() throwing (no service-role
      // key configured) is just another reason there's nothing to log yet.
    }

    if (denied) return denied

    const order = parseGhlOrder(body)
    if (order) {
      try {
        await recordOrder(getSupabaseAdmin(), order, eventId)
      } catch {
        // the response GHL sees already succeeded; a ledger failure is logged, not surfaced.
      }
    }

    return NextResponse.json({ ok: true })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}
