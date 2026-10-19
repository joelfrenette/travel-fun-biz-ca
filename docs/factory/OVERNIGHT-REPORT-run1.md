# Overnight report, run 1 (branch overnight-2026-10-19)

Final check: tsc passes. All 58 scripts/check-*.ts exit 0. No migration file was added by any commit. No protected affiliate file was touched. Final QA passed with 3 MINOR findings (listed at the end).

Lever key: T traffic, L leads, B bookings, R revenue, M less manual work.

## Commits (git log main..HEAD)

1. 1575172 Show success when the lead was saved even if GoHighLevel failed
   - What: submit-lead, newsletter and trip-alerts answer success when the lead was saved first. The GoHighLevel error is still logged and the retry job picks the row up. New lib/lead-response.ts.
   - Levers: L, B. Risk: low. Migration: none. Live setting: none.
   - UAT: Submit a test enquiry while GoHighLevel is unplugged. The visitor should see the thank-you page, and the lead should show in /admin/leads and in Needs attention as not sent.
   - SHIP. Stops lost-looking leads and double submits.

2. b19df75 Email Joel the moment a new real lead arrives
   - What: notifyNewLead in lib/alerts.ts. Email has no personal data, only the page, the source and a link to /admin/leads. Max 20 a day, test rows skipped, does nothing without RESEND_API_KEY.
   - Levers: L, B, M. Risk: low. Migration: none. Live setting: needs RESEND_API_KEY already set to do anything.
   - UAT: Send one real-looking test lead. Check you get one short email with no name, email or phone in it.
   - SHIP.

3. 1da1d03 One-tap call or text on trip, guide, blog and destination pages
   - What: PhoneLink and a "Call or text now" sticky button on phones, tracking phone_click and sms_click. Uses site.phone (the AI agent line). Edited scripts/check-guide-pages.ts to allow package-card.
   - Levers: L, B. Risk: low. Migration: none. Live setting: none.
   - UAT: Open a guide page on a phone. Tap Call or text now. The phone should offer (833) 878-5386. The bar should hide when the enquiry form is on screen.
   - SHIP.

4. da42d0d Catch-up social enrolment for old published guides
   - What: When the one-per-day slot is unused, the oldest never-posted guide is enrolled through the existing path. No new cron. Gates and caps unchanged.
   - Levers: T, M. Risk: low to medium (more posts go out, still capped and gated). Migration: none. Live setting: only acts when distribution is already on.
   - UAT: In Autopilot, wait for a posting pass on a day with no new guide. One older guide should appear in the queue or ledger, no more than one.
   - SHIP. Spend and posting caps are unchanged.

5. 286a0d3 Inline lead form on guide pages
   - What: Name and email form in the #guide-cta section, posts to /api/submit-lead, honeypot kept, friendly 429 and network messages with the phone number.
   - Levers: L, B. Risk: low. Migration: none. Live setting: none.
   - UAT: On a guide page, fill the form with test data. You should land on /thank-you and see the lead in /admin/leads. Fill the hidden field via dev tools and confirm nothing is saved.
   - SHIP. Note: the #guide-cta wiring check is a text match, so look at it once by eye.

6. 9ac7282 Let rejected guide drafts be retried once after 2 days
   - What: Rejected drafts older than 2 days with fewer than 2 rejections are offered again, bounded by the existing 24 hour breaker.
   - Levers: T, M. Risk: medium. Migration: none in this commit, but the full behaviour needs the review_state column from migration 0041. Before that column exists the old behaviour stays (fails closed).
   - UAT: Look at Needs attention after a day. A retried guide should show once, not repeat.
   - HOLD together with 7 until 0041 is confirmed applied in Supabase. Safe if not applied, but it does nothing.

7. 7084b4b Guide retry covers only heal-rejected drafts, never person-rejected ones
   - What: Fix to commit 6 so drafts that Joel rejected by hand are never retried.
   - Levers: T, M. Risk: low. Migration: none (same 0041 dependency as 6).
   - UAT: Reject one draft by hand. It should never come back.
   - HOLD with 6 for the same reason. Ship 6 and 7 together.

8. 72338c7 Webhook no longer hides failed order writes
   - What: GoHighLevel webhook answers 500 when the order write fails so GoHighLevel retries, logs a short note with no personal data, and adds a Needs attention item with grade-5 steps.
   - Levers: B, R, M. Risk: low. Migration: none (uses existing webhook_events.status and payload). Live setting: none.
   - UAT: Send a test webhook with a bad order. It should answer 500 and show in Needs attention within the 7 day window.
   - SHIP.

9. 257b505 Only list and index compare and best-time pages that have published copy
   - What: The sitemap and robots meta skip compare and best-time pages with no published page copy.
   - Levers: T. Risk: medium. Migration: none. Live setting: none. Caveat: a brief copy read error can noindex a page until the 5 minute revalidate.
   - UAT: Open /sitemap.xml and pick one compare URL with no copy. It should not be listed. Open a page with copy and check it is still indexable.
   - SHIP. Watch Search Console for a day. Fails open when the query returns nothing.

10. d618b8c Contact form: optional package, plain error messages
    - What: Package is optional (sent as Custom Package), 429 and network errors show a plain message with the phone number. Server fills Custom Package so GoHighLevel always gets a value.
    - Levers: L, B. Risk: low. Migration: none. Live setting: none.
    - UAT: Submit the home page contact form without choosing a package. It should succeed and the lead should say Custom Package.
    - SHIP.

11. 712cdf8 Attribute orders to the lead's first-touch channel by email
    - What: When GoHighLevel sends no utm values, recordOrder borrows them from the buyer's earliest real lead (read-only, email never logged). New basis value lead_email_match.
    - Levers: B, R. Risk: low. Migration: none. Live setting: none.
    - UAT: Record a test order for an email that has an earlier lead. The order should show that lead's source.
    - SHIP. QA note: label lead_email_match as first touch in revenue-by-channel views.

12. 1425088 Watchdog alert when the 15 minute autopilot cron stops
    - What: The daily gsc-snapshot job checks the heartbeat and sends one throttled alert if Autopilot is on and the heartbeat is stale. Never throws.
    - Levers: M, T. Risk: low. Migration: none. Live setting: none (acts only when Autopilot is on and the kill switch is off).
    - UAT: Hard to trigger live. Read the check script output and confirm the Needs attention light still shows amber when the heartbeat is old.
    - SHIP.

13. 96a092d Blog posts link to matching published guides and related posts
    - What: Autoblog may link up to 3 guides and 2 related posts (cap 5 total). Quality gate paths come from the same list.
    - Levers: T. Risk: low to medium (a short guide name could match loosely). Migration: none. Live setting: none.
    - UAT: Run one autoblog draft in a safe moment and check the links point to real published pages that fit the topic.
    - SHIP.

## Needs Joel

1. Decide whether travel news should be set to publish or off. In draft mode it spends about $10 a month (about $0.9 a week in one estimate) and can never go live. Four Hurricane Trudy drafts and one advisory draft are waiting.
2. Decide whether trip pages may get automatic social posts (suggested: one per trip per 30 days, held 24 hours with auto-release) before the loop builds it.
3. Decide under CASL and PIPEDA whether the form may record a session-only first page and referrer when analytics consent is declined, so lead sources can be measured. This includes whether utm tags may be read from the page URL at submit time without the banner choice (L3-3), and whether attribution (utm values and referrer host, nothing stored) may be sent at submit time without the banner choice.
4. Decide whether to state a response time near the enquiry form, only if it is a real commitment you will keep, and confirm the privacy and terms page paths for linking.
5. Apply a migration later if you want referrer, landing_path and utm_term stored on leads. The orchestrator should review the migration file when one is written. Also confirm migration 0041 (review_state) is applied so guide retry (commits 6 and 7) does anything.
6. Decide how new leads get an instant reply: build a GoHighLevel workflow on the travel-lead tag (acknowledgement, text the AI agent line, task after 1 hour with no reply), or approve a default-OFF acknowledgement email via Resend (CASL wording is yours to confirm).
7. Connect Facebook, Instagram and Pinterest accounts in GoHighLevel Social Planner so posts reach more than Bluesky, then tick them on the Autopilot distribution card.
8. Approve the shorter newsletter form (email plus consent only, name and phone optional) and the exact consent wording, since it is a CASL legal choice. Also approve CASL-safe wording for an email-only signup box with an unticked consent checkbox under the guide, blog, compare and best-time forms (L3-5).
9. Add a GoHighLevel workflow that posts won opportunities to the webhook (secret already exists) so Booked reflects phone-closed bookings, and send one real refund payload sample (field names only) so refunds can be recorded correctly (BR3-3).
10. Confirm the GoHighLevel API key has opportunities write scope and that you want paid orders to mark the pipeline card as won automatically (BR3-6).
11. Pick a daily AI dollar ceiling (suggested 5 dollars) if you want a spend tripwire added next round.
12. Approve the cookie wording and turn on visit_tracking so the site can measure where visitors drop off (L3-6).
13. Decide whether to raise posts per week to 4 or 5 and page copy per day to 2 in admin settings, knowing it raises AI spend (T3-6).

## Next round should target

- Instant lead reply and follow-up (item 6 above), the biggest gap between a lead and a booking, once Joel picks the route.
- Lead source measurement (a migration for referrer, landing_path, utm_term, plus the consent decision), so channel spend can be judged.
- Phone-closed bookings and refunds into the Booked numbers (webhook workflow, refund sample, won-opportunity write).
- Email-only signup boxes under guide, blog, compare and best-time forms after the CASL wording is approved.
- Trip page social posts and a spend tripwire, after Joel's decisions.
- Revenue per visitor: label lead_email_match as first touch in channel views, and review loose guide-name matching in autoblog links (minimum name length or destination match).
- Watchdog backup: if the daily gsc-snapshot cron stops, nothing alerts. Consider an external check.

## Final QA findings (all MINOR, none blocking)

- lib/purchase-ledger.ts: new attribution_basis value lead_email_match appears in any grouping; label it first touch.
- lib/autoblog-run.ts: short generic guide names can match loosely and offer an off-topic link (still published-only, cap 5, gate still checks paths).
- lib/cron-watchdog.ts: depends on the daily gsc-snapshot cron; no heartbeat never alerts, so new deploys cannot false-alarm.
