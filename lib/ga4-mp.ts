import { buildMeasurementProtocolRequest } from './ga4-lead'

// Server-side GA4 "generate_lead" through the Measurement Protocol, for a lead that carries the visitor's GA client id
// (sent only when the visitor accepted analytics). It ties the lead to the same anonymous GA visitor even when an ad
// blocker stopped the browser event. OFF unless GA4_MEASUREMENT_PROTOCOL_SECRET and NEXT_PUBLIC_GA_ID are both set.
// Fire-and-forget: 3 second limit, never throws, never touches the visitor's response. No personal data is sent.

export const MP_TIMEOUT_MS = 3000

export interface MpLead {
  clientId: string | null | undefined
  isTest: boolean
  tripName?: string | null
  source?: string | null
  intent?: string | null
}

/** Returns true when GA accepted the request. Any problem (no secret, bad id, network, timeout) is false and silent. */
export async function sendLeadToMeasurementProtocol(lead: MpLead, env: Record<string, string | undefined> = process.env): Promise<boolean> {
  try {
    const req = buildMeasurementProtocolRequest({
      measurementId: env.NEXT_PUBLIC_GA_ID,
      apiSecret: env.GA4_MEASUREMENT_PROTOCOL_SECRET,
      clientId: lead.clientId,
      isTest: lead.isTest,
      tripName: lead.tripName,
      source: lead.source,
      intent: lead.intent,
    })
    if (!req) return false
    const res = await fetch(req.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
      signal: AbortSignal.timeout(MP_TIMEOUT_MS),
    })
    return res.ok
  } catch {
    return false
  }
}
