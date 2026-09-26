# TravelFunBiz.ca vs the Nomad factory spec — gap report (audit only, no code changed)

**Prepared:** 2026-09-26. **Compared against:** `joelfrenette/nomad-escape-plan`, tag `factory-v8`
(`docs/factory/PARITY-SPEC.md` sections 1–16, `FACTORY-INTEGRATION.md`). **Method:** read both spec
files in full; inspected this repo's actual code, Supabase schema, and deployment config — not
reconstructed from memory. No application code was changed to produce this report.

## 0. The honest scale read, before the detail

This is not a small port. Nomad's spec describes roughly 19 phases of engine code — tracking,
CRM webhooks, a 7-stage funnel with search/social/email attribution, autoblogging with quality
gates, social distribution across 6+ networks, speedometers, an influencer program, programmatic
SEO pages, and a full boot-sequence health check — built up over what reads like months of
iteration on Nomad itself (the spec's own section 16.19 describes a detector's first live run
being ~70% false alarms, found and fixed one fixture at a time).

TravelFunBiz.ca today is a real, working lead-gen site with a genuinely useful admin (packages,
keyword research with live Search Console/Bing data, a roadmap tracker, and — as of last week — a
blog editor), but it has **none** of the tracking/CRM/funnel/distribution engine this spec
describes. Two foundational things Nomad assumes don't exist here at all: a `site_visits`-style
table with server-side channel classification, and any numbered-migration convention. Those are
the true phase-1 prerequisites, not an afterthought.

My read: this is buildable, additive, and safe to do in the phased, dormant-by-default way the
spec insists on — but "bring TravelFunBiz to Nomad parity" is a multi-month program of PRs, not a
session. I'll say so again at the end of every phase, not just here, so scope creep doesn't sneak
in one "small" PR at a time.

## 1. Stack and DB inventory (verified, not assumed)

| Item | TravelFunBiz.ca (verified) |
|---|---|
| Framework | Next.js 14, App Router, React 19, Tailwind v4 (CSS-based config, no `tailwind.config.js`) |
| Host | Vercel. **No `vercel.json` exists in the repo** — zero cron jobs configured today. |
| Database | Supabase project `ldwmbwsxrktpcisqaxrb`. Tables today: `travel_packages`, `roadmap_epics`, `roadmap_features`, `roadmap_usecases`, `keyword_research`, `testimonials`, `posts`. None of Nomad's tracking/CRM/social tables exist. |
| Migrations | **No numbered migration files in this repo at all.** Schema changes are applied ad hoc, by name, straight to the live Supabase project via the Supabase MCP tool. There is no "next migration number" to port Nomad's `067`, `072`, `081`, etc. onto — see Decision 1. |
| Admin auth | Not Postgres-RLS-based. A single hardcoded admin identity (`ADMIN_EMAIL`/`ADMIN_PASSWORD_HASH`), HMAC-signed session tokens (`lib/admin-auth.ts`), checked per-route with `isAuthorized(request)`. All admin writes go through a service-role Supabase client that **bypasses RLS entirely** — there is no Postgres session with an authenticated role for RLS policies to key off. Nomad's `current_is_admin()` RPC-in-RLS-policy pattern does not map onto this project as designed — see Decision 2. |
| Admin nav | `lib/admin-nav.ts`: one flat list of tools with an Active/Coming-Soon badge, rendered as a sidebar (`components/admin/admin-shell.tsx`) and a dashboard tile grid. No Dashboards/Action-items/Setup-items three-group hierarchy, no `check-admin-nav`-style enforcement script. |
| CRM | GoHighLevel **v1 REST API** with an agency API key, `GOHIGHLEVEL_LOCATION_ID`, `GOHIGHLEVEL_PIPELINE_ID` (`lib/gohighlevel.ts`). Outbound only: the site POSTs a contact on every lead/newsletter signup. Nothing reads GHL back (no tag counts, no Social Planner statistics, no message export), and nothing receives a webhook from GHL. Nomad's contract needs `GHL_API_TOKEN`/`GHL_SOCIAL_API_TOKEN` (private integration tokens with named scopes) and inbound webhook routes — different shape, not just missing pieces. |
| Analytics/consent | `lib/analytics-client.ts` fires GA4 `gtag` events directly, no consent gate. `lib/attribution.ts` captures UTM/referrer/landing path into **`localStorage` only** (no cookie, no server round-trip, no `site_visits` table). **There is no consent banner, no Consent Mode, anywhere in this codebase.** Given Joel's own compliance callout (CASL, Quebec Law 25, PIPEDA), this is a real gap independent of the Nomad port. |
| SEO integrations already live | GA4 Data API, Search Console query data, and Bing Webmaster keyword stats are **already built and working** (`lib/ga4.ts`, `lib/search-console.ts`, `lib/bing-webmaster.ts`, all shipped in earlier sessions) — real overlap with Nomad's `GSC_CLIENT_EMAIL`/`GSC_PRIVATE_KEY`/`BING_WEBMASTER_API_KEY` needs. This is a head start, not a gap. |
| IndexNow | A basic ping-on-publish/update/delete already exists (`lib/indexnow.ts`, `/indexnow-key.txt` route), verified locally. Nomad's version (16.18) additionally verifies the key file before sending, runs on a daily cron with batching and status reporting, and adds a Bing priority lane for up to 90 URLs/day. Ours is the simpler, synchronous, no-cron version — a real base to extend, not a rebuild. |
| Blog | `posts` table, `lib/posts.ts`, `/admin/blog` editor (Markdown, no dependency, live preview, image upload), public `/blog` + `/blog/[slug]`, sitemap + RSS — all shipped last session. **100% human-authored today: no composer, no topic queue, no autoblog cron, no dedupe, no quality gates, no claim/experience guard, no facts-grounding, no drift monitor.** The schema and admin pattern are a genuine, compatible foundation for phases 2–3, but none of the automation exists yet. |
| Roadmap tracker | `/admin/tracker` (Supabase-backed epics/features/use-cases, Gantt-ish board) is this project's closest existing analogue to Nomad's Today/runbook system — but it's a **developer task tracker for building the site**, not a marketing "what to do today" system fed by cadenced runbook steps with tick ids. Conceptually adjacent, not a port target as-is. |

## 2. Section-by-section verdict against PARITY-SPEC §1 (Definition of done)

Legend: **MISSING** (nothing exists), **PARTIAL** (a different, smaller thing exists), **HEAD START** (real working code that a phase can build on).

| Screen (spec §1) | Verdict |
|---|---|
| Dashboard (7-stage funnel, search/social split, tracking-since date) | MISSING. Current `/admin` dashboard shows GA4 traffic + quick stats only; no funnel concept exists. |
| Blog Auto Content (SEO score, views/clicks columns, composer, topic queue, autoblog switch) | PARTIAL. Post list and editor exist; SEO score, view/click columns, composer, topic queue, autoblog switch do not. |
| Blog Auto Posts (distribution control, Autopilot ignition) | MISSING. No distribution/social-posting code at all. |
| Blog Posts Tracking (channel speedometers, Posts tracker table) | MISSING. |
| Search rankings (top 10/50/100 counts, movers with sparklines) | MISSING (we have raw GSC/Bing query data in Keyword Research, not a rankings-over-time view). |
| Funnels and email (email funnel stages, campaigns) | MISSING. |
| Action items (Today, Content calendar, SEO tasks, Internal links, Auto-links, Video, Grow Social, Distribution, Social library, Email library, Campaigns, Grow audience) | MISSING, except SEO tasks has a rough analogue in the roadmap tracker's backlog (not computed the way Nomad's `task-generator.ts` is). |
| Setup items (runbooks) | MISSING as a system. `.env.example` plus this document are the closest thing today. |

## 3. Tracking contract (§2) — gap detail

- **UTM tagging (`lib/utm.ts`, §2.1):** does not exist. We have no link-tagging helper at all; outbound affiliate/social links aren't a concept in this codebase yet.
- **Channel classification (`classifyVisit`, §2.2):** does not exist server-side. Attribution is captured client-side into `localStorage` and sent as free-form fields on lead submit; there is no first-match-wins channel resolver, no ad-click-id handling, no bot filtering.
- **Cookies (§2.3):** none of the five cookies (`_src`, `_lt`, `_ref`, `_lead`, `_consent`) exist. Current attribution is `localStorage`-only, which is weaker (cleared by "clear site data", not shared across subdomains, no `httpOnly` lead-hash cookie).
- **`POST /api/track/visit` (§2.4) and owner exclusion (§2.5):** neither exists. No `site_visits` table, no bot/rate-limit/owner filtering, no `stat_exclusions` concept.
- **Attribution columns on records (§2.6):** `leads`/`orders` tables don't exist at all — GHL is the only place a lead currently lives.
- **Analytics events (`track()`, §2.7):** a same-named `track()` helper already exists (`lib/analytics-client.ts`) and fires `generate_lead`, `newsletter_signup`, `book_now_click` — real overlap, but it is GA4-only (no Meta/TikTok/Pinterest), not consent-gated, and doesn't no-op for the owner.

## 4. CRM contract (§3) — gap detail

Outbound lead capture exists and works (`/api/submit-lead`, `/api/newsletter`). Everything else in
Nomad's contract is new: an inbound purchase webhook, an inbound DM-lead webhook, reading GHL back
for tag counts and Social Planner statistics, and a tag scheme mapped onto travel bookings
(lead → quote-started → booked → collected, per Decision 4 below). GoHighLevel's plan tier gates
some of this (Social Planner and its statistics endpoint, and coupon creation for the ambassador
program, are not on every GHL plan) — needs verifying against Joel's actual GHL subscription, not
assumed.

## 5. Funnel, speedometers, tasks (§5–9) — gap detail

All MISSING as described in §1 above. The one open design question worth raising now rather than
per-phase: Nomad's phase 5 stage ("Checkout") and the tag `checkout-started` assume a single
in-house checkout. Travel bookings here are commission-based and often close outside the site
(a phone call, a supplier's own booking flow) — the funnel's stage mapping needs travel-specific
definitions before the engine route can be written meaningfully. Section 6 below proposes a first
draft; it needs Joel's confirmation, not silent adoption.

## 6. Section 16 levers — gap detail (the newest layer)

| Lever | Verdict |
|---|---|
| Carousels, hook images | MISSING — depends on distribution existing first. |
| Programmatic SEO (`/compare/a-vs-b`, `/passport/...`) | MISSING. Travel analogue (destination-vs-destination, best-month, from-Canada routes) proposed in the original ask; needs real fact tables to ground it (§ below). |
| IndexNow hardening + Bing priority lane | PARTIAL — see §1 table above; the simple version works, the hardened/cron version doesn't exist. |
| Grow Social / account settings checklist | MISSING. |
| Community queues (Reddit/Quora/FB groups) | MISSING. Needs `FIRECRAWL_API_KEY` (unset today; `SCRAPINGBEE_API_KEY` is the closest thing we have, different vendor) and an Anthropic API key server-side (none configured — this app currently makes zero AI calls of its own; the "AI" buttons in Packages are static heuristics, not model calls). |
| Consent and identity | **MISSING entirely** — flagged above independent of Nomad, since it's a real legal gap for a Canadian site collecting leads. |
| All Systems Check boot sequence | MISSING. |
| Growth levers map, outreach queue, paid placements | MISSING. |
| Influencer/ambassador program | MISSING — this is Joel's "inbound affiliates" ask (goal 4). Needs `CONVERSIONS_HMAC_SECRET`, an offer structure (`AUDIENCE_PCT`/`COMMISSION_PCT`), and its own GHL webhook, all new. |
| No-invented-experience gate, facts grounding, drift monitor | Not urgently needed yet — the blog has no AI composer to guard. Becomes mandatory the moment phase 2/3-equivalent autoblogging is built, not before. Flagging now so it isn't forgotten when that phase starts. |

## 7. Crons (§11) — the hard external constraint

Nomad wants 11 distinct scheduled jobs (autoblog, distribute, post-health, email-engagement,
social-library, weekly-digest, gsc-snapshot, shotstack-cleanup, nurture, indexnow, community).
Vercel's Hobby plan caps cron jobs at 2 total and once-per-day minimum frequency; Pro allows far
more with finer-grained schedules. **I don't know which Vercel plan this project is on** — the
Vercel connector for this session is disconnected, so I can't check it myself. This blocks phases
9–13 and most of §16 regardless of code readiness. See Decision 7.

## 8. Env vars this program needs (names only; values are Joel's to add, matching `.env.example`'s existing convention)

Core: `CRON_SECRET`, `RATE_LIMIT_SALT`, `CONVERSIONS_HMAC_SECRET`.
Already have the equivalent: GA4/GSC/Bing (via `GOOGLE_SERVICE_ACCOUNT_KEY`, `GA4_PROPERTY_ID`, `SEARCH_CONSOLE_SITE_URL`, `BING_WEBMASTER_API_KEY`), `INDEXNOW_KEY`.
New, CRM: `GHL_API_TOKEN`, `GHL_SOCIAL_API_TOKEN`, `GHL_USER_ID`, `GHL_LEAD_WEBHOOK_URL`, `GHL_WEBHOOK_SECRET`, `GHL_AMBASSADOR_WEBHOOK_URL` (confirm these coexist with, or replace, the current `GOHIGHLEVEL_*` v1 keys — Decision 4).
New, distribution: `AYRSHARE_*` or `UPLOAD_POST_*`, `SHOTSTACK_*`.
New, content: `ANTHROPIC_API_KEY` (this app makes zero AI calls today — a real, separate decision, see Decision 8), `PEXELS_API_KEY` (already in `.env.example` as a considered-but-unused var from an earlier session), `FIRECRAWL_API_KEY`.
New, email: `RESEND_API_KEY`, `RESEND_FROM`, `RESEND_STATS_API_KEY` (or confirm GHL's own email sending covers this — Nomad uses Resend *and* GHL together, for different jobs).
New, pixels (optional, needs consent work first): `NEXT_PUBLIC_META_PIXEL_ID`, `NEXT_PUBLIC_TIKTOK_PIXEL_ID`, `NEXT_PUBLIC_PINTEREST_TAG_ID`, `NEXT_PUBLIC_CLARITY_ID` (already discussed once, never added).

## 9. Decisions needed from Joel before Phase 1 can start

1. **Migration numbering.** Adopt a numbered-migration-file convention in this repo (so Nomad's "next number" instruction has something to attach to), or keep applying schema changes ad hoc by name and track "the order things landed in" a different way (e.g. this same ADOPTION-LOG)? My recommendation: adopt sequential numbered files under `supabase/migrations/`, matching how the Supabase CLI itself expects them — it's boring, standard, and makes "Nomad's migration 067 became our migration 004" traceable. Confirm before Phase 8.
2. **Admin auth shim.** Confirm: no new Postgres `current_is_admin()` RPC is needed. Every new factory admin route reuses the existing `isAuthorized(request)` check (HMAC token, service-role writes) exactly like every other admin route in this project. Flag if you disagree.
3. **Funnel stage titles and travel-specific definitions** (my draft, needs your correction): 1 Awareness, 2 Visits, 3 Leads (trip inquiry / newsletter), 4 Nurture, 5 Quote Started (a real advisor conversation opened — no in-house checkout to key off), 6 Booked (a supplier confirms the booking — this is *before* commission is paid), 7 Loyalty (repeat bookings, referrals, reviews). Separately define **"collected"** (commission actually received, often weeks/months after Booked) as its own tracked event, since Nomad's `collectedBaseCents()` rule ("commission on money collected, never list price") assumes a gap like this exists.
4. **GHL contract.** Confirm which GHL sub-account and API model this integration should use going forward: keep the current v1 API key (simple, but read-only outbound, no webhooks, no Social Planner) or move to a private integration token with the scopes Nomad's contract needs (`conversations/message.readonly`, `socialplanner/statistics.readonly`, webhook support, coupon creation for the ambassador program). This is a real re-architecture of `lib/gohighlevel.ts`, not an additive change — flagging so it isn't done as a quiet side effect of a later phase.
5. **Tag scheme** for travel bookings, mapped onto Nomad's slots (lead, quote-started, abandoned, booked/customer, per-supplier product tags, review, cooling, test-purchase). Needs your real supplier/product list to fill in "per product" meaningfully.
6. **Which revenue streams are real, and which is primary** (per the original ask): travel commissions/affiliate payouts, recruiting independent agents/affiliates, direct trip-planning inquiries — confirm which of these actually make money today versus which are aspirational, since the funnel and the tag scheme both need a primary answer to be honest rather than hedged.
7. **Vercel plan tier** (Hobby vs Pro), since it hard-caps how many of the 11 crons this program wants can exist at all, and how often they can run. I can't check this myself; the Vercel connector for this session isn't authorized.
8. **Whether an AI content composer is in scope at all right now.** This project makes zero AI-generated calls today (the "AI" buttons in Packages are static heuristics). Autoblogging, carousels, community-queue drafting and the influencer-invite drafter all assume `ANTHROPIC_API_KEY` and real model calls. Confirm you want that turned on, and understand it's a real per-call cost, before Phase 3 (autoblog) is built — it is the one piece of this whole program with an ongoing dollar cost per use, versus everything else here being flat monthly subscriptions.
9. **Compliance ownership.** CASL, Quebec Law 25/PIPEDA consent wording, provincial seller-of-travel registration numbers (Ontario TICO, BC, Quebec OPC), and the affiliate-disclosure wording all need real numbers and legal wording from you or your counsel — none of it will be invented, drafted, or guessed at by Claude. Phase 8 (tracking foundation) touches consent directly, so this decision blocks that phase specifically, not the whole program.
10. **GHL Social Planner and coupon support.** Both need to be probed against your actual GHL plan before Phase 6 (distribution) and Phase 16.13 (influencer coupons) are built — Nomad's own code treats these as "probed, never assumed," and I'll do the same rather than build against capabilities your plan might not include.

## 10. What I did not do

No application code changed. No migrations applied. No branch other than this one (`factory-audit`)
touched. Nothing merged. This file is the only change in this diff.
