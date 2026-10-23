# Conversion loop (visit -> lead)

Branch `loop-conversion`, from main `51e633a`. Audit first, then the safe fixes. Line numbers are from main before this change unless marked (new).

## 1. Audit: where the funnel leaks

| Page type | Primary action | Above the fold on a 375x812 phone | Notes |
|---|---|---|---|
| Guide (`components/guide-page.tsx`) | Header panel `components/guide-header-actions.tsx:50-72`: call or text button plus "Send an enquiry" (anchors to `#guide-cta`) | Yes, but it sits under the title, summary and quick facts (`guide-header-actions.tsx:39-49`), so on a phone it is usually the second screen | Closing form `components/guide-cta.tsx:30-47`; sticky bar `guide-page.tsx:335-341` |
| Blog post (`app/blog/[slug]/page.tsx`) | A one-line text CTA (`GuideCta compact`, line 187 before) | No. It sat after the cover image and takeaways | No sticky bar at all. At the end: package cards with no CTA, or the full form only when no trip is linked (lines 240-251 before) |
| Compare, best-time (`app/compare/[pair]/page.tsx:125`, `app/best-time-to-visit/[destination]/page.tsx:153`) | Closing `GuideCta` form only | No | No sticky bar. Not changed in this pass |
| `/from/<city>` (`app/from/[city]/page.tsx:165`) | `ContactForm` (long: 8 fields) | Below trip list | No sticky bar. Not changed |
| Trip page (`app/packages/[slug]/page.tsx:423-428`) | `ContactForm` plus sticky bar | Sticky bar yes | Has TripAlertForm for past trips (line 401) |
| Home (`app/page.tsx:82`) | `ContactForm` | Below the hero | Long form |

Findings, ranked:

1. **Blog posts had no mobile bar and no CTA near the top that named the subject.** The only top CTA was a small text line (`guide-cta.tsx:19-28` compact branch).
2. **Two enquiry actions under one form.** `components/guide-cta.tsx:44` had a big "Ask us about your trip" button, which goes to the home-page form, directly beneath the inline form that does the same job. Competing CTA. Now a quiet text link (kept as the no-JS fallback that `scripts/check-guide-lead-form.ts` pins).
3. **The sticky bar covered the email signup box.** `components/sticky-cta.tsx:23` only hid for `enquire`, `contact`, `guide-cta`; the signup form in `components/page-signup-box.tsx:11` (`#page-signup`) was not listed, so on a phone the bar sat over its submit button.
4. **The link to the enquiry form lost its context.** `enquiryHref` (`lib/guide-facts.ts:152`) carries only the trip. And `components/contact-form.tsx:56-68` took `?package=` as the value even if that name was not in the dropdown, so the select showed blank. Leads from guides arrived with "Custom Package" and no hint of the destination.
5. **Guide inline form sends no topic.** `lib/guide-lead-form.ts:48-62` built the message from what the visitor typed only.
6. **Thank-you page was a dead end.** `app/thank-you/page.tsx:32-47`: confirmation, phone line, "Browse more trips". No trip alerts, no "what happens next".
7. **No funnel events.** Only `generate_lead`, `phone_click`, `sms_click`, `book_now_click` existed (`components/guide-lead-form.tsx:64`, `components/phone-link.tsx:29`). Nothing for CTA views, form starts or the thank-you view.
8. **Lead source was stored but shown badly.** `lib/leads.ts:31-35,78-82` already stores utm source/medium/campaign/content and `page_path`; `lib/lead-touch.ts:52-58` stores referrer host, landing path (no query) and utm_term only when analytics was accepted. But `app/api/admin/leads/route.ts:12` did not read `page_path` or `utm_content`, and `app/admin/leads/page.tsx:65-69` printed a "Source:" line only when some field existed, so a lead with no source looked the same as a lead nobody had checked.
9. **Dashboard funnel had no page-type split.** `lib/funnel.ts` counts stages and channels only. Enquiry-form views are not stored anywhere on our side; they exist only as Google Analytics events.

Checked and fine:

- Fields are minimal on the guide form: name and email required, phone and a note optional (`components/guide-lead-form.tsx:75-90`). The long `ContactForm` asks for 8 fields; name and email are the only required ones (`lib/schemas/contact.ts:5-6`).
- Errors: `role="alert"` message on the guide form (line 91), the browser's own `required` check runs first. The contact form shows a toast and inline messages with `aria-invalid`. Both keep keyboard focus order natural; labels are linked with `htmlFor`.
- Consent: the contact form line (`components/contact-form.tsx` "By submitting this form...") and the two CASL checkbox sentences (`components/trip-alert-form.tsx:80-83`, `components/newsletter-form.tsx:143-144`) are untouched. `scripts/check-conversion-loop.ts` hashes all five.
- Without analytics consent only `page_path` is sent with a lead (`lib/attribution.ts:70`).

Things I did **not** change, for Joel to decide:

- The guide inline form has no privacy sentence under its button (the contact form does). Adding the existing sentence is a consent decision, so I left it.
- `app/thank-you/page.tsx:31` says "will contact you soon". "Soon" is a soft response-time promise. It is existing translated copy; I left it and made the new block say only that an advisor reads the enquiry and replies by email.
- Compare, best-time and from-city pages still have no sticky bar or context block.
- The new copy is English only (the guide closing CTA is also English only). The existing header panel and sticky bar are translated.

## 2. What changed

- `lib/conversion.ts` (new): pure helpers. CTA copy from a stored subject, pre-fill helpers, page-type mapping, funnel-by-page-type rows. No prices, no counts, no response-time wording.
- `components/context-cta.tsx` (new): "Planning {subject}? Talk to a travel advisor." One primary button (call or text when `site.phone` has a number, else the enquiry), one quiet text link, and a "what happens next" line with no time promise. Used twice per page with different block ids.
- Blog post: block after the Quick answer (the article HTML is split right after the Quick answer paragraph; with none, the block sits before the article), a sticky mobile bar, and one closing block: the full form when no trip is linked, else the short block after the trip cards. Never both.
- Guide page: block after the key takeaways; the closing form stays.
- `components/sticky-cta.tsx`: also hides while `#page-signup` is on screen; tracks `cta_click`.
- Pre-fill: `lib/guide-lead-form.ts` puts "I am interested in: {topic}." first in the message; `ContactForm` reads `?about=` and `?package=` and keeps a trip named in the link selectable. Links from the new block use `enquiryHrefWithContext`.
- Thank-you page: "What happens next", the trip alerts signup (existing form, existing consent box, source `/thank-you`), and a `thank_you_view` event.
- Admin: `/admin/leads` shows "Lead source:" on every lead (page the form was on and its type, utm fields, referrer host, landing path) or says not recorded. The dashboard Funnel card has "Visit to lead, by page type" using `site_visits.landing_path` and `leads.page_path`; visits show "not measured" when visit tracking is off, never zero.
- Events (all through `track()`, so only after analytics consent): `cta_view`, `cta_click` (with `block_id` and `kind`), `form_start`, `form_submit`, `thank_you_view`.
- Tests: `scripts/check-conversion-loop.ts` (new); `scripts/check-blog-page.ts` and `scripts/check-guide-schema.ts` updated for the new structure.

## 3. Not measurable today

Enquiry-form views and form starts are Google Analytics events only. There is no first-party table for them, so the dashboard says so instead of showing a zero.
