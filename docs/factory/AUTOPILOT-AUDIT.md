# Autopilot audit: how close is the site to 98% hands-off?

Read-only audit, 2026-10-24, main branch. No code, DB or settings were changed. Every claim below was checked against the code named next to it. Where I read a page's controls from its source only partly, the section says so ("not read button by button").

Scheduler facts that shape every proposal (vercel.json, app/api/cron/*):

- Two crons only. `/api/cron/autopilot` every 15 minutes (maxDuration 300, internal budget 200 s, `lib/pipeline.ts`). `/api/cron/gsc-snapshot` daily 14:00 UTC (maxDuration 60).
- The daily cron is already full: ranking snapshot, keyword connect, cron watchdog, AI tripwire, Bing, optimizer, funnel watchdog (needs 25 s free), SEO engines, site crawl (up to 40 s), SEO playbook audit, URL inspection, system check. Each later step has a "skipped (time budget already used)" fallback (`app/api/cron/gsc-snapshot/route.ts`). So under load the LAST steps (URL inspection, playbook audit, system check) are skipped silently. Do not add work there. New daily work belongs in the autopilot pass with the existing "claim once a day inside the function" pattern.
- The autopilot pass skips most steps when Autopilot is off, when `automation_paused` is on, or when dry run is on (`runPipeline`). Only `housekeeping()` runs in the first two cases.

---

## 1. Touchpoint inventory

Legend: A = must stay human (agreed list), B = automate with safe default plus Undo, C = remove (redundant), D = a setting that should be derived.

The control counts come from a grep for buttons, switches, selects and checkboxes: 201 in `app/admin/**`, 247 in `components/admin/**`. Most are CRUD plumbing on lists, not daily decisions. The tables list the decisions only.

### 1.1 Today (`/admin`, `lib/today-cards.ts`, `components/admin/today-stack.tsx`)

The Today stack has 20 card kinds. Each card has Yes/No (answer), Later, Skip, Auto-heal, Copy for Claude, Undo.

| Card kind (today-cards.ts) | What the human does | Class | Note |
|---|---|---|---|
| hot-lead | Assign to agent / Later | A | Agreed. Keep. |
| lead-reply | Reply to new non-hot lead | B | Instant ack exists but is OFF by default (`lib/lead-ack.ts` `isLeadAckOn`). Turning it on (derive) removes the "answer" pressure. Setting is D. |
| agent-submission | Approve agent trip | A | Agent profiles/legal. Keep. |
| failed-post | Retry | B | Already retried automatically 3 times (`RETRY_WAITS_MS` 15 min, 2 h, 12 h). The card only appears after the ladder is spent or for non-self-fixable errors. Keep as the escalation, but see WP5/WP7. |
| failed-render | Retry carousel/video | B | `stepResumeVerdict` resumes a stuck step ONCE after 2 h. Rows that hit `MAX_ATTEMPTS = 3` in `lib/autopilot.ts` stay `failed` forever. WP5. |
| video-paused | Resume videos | B | `VIDEO_BLOCK_KEY` pause after a Shotstack 401/403 expires by itself; the card is for key problems. Keep (needs a key, human). |
| news-draft | Approve/reject a news brief | B | `runPublishPassingNews` auto-publishes passing briefs after 2 h cooling, but only when `travel_news_mode` is `publish`. Default is `draft`. Setting is D (WP11). |
| held-guide-post, guide-caption-held, held-post | Release held social posts | B | `runReleaseHeldPosts` already releases after 24 h (cap 2/day). Cards remain for ones that failed caption checks. |
| topic | Approve blog topic | C/B | `runApproveSafeTopics` approves 2/day. `lib/autoblog-run.ts` uses `pickOneTopic()` freeform fallback when no approved topic exists, so no approval is ever required for writing to continue. The queue is a steering wheel, not a gate. |
| guide-review | Approve guide page | B | Only when `guides_publish_mode` is `draft` (default, `getGuidePublishMode`). D (WP11). |
| blog-draft | Approve blog draft | B | Only when `autoblog_mode` is `draft`. D (WP11). |
| supplier-change | Decide on a supplier-page change | A | Price/availability claims. Keep. |
| issue-dismiss ("Needs a look") | Dismiss an issue | C | Pure housekeeping of the issue list. WP5 expires stale ones. |
| promote-prompt | Pick a trip to promote | B | Trip social is a switch (`trip_social_posts`, default off). Selection could use `content_performance` leads/visits, which `lib/promotion.ts` already reads for display only. WP8. |
| recap-prompt | Start a recap for a finished trip | B | WP10 drafts it privately when notes exist. Recap needs real notes (cannot be invented). |
| thin-page | Fix a thin trip page | C | `autopilotTripKitStep` already fills one thin trip per pass (`lib/trip-kit-run.ts`). The card is a duplicate once autopilot is on. |
| affiliate-setup | Set up an affiliate partner | A | Account sign-up. |
| seo-fix | Re-check an SEO item | B | Auto-heal button just re-reads the audit (`seoHealer`). A re-check can be automatic. Part of WP4. |

### 1.2 Daily follow-ups (`/admin/follow-ups`, `lib/followups.ts`, `components/admin/followups-panel.tsx`)

Groups: lead, digest, seo, social, weekly, links, recap, setup. Controls: Done, Later, AI assist (`runAssist`), Copy prompt, Copy text.

- lead items duplicate the Today hot-lead and lead-reply cards. C.
- weekly `weekly:fix-<stage>` items are the System check red/amber stages re-listed (`lib/system-check-fixes.ts`). C: the System check page already lists them.
- weekly `mon-search-console` and `fri-grid` are reading chores with no write action. C (digest already emails, `lib/growth-digest.ts`) or fold into the 7 am brief.
- `social:routine` (15 minute social routine) is a human social-engagement task. A.
- links (link building drafts) and setup steps are one-off human sign-ups. A.
- recap group duplicates the Today recap-prompt card. C.

### 1.3 System check (`/admin/system-check`, `lib/system-check*.ts`)

- "Fix these today" ticks (Done/Later per stage, `tick(f.stage, ...)`). C: it ticks a to-do list that is derived from live state; the item disappears when the stage turns green.
- "Auto-heal" button (`POST /api/admin/system-check`, `runAutoHeal` in `lib/system-check-heal.ts`). B: `runAutoHeal` is called ONLY from that admin route (verified: grep shows only `app/api/admin/system-check/route.ts` and the file itself). Its four plain steps (funnel watchdog, retry failed posts, approve safe topics, site crawl) already run on their own elsewhere (pipeline step 1e, gsc-snapshot). The only thing the button adds that never runs unattended is the bounded AI fix step (`lib/system-check-ai.ts`, cap `system_check_ai` 12/day). WP4 schedules that.
- Copy for Claude / Refresh. Keep as optional.

### 1.4 Content Autopilot (`/admin/autopilot`, `components/admin/posting-card.tsx`, `posts-automation-card.tsx`, `trips-automation-card.tsx`, `guides-automation-card.tsx`, `evergreen-card.tsx`, `dry-run-card.tsx`, `auto-decisions-card.tsx`, `self-healing-card.tsx`, `travel-news-card.tsx`)

| Control | Class | Note |
|---|---|---|
| Autopilot Turn on/off | A (master switch) | Keep. |
| Pause all automation (kill switch) | A | Keep. |
| Write and publish a post now / Email me the brief now / Email me a test alert | C | Manual run-now buttons. Debug tools; move behind Advanced. |
| Videos per week select | D | Derive from Shotstack credits and measured reel performance (optimizer already tracks formats). Low value. |
| Keyword budget select | A | Money cap. Keep. |
| Provider choice (Upload-Post vs GHL), account checkboxes, profile select, Connect accounts, Refresh | A | Account/OAuth. |
| "Write a different caption for each network" | D | Should be on whenever AI is configured. |
| "Post about our trips" (trip social, default off) | D | Derive: on once N trips are published and gate passes (WP11). Never publishes drafts (`tripReleaseProblems`). |
| Distribution mode (off/prepare/auto, `DISTRIBUTION_MODE_KEY`) | D | `prepare` holds every post; `release_held_posts` frees them after 24 h. So `auto` and `prepare` differ only by 24 h. Derive. |
| Autoblog max per day select (1 to 3) | D | Derive from cadence/quality (WP11). |
| Autoblog mode (off/draft/publish) | D | WP11 ladder. |
| Guides publish mode, Guides catch-up switch, Heal now | D / C | Heal now duplicates the daily `runHealContentIfDue`. |
| Evergreen re-share switch (default off) | D | WP11. |
| Dry run switch | A (safety tool) | Keep. |
| Per-policy switches on the decisions card (5 default ON + 2 SEO) | A | Safety switches. Keep, but Undo buttons on log lines are the correct B mechanism. |
| "Needs attention" items with Fix/Dismiss buttons (`post({action:'issue'...})`) | B/C | See issue-dismiss. |
| Autopilot decisions Undo | A (it is the Undo) | Keep. |

### 1.5 Posts: Blog (`/admin/blog`, `components/admin/blog-posts-list.tsx`, `blog-topic-queue.tsx`, `app/admin/blog/[id]`)

18 controls in the list, 7 in the queue. Decisions: approve/reject/schedule topic (C/B above), publish/unpublish a draft (B when mode is publish), edit post. The editor is optional CRUD. Class: mostly C once WP11 moves the mode to publish with the quality gate; keep manual edit.

### 1.6 Posts: News (`/admin/news`)

approveBrief / rejectBrief (B), per-feed on/off, mode Off/Draft/Publish (D), per-day numbers (D). Not read button by button beyond that.

### 1.7 Posts: Guides (`/admin/guides`, `components/admin/guides-panel.tsx`, `guides-backfill.tsx`)

`bulk(...)`, `healOne(r)`, `setLive(r, true/false)`, backfill controls, publish mode. Class: setLive true is B (gate-passing guide in publish mode is already auto-released; `lib/guide-release.ts`), healOne is B (daily heal covers it), backfill start is A/B (cost; capped by `guides_per_day` and `guides_per_week`).

### 1.8 Posts: Trips (`/admin/packages`, 47 controls; `package-sources-panel.tsx`, `package-kit-panel.tsx`, `past-trip-panel.tsx`)

- Add trip (AI interview, URL scrape, paste, CSV, manual), edit fields. A for new trips (source of truth is a supplier/agent). Price fields: A, never automated.
- Publish/unpublish a trip. A-ish: "never publish unpublished/draft trips" is a hard rule. Keep manual.
- "Confirm and show" / "Take the price off the page" in `package-kit-panel.tsx`: A (price confirmation by an agent).
- Past-trip panel: saveSettings, add to gallery, delete/undo photo. B (photo adoption could be automatic when a recap exists), A for recap publish if it contains quotes/claims.
- Trip Kit fill: already automatic (`autopilotTripKitStep`), and batch button (`package-kit-batch.tsx`) is C.

### 1.9 Content Autopilot downstream: Post Distribution (`/admin/distribution`)

"Sync pending", `setStage(row.slug, ...)` (approve/hold/skip a social row). B: queue approvals are what `release_held_posts` and the retry ladder already do. Keep a view, drop the daily duty.

### 1.10 Keyword Research (`/admin/keywords`, 24 controls) and SEO engines (`/admin/seo-engines`) and SEO & GEO Manager (`/admin/seo-manager`, 16)

- addPhrase / remove / saveRow (assign a target page): B. `connectKeywordsToRankingPages` (daily) only connects a keyword to the page Google ALREADY shows for it. Unranked keywords have no automatic target (see WP9).
- Idea scheduling (`setIdeaStatus(idea.id, ...)`, scheduleDate): B, same as topic approval.
- Weekly keyword engine: automatic inside the dollar budget (`runKeywordEngineIfDue`). Budget: A.
- SEO engines "scan all competitors" and `call(...)` actions: C. One competitor per day already scans in `runSeoEngines`.
- SEO manager checklist "only you can do" items: A, the rest auto-audited.

### 1.11 Leads (`/admin/leads`, `components/admin/leads-desk.tsx`, `hot-lead-panel.tsx`)

- Assign to agent: A.
- Mark contacted / booked / lost: B. Nothing sets these automatically (verified: `'booked'` appears only as a status constant and in funnel counting; no code writes it from an order). WP2.
- Lead ack email (OFF by default): D.

### 1.12 Orders (`/admin/orders`)

Read only. No controls. But also no outgoing trigger (see section 2).

### 1.13 Travel Agents (`/admin/agents`, `components/admin/agents-*.tsx`, `agent-invites-card.tsx`)

Invite, import, approve profile, edit. A (agreed: profile approval).

### 1.14 Testimonials (`/admin/testimonials`)

Create/edit/delete rows; draft rows stay hidden. A for publishing (claims), B for creating the draft from approved recap quotes (WP10).

### 1.15 Affiliate Links (`/admin/affiliate-links`, 13 controls), Link building (`/admin/links-building`), Project Tracker (`/admin/tracker`, 11), Website Value, Users and Analytics, Dashboard, Search Rankings, System Health, Content edits

- Affiliate links: create /go links, partner setup: A (account/commission terms).
- Link building: human outreach: A.
- Tracker: planning notes for Joel/Claude: not part of the daily loop. C from the daily list.
- Value, Users, Dashboard, Rankings, System Health: read only. Content edits: the Undo list for the site's own edits. Keep (it is the Undo).
- Not read button by button: `affiliate-links/page.tsx`, `tracker/page.tsx`, `value/page.tsx`.

### 1.16 Setup (checklist artifact)

Env vars, account sign-ups. A.

---

## 2. Flywheel handoffs

Stages: keyword research, topic, post/guide/trip page, SEO gates, publish, social distribution, traffic, lead capture, Lead desk, agent assignment, booking, recap/testimonial, back to content.

| # | Handoff | Status | Exact mechanism / missing trigger |
|---|---|---|---|
| 1 | Keyword research -> keyword list | AUTOMATIC | `runKeywordEngineIfDue` (`lib/keyword-intel.ts`) called from pipeline step 0, once per ISO week, inside `keyword_budget`; claim before spend. |
| 2 | Keyword -> target page | PARTIAL | `connectKeywordsToRankingPages` (`lib/keyword-pages.ts`, daily in gsc-snapshot) only links keywords already ranking. Missing trigger: an unranked keyword with no page never gets a target or a "build a page" seed. Manual in `/admin/keywords` (`saveRow`). WP9. |
| 3 | Keyword/Search Console -> blog topic | AUTOMATIC | Engine writes topic suggestions; `runSeoEngines` adds up to 3 (`seo_topics`); `runApproveSafeTopics` approves 2/day (`TOPICS_PER_DAY`) with a backlog cap; `runAutoblog` prefers `dueApprovedTopics()` else `pickOneTopic()`. |
| 4 | Topic -> post | AUTOMATIC when `autoblog_mode` is not off | `runPipeline` step 1 -> `runAutoblog` (`lib/autoblog-run.ts`), publish hour gate 13:00 UTC, `autoblog_max_per_day` (default 1, max 3). Waits for a person only in the sense that `autoblog_mode` default is not `publish` (D). |
| 5 | Post -> SEO/quality gates -> publish | AUTOMATIC | Gates in `lib/blog-quality.ts` etc.; failing drafts go to `rehealStuckDrafts` (`lib/blog-reheal.ts`, called from `lib/content-heal-run.ts`) with daily tries and a `rejected` end state. Publish-time: `pingIndexNow`. |
| 6 | Guides | AUTOMATIC | `runGuidesStep` (step 1b), caps `guides_per_day`/`guides_per_week`; publish needs `guides_publish_mode = publish`, otherwise draft + Today card. |
| 7 | Trip pages | MANUAL (by design) | A person adds a trip and publishes it. After that the kit fill (`autopilotTripKitStep`, one per pass) and enrichment are automatic. Keep. |
| 8 | Publish -> verified live | PARTIAL | `runPublishVerifyIfDue` (housekeeping) checks 6 pages/pass read-only and raises an issue. Missing trigger: no remediation (no revalidate/re-ping/re-run). The file header states it deliberately takes no action. WP6. |
| 9 | Publish -> social | AUTOMATIC | `enrollRecentPosts` (autopilot.ts) and `enrollNewsIfDue` -> `runDistribution` (step 2). Mode `off` (default) stops it; `prepare` holds; `auto` sends. Daily ceiling `SOCIAL_ENROLMENTS_PER_DAY_CEILING = 6`. |
| 10 | Post -> carousel -> reel -> posts | AUTOMATIC | `runAutopilotTick` (step 3) with gates (`gateCarouselCover`, frame gate), weekly video cap. Rows that fail 3 times stay `failed`. |
| 11 | Social failure -> retry | PARTIAL | `runRetryFailedPosts` (step 1e): 3 retries with waits, cap 6/day, only self-fixable errors; ambiguous errors (timeouts, might have posted) and needs-person errors (auth) are NOT retried by design. Per-network pause after 3 consecutive failures (24 h, 2 strikes, then a person) in `funnel-watchdog.ts`/`network-pause.ts`. Nothing un-pauses after the account is reconnected. WP7. |
| 12 | Social -> traffic -> measurement | AUTOMATIC | `snapshotContentPerformance` (daily, housekeeping), GA4/GSC reads, optimizer `ingest`. |
| 13 | Traffic -> lead capture | AUTOMATIC | `/api/submit-lead`: `saveLeadFirst` -> `submitLeadToGoHighLevel` -> `markLeadSent` -> `sendLeadAck` (OFF by default). |
| 14 | Lead -> GHL | PARTIAL | `healLeads` (`lib/heal.ts`): up to 3 tries per lead, only leads 5 min to 48 h old, 5 per pass, then `[gave up]` and an issue. No longer ladder, no escalation beyond the issue/alert email. WP3. |
| 15 | Lead -> Lead desk alert | AUTOMATIC | `announceHotLead` (fire and forget) then `runHotLeadReminders` in housekeeping: ONE reminder at 15 min, window ends at 24 h (`REMINDER_AFTER_MIN`, `REMINDER_WINDOW_MIN`). No second tier after the single reminder. |
| 16 | Lead desk -> agent assignment | MANUAL (A) | `assignLead` records only what a person chose. Agreed. Keep. |
| 17 | Assigned lead -> contacted/booked/lost | MANUAL | `setLeadStatus` only from the Leads page buttons. |
| 18 | Booking -> order recorded | AUTOMATIC | GHL webhook `app/api/ghl/webhook/route.ts` -> `parseGhlOrder` -> `recordOrder` (`lib/purchase-ledger.ts`), idempotent upsert, 500 so GHL retries, event logged. |
| 19 | Order -> lead status booked | MANUAL | `recordOrder` matches a lead only to copy first-touch attribution (`firstTouchLead`). It never updates the lead's status. WP2. |
| 20 | Order -> recap/testimonial request | MANUAL / NO TRIGGER | Nothing reads `orders` to start a post-trip process. Recap start is the Today `recap-prompt` card or the "Start recap" button for trips with `available_to` in the past (`pastTripsNeedingRecap`, `lib/past-trip.ts`). `writeRecap` is called only from `app/api/admin/packages/[id]/recap/route.ts`. WP10. |
| 21 | Recap -> published page -> content | PARTIAL | `enrollFanoutRecaps` is a different thing (a "you asked, here is the answer" post for a blog post 7 to 10 days old). Trip recaps are not re-fed into blog topics or social. |
| 22 | Results -> next content | PARTIAL | See section 4. |

---

## 3. Self-healing and retry gaps

What exists and works (so it is not re-built): `selfHeal` (orphans, leads, videos; `lib/heal.ts`), `runAutoPolicies` (retry, topics, news, release), funnel watchdog (7 stages, bounded repairs, network pauses, IndexNow catch-up, blog nudge), `runSiteCrawl` safe repairs (5/day), `runHealContentIfDue` (daily SEO score + cheap fixes + CTR loop with auto revert, `lib/ctr-loop.ts`), `rehealStuckDrafts`, guide repair ladder, `runIndexNowCatchupIfDue`.

Gaps (reported but not fixed, or fixed once and then abandoned):

1. System check red/amber stages: the AI fix step runs only when a person presses Auto-heal. (`runAutoHeal` has one caller, the admin route.) WP4.
2. Failed GHL lead push: 3 tries, 48 hour window, then `[gave up]`. A GHL outage longer than about 15 minutes of retries (they happen on pipeline passes, so 3 passes) burns all tries. No backoff spacing, no later retry. WP3.
3. Failed social posts: errors classified `ambiguous` (timeout, 500) or `needs-person` are never retried automatically. After the 3-retry ladder or the 6/day cap, the row stays failed and shows a Today card forever. Per-network pause expires but nothing re-probes after a reconnect. WP5, WP7.
4. Failed carousel/video: `fail()` marks `failed` after `MAX_ATTEMPTS = 3` (autopilot.ts line 42); `stepResumeVerdict` resumes once after 2 h. A render whose request timed out is deliberately not retried (may have been charged, see header of `lib/heal.ts`). No dead-letter handling and no "post without the video" path. WP5.
5. Stuck pipeline rows: `ACTIVE_WINDOW_DAYS = 7`; rows older than 7 days are silently dropped from the query and never reported. WP5.
6. Stale cron heartbeat: `runCronWatchdog` (`lib/cron-watchdog.ts`) emails a alert. Nothing else is possible from inside the app because the scheduler itself is what died; the only code-level mitigation is an external uptime ping or a second trigger. It is also called from the daily cron, so a dead autopilot is noticed up to 24 h later. Joel-side item (see section 6).
7. Gate-failing posts: `rehealStuckDrafts` tries daily with a cap and ends `rejected`; after that, the draft waits for a person. There is no "replace with a new topic" handoff for a rejected draft's topic. Partially covered by WP11.
8. Publish verify failures: issue only; no revalidate, no IndexNow re-ping, no re-check after a fix. WP6.
9. Daily cron time budget: skipped steps are only noted in the response string; there is no carry-over to the next day. If the funnel watchdog is skipped three days in a row nobody is told. Small addition to WP4 (record "skipped N days" in the system check's `jobs` stage).
10. AI spend: `runAiTripwire` is alert only (comment in the route: "Alert only, never blocks anything"). The per-step caps are the real brake. Acceptable; flagged because Joel's goal is "self-healing".
11. Autopilot off or paused: `runPipeline` returns after housekeeping. The retry ladder, topic approvals and all `runAutoPolicies` stop. That is the correct behaviour for the kill switch but for "Autopilot off" (not paused) nothing tells a person that heals are also off; the System check `jobs` stage covers heartbeats, not this.
12. Issue list growth: `Needs attention` items and `issue-dismiss` cards are only cleared by a person or when the underlying state changes. WP5.

---

## 4. Self-improving gaps

Closed loops that exist (verified in code):

- Social format/hook/time: `lib/optimizer-run.ts` `runOptimizer` (daily) ingests settled sends, retires clear losers, `steeredRotate`/`makeHookSteer` steer hook formula and style. Used in autopilot video hooks.
- Titles/meta from clicks: `runCtrLoop` (inside the daily heal): finds below-expected-CTR pages, proposes a change through a gate and a judge, evaluates after a window, auto-reverts losers.
- Topic ranking from Search Console: `rankByGsc` in `lib/blog-topics.ts` (striking distance positions 8 to 20).
- Evergreen: older winners re-shared (`evergreen-reshare-run.ts`, off by default).

Open loops (measured, not fed back):

1. Lead and order outcomes -> topics. `content_performance` stores `leads` per path (`lib/content-performance.ts`) and `orders` carry `package_slug` and attribution (`lib/purchase-ledger.ts`), but `rankByGsc`/`pickOneTopic` (blog-topics) use only Search Console impressions and clicks. A topic that earns leads gets no priority. Same for guide plans (`lib/guide-plan.ts`) and keyword priority. WP8.
2. Lead outcomes -> promote-trip choice. `lib/promotion.ts` reads `content_performance` for display (line 583) but selection is a human tapping the Today `promote-prompt`. WP8.
3. Booked/lost -> channel quality. `orders` have `channel`; `leads` have status; nothing compares channel to closed-won. Needs WP2 first (status is never set automatically, so the data is empty).
4. Social engagement is optimised on click/lead funnel rows (`stitchFunnel`); the optimizer does not see which posts' topics produced bookings.
5. Recap/testimonial content never feeds topics or trip-page testimonials automatically (WP10).
6. Quality-gate failure reasons (counted in `visual-gate-stats`, `guide-failures`) are shown, not used to change prompts. Low value; skip.
7. Keyword engine results: rankings snapshot -> keyword `target` page only for ranking keywords (see handoff 2).

---

## 5. Ranked work packages (max 12)

Ground rules for every package: capped per day through `POLICY_CAPS` in `lib/auto-decisions.ts`; logged with `decision(...)`/`appendDecisions` with an Undo; gated by `policyGate` (kill switch, own switch default ON for safe ones and OFF for WP11); skipped when `blockIfDry`; never touch unpublished trips, never write a price, never call `assignLead`, send nothing to a person except existing alerts; each runs inside the autopilot pass (not the daily cron).

Shared hotspots that make parallel work collide: `lib/auto-decisions.ts` (PolicyName, POLICY_LABELS, POLICY_CAPS), `lib/pipeline.ts`, `lib/auto-policies.ts`, `lib/today-cards.ts`. WP1 exists to remove the collision: it adds all the new policy names and one registry call in one commit, so every later package lives in its own new file.

Ordering is touchpoints removed per unit of risk, except WP1 which removes none but unblocks parallel work.

### WP1. Flywheel foundation (must go first, sequential)
- Automates: nothing by itself. Adds policy names with caps and labels for the packages below, a `runFlywheelPolicies(admin, now)` step (step 1f in `runPipeline`, after 1e and before posting) that dynamically imports `lib/flywheel/<name>.ts` modules (each exports `run(admin, now): Promise<string | null>`; stubs return null), a time budget guard (skip when `overBudget()`), and a "handled for you" counter on Today.
- Files touched: `lib/auto-decisions.ts`, `lib/pipeline.ts` (one block), new `lib/flywheel-policies.ts`, new `lib/flywheel/*.ts` stubs, `scripts/check-admin-v2.ts` (registry test).
- Avoid: everything else.
- Risk: low. Effort: S.
- Touchpoints removed: 0 (enabler).

### WP2. Order-to-lead "booked" sync
- Automates: when `recordOrder` stores a non-test, paid order, find the lead by email (lowercased) and call `setLeadStatus(leadId, 'booked', note)` once, with a decision-log line and Undo (restore previous status). If no lead matches, log nothing. Does not touch price fields or send anything. Also stores the order's `package_slug` on the lead note for the recap trigger (WP10).
- Files touched: new `lib/flywheel/booked-sync.ts`; read `lib/purchase-ledger.ts`, `lib/lead-desk-store.ts` (`setLeadStatus` only called). `lib/auto-decisions.ts` undo kind added in WP1.
- Avoid: `lib/lead-desk-store.ts` internals, `assignLead`.
- Risk: low (status only, undoable). Effort: S.
- Removes: Leads page "Booked" click; the ghost of "was this lead won?"; enables WP8/WP10. Class B.
- Parallel: yes after WP1.

### WP3. Lead-to-GHL retry ladder with escalation
- Automates: replace "3 tries then give up" with spaced retries (5 min, 1 h, 6 h, 24 h, 72 h) for leads and newsletter rows, window extended from 48 h to 7 days, cap of 5 sends per pass; at give-up, one existing alert email (not a new channel). A new `[retry n at <iso>]` marker keeps the format the Needs attention parser expects.
- Files touched: `lib/heal.ts` (`healLeads` only), `lib/leads.ts` read, maybe `lib/issues.ts` text.
- Avoid: `app/api/submit-lead/route.ts`, `lib/gohighlevel.ts`.
- Risk: low-medium (duplicates in GHL if a first attempt really succeeded; mitigate by the existing GHL upsert-by-email behaviour; verify `submitLeadToGoHighLevel` is an upsert before shipping). Effort: S.
- Removes: the manual "resend leads to GHL" duty and one amber/red System check state. Class B.
- Parallel: yes.

### WP4. Scheduled AI auto-heal and carry-over skip report
- Automates: call the existing `runAiFixStep` (`lib/system-check-ai.ts`) once a day from the autopilot pass using `getSystemCheck`'s listed stages; it is already bounded (3 pages, once per item per day, `system_check_ai` 12/day, heal-loop call budget). Do NOT re-run the four plain steps (they already run). Also records "step skipped for time" counts into app_settings so the `jobs` stage can go amber after 2 consecutive skipped days.
- Files touched: new `lib/flywheel/ai-heal.ts`; read `lib/system-check-run.ts`, `lib/system-check-heal.ts`, `lib/system-check-ai.ts`; small edit to `lib/system-check.ts` jobs stage (only for the skipped-days read).
- Avoid: `app/api/cron/gsc-snapshot/route.ts` (time budget), `lib/auto-policies.ts`.
- Risk: medium (spends AI credit; mitigated by existing caps and `isAutomationPaused`). Effort: S-M.
- Removes: the Auto-heal button, the "Fix these today" ticks, the seo-fix recheck card, the amber stage reminders. Class B plus C.
- Parallel: yes. UI removals belong to WP12.

### WP5. Dead-letter and stale-issue sweeper
- Automates: (a) a failed carousel/video row older than 7 days, or one that hit `MAX_ATTEMPTS`, is moved to a terminal `skipped` state with a log line (the post stays published without the extra format); (b) a failed social row after the ladder and the 6/day cap is retired with a log line and a single weekly digest line instead of a Today card; (c) issues whose subject no longer exists are resolved. All with Undo (restore prior stage).
- Files touched: new `lib/flywheel/dead-letter.ts`; read `lib/issues.ts`, `lib/autopilot.ts` (stage constants), `lib/auto-policies.ts` (`postRetryVerdict`).
- Avoid: `lib/autopilot.ts` main loop, `lib/today-cards.ts` (WP12 owns).
- Risk: medium (retiring a row that could still succeed; mitigate: only after the ladder is spent AND age greater than 3 days, never rows a person pressed Retry on, veto list respected). Effort: M.
- Removes: failed-post, failed-render, issue-dismiss cards (about 3 card kinds). Class B/C.
- Parallel: yes. Must precede the card removal in WP12.

### WP6. Publish-verify remediation
- Automates: when `runPublishVerifyIfDue` marks a live page failing (not 200, canonical wrong, no JSON-LD, not in sitemap), do the safe, reversible actions: `revalidatePath` for the page, one `pingIndexNow`, then re-check next pass; escalate to the existing issue only after 2 failed re-checks. Does not edit content or unpublish.
- Files touched: `lib/publish-verify.ts` (runner part only), new `lib/flywheel/verify-fix.ts`, `lib/blog-revalidate.ts` (read).
- Avoid: gate logic (`verifyPage`, `planPass` pure parts).
- Risk: low. Effort: S.
- Removes: "page failed verification" needs-attention items that are only cache problems. Class B.
- Parallel: yes.

### WP7. Network un-pause and reconnect re-probe
- Automates: when a network is paused (`network_pauses`) or posting rows failed with an auth-class error, once per pass ask the provider for account status (`getActivePlatforms` / `social-provider`), and when the account reports healthy, clear the pause and re-queue at most 2 failed rows for that network via the existing retry path. Strike counter resets only after one success.
- Files touched: new `lib/flywheel/network-recover.ts`; read/write `lib/network-pause.ts`; read `lib/social-provider.ts`, `lib/auto-policies.ts`.
- Avoid: `lib/funnel-watchdog.ts` (its pause logic stays as is).
- Risk: medium (a bad status read re-enables a failing network; mitigate with 1 attempt then pause again with the existing strike rule). Effort: M.
- Removes: "reconnect and retry" Today cards after Joel reconnects (the reconnect itself stays A). Class B.
- Parallel: yes.

### WP8. Conversion-weighted topic, guide and promote ranking (close the loop)
- Automates: add lead and order counts (from `content_performance.leads`, `orders.package_slug`, `leads.status`) as a bounded tie-break (not a replacement) in `rankByGsc`, in `guide-plan` ordering, and in an automatic `promote` pick for trip social (only published trips, only when `trip_social_posts` is already on; never auto-turns it on). Writes a decision line explaining the pick.
- Files touched: `lib/blog-topics.ts` (`rankByGsc` ordering function), `lib/guide-plan.ts` (ordering), `lib/promotion.ts` (pick), new `lib/flywheel/promote-pick.ts`.
- Avoid: `lib/autoblog-run.ts`, `lib/guide-run.ts`.
- Risk: medium (small data, noisy; mitigate with a minimum-sample floor like the optimizer's confidence bounds and a cap on how far a conversion signal may move a rank). Effort: M.
- Removes: topic approval choice, promote-prompt card. Class B.
- Parallel: yes. Value grows after WP2 (booked data exists).

### WP9. Keyword target-page auto-assignment and gap seeds
- Automates: for each keyword with no target page, pick the best matching published page by cluster/title (`lib/keyword-cluster.ts`) when the match score clears a threshold, otherwise add a guide seed (`lib/guide-seeds.ts`) so a page gets built; max 5 per day, each logged with Undo.
- Files touched: `lib/keyword-pages.ts`, new `lib/flywheel/keyword-assign.ts`; read `lib/keyword-cluster.ts`, `lib/guide-seeds.ts`.
- Avoid: `app/admin/keywords/page.tsx` (UI stays; WP12 trims later).
- Risk: low-medium (wrong target is cosmetic and undoable). Effort: M.
- Removes: the Keywords-page "assign a page" duty and idea scheduling. Class B.
- Parallel: yes.

### WP10. Recap and testimonial auto-draft after trip end
- Automates: when a trip is past (`isPastTrip`) and has usable journal notes (the human-supplied account is still required; nothing is invented), run `writeRecap` once as a PRIVATE draft (`readDraft`/`gateRecap` already enforce grounding), and for approved quotes create a draft testimonial row. Neither is published; a single Today card "Publish this recap" (A for claims and quotes) replaces the "Start a recap" hunt. No message is sent to travellers or agents; the follow-up request stays a drafted text Joel sends (constraint: nothing automatic to people).
- Files touched: new `lib/flywheel/recap-auto.ts`; read `lib/past-trip.ts`, `lib/recap-run.ts`, `lib/recap-draft.ts`, `lib/testimonials.ts`.
- Avoid: `lib/recap-store.ts`, recap public routes, `app/packages/[slug]/page.tsx`.
- Risk: medium (public content with quotes; mitigated by draft-only plus the existing recap gate and a human publish tap). Effort: M.
- Removes: "Start a recap" clicks and manual testimonial entry. Class B (publish stays A).
- Parallel: yes.

### WP11. Autonomy ladder: derive the modes from track record
- Automates: replaces seven hand-set modes with a promotion rule, each step capped, logged, Undoable, and demoted automatically on a bad signal. Candidates: `travel_news_mode` draft to publish, `guides_publish_mode` draft to publish, `autoblog_mode` draft to publish, `distribution_mode` prepare to auto, `trip_social_posts` on (published trips only), `tailored_captions` on, `evergreen_reshare_enabled` on. Rule: promote one rung after N consecutive items (suggest 10) cleared every gate with zero Undo and zero verify failures; demote on any rollback or an AI tripwire alert. Nothing moves while paused. Starts OFF (its own switch), per the constraint list.
- Files touched: new `lib/flywheel/autonomy.ts`; calls the existing setters only (`setDistributionMode`, `setGuidePublishMode`, news-settings setters, `setSetting`).
- Avoid: gate code (`lib/blog-quality.ts`, `guide-composer`), trip publish status.
- Risk: HIGH (it changes what goes public). Mitigate: opt-in switch, per-step Undo, promotions only for modes whose items already pass the same gates.
- Effort: M-L.
- Removes: mode toggles (D) and the approve cards news-draft, held-guide-post, guide-review, blog-draft, held-post (5 card kinds). Class D plus B.
- Sequential: after WP5 and WP6 (needs their failure signals) and after WP12 (UI shares the Autopilot page).

### WP12. Admin consolidation (remove redundant touchpoints)
- Automates: nothing new; it deletes duplicates once packages above land. Remove: Daily follow-ups groups lead, recap, weekly fix ticks, Search Console reading chores; Today cards issue-dismiss, thin-page, seo-fix recheck; System check ticks and Auto-heal button (after WP4); run-now buttons; Dashboard duplicates. Fold Tracker, Content edits, System Health, Auto-Writer into one "Advanced" place. Sidebar "Do first" becomes Today + System check only.
- Files touched: `lib/followups.ts`, `lib/followups-run.ts`, `components/admin/followups-panel.tsx`, `lib/today-cards.ts`, `components/admin/today-stack.tsx`, `lib/system-check-fixes.ts`, `app/admin/system-check/page.tsx`, `lib/admin-nav.ts`, `scripts/check-admin-v2.ts`.
- Avoid: lib/pipeline.ts and all `lib/flywheel/*`.
- Risk: low (UI), but `scripts/check-admin-v2.ts` asserts every module appears once and each Today kind's route files exist, so edits must keep it green.
- Effort: M.
- Removes: the largest number of daily clicks of any package. Class C.
- Sequential: after WP4 and WP5, before WP11.

### Parallel plan

1. WP1 alone (1 commit).
2. Parallel batch A, disjoint file sets: WP2, WP3, WP4, WP5, WP6, WP7, WP9, WP10 (each only touches its own `lib/flywheel/*.ts` file plus the one or two existing files named above). Overlap check: WP3 = `lib/heal.ts`; WP6 = `lib/publish-verify.ts`; WP7 = `lib/network-pause.ts`; WP9 = `lib/keyword-pages.ts`; WP2/WP5/WP10 read-only on shared libs. WP4 edits `lib/system-check.ts`; nobody else does.
3. WP8 can join batch A (touches `blog-topics.ts`, `guide-plan.ts`, `promotion.ts` only) but wait to enable it until WP2 has produced booked data.
4. WP12 after WP4 and WP5 land.
5. WP11 last.

---

## 6. Target: what a human must do daily (one screen)

Daily (about 5 minutes, only when something is waiting):

1. Open Today. Cards that remain are only: Hot lead -> Assign to an agent (Joel/Shelby/Leslie). New agent submissions/profile approvals. Supplier page changed (price/availability) -> confirm. Publish this recap/testimonial (claims and quotes).
2. Look at the one red/amber line on System check that says "needs you" (account reconnect, expired key). Everything else shows under "handled for you" with Undo.
3. Confirm any agent price confirmation on a trip (never automated).

Weekly (10 minutes): skim the "Autopilot decisions" log and hit Undo on anything wrong; glance at the Monday growth digest email.

As needed (not daily): add a new trip and publish it; reconnect a social account; renew an API key; set a spend cap; account sign-ups; link building outreach; the 15 minute social routine if Joel wants it.

Joel-side items the code cannot fix (listed so they are not lost): an external uptime ping on `/api/cron/autopilot` (the watchdog is inside the thing that can die); apply any pending migrations before WP4/WP11 (the repo has migration-gated features, e.g. 0033 for the edit log); turn on the instant lead reply (`lead_ack`) once copy is approved; decide on a second hot-lead reminder tier (it is another message to a person, so I did not package it).

## Things I did not verify

- Button-level detail on `affiliate-links`, `tracker`, `value`, `news`, `seo-engines` pages (counts only).
- Whether `submitLeadToGoHighLevel` upserts by email (needed to size WP3 duplicate risk).
- Whether the recap studio lets a traveller approve quotes without Joel (WP10 assumes the existing quote approval flow stays human).
- Live DB state (which switches are actually on in production); nothing was queried.
