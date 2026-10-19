// Decides what a lead form tells the visitor. Pure, no imports, so it can be checked offline.
//
// The rule: once the lead is saved in our own table, the visitor is told it worked, even if GoHighLevel
// was slow or down. The row keeps forwarded_to_ghl=false, so lib/heal.ts retries it and Needs attention
// still shows it. An error status is only for the case where neither the save nor GoHighLevel worked.

export interface LeadResponseInput {
  /** The early save (saveLeadFirst) returned a row id. */
  saved: boolean
  /** GoHighLevel accepted the send. */
  ghlOk: boolean
  /** GoHighLevel's error text, used only to tell "not configured" (503) from a failure (502). */
  ghlError?: string
}

export type LeadResponse =
  | { success: true; status: 200; retryLater: boolean }
  | { success: false; status: 502 | 503 }

export function resolveLeadResponse({ saved, ghlOk, ghlError }: LeadResponseInput): LeadResponse {
  if (ghlOk) return { success: true, status: 200, retryLater: false }
  if (saved) return { success: true, status: 200, retryLater: true }
  return { success: false, status: (ghlError ?? '').includes('not configured') ? 503 : 502 }
}
