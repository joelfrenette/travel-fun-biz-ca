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

## Rejected guide drafts can be retried, bounded
- What changed: `isRetryableRejected(row, now, rejectionCount)` (pure) and `rejectionCountFor` in `lib/guides.ts`. `listGuideCandidates` no longer treats a draft with review_state 'rejected', untouched for over 2 days and with fewer than 2 rejections, as taken, so it is offered again; published and non-rejected drafts still block. `writeGuide` in `lib/guide-run.ts` replaces such a row by upsert (kind + slug) instead of refusing with "already exists" and clears review_state. Each replacement is recorded in the existing guide-failures store (not cleared on save), so after the second rejection the slug is no longer offered. Quality gates, judge, weekly cap and heal caps untouched; `lib/issues.ts` untouched.
- Why it helps: a guide the heal or a person turned down is not stuck forever; the pipeline writes it again once, so more pages reach the site (more organic traffic) with no manual work, and spend stays capped.
- Note: a replacement counts as one entry in the guide failure log, so it also counts toward the existing 24h breaker and shows in Needs attention as a plain-English reason.
- UAT: `pnpm dlx tsx scripts/check-guide-retry.ts`. Live: reject a draft in the review queue, wait 2 days (or backdate in a test), run the guides step and see it rewritten; reject again and see it no longer offered.
- Migration: none (degrades to old behaviour before 0041, where there is no review_state column).

## Webhook no longer swallows failed order writes
- What changed: `app/api/ghl/webhook/route.ts` now runs the order save through the new pure helper `handleOrderWrite` in `lib/webhook-order-result.ts`. If `recordOrder` returns `{error}` or throws, the already-logged `webhook_events` row is updated to status 500 with a short, personal-data-free `order_error` note in its payload, and the route answers 500 so GoHighLevel retries (the upsert on provider + provider_order_id makes a retry safe). Success path and auth are unchanged. `lib/issues.ts` adds one Needs attention item (`ORDER_WEBHOOK_ISSUE_ID`, plain steps in `lib/plain-steps.ts`) when failed order events exist in the last 7 days; a missing table or column gives no item.
- Why it helps: a paid order that failed to save used to vanish silently (GoHighLevel saw success and never retried), which hid revenue and bookings. Now it is retried automatically and shown to Joel if it keeps failing.
- UAT: `pnpm dlx tsx scripts/check-webhook-order-failure.ts`. Live: with a deliberately broken orders write in a test, the webhook answers 500 and the event row shows status 500 with order_error; a retry that works answers 200.
- Migration: none (reuses webhook_events.status and payload).

## Only list and index compare and best-time pages that have copy
- What changed: new pure helper `lib/page-copy-index.ts` (`buildCopyPathSet`, `shouldListPath`, `filterByCopy`, `copyRobots`) and one query `getPublishedPageCopyPaths()` in `lib/page-copy.ts` (published rows, path only). `app/sitemap.ts` fetches that set once and lists a compare or best-time URL only when its path has published copy. A read error or an empty table gives a null set and the sitemap lists everything as before (fail open, never shrinks by accident). `generateMetadata` on `app/compare/[pair]` and `app/best-time-to-visit/[destination]` now returns robots index:false, follow:true when no usable copy exists (not-found behaviour, routes, links and IndexNow unchanged).
- Why it helps: thin, copy-less pages stop diluting the index and crawl budget, so the pages with real copy get crawled and ranked sooner (more organic traffic) with no manual work. Pages flip to indexed and listed automatically within the revalidate window once the pipeline publishes copy.
- Note: a transient page_copy read error on one page render can briefly mark it noindex until the next revalidate (5 minutes).
- UAT: `pnpm dlx tsx scripts/check-page-copy-index.ts`. Live: view /sitemap.xml and see only compare and best-time URLs that have published copy; view source of one without copy and see robots noindex, follow.
- Migration: none.
- FIX guide retry: only heal-rejected drafts (quality_notes starts with 'Rejected by heal:') are retried; a person-rejected or unmarked draft never is. Checks added in scripts/check-guide-retry.ts.

## Shorter contact form: optional package, clear error and throttle messages
- What changed: `package` is optional in `lib/schemas/contact.ts` and no longer required or starred in `components/contact-form.tsx`. New `lib/form-errors.ts` (`submitPackage`, `formErrorMessage`) reuses the guide form wording. The form sends 'Custom Package' when nothing is chosen, and shows the plain 429 and network messages (with the site phone) instead of "Something went wrong". `app/api/submit-lead/route.ts` also fills 'Custom Package' for direct API callers so downstream code (GoHighLevel, leads) still always gets a package. `ContactForm` takes a `phone` prop (passed from the home and package pages). `ContactSubmission` type keeps `package: string`.
- Why it helps: one fewer required field means fewer abandoned enquiries, and a throttled or offline visitor is told what to do (wait or call) instead of leaving.
- UAT: `pnpm dlx tsx scripts/check-contact-form.ts`. Live: submit the home form with only name and email, it reaches /thank-you with package Custom Package.
- Migration: none.

## Orders inherit the buyer's first-touch channel by email
- What changed: `lib/purchase-ledger.ts` has a pure helper `pickLeadAttribution(lead, ghlAttribution)` and a read-only `firstTouchLead` lookup. When GoHighLevel sent no utm, `recordOrder` reads the earliest non-test lead with the buyer's email (service role, select only), copies its utm_source, utm_medium, utm_campaign, utm_content, classifies the channel with `classifyVisit`, and stores attribution_basis 'lead_email_match'. The lead's page_path fills utm_content only when it is empty. GHL utm still wins; no lead, no utm on the lead, or any read error keeps today's result (basis 'none'). The email is never logged.
- Why it helps: sales that arrive without utm tags were unattributed, so revenue per channel was blank. Now bookings are credited to the channel that first brought the lead, with no manual work.
- UAT: `pnpm dlx tsx scripts/check-order-attribution.ts`. Live: record a test order for an email that has a lead with utm_source, and see attribution_basis 'lead_email_match' on the orders row.
- Migration: none.

## Watchdog alert when the 15-minute autopilot cron stops
- What changed: new `lib/cron-watchdog.ts` with pure `decideWatchdog(judgement, autopilotMode, paused)` and `runCronWatchdog(admin)`. The daily `app/api/cron/gsc-snapshot/route.ts` now reads the autopilot heartbeat (`readCronRuns`, `judgeCron`) after the snapshot work and calls `sendThrottledAlert` with subject 'Autopilot has stopped running' and 3 grade-5 steps (Vercel Cron tab, CRON_SECRET, Redeploy), only when the light is amber because the run is stale, Autopilot is on and the kill switch is not set. Double try/catch so it never breaks the snapshot. `CronStatus` in `lib/cron-health.ts` gets an optional `stale` flag so "went quiet" is told apart from "last run reported a problem". No new cron, no spend, no setting writes beyond what sendThrottledAlert does (throttled to one email per 6 hours).
- Why it helps: if the cron that runs the whole autopilot dies, nothing else can say so; Joel now gets an email within a day instead of finding out from missing leads and posts.
- UAT: `pnpm dlx tsx scripts/check-cron-watchdog.ts`. Live: the gsc-snapshot cron result text ends with "watchdog: autopilot stale, alert sent" only when the autopilot heartbeat is older than 3 hours with Autopilot on.
- Migration: none.

## Blog posts link to matching published guides and related posts
- What changed: `lib/autoblog-run.ts` has exported pure `pickGuideAndPostLinks(topic, guides, posts, selfSlug)`, `mergeAllowedLinks` and `withGuideAndPostLinks`. `buildAllowedLinks` now adds, after the trip, destination and best-time links, up to 3 published guides whose name appears (whole word, any case) in the topic angle, keywords or tags (`listPublishedGuideLinks`, `guidePath`, read only) and up to 2 recent published posts sharing a tag with the topic (never the post being written, no drafts or future-dated posts). Total is capped at 5 and the existing links always come first. The quality gate's allowed paths come from the same list, so these paths count as allowed and any unlisted path is still a dead link. Any read error returns today's links. Affiliate linker files untouched.
- Why it helps: more internal links from each new post to guides and sibling posts means better crawl paths and ranking for guides, and more routes from a reader to a trip page, with no manual linking.
- UAT: `pnpm dlx tsx scripts/check-blog-links.ts`. Live: run autoblog in draft mode for a topic naming a published cruise line and see its guide link in the draft body.
- Migration: none.
