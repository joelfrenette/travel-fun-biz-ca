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

## One-tap call or text on trip, guide, blog and destination pages, with click tracking
- What changed: new `components/phone-link.tsx` (`PhoneLink`): a tel:/sms: anchor that calls `track()` with `phone_click` or `sms_click` ({page_path, method}); renders nothing for an empty address. `StickyCta` gets optional `phone`, `callLabel`, `requestHref` props and a third "Call or text now" button (hidden on lg and up, bar slides away while #enquire, #contact or the new #guide-cta section is on screen). `components/guide-page.tsx` now mounts `StickyCta` with `site.phone`, so every guide kind gets it. The plain tel anchors in `app/packages/[slug]/page.tsx`, `components/package-card.tsx`, `components/guide-cta.tsx` and `app/thank-you/page.tsx` became `PhoneLink`. fr and es strings added for the new labels. `lib/site.ts` untouched.
- Why it helps: a phone visitor can call or text our AI agent in one tap from the page they are reading, and every tap is counted by page, so leads from calls become visible.
- Note: the guide page's request button points at the existing enquiry link (`enquiryHref`), since guides have no #enquire form.
- UAT: `pnpm dlx tsx scripts/check-phone-link.ts`. Live: on a phone, open a guide or trip page, see the bar with Call or text now, tap it, and see `phone_click` in GA4 with page_path and method.
- Migration: none.

## Catch-up social enrolment for published guides that never got a post
- What changed: `pickCatchUpGuide` (pure) and `runGuideCatchUp` in `lib/guide-distribution.ts`; `runDistribution` in `lib/distribution.ts` calls it once per posting pass, after the held-guide release and before the send. If today UTC single guide enrolment (GUIDE_ENROLMENTS_PER_DAY) is unused, it picks the oldest published guide with no ledger row and empty quality_notes (destinations first) and hands it to the existing `enrollGuideIfDue`, so the cap, held-for-named-businesses, kill switch, distribution mode and caption checks are unchanged. No new cron, `lib/guide-run.ts` untouched.
- Why it helps: guides published before enrolment existed (or on a day the cap was used) get a social post one per day, so more organic and social traffic from content already written, with no manual work.
- UAT: `pnpm dlx tsx scripts/check-guide-catchup.ts`. Live: with distribution mode prepare or auto, run the posting pass and see one old guide appear in the distribution queue (held for named businesses); a second run the same day adds none.
- Migration: none.

## Inline lead form on guide pages
- What changed: new `components/guide-lead-form.tsx` (client form: name and email required, phone and one-line message optional, hidden `company_website` honeypot) mounted inside the `#guide-cta` section of `components/guide-cta.tsx`. It posts to the existing `/api/submit-lead` with package = the guide's linked trip, else Custom Package, plus `getAttribution()`, tracks `generate_lead` (method guide_form) and routes to `/thank-you`. Pure helpers in new `lib/guide-lead-form.ts` (payload, package fallback, required fields, 429 and network messages that offer `site.phone`). The guide page sticky bar and the header "Send an enquiry" button now point at `#guide-cta`; the "Ask us about your trip" enquiry link stays in the section as the no-JS fallback. No API route, no `lib/site.ts` change.
- Why it helps: a guide reader can leave their details in place, in two fields, instead of going to another page first, so more guide traffic becomes leads.
- UAT: `pnpm dlx tsx scripts/check-guide-lead-form.ts`. Live: open a guide page, tap Request Info (scrolls to the form), submit a test lead and land on /thank-you; the lead row carries the guide page path in attribution.
- Migration: none.
