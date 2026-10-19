# Overnight log

## Show success when the lead was saved, even if GoHighLevel is slow
- What changed: new `lib/lead-response.ts` (`resolveLeadResponse`). `app/api/submit-lead`, `app/api/newsletter` and `app/api/trip-alerts` now return success 200 when the early save returned a row id, even if the GoHighLevel send failed. The GHL error is still logged, the row keeps `forwarded_to_ghl=false`, so `lib/heal.ts` retries it and Needs attention shows it. An error (502, or 503 when GHL is not configured) is returned only when neither the save nor GHL worked.
- Why it helps: a visitor whose lead is safely stored no longer sees an error and leaves or double-submits, so fewer lost or duplicate leads.
- Note: in submit-lead, `recordLead` (fallback save) returns nothing, so "saved" there means the early save returned an id.
- UAT: `pnpm dlx tsx scripts/check-lead-response.ts`. Live: with GHL unreachable, a form submit shows the thank-you and the leads row shows forwarded_to_ghl=false.
- Migration: none.
