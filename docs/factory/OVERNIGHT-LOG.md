# Overnight log

## Show success when the lead was saved, even if GoHighLevel is slow
- What changed: new `lib/lead-response.ts` (`resolveLeadResponse`). `app/api/submit-lead`, `app/api/newsletter` and `app/api/trip-alerts` now return success 200 when the early save returned a row id, even if the GoHighLevel send failed. The GHL error is still logged, the row keeps `forwarded_to_ghl=false`, so `lib/heal.ts` retries it and Needs attention shows it. An error (502, or 503 when GHL is not configured) is returned only when neither the save nor GHL worked.
- Why it helps: a visitor whose lead is safely stored no longer sees an error and leaves or double-submits, so fewer lost or duplicate leads.
- Note: in submit-lead, `recordLead` (fallback save) returns nothing, so "saved" there means the early save returned an id.
- UAT: `pnpm dlx tsx scripts/check-lead-response.ts`. Live: with GHL unreachable, a form submit shows the thank-you and the leads row shows forwarded_to_ghl=false.
- Migration: none.

## Email Joel the moment a new real lead arrives (no personal data)
- What changed: `notifyNewLead` in `lib/alerts.ts` (plus pure `decideNewLeadNotice`, `buildNewLeadEmail`, `parseDayCount`). Called fire-and-forget from `saveLeadFirst` and `recordLead` in `lib/leads.ts` after a successful insert, so no route file changed and the form can never fail because of it. The email says "New lead", the package or page path, the utm source and a link to /admin/leads. No name, email or phone; any `@` or 7+ digit run in the free text is stripped. Test rows are skipped. Each lead id is claimed once in `app_settings` (`new_lead_notified_<id>`) and at most 20 go out per day (`new_lead_notice_day`); the shared 6 hour throttle is not used. No-op without RESEND_API_KEY.
- Why it helps: Joel hears about a lead within seconds, so follow-up starts sooner and fewer leads go cold.
- Note: newsletter and trip-alert signups also use `saveLeadFirst`, so they trigger the same notice (the package field says which).
- UAT: `pnpm dlx tsx scripts/check-new-lead-alert.ts`. Live: submit a non-test contact form with RESEND_API_KEY set and see one short email; resubmitting does not repeat the same row's notice.
- Migration: none (uses existing `app_settings`).
