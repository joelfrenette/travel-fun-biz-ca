# Factory parity program — adoption log

Per Joel's working rules: one entry per PR, recording what was ported, what was changed for
travel and why, which Nomad checks were ported, and any deviation from the spec. Anything found
wrong in Nomad itself gets reported back to Joel, not silently worked around here.

## Phase 0 — Audit and decisions (2026-09-26)

**PR:** [joelfrenette/travel-fun-biz-ca#1](https://github.com/joelfrenette/travel-fun-biz-ca/pull/1) (not merged — docs only).

**What happened:** read `docs/factory/PARITY-SPEC.md` and `FACTORY-INTEGRATION.md` in full from
`joelfrenette/nomad-escape-plan` at tag `factory-v8`; wrote `GAP-REPORT.md` comparing this project
against the spec section by section; asked Joel the 9 blocking decisions one at a time.

**Decisions resolved** (full detail and rationale in `GAP-REPORT.md` §9; this is the answer only):

1. **Migration files:** adopt numbered files under `supabase/migrations/`, starting now — no
   retroactive renumbering of the 7 migrations already applied ad hoc.
2. **Admin auth:** confirmed — every new factory route reuses the existing `isAuthorized()` check.
   No new Postgres `current_is_admin()` RPC; this project's admin auth is HMAC-token + service-role,
   not RLS-role-based, so Nomad's pattern doesn't map on directly.
3. **Funnel stages** (travel-specific, no in-house checkout): **Awareness → Visits → Leads →
   Nurture → Quote Started → Booked → Traveled → Loyalty** — 8 stages, not Nomad's 7. Joel added
   **Traveled** after Booked: a confirmed booking and a completed trip are different events for a
   travel business, and it's the natural place "collected" (commission actually paid) sits, since
   suppliers commonly release final commission after travel completes, not at booking. "Collected"
   is tracked as its own timestamp on the order record, not a numbered funnel stage of its own.
4. **GHL contract:** move from the current v1 API key (outbound-only) to a private integration
   token with the scopes Nomad's contract needs (webhooks, `conversations/message.readonly`,
   `socialplanner/statistics.readonly`). Real re-architecture of `lib/gohighlevel.ts`, due at
   Phase 9. Joel generates the token in GHL settings when that phase starts.
5. **Revenue streams:** all three (supplier commissions/affiliate payouts, recruited
   agents/affiliates, direct trip-planning inquiries) are live today, roughly equal weight. No
   single primary to bias the tag scheme or funnel toward — the tag scheme (still needs Joel's
   real supplier/product list) should track all three without favoring one.
6. **Vercel plan:** Pro, confirmed by Joel. Unblocks all 11 factory crons; exact schedule limits
   (max jobs, minimum interval) get confirmed against Vercel's current docs when `vercel.json` is
   actually written for Phase 8+, not assumed from memory now.
7. **AI content composer:** in scope. `ANTHROPIC_API_KEY` and its real per-call cost are accepted,
   effective when Phase 3 (autoblog) starts — not before, since nothing needs it before then.
8. **Compliance wording:** Joel supplies the real CASL/Quebec Law 25/PIPEDA consent wording and
   the actual TICO/BC/QC seller-of-travel registration numbers. None of it is invented, drafted
   from a template, or guessed at by Claude. This blocks Phase 8's consent banner specifically.
9. **GHL capability probing:** probe Social Planner statistics (Phase 6) and coupon-creation
   support (Phase 16.13, the ambassador program) for real against Joel's actual GHL plan at the
   start of each of those phases — never assume from GHL's general docs.

**Tracked:** all 9 decisions plus the audit itself are logged as `done` use-cases under the new
"Factory Parity Program" epic (`e10`) in `/admin/tracker`, sort orders 1001–1009 and 1018, each
with its resolution in the `note` field.

**Deviations from the vanilla spec, and why:** none yet — this phase only made decisions, no code.
The migration-numbering and admin-auth-shim answers above are themselves the two places this
project's own architecture required a real adaptation rather than a literal port; both are
recorded here so a later phase doesn't quietly relitigate them.

**Next (superseded):** the line below originally said Phase 1 hadn't started - that's stale. Per
`/admin/tracker` epic `e10`, phases 1 through 13 (minus a few still-backlog items) shipped across
several sessions after this entry was written. This file just wasn't updated along the way; the
tracker, not this log, has stayed the live "what's actually done" source. See the next entry below
for the first one logged here since.

## Content pipeline hardening, phase 1 (2026-10-04)

**PRs:** `ff9aba1`, `79d9f43`, `76a3aee` (direct to `main`, this project's standing convention -
see the "Workflow convention" note elsewhere in this repo's memory/CLAUDE.md).

**What happened:** Joel shared a detailed writeup of Nomad Escape Plan's content pipeline
(discovery → score → write → QA → image → publish → repurpose into video/carousel/captions →
distribute → track → learn) and asked for the same patterns here. Ran a 4-agent audit of this
project's actual current code first (topic discovery/dedup/grounding; cover images; distribution/
heartbeats/health/duration budgets; video/carousel/analytics/A-B-testing existence) rather than
assuming anything from the Sept 26 `GAP-REPORT.md` was still accurate - a lot had shipped since.

**Already strong, left alone:** the topic queue (`blog_topic_queue`) decoupling discovery from
writing; `lib/content-dedupe.ts`'s fuzzy (token-overlap, 0.75 threshold) near-duplicate check, run
3x across the pipeline; one shared `runAutoblog()` for both the admin button and the cron; discrete
keywords→idea→body→title composition steps; an explicit no-fabrication instruction backed by a
post-hoc regex gate on the output; cron heartbeat coverage on all 3 real crons; System Health
computing its verdict from the same single data source the rest of the dashboard reads, not a
second disagreeing calculation.

**Built this phase** (deterministic engineering, no new vendor/budget needed):
- `lib/content-drift.ts` + `/api/admin/blog/drift` + an admin-page trigger: re-checks every
  published post against CURRENT `travel_packages` data, flags a post whose linked trip is no
  longer published or whose dates already passed. The single highest-leverage item named in Joel's
  writeup ("cheap, catches a real recurring error class").
- `lib/social-captions.ts`: a real per-platform character-limit table + mechanical truncation,
  wired into `lib/distribution.ts` so the shared caption Upload-Post sends to every network can
  never silently exceed any of their real limits.
- `maxDuration` added to 4 routes doing real per-row work with none declared
  (`keywords/search-data`, `funnel`, the `distribute` and `gsc-snapshot` crons).
- `lib/funnel.ts`'s `site_visits` scan was unbounded - now an exact Postgres `COUNT` for the stage
  number, a capped/ordered sample for the channel breakdown (harmless today at 0 rows, a real fix
  for once the consent-gated tracking route goes live).
- `lib/blog-topics.ts`'s `travel_packages` prompt-material query had no `.order()` - added one.
- Autoblog's body prompt (`lib/blog-composer.ts`) now explicitly requires a direct-answer opening
  sentence and the primary keyword in the first heading - unchanged otherwise (word count, heading
  count, no-fabrication rule, tone). Not live-tested against a real model call (real cost per call,
  same discipline as everywhere else in this project) - worth a glance next time autoblog runs.

**Decisions needed from Joel, not built blind, each with a real reason:**
1. **Video/TTS/auto-caption pipeline** (a Shotstack-equivalent hosted render API) - genuinely
   missing (confirmed: zero Shotstack/voiceover/b-roll code anywhere). Real vendor + budget
   decision, same class as decision 7 in Phase 0 above.
2. **Carousel/slide-deck generation** - missing, and lower priority than video per Nomad's own
   framing ("depends on distribution existing first") - distribution exists here now but is still
   dormant (mode = off).
3. **Genuinely distinct per-platform caption VOICE** (not just the length-fit built this phase) -
   needs either a new AI call per post or one Upload-Post call per platform instead of one shared
   call, multiplying its metered upload quota. A real cost/quota tradeoff to decide, not a default.
4. **Social engagement-analytics sync** (likes/shares/saves/reach back from Upload-Post into the
   DB) - `uploadPostGetStatus` exists but has no caller; wiring it up means a real live test
   against Upload-Post's actual account first (per the writeup's own "live-test before trusting
   docs" rule, and this project's standing "never hit a paid API without go-ahead" discipline) -
   can't be done from an unattended session without Joel's explicit say-so.
5. **A/B testing of hooks/cover styles/posting times** - blocked on #4 existing first; no real
   engagement data to learn from yet.
6. **Automatic AI-image fallback for autoblog covers** - confirmed real gap: autoblog's cover-image
   path (`lib/blog-image.ts`) only tries Pexels, with a silent `null` fallback (a published post
   with no image, generic beach-photo OG fallback). An AI generator already exists
   (`lib/image-ai-gen.ts`) but is wired exclusively to a manual admin-clicked button on the
   Packages page, specifically because credit-costing calls are admin-triggered here, never
   silent. Wiring it into the unattended cron as an automatic fallback would reverse that explicit
   rule - needs an opt-in toggle (default off) if Joel wants it, not a silent default.

**Deviations from the vanilla spec, and why:** per-platform captions scoped down to mechanical
length-fitting only, for the reason in decision 3 above - the full ask (distinct per-platform
voice) isn't a free port, it has a real recurring cost/quota shape that needs a decision.

**Tracked:** logged in `/admin/tracker` under epic `e10`; see that tracker for exact rows/ids
rather than duplicating them here.

## Content pipeline hardening, phase 2 — all 6 decisions built (2026-10-04)

**PRs:** `26d455d`, `dfad3e9`, `cebfe50`, `b27083f`, `1da68fa`, `8b48e18` (direct to `main`).

**What happened:** Joel authorized building all 6 decisions deferred at the end of phase 1,
"in order of most impactful," without per-item check-ins - with the same standing discipline from
phase 1 unchanged: never hit a paid third-party API for real without more specific go-ahead, never
flip `distribution_mode`/`autoblog_mode` into a live-posting state, never fabricate data.

1. **AI-image autoblog fallback** (`lib/blog-image.ts`): opt-in toggle (default off,
   `autoblog_ai_image_fallback`), Pexels still tried first; only falls back to a generated
   illustration (alt text says "Illustration:", never claims a real photo) when Pexels comes up
   empty and the toggle is explicitly on.
2. **Tailored per-platform captions** (`lib/social-captions.ts`): real published per-platform
   character limits + platform-specific voice table, one Anthropic call writes all platforms at
   once; still mechanically re-fit to each limit regardless of model output. Own toggle (default
   off, `distribution_tailored_captions`) since it's a real recurring extra cost/quota, not free.
3. **Video script generation** (`lib/video-script.ts`) + Shotstack scaffold (`lib/shotstack.ts`,
   explicitly marked NOT live-tested - built from documented API shape only, no real account to
   verify against yet). Two explicit admin steps (generate script, review, THEN submit render) so
   nothing costs money without a human seeing the script first.
4. **Engagement-analytics sync** - scoped down from the vanilla ask (likes/shares/saves back from
   Upload-Post) to what's honestly buildable without guessing at an unconfirmed vendor response
   shape: `syncPendingDistribution()` resolves held rows stuck on "needs review" by polling
   Upload-Post's own completed/total counts, not real engagement metrics. Flagged to Joel rather
   than fabricated.
5. **Carousels** (`lib/carousel.ts`, `/carousel/[slug]/[n]`, admin UI card): 7-slide deck per post,
   same numeric-grounding hard gate as the FAQ generator and composer (whole deck fails together).
   Slides render as real PNGs via next/og's `ImageResponse`. Hit a confirmed real bug along the
   way: Next 14.2.35's compiled `@vercel/og/index.node.js` reads its default font via a module-level
   `fileURLToPath(path.join(import.meta.url, ...))` that produces a backslash-mangled path and
   crashes every request on Windows - verified by reading the compiled file directly, not just the
   stack trace. Fixed by running that one route on the edge runtime instead, which loads the same
   default font via `fetch(new URL(...))` and has no such bug on any OS (also confirmed by reading
   that bundle) - a targeted fix for a specific library bug, not a general edge preference.
6. **A/B testing** - also scoped down, for the same honesty reason as #4: `distribution_mode` is
   off and nothing has posted, so there's no real engagement data to compare variants against.
   Built only the logging foundation (`content_variants` table, migration 0017,
   `lib/content-variants.ts`'s `tagVariant()`) - tags cover-image source, video hook formula, and
   carousel presence per post as each generator already runs, so a real comparison has data to work
   from once posting history exists.

**Deviations from the vanilla spec, and why:** items 4 and 6 above are both honest scope
reductions, not full ports - building either one fully would mean inventing vendor response shapes
or sample engagement numbers that don't exist yet, which this project's no-fabrication discipline
rules out either way.

**Tracked:** filed under epic `e10` in `/admin/tracker` (carousels done, A/B logging and
engagement sync kept in progress with honest scope notes).

## Content Autopilot - one pipeline, live on real accounts (2026-10-07 to 2026-10-08)

**Commits:** `4d5b155` ... `e2fbe5b` (direct to `main`). Migrations `0017`-`0025`, all applied to the
one Supabase project and verified.

**What happened:** Joel asked for the whole content chain to run on autopilot with one action, not a
set of settings and clicks. Built it, turned it on (his call), and tested it end to end on his real
accounts, fixing what the test found.

**Built**
- `lib/pipeline.ts`: ONE scheduler (`/api/cron/autopilot`, every 15 minutes) that does whatever is due,
  in order: weekly keyword research, write+publish the day's post (from 13:00 UTC), post it with a
  caption per network, then carousel and video and their posting, plus housekeeping. The separate
  autoblog and distribute schedules were removed (their heartbeats are recorded by the pipeline).
  `/admin/autopilot` has the one switch, one "write and publish a post now" button, and each step's
  result. Turning it on applies a preset (autoblog publish, distribution auto unless already in
  review mode, tailored captions, AI cover fallback).
- `lib/autopilot.ts`: per-post `content_pipeline` state machine (carousel, video), videos-per-week cap,
  48-hour Shotstack render cleanup, Shotstack environment auto-detection (key decides sandbox vs
  production), and a 6-hour pause when Shotstack rejects the key.
- `lib/social-provider.ts` + `lib/ghl-social.ts`: one active provider at a time, Upload-Post or
  GoHighLevel Social Planner, behind one PostingTarget. Provider-aware network rules (YouTube is
  video-only; GHL's TikTok takes video only, hosted on GHL first). "Where it posts" card on the
  Autopilot page (profile and accounts loaded from the provider, nothing ticked by default for GHL
  because that location holds several businesses' accounts).
- `lib/issues.ts`: ONE "Needs attention" list for every error (failed posts, carousels, videos,
  GHL posts a network rejected after accepting, paused video, quiet cron jobs, failed steps,
  missing setup), each with plain advice and a Retry/Dismiss/Resume button; the alert email
  (`lib/alerts.ts`, Resend, 6-hour throttle) is built from it.
- `lib/keyword-refresh.ts`: weekly capped (default $1) DataForSEO keyword research seeded from the
  site's own trips, feeding the existing topic picker.
- Video: Shotstack rewritten against its real API; Pexels portrait stock footage; cover card for the
  first 3 seconds with a model-written catchy headline; text wrapped inside the 9:16 frame.
  Carousels: a portrait photo per slide, bold red cover card, progress strip and swipe cue.
- Tracker: per-use-case size estimate and rough cost (S/M/L x a stated day rate).

**Bugs the live test found (all fixed)**
- A photo post was sent to YouTube (video-only), and a partial failure made retries re-send to every
  network: Bluesky got 4-5 copies of one post. Now each post and carousel/video records the networks
  it reached (`sent_platforms`, `carousel_sent`, `video_sent`) and retries skip them.
- The "pause video on a rejected key" safety never fired: a backspace character had replaced `\b` in
  its regex (a shell-heredoc escaping accident). Now keyed on the HTTP status.
- A just-submitted video render was marked timed out in the same pass (stale in-memory timestamp).
- Keyword research ran on six passes in one day instead of once a week (cause not proven); now an
  atomic database claim plus a real weekly spend cap.
- GHL's TikTok rejected photo posts and, later and silently, a video from an unverified domain.

**Not yet confirmed by a real run:** the new-look video (cover card, wrapped text), the new carousel
with per-slide photos, GHL hosting of the TikTok video (needs the `medias.write` permission on the
GHL token), the Resend alert email, and the Upload-Post connect link. The next scheduled post is the
test for the first three.

**Deviations from the spec, and why:** none from the vanilla Nomad spec; this phase is this
project's own automation layer on top of the ported engines.

## Autopilot hardening, daily brief, consent, keyword-first topics (2026-10-09)

**Runaway found and stopped.** On 9 Oct the pipeline wrote 7 near-identical Rhine posts in 4 hours (cap is
1 a day, 3 a week). Cause: decisions made from stale database reads. Fix: `lib/supabase-admin.ts` forces
no-store; `lib/autoblog-run.ts` has a fresh fail-closed daily count (before compose and again before save),
a one-post-per-package-per-30-days guard with a 4-skips-a-day cap. Verified at the 17:30 UTC pass. Five
extras unpublished (301 to the kept post in `next.config.mjs`), nothing deleted.

**Shipped (all on main):**
- Video: Shotstack `stroke` placement and `rich-caption` fixes (9c59eb6); TikTok video now uploaded as a file
  to GHL media (cbf94cd). Instagram reel and TikTok video confirmed published.
- Leads: GHL v2 contacts/upsert + opportunity (Bookings Pipeline, New Lead), saved before forwarding, newsletter
  backed up, `leads.is_test` (migration 0026) and `lib/test-data.ts` exclude test data everywhere.
- Self-heal (`lib/heal.ts`): unsent leads x3, Shotstack 429/503 videos x1, orphaned carousels/videos cancelled
  (confirmed live 20:30 UTC), stale GHL errors auto-hide (reads 8 pages).
- Daily brief from "Aiva from TravelFunBiz.ca" (`lib/debrief.ts`, `brief-html.ts`, `plain-steps.ts`): 7 am ET
  via Resend (domain m1.travelfunbiz.ca), grade-5 steps, Outlook-safe layout, Copy for Claude button on the
  Autopilot page, counts only ticked accounts (it once counted other businesses' posts: the "37").
- Consent-first tracking: cookie banner, GA and attribution only after yes, CASL newsletter box, French
  wording; privacy policy DRAFT in `docs/legal/privacy-policy-draft.md` (not published, not legal advice).
- Payment webhook records only `site-ca` contacts (the GHL location also holds members and client invoices).
- Keyword work: Search Rankings and Keyword Research track every package/destination/blog page; keyword to
  ranking-page connection (auto daily); keyword scoring + clustering (`lib/keyword-score.ts`) drives the
  next blog topic; ideas from Google autocomplete, People Also Ask, Reddit (needs keys) and customer
  questions; Google Trends peak months feed the timing score (`lib/keyword-ideas.ts`).
- Content map on the Autopilot page; one-network Retry button REMOVED (QA: double-post risk).

**Spend today:** DataForSEO about $0.22 (balance about $50.13). Every automatic step stays capped.

**Not merged, local only:** branches `qa/overnight-r1..r3` and `qa/growth-r1` (worktrees under
`.claude/worktrees`). Only shotstack.ts, social-provider.ts, app-settings.ts and the growth prompt commit
were taken. Their autopilot.ts changes (retry markers, back-offs) were judged too complex for a live pipeline.

**Open, Joel's side:** pick/confirm Rhine social copies to delete; delete test contact "TEST LEAD Claude"
in GHL; add `site-ca` tag filter to the GHL payment workflow; legal review of banner/checkbox and fill the
privacy-policy brackets; tick Facebook, LinkedIn, YouTube in "Where it posts"; Reddit keys added (untested);
`GOHIGHLEVEL_WEBHOOK_SECRET` set and tested.

**Unverified:** Search Rankings and Keyword Research screens were never viewed (admin login); the first
keyword-led post (Mon 12 Oct, 9 am ET); the new brief layout in Outlook; Reddit connection.

## Growth loop, wave 1: SEO/GEO/AEO posts, social hooks, guide pages, performance scores (2026-10-09 to 2026-10-10, overnight)

**How it was built.** Joel asked for an unattended multi-agent loop: Sonnet builders in isolated git worktrees,
critical Sonnet QA agents reading the whole diff, builder fix rounds, and the Fable 5.1 orchestrator deciding what
merges. Contract: `docs/factory/GROWTH-LOOP-BRIEF.md`. Four work packages, each 1 to 2 QA rounds, all merged
to `main` the same night: WP2 (512623b), WP3 (8fc54d8), WP1 (75195ac + ff534b6 wiring), WP4 (ae78a27), plus
f061bfb. Migrations 0027, 0028, 0029 applied. Every WP ships an offline check script under `scripts/`
(`check-content-styles`, `check-captions`, `check-performance`, `check-guide-gate`, run with `pnpm dlx tsx`).

**Shipped (all on main):**
- WP1 Blog posts for SEO + GEO + AEO: 7 content styles rotated (`lib/content-styles.ts`), 5 CTA styles, Quick
  answer line, definition sentence, FAQ (FAQPage JSON-LD), key takeaways (speakable), OG title/description,
  primary/secondary keywords, internal links only to real pages, BreadcrumbList, Article wordCount/keywords. Gate:
  numbers only from the grounding text (digits and word-numbers), dead or external links, em dashes (auto-repaired),
  OG length (auto-repaired), ONE repair model call for number/link slips, a 240s compose deadline. Held drafts
  carry `held_reasons` in content_variants and show in the daily brief. Posts table: migration 0027.
- WP2 Social: hook style per network rotated with a per-network offset (`lib/hook-styles.ts`), per-network hashtag
  rules, caption gate (limit, link-only, title repeat, ungrounded digits and spelled numbers, em dash), every link
  UTM-tagged (source = network, medium = social, campaign = slug, content = hook style), video hook formulas
  question/story added and rotated, carousel hook/CTA rotated, tags `hook_style:<network>`, `caption_style:<network>`,
  `cta_style:<network>`, `video_hook`, `carousel_hook`, `carousel_cta`. Send path byte-identical to before (QA-audited).
- WP3 Tracking and self-improvement: daily `content_performance` snapshot in housekeeping (GSC 28-day clicks per
  page, social sends/failures, 90-day leads, visits null until consent tracking writes), `styleScores` per tag key
  (only posts 28+ days old, null clicks never counted as 0, thin-sample label under 3 posts), "What is working" card
  on /admin/autopilot and a brief section, and `chooseWeighted` wired into the composer: 70% best style (leads first,
  then clicks) once a style has 3 measured posts, rotation otherwise. Migration 0029.
- WP4 Guide pages: `guides` table (migration 0028, RLS, anon reads published only), kinds destinations, hotels,
  resorts, cruise-lines, ships, river-cruises, yachts; routes `/<kind>` and `/<kind>/<slug>` (destinations keep
  `/destinations/<slug>`), one shared page component, TouristDestination or Article+about JSON-LD, FAQPage,
  BreadcrumbList, sitemap, Guides page type in Keyword Research/Search Rankings. Composer with a strict gate:
  numbers, superlatives, recency, named venues/people not in the brief, agency "we offer/our hosts" claims, dashes.
  Pipeline step `guides` (1/day, 5/week, kind rotation, 2 tries per candidate, 3 failures in 24h pauses everything).
  `guides_publish_mode` defaults to draft (Joel: review the first week); hotels/resorts/ships/river cruises/yachts
  are NEVER auto-published. Admin: guides panel on Autopilot and Destinations, Preview page for drafts, Write buttons.
- Fix found in the browser pass: related trip cards never rendered on posts without a linked package
  (`.neq('id','')` on uuid). Pre-existing funnel leak on every autoblog post.
- Rhine duplicates: Joel kept the published post; the 5 drafts and their ledger rows were deleted.

**Verified:** tsc clean after every merge; all four check scripts pass on main; local browser pass of
/blog/<slug>, /destinations, /hotels, /destinations/rhine-river, sitemap (200s, correct JSON-LD, noindex on empty
index). NOT verified: any real model output from the new prompts (first real post is Mon 12 Oct 13:00 UTC), the
first AI guide draft, the Autopilot page and Preview page in a browser (admin login), Outlook rendering of the new
brief section, the live Vercel deploy of ae78a27+.

**Spend:** no paid calls made by the loop itself. New automatic spend: at most 2 Anthropic calls per guide,
1 guide/day, plus one repair call per post at most.

**Open, Joel:** review the first guide drafts via Preview and decide `guides_publish_mode`; delete duplicate
Rhine social posts in GHL; tick Facebook/LinkedIn/YouTube; the Reddit line; everything from the 2026-10-09 entry.
**Open, Claude (filed in the tracker):** tune the named-venue check from week-1 quality_notes; measure the real
auto-publish rate over the first 6 posts; Pexels photographer credit column for guides.

## Growth loop, wave 2 + keyword engine (2026-10-10, daytime)

Same builder / critical QA / orchestrator loop as wave 1. All merged to main the same day: WP7 (7c5e755),
WP6 (8e65c6e), WP8 (5e984b1), WP9 (eeafec3) plus eff4551. Migrations 0030, 0031, 0032 applied. Check scripts
added: `check-og-paths`, `check-guide-distribution`, `check-page-copy`, `check-keyword-intel` (all pass on main).

**Shipped:**
- WP6 Share images: `/og/<family>/<slug>` renders a 1200x630 card (photo, kind label, title, brand) for blog,
  guides, trips, compare, best-time and destination pages; force-dynamic with explicit cache headers, 308 on
  query strings, 404 for unpublished, host allow-list and one redirect for the photo. Verified LIVE (200 PNG,
  404, 308; two real renders inspected).
- WP7 Guides earn traffic: published guides enrol for social (one guide per UTC day, `post_distribution.path`,
  slug `guide-<kind>-<slug>`, same captions/hooks/UTM, send path byte-identical to before per QA); named-property
  kinds published by hand enrol as `held` (Joel's rule); gate-held guides never enrol; related-guides link graph on
  guide pages, "Guides for this trip" box on posts, hotel/resort guides listed on destination pages; the gate now
  excuses a count in words when the grounding has it ("four-night" vs a 4-night trip).
- WP8 Compare and best-time copy: `page_copy` table, grounded intro/FAQ/takeaways/meta written by a capped
  pipeline step `copy` (1/day, 7/week), weather/crowd/verdict gates, stale-link guard at render, daily stale
  check with Dismiss, `page_copy_publish_mode` default draft (Joel: first week), Autopilot card.
- WP9 Keyword intelligence engine: Google-only Keyword Research page (no Bing), sorted by volume; weekly engine
  (SEEDS, EXPAND, ENRICH, CLUSTER, PLAN, TRACK) under an atomic ISO-week insert claim, per-stage spend log pruned
  by age, budget `autopilot_keyword_budget_usd` ($5/week, Joel), opportunity labels (RANKING / ALMOST /
  SHOOT_FOR / TARGETED / SKIP), one AI call plans up to 6 next blog ideas with validated keyword sets saved to
  `blog_topic_queue`, the autoblog writes for the set, progress per keyword from `gsc_rankings`. Unbudgeted
  routes closed (suggest 410, paid lookup needs track_only, collectIdeas POST removed).
- First real engine run (local, button): 92 phrases in 43 topics, 40 SHOOT_FOR, 6 ideas planned (Dominican
  Republic cruise ports 87, Split/Dubrovnik cruise ports 86, Croatia small ship 75, Australia/NZ 2027 73, ...).
  Bug found and fixed the same hour: one 11-word People-Also-Ask phrase made Google Ads reject the whole
  volume batch (eff4551 filters over-10-word phrases and marks them).

**Live actions today (Joel's picks):** `guides_publish_mode` = publish; Montego Bay guide edited (2 words),
published, posted to Bluesky/Pinterest/Threads/Instagram via the new guide path; Fairmont Banff Springs hotel
guide written, edited (2 phrases), published; keyword budget raised to $5/week; Reddit keys added in Vercel
(Joel). Languages: English only, ever (Joel).

**Not verified:** the Keyword Research page in a browser (admin login); the first pipeline-written compare or
best-time draft; the first guide social post's caption text on each network; Reddit ideas in a real weekly run.

**Next (WP10, in build):** self-healing content: reword repairable held phrases and publish, daily SEO score with
cheap fixes, `content_edits` audit trail with Revert, "Edits made" in the brief; named-property guides may
auto-publish after a clean repaired gate (Joel). Wave 3 queued: trip pages SEO pass.
