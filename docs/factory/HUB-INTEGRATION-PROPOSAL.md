# Hub integration proposal for TravelFunBiz.ca

Date: 2026-10-24. Research and proposal only. No code was written, nothing was pushed, no live database or setting was touched.

## How to read this

- Written in plain English. Short glosses sit in brackets after jargon.
- Effort: S is under a day, M is one to three days, L is a week or more.
- Verdicts: PORT now (worth doing in the next batches), LATER (good idea, wrong time or needs data), SKIP (not worth it for us).
- Anything I could not confirm from a file I read is marked "unverified".
- "Hub" means the shared repo joelfrenette/autoblogging. "Master list" means its file `seo-aeo-geo-checklist.md`.

## What I read (and what I did not)

Read in the hub clone `C:\CODING\autoblogging` (main at d08950f, up to date after `git fetch`; the only untracked item is its own `.claude` folder, which I ignored):
README, HUB-CLAUDE, exchange-matrix, CONTRIBUTIONS, the master SEO list, seo-merge-procedure, seo-merge-log, seo-status and seo-intake READMEs, content-and-seo-automation, ops-reliability-and-self-healing, social-distribution-automation, tracking-and-funnel, publish-safety-and-ai-content-risk, zero-touch-automation, admin-ui-patterns, admin-information-architecture, new-site-bootstrap-and-social-growth, SIBLING-SWEEP-PROMPTS, SUPER-PROMPT, the autoblogging skill, all five inventories (options-calculators by headings only), and the README of every `reference/` folder (not the code files).

Read through `gh pr diff` because they are not merged: PR 30 (our own contribution, including `seo-status/travelfunbiz.md`, `seo-intake/travelfunbiz-2026-10-24.md`, `speed-and-edge-caching.md`, `admin-today-queue-and-workspaces.md`), PR 33 (HOACrimes status and intake), PR 31 (a closed TravelFun.ai "mega list", the only TravelFun.ai SEO source in the hub).

Our code, read in this worktree (commit 8f01427): `lib/pipeline.ts`, `lib/autoblog-run.ts`, `lib/blog-quality.ts`, `lib/blog-composer.ts`, `lib/guide-composer.ts`, `lib/guide-run.ts` (first 260 lines), `lib/guide-release.ts`, `lib/guide-distribution.ts`, `lib/social-captions.ts`, `lib/seo-score.ts`, `lib/seo-engines-run.ts`, `lib/seo-playbook-types.ts`, the top of `lib/seo-playbook-audit.ts`, `lib/site-crawl.ts` (top), `lib/publish-cadence.ts` (top), `lib/indexnow.ts`, `lib/indexnow-catchup.ts`, `lib/jsonld.ts`, `lib/org-jsonld.ts`, `lib/fanout-plan.ts` (top), `lib/content-dedupe.ts` (top), `app/sitemap.ts`, `app/robots.ts`, `app/api/cron/gsc-snapshot/route.ts` (top), `vercel.json`, `.env.example`, the card list in `lib/today-cards.ts`.

Not read, so anything about them is unverified: the bodies of `lib/heal-loop.ts`, `ctr-loop.ts`, `gsc-mining.ts`, `competitor-scan.ts`, `hub-spoke.ts`, `cannibalization.ts`, `seo-links.ts`, `page-copy-composer.ts`, `distribution.ts`, `autopilot.ts`, `content-performance.ts`, `rankings-snapshot.ts`, `keyword-ideas.ts`, `posts.ts`, the blog page body, `middleware.ts`, `cache-routing.ts`, the recap store. Not read in the hub: the `.ts` files under `reference/`, `standard-value-page.md`, `admin-analytics-*.md`, the options-calculators plan body, PR 9 (an older TravelFunBiz contribution, superseded by PR 30). Missing in the hub on main: `seo-status-matrix.md` does not exist yet, and `seo-status/` and `seo-intake/` hold only READMEs on main. Nomad's SEO status lives inside the master list; there is no TravelFun.ai status file. Nothing was run anywhere.

## Corrections to what the hub believes about us

The hub matrix was last checked on 17 Oct. Against our code on 24 Oct these rows are stale for TravelFunBiz (they say GAP or PARTIAL):

| Matrix row | Hub says | What our code has |
|---|---|---|
| 2 CTR experiment loop, cannibalisation | GAP | `lib/ctr-loop.ts`, `lib/cannibalization.ts` exist. Whether they are switched on in production is unverified. |
| 13 llms.txt, AI channel, speakable | PARTIAL, no llms.txt | `app/llms.txt`, `app/llms-full.txt`, `lib/traffic-source.ts` AI channel, speakable on posts. Still no image or video sitemap. |
| 14 IndexNow daily diff | GAP | `lib/indexnow-catchup.ts`: once a day, pings pages changed in the last 48 hours that have no recorded ping. It is a "changed pages" catch-up, not a full sitemap diff. |
| 19 CI typecheck | GAP | `.github/workflows/typecheck.yml` and a `typecheck` script exist. The migration-apply workflow is still missing. |
| 16 independent AI review | PARTIAL | `lib/heal-loop.ts` runs a second, independent model call as a judge (per our own PR 30 notes; body unread here). |
| 25 alert-only spend ceiling | UNVERIFIED | `lib/ai-tripwire.ts` is alert only (called from the daily cron). |

One more correction, to our own PR 30: its intake says two trip pages return HTTP 500 for visitors with no cookie. Commit `6279e3b` (24 Oct, on main) serves `/packages/[slug]` without the cache mirror and says it fixes exactly that. I did not re-test the live site. Ask the contribute session to amend the PR text once the fix is confirmed live (WP1 does that).

---

# Part A. Ideas and integrations from the hub that we lack

Ranked by likely effect on traffic or leads, highest first. For every item: what it is, where it comes from, why it helps us, effort, risk, whether it needs a key or account, and the verdict.

## A1. Google URL Inspection feedback (is each page really indexed?)
- What: a daily job asks Google, one page at a time, "is this URL indexed, and if not, why?". Oldest-checked first. A page still not indexed 7 days after publishing gets one fresh IndexNow ping and one extra internal link.
- Source: TravelFun.ai `lib/marketing/search/gsc-inspect.ts` (hub `content-and-seo-automation.md`, matrix row 13); Nomad merged the same idea (#670). Master list T1.8 and A14.
- Why it helps us: our status file says we only have Bing coverage plus a funnel watchdog. We cannot see whether Google skipped pages. Every other growth step is guesswork without this.
- Effort M. Risk low (read only). 
- Key or account: no new key if the Search Console service account we already use can inspect URLs. That needs the account to be a user on the exact Search Console property (unverified; Joel confirms). Google limits inspections per day, so we cap ours low.
- Verdict: PORT now (WP2).

## A2. Index-ratio publishing gate (indexed pages divided by sitemap pages)
- What: below about 80 percent indexed, slow or pause new content and fix indexing first. At 80 percent or more, keep a measured pace.
- Source: master list T1.16, ranked number 1 of 28 in the hub's tips table. No site has built it. The 80 percent line is one creator's rule of thumb, not measured.
- Why it helps us: we publish automatically (posts, guides, news briefs). On a young domain, flooding the index with pages Google ignores is the main way the autoblog backfires. We already cap volume (`lib/publish-cadence.ts`), so this adds "and stop if Google is not keeping up".
- Effort S after A1 exists. Risk medium: with little data it can block everything forever. Start as measure and alert only, with the switch off (WP3).
- Key or account: none beyond A1.
- Verdict: PORT now, after A1.

## A3. Core Web Vitals / PageSpeed monitor
- What: a daily job calls Google's PageSpeed Insights API for about five page templates (home, blog post, guide, trip, compare). It records LCP (how fast the main content shows), INP (how fast the page reacts) and CLS (how much the page jumps). A bad result becomes a Needs-attention item.
- Source: Nomad's own audit lists it as its number 1 gap (master list T1.11, A12). Nobody has built it. We tried the keyless API on 22 Oct and got HTTP 429 (quota), so we have page weight and speed budgets but no real numbers.
- Why it helps: speed is a ranking and conversion factor, and we just rebuilt caching for speed, so we should prove it worked. The hub itself says to monitor for regressions, not chase scores.
- Effort M. Risk low. Lab numbers are noisy, so alert on a bad run seen twice, not once.
- Key or account: yes. A free Google Cloud API key for PageSpeed Insights, set as a new env var and added to `.env.example`.
- Verdict: PORT now (WP9), after the first batch.

## A4. Image sitemap (and later a video sitemap)
- What: `/sitemap-images.xml` listing each page's pictures so Google Images can find them. A video sitemap lists pages that embed a video.
- Source: `reference/image-video-sitemaps/` (Nomad, ported from TravelFun.ai). Master list T10.3.
- Why: our trips, guides and posts are photo-heavy and travel searches use image search a lot (my judgment, not measured). We have no image or video sitemap today (confirmed in the status file).
- Effort M for images, because the reference reads a `blog_posts` table and ours has `posts`, `guides` and trips. Risk low. 
- Key or account: none. After it ships, Joel submits the new sitemap in Search Console and Bing.
- Video sitemap: LATER. It only lists videos that are embedded on a page, and we post reels to YouTube but I did not see them embedded (unverified).
- Verdict: image sitemap PORT now (WP8); video LATER.

## A5. Table of contents with jump links
- What: a short contents list at the top of long pages, each entry jumping to a heading.
- Source: TravelFun.ai `lib/marketing/blog/toc.ts` (inventory); master list T2.10 and Nomad's audit gap 8. We have none (status: N).
- Why: Google can show those jump links under the result, and AI answer tools can quote one section. Guides are 1,000 to 2,300 words, so they qualify.
- Effort S. Risk low.
- Verdict: PORT now (WP6).

## A6. Keep the `*.vercel.app` address out of Google
- What: a rule that sends every `*.vercel.app` address to the real domain (or marks it noindex).
- Source: HOACrimes `proxy.ts`. Their notes say Google had indexed a vercel.app alias as a duplicate site (PR 33 status file, T1.4).
- Why: duplicate-site risk. I did not find out whether we already have this (`middleware.ts` unread), so it is unverified.
- Effort S. Risk low. Verdict: PORT now (WP7), after checking the live answer for the vercel.app address.

## A7. Basic security headers
- What: add `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy` (HOACrimes and Nomad have these).
- Why: our live headers show only `Strict-Transport-Security` (status file T10.6). Small trust and hygiene gain, tiny ranking effect.
- Effort S. Risk low if we skip a strict Content-Security-Policy (a wrong one can break the consent banner and Google tags). Verdict: PORT now (WP7).

## A8. Write down the AI-crawler decision in robots.txt
- What: explicit lines for GPTBot, OAI-SearchBot, ClaudeBot, PerplexityBot and Google-Extended (Nomad `AI_BOTS`). Ours allows everyone by default and has no recorded decision (status T6.2: P).
- Why: AI answer tools cannot cite pages they cannot read. The default already allows them, so this is documentation plus a safe guard against a future accidental block.
- Effort S. Risk none if the decision is "allow". Needs a decision from Joel. Verdict: PORT now (WP7).

## A9. Alert dedupe and "all clear"
- What: an alert is emailed only after it shows on two checks in a row, not again within 24 hours, with one reminder after 3 days and one "fixed" message.
- Source: TravelFun.ai `ops/alert-shape.ts` (`zero-touch-automation.md` rule 6).
- Why: our `sendThrottledAlert` sends at most one email per 6 hours and leaves out setup and waiting items. That is already decent. The gain is fewer repeats and a clear "all fixed" mail. Ops comfort, not traffic.
- Effort S. Risk low. Verdict: LATER (nice to have).

## A10. RSS feed (`/feed.xml`)
- What: a feed of the latest posts. Source: Nomad and HOACrimes `feed.xml` (master list T10.7). Ours returns 404 (live check in the status file); `lib/news-feed.ts` only reads other people's feeds.
- Why: cheap discovery for feed readers, aggregators and some AI crawlers. Small effect.
- Effort S. Risk low. Verdict: PORT now (WP7), low priority.

## A11. Evergreen re-share of old posts
- What: re-post strong older posts on social on a schedule, with a fresh caption each time.
- Source: TravelFun.ai, then Nomad (`evergreen-reshare.ts`, matrix row 3; Nomad has it default off).
- Why: we publish about 3 posts a week and each social post is spread over a week by `lib/fanout-plan.ts`; after day 7 the post is never shared again. Re-sharing is free traffic from content we already own.
- Effort M. Risk medium: double-post risk and platform spam rules. It must reuse our `sent_platforms` ledger and caps.
- Verdict: LATER. Wait until the Optimizer shows social actually sends clicks.

## A12. Meaning-based duplicate check (embeddings) and repeated-headings check
- What: store a numeric "fingerprint" of each post's meaning (OpenAI `text-embedding-3-small` in the pgvector database add-on) and reject a new topic that is too close in meaning. A second layer compares headings.
- Source: TravelFun.ai original, Nomad port in `reference/embedding-dedupe/`; matrix row 6. Our own notes say dedupe is token overlap only.
- Why: we already have a title check (0.75), a keyword-set check (`checkTopicConflict`), and a one-post-per-trip wall for 30 days. With about 10 live posts the extra layer pays little yet. The heading layer would also trip on our fixed template headings (for example "Who this is not for"), so it needs a stop list.
- Effort M to L. Risk medium. Key: `OPENAI_API_KEY` (listed in `.env.example`, set or not is unverified) plus a pgvector migration.
- Verdict: LATER (revisit at 50 or more posts).

## A13. Learning loop that weighs leads, not just clicks
- What: score published articles by paid bookings, then leads, then clicks, and write more like the winners.
- Source: HOACrimes `learn-loop.ts` (PR 33 intake).
- Why it could matter: our goal is leads. We already score styles by clicks (`lib/content-performance.ts`). Needs lead data tied to the first page a visitor landed on (`lead-touch` check exists; volume unverified).
- Effort M. Risk low. Verdict: LATER (needs enough leads).

## A14. Database migration workflow in CI
- What: a GitHub job that applies new migrations on merge (TravelFun.ai `supabase-db-push.yml`).
- Why: we apply migrations by hand and the Today and system check screens already say "run migration NNNN" when one is missing.
- Risk: a bad migration reaching the live database; needs a Supabase access token. Verdict: LATER, Joel decision.

## A15. VideoObject markup and video sitemap
- Source: Nomad and TravelFun.ai (master list T4.6, T10.3). We have no VideoObject (status N). Only useful once a reel is embedded on a page. Verdict: LATER with A4.

## A16. Named author (Person markup, author page)
- Source: TravelFun.ai `author.ts` (master list T4.5, T9.8). Our posts say the author is the organisation. A real, named agent with a bio helps trust (E-E-A-T, Google's "experience, expertise, authority, trust"). This is a human choice, not code. Verdict: LATER, Joel decision (see Part C).

## A17. AI citation tracker
- What: monthly, ask a fixed list of questions to an AI search tool and log whether we are cited (master list T6.10, A10). Nomad suggests it, nobody built it.
- Key: yes, a new AI search API key and a small monthly cost (unverified). Verdict: LATER.

## A18. Backlink-gap list
- Source: master list T3.8, A9; TravelFun.ai plans a competitor backlink job on DataForSEO. We already have the login, but whether the backlinks product is included in our DataForSEO plan is unverified. We keep an owner to-do list instead (`lib/link-targets.ts`). Verdict: LATER.

## A19. Community answer queue (Reddit, Quora)
- Source: Nomad `community-queue.ts`, `reddit.ts`, `quora-forums.ts` (master list T3.12, T9.7). It drafts value-first answers for a person to approve; it never posts alone.
- Why: AI answer tools lean on Reddit and Quora. Our status: Reddit is used only for question mining and is dormant until `REDDIT_CLIENT_ID` and `REDDIT_CLIENT_SECRET` are set. 
- Risk: reputation and each site's self-promotion rules. Always manual approval. Verdict: LATER, as Today cards.

## Looked at and not recommended

| Idea | Source | Verdict | Why |
|---|---|---|---|
| Claim-before-send social ledger | Nomad, HOACrimes, ours | SKIP | We have `sent_platforms`, non-retryable errors go to `failed`, and the "Retry one network" button was removed. The hub itself says no action. I did not read `lib/distribution.ts` fully, so verify only if a double post ever shows up. |
| Post-health check (did it really publish?) | Nomad `post-health.ts` | LATER | We already read the GoHighLevel failed list into Needs attention. A separate hourly poll adds little. |
| Dry-run mode | TravelFun.ai | SKIP | We have `prepare`, `draft` and kill-switch modes already. |
| Web manifest | Master list T10.8 | SKIP | Nobody has it, no search effect, we are not a web app. |
| Fix cards with a key-to-card test | TravelFun.ai, Nomad | LATER | `lib/plain-steps.ts` and `scripts/check-today-queue.ts` do the same job for actions. A test that every issue id has plain steps is a tiny add-on. |
| Opinion pieces (ads versus SEO, tier lists) | Hub inbox | SKIP | Strategy talk, nothing to build. |

---

# Part B. SEO improvements inside our autoblog steps

## B1. The pipeline as it is today

`lib/pipeline.ts` runs every 15 minutes (one Vercel cron). Order: weekly keyword engine, write the blog post (`lib/autoblog-run.ts`), write a guide (`lib/guide-run.ts`), page copy, travel news, automatic decisions (`lib/auto-policies.ts`), social posting (`lib/distribution.ts`), reels and carousels (`lib/autopilot.ts`), daily heal of existing pages (`lib/content-heal-run.ts`), then housekeeping (self-repair, performance snapshot, IndexNow catch-up, daily brief). A second cron, `gsc-snapshot` (daily 14:00 UTC), runs the ranking snapshot, Bing coverage, funnel watchdog, nightly site crawl, SEO engines (query mining, competing pages, hub and spoke, competitor scan) and the SEO playbook audit.

Two facts that shape everything below:
1. The SEO score (`lib/seo-score.ts`) is computed after publishing, once a day, and it only repairs "cheap" reasons. It is not a publish gate. The publish gate is `autoPublishBlockers` (`lib/blog-composer.ts`, which calls `qualityBlockers` in `lib/blog-quality.ts`) for posts, `guideBlockers` (`lib/guide-composer.ts`) for guides, and a page-copy gate (`lib/page-copy-composer.ts`, unread).
2. Every gate message must be classified as repairable or hard in `BLOCKER_RULES` (`lib/content-repair.ts`). An unclassified blocker defaults to hard, and a drift check fails the build when a `blockers.push` has no rule (hub `content-and-seo-automation.md`; the check is `scripts/check-content-repair.ts`). So each new gate below includes that table row.

## B2. Step by step: which checks become gates or auto-fixes

Master list IDs in brackets. Status words come from our own `seo-status/travelfunbiz.md` in PR 30. Rows added to the master list after that audit (T1.16, T2.20 to T2.22, T3.17 to T3.21) have no status from us yet; I give my read and mark it.

### Step 0. Topic pick (keyword engine, Search Console mining, approved queue)

Files: `lib/keyword-intel.ts` (weekly engine), `lib/gsc-mining.ts` `runMining` (daily, via `lib/seo-engines-run.ts`), `lib/blog-topics.ts` (`dueApprovedTopics`, `rankByGsc`, `checkTopicConflict`, `autoApproveDecision`), `lib/auto-policies.ts` `runApproveSafeTopics`.

| Check | Status | What to add | Exact place |
|---|---|---|---|
| T3.2 buyer-intent search terms (best, vs, review, compare, alternative) | D for mining, no intent filter | Tag mined queries with an intent bucket and rank buyer-intent first | `runMining` and `rankByGsc` |
| T3.18 conversational queries (7 or more words, question words) | N | Same function, two more buckets, pushed to the existing "suggested" topic queue under the 3 a day cap | `runMining` |
| T3.15 branded versus non-branded split | N | Report only: split mined queries by a brand regex | `runMining`, `lib/growth-digest.ts` |
| T5.6 and T3.10 People Also Ask | P | Keep the real questions per topic and hand them to the writer (Step 1) | `lib/keyword-ideas.ts` (storage unverified), `lib/blog-topics.ts` |
| T6.9 "best X for Y" pages | P | Topic template, but see the conflict in Part C | `lib/content-styles.ts` |
| T1.16 index-ratio | N | Throttle in Step 4 | n/a here |
| T2.22 focus-first expansion (win one cluster before opening the next) | N (my read) | LATER. With few impressions the rule would block all growth forever. | `lib/guide-backfill.ts` order |
| Already done | D | T3.11 clusters (`lib/keyword-cluster.ts`), T3.13 autocomplete, T3.14 Trends, T3.1 cannibalisation, one post per trip per 30 days | no change |

HITL: topics already arrive as "suggested" and wait as Today cards of kind `topic` (`lib/today-cards.ts`). No new card is needed.

### Step 1. Write (post, guide, page copy prompts)

Files: `lib/blog-composer.ts` `composerPrompt`, `ComposerContext`, `composeFullPost`; `lib/guide-composer.ts` `articlePrompt`, `enrichPrompt`, `groundingText`; `lib/guide-run.ts` `buildBrief`.

| Check | Status | What to add | Exact place |
|---|---|---|---|
| T5.6 questions people ask | P | Add a `paa` list to the context and tell the enrich step to use those as FAQ questions where they fit | `ComposerContext`, `composerPrompt('enrich')` |
| T2.21 interview-first, T2.8 first-hand detail | N | Let owner or traveller answers be part of the grounding text (see WP11) | `groundingText`, `buildBrief` |
| T5.2 definition in the first two sections | P | Already asked in the prompt; the gate does not check it. Skip a gate (see Step 2) | none |
| T2.4 keyword in the first 100 words | P | Largely done for posts already: `firstSentenceIssue` requires half the keyword stems in the first sentence. Guides must name the subject in the opening paragraph. The remaining gap (heading, alt text) is small. No new gate. | none |
| T2.20 price and availability block | not audited | Only from stored fields, never invented (our rule). Trip schema has no Offer today (status T4.7). Add Offer when a visible price exists | trip page JSON-LD (file not read) |

### Step 2. Quality gate (before anything goes live)

Files: `lib/blog-quality.ts` `qualityBlockers`, `lib/blog-composer.ts` `analyse`, `lib/guide-composer.ts` `guideBlockers`, `lib/content-repair.ts` `BLOCKER_RULES`.

Already gates, no work: title and meta length (T2.1, T2.2 via `seo-score.ts` and the crawl), internal links at least 3 plus a contact or trip link (T2.12), Quick answer line present (T5.5), FAQ at least 3 (T5.4), numbers and names grounded (T2.8, T6.12), banned filler (template footprint), links must exist (T1.10), dashes.

New gates worth adding, all pure code with no key:

| Gate | Master ID | Rule | Repair class | Place |
|---|---|---|---|---|
| Quick answer length | T5.1 | The Quick answer paragraph is 15 to 60 words (measure the real spread of our 10 posts first, then set the numbers; the hub's 40 to 60 is for answers under a heading) | repairable: cut at a sentence end if long; regenerate from the body if short | `hasQuickAnswer` becomes `quickAnswerIssue` in `lib/blog-quality.ts`; add the prefix to `QUALITY_PREFIXES` |
| Meta uniqueness | T2.1, T2.2 | New title and description may not equal or nearly equal another live page's | repairable: regenerate the meta text only | `qualityBlockers` gets the other posts' meta through `QualityCtx`; caller `autoblog-run.ts` already has `existingPosts` |
| Cover alt text present and not generic | T2.9 | `alt_text` non-empty and not the bare keyword | repairable: rebuild with `coverAlt` | `autoblog-run.ts` before `createPost`; same in `lib/guide-run.ts` |
| JSON-LD preflight | A1, T4.x | Build the same schema the page will render from the composed fields and check required properties (headline, dates, image, FAQ entries) | hard (a template bug, not a text bug) | new pure `lib/schema-preflight.ts`, used by an offline check and the post-publish verify in Step 5 |

Not recommended as gates: a rule that every H2 is a question (forced, awkward headings for travel pages), and any "best X" check (see Part C).

HITL: a held draft already appears as a Today card (`blog-draft`, `guide-review`) with the reasons. No new card.

### Step 3. Heal (daily SEO heal, heal loop, CTR loop, refresh)

Files: `lib/content-heal-run.ts` (SEO_FIX map in `lib/seo-score.ts`), `lib/heal-loop.ts`, `lib/blog-reheal.ts`, `lib/ctr-loop.ts`.

| Check | Status | What to add | Place |
|---|---|---|---|
| T2.9 image alt | P | Add an `alt` fix to `SEO_FIX` (rebuild the alt from title and destination by code) | `lib/seo-score.ts` `SEO_FIX['image-alt']`, `content-heal-run.ts` |
| T3.5 falling pages (A5) | N | Detector: compare the latest 28-day Search Console snapshot with the one 28 days earlier per page (they are trailing 28-day totals, so only non-overlapping pairs are comparable; our growth digest already warns about summing them). Falling posts older than 28 days enter the existing refresh path with the heal ladder and Undo. Guides become a Today card, never auto-rewritten. First month: report only. | `lib/rankings-snapshot.ts`, `lib/blog-reheal.ts` |
| T3.3 page-level query gap | P | Let the CTR loop propose one extra FAQ or section for queries with many impressions and few clicks, through the same gate and judge | `lib/ctr-loop.ts` suggester |
| T3.16 rank drop alerts | P | A line in the growth digest and one `seo-fix` Today card when a page drops several places | `lib/growth-digest.ts` |
| T2.17 thin or duplicate pages | P | Extend the `thin-page` card idea to posts. The hub's 16-month zero-click prune cannot apply yet (the site is younger than that). Never auto-delete. | `lib/today-cards.ts` |
| T6.8 honest freshness | P | Check where `updated_at` is set. If every auto link edit moves it, `dateModified` and sitemap lastmod move without a real update (the hub flagged the same for Nomad). Add a real-change date. Unverified until I read `lib/posts.ts` and any database trigger. | `lib/posts.ts` |
| Already done | D | T1.4 safe pages noindex, T2.18 grounded guide data, T5.7 `content-drift.ts`, T3.4 CTR loop, cannibalisation links with Undo (default switch state unverified) | none |

### Step 4. Publish (decision and pace)

Files: `lib/autoblog-run.ts` (`checkCadence` near the top of `runAutoblogLocked`), `lib/guide-run.ts` `publishDecision`, `lib/publish-cadence.ts`.

| Check | What to add | Place |
|---|---|---|
| T1.16 index ratio | New "index" reason in the cadence limiter that defers new posts, guides and news (never heals, never a manual publish). Unknown ratio never blocks (otherwise we deadlock before data exists). Setting default off, alert first. | `lib/publish-cadence.ts` `evaluateCadence`; callers `autoblog-run.ts`, `guide-run.ts`, `lib/news-run.ts` |
| T2.13 no orphans for new posts | Right after publish, queue two internal links to the new post from the closest published posts, using the existing capped link writer (3 pages a day, Undo) | `lib/seo-links.ts` wishes, called from `autoblog-run.ts` after `recordPublish` |
| T2.7 author | Organisation today; Person is a Joel decision | `app/blog/[slug]/page.tsx` |

### Step 5. Sitemap, ping and indexing

Files: `app/sitemap.ts`, `app/robots.ts`, `lib/indexnow.ts`, `lib/indexnow-catchup.ts`, `lib/bing-coverage.ts`, `lib/search-console.ts`, `app/api/cron/gsc-snapshot/route.ts`, `lib/site-crawl.ts`.

| Check | Status | What to add | Place |
|---|---|---|---|
| A2 post-publish chain | P | **Post-publish verify**: on the next pass (about 15 minutes later, because the cache mirror can take up to 5 minutes to show a new page to visitors with no cookie, per our `speed-and-edge-caching.md`), fetch each page published in the last hour without a cookie. Check 200, a canonical, exactly one H1, JSON-LD that parses, and that the URL is in the sitemap. A failure becomes a Needs-attention item. The pure page readers already exist in `lib/site-crawl.ts` (`extractFacts` and the analysers). | new `lib/publish-verify.ts`, called from `housekeeping` in `lib/pipeline.ts` |
| Hub lesson from our own bug | n/a | **Cookie-less sweep script**: every sitemap URL, with and without a cookie, compare status and a body hash. Run by hand after a deploy. | new `scripts/check-live-sitemap.ts` (live, so not part of the offline checks) |
| T1.8, A14 | P | URL Inspection step (Part A, A1) in the daily cron with its own time budget | new `lib/gsc-inspect.ts` |
| T10.3 | N | Image sitemap route, listed in robots | new `app/sitemap-images.xml/route.ts`, `app/robots.ts` |
| T1.2 | P | Do not split the main sitemap now. The index ratio can be counted by URL prefix. Splitting changes the submitted URL and Next 14 has no automatic sitemap index (my understanding, unverified). | none |
| T1.9 | D | IndexNow on publish and a daily catch-up (limit 100). Keep. | none |
| T1.6 | P | Apex redirect is a temporary 307; change it to permanent in the Vercel domain settings (Joel) | Vercel, not code |
| T6.2 | P | Explicit AI-crawler lines (Part A, A8) | `app/robots.ts` |

### Step 6. Social fan-out

Files: `lib/distribution.ts`, `lib/social-captions.ts` (`captionProblems`, `PLATFORM_CHAR_LIMITS`, `repairCaptionCta`), `lib/fanout-plan.ts`, `lib/guide-release.ts`, `lib/guide-distribution.ts`.

What exists and works: per-network character limits as data, link never cut, UTM on every link, numbers must be in the post, call to action required, guide posts for named places held 24 hours and released only if the caption passes (`guideCaptionProblems`), fan-out calendar over a week.

| Check | Status | What to add | Place |
|---|---|---|---|
| T6.6, T9.4 YouTube description | ? | For reels, put the voice-over script and the tagged link in the description. Chapters do not apply to Shorts. Needs a read of the YouTube path first (unverified). | `lib/distribution.ts` |
| T9.5 Pinterest link | P | Our status says no destination link field is set. Confirm in the provider's API before building. | `lib/distribution.ts` |
| T6.11 AI traffic per page | D for channel, N per page | Add a GA4 report of AI-referred sessions by landing page (these are pages AI tools already cite). | `lib/ga4.ts` |
| T9.7 community answers | N | See A19. Drafts only. | later |

### Step 7. Measure

Files: `lib/rankings-snapshot.ts`, `lib/growth-digest.ts`, `lib/content-performance.ts`, `lib/seo-playbook-audit.ts`, `lib/funnel-watchdog.ts`, `app/api/cron/gsc-snapshot/route.ts`.

| Check | Status | What to add |
|---|---|---|
| T1.11, A12 | P | CWV monitor (A3). Upgrade the playbook audit check `page-speed` from the crawl-based proxy to real numbers. |
| T1.16, T1.8 | N, P | Index-ratio and inspection results on the SEO manager page and in the daily brief (A1, A2). |
| T3.5, T3.16 | N, P | Falling pages and rank drops (Step 3). |
| T6.10, A10 | N | AI citation tracker, LATER (A17). |
| T3.20, T3.21 | not audited, N by my read | GA4 busiest hours and where visitors go after the home page. Low effect. LATER. |
| T4.9 | ? | No API exists for Search Console "Enhancements". Joel looks at it by hand once a month. |

---

## B3. Work packages

Order is the recommended build order. Every package keeps our rules: no invented data, every admin route checks `isAuthorized`, anything that costs credits is admin-triggered or capped, new env vars go into `.env.example` in the same change, migrations are files that the orchestrator applies, and one offline `scripts/check-<name>.ts` per package.

### WP1. Post-publish verify and the cookie-less sweep (S)
- Why first: it protects everything else and finally closes the lesson from the trip-page 500 (fixed in `6279e3b`, live status unverified).
- Files: new `lib/publish-verify.ts`; `lib/pipeline.ts` (`housekeeping`); `lib/issues.ts` and `lib/plain-steps.ts` (new issue with plain steps); new `scripts/check-live-sitemap.ts`.
- Test to add: `scripts/check-publish-verify.ts` with a fake fetch: 200 and clean, 500, missing canonical, two H1s, broken JSON-LD, not in sitemap, fetch error. Rule from the playbook audit: "cannot read" is `unknown`, never `pass`.
- Stays manual: Joel runs the sweep after big deploys and reads any Needs-attention item (existing screen).

### WP2. URL Inspection feedback and index ratio, measure only (M)
- Files: new `lib/gsc-inspect.ts` (pure shape plus runner); `lib/search-console.ts` (an inspect call); `app/api/cron/gsc-snapshot/route.ts` (new block with its own budget, started only if time is left); `lib/indexnow-catchup.ts` and `lib/seo-links.ts` reused for the 7-day nudge; a playbook audit check `indexed-ratio`; plain steps.
- Behaviour: oldest-checked first, small daily cap, stores results in `app_settings`, one IndexNow re-ping and one capped link for a page not indexed after 7 days, fails closed when the store cannot be read.
- Test: `scripts/check-gsc-inspect.ts`: order, cap, nudge happens once, ratio maths, unreadable store, unknown ratio.
- Stays manual: Joel confirms the service account can inspect; "Do it" Today card (`seo-fix`) for pages stuck 14 days.

### WP3. Index-ratio throttle (S, switch default off)
- Files: `lib/publish-cadence.ts` (`evaluateCadence`, new reason), `lib/autoblog-run.ts`, `lib/guide-run.ts`, `lib/news-run.ts`, one setting key with a documented default, a line in `lib/auto-decisions.ts` style log.
- Test: extend `scripts/check-publish-cadence.ts`: unknown ratio never blocks; under threshold with enough inspected pages defers; heals and manual publishes are never blocked.
- Stays manual: Joel turns it on after two weeks of WP2 data and picks the threshold.

### WP4. Quality gate bundle (S)
- Gates: Quick answer length, meta uniqueness, cover alt present (Step 2 table).
- Files: `lib/blog-quality.ts` (+ `QUALITY_PREFIXES`, `QualityCtx`), `lib/blog-composer.ts` `analyse`, `lib/content-repair.ts` `BLOCKER_RULES`, `lib/guide-composer.ts` if the guide side needs the same, `lib/autoblog-run.ts`.
- Test: `scripts/check-blog-quality.ts` and the drift check in `scripts/check-content-repair.ts`. First, a one-off script prints the real Quick answer lengths of live posts so thresholds are set from data.
- Stays manual: nothing new; held drafts show in Today.

### WP5. Questions people ask: PAA into FAQ, plus conversational and buyer-intent mining (S)
- Files: `lib/keyword-ideas.ts`, `lib/blog-composer.ts` (`ComposerContext`, enrich prompt), `lib/gsc-mining.ts`, `lib/blog-topics.ts` `rankByGsc`.
- Test: `scripts/check-keyword-intel.ts`, `scripts/check-seo-engines.ts`: regex buckets, cap of 3 topics a day still holds, FAQ question comes from the list when present, nothing invented when the list is empty.
- Stays manual: approve topics in Today (existing).

### WP6. Template polish (S)
- Contents link list (TOC) on posts and guides with four or more H2s, a visible breadcrumb trail on trip pages and who-we-are, BreadcrumbList on those pages and home, WebSite node on home, og:image for `/from/*`.
- Files: `lib/markdown.ts` (heading ids), `components/guide-page.tsx`, `app/blog/[slug]/page.tsx`, `lib/org-jsonld.ts`, the home and trip page files, the from-city page.
- Test: `scripts/check-blog-page.ts`, `scripts/check-guide-schema.ts`, `scripts/check-og-paths.ts` extended; the nightly crawl already reports regressions.
- Stays manual: none.

### WP7. Technical hygiene (S)
- Security headers (four safe ones, no strict CSP), `*.vercel.app` redirect (after checking the live answer), explicit AI-crawler lines, `/feed.xml`.
- Files: `next.config.mjs`, `middleware.ts`, `app/robots.ts`, new `app/feed.xml/route.ts`.
- Test: new `scripts/check-head-hygiene.ts` (headers present, robots has the lines, feed is valid XML with absolute links, the cache-mirror matcher does not touch the feed).
- Stays manual: Joel's decision on the AI-crawler policy; Joel changes the apex redirect to permanent in Vercel.

### WP8. Image sitemap (M)
- Files: new `lib/image-sitemap.ts` (pure builder, rewritten from `reference/image-video-sitemaps/`), `app/sitemap-images.xml/route.ts`, `app/robots.ts`, add the path to the cache-routing exclusion list if needed.
- Test: `scripts/check-image-sitemap.ts` (only absolute URLs, at most 10 pictures per page, empty valid file when none, no unpublished page).
- Stays manual: Joel submits it in Search Console and Bing.

### WP9. Core Web Vitals monitor (M)
- Files: new `lib/cwv-run.ts`, `app/api/cron/gsc-snapshot/route.ts`, `lib/seo-playbook-audit.ts` (`page-speed`), `lib/issues.ts`, `.env.example` (`PAGESPEED_API_KEY`).
- Test: `scripts/check-cwv.ts` with canned API answers: pass, fail twice, quota error (must say "unknown", not "pass").
- Stays manual: Joel creates the key; regression becomes a Needs-attention item, fixes are developer work.

### WP10. Decay refresh and page-level query gaps (M)
- Files: `lib/rankings-snapshot.ts`, `lib/blog-reheal.ts`, `lib/ctr-loop.ts`, `lib/growth-digest.ts`, `lib/today-cards.ts` (guide cards only).
- Test: new `scripts/check-decay.ts`: windows are non-overlapping, a post under 28 days is skipped, seasonality note, first month report only.
- Stays manual: guide rewrites are a Today card ("Do it"), never automatic. Posts use the heal ladder with Undo.

### WP11. Owner and traveller grounding, "interview lite" (M)
- Idea: the hub's strongest answer to generic AI copy (T2.21). Today our copy is thin where data is thin because the gate allows only stored facts. Let approved Recap Studio answers (collected with consent) and a few short owner answers become grounding text, so the writer may use them and the gates still block everything else.
- Files: `lib/today-cards.ts` (new card kind `owner-interview`), `lib/guide-run.ts` `buildBrief`, `lib/guide-composer.ts` `groundingText`, the recap store (unread), `lib/blog-topics.ts` `findGroundingPackage`.
- Test: `scripts/check-today-queue.ts` (its enumeration test fails until the card exists, by design) and `scripts/check-guide-gate.ts` (owner numbers allowed, anything else still blocked, no customer names or contact details).
- Stays manual: this is the human step. Joel answers a few questions per new guide or popular trip.

### WP12. Inbound links for each new post (S)
- Files: `lib/seo-links.ts`, `lib/autoblog-run.ts`. Test: extend `scripts/check-seo-engines.ts` (cap, Undo, never to itself, published pages only).
- Stays manual: none (every link is logged with Undo).

### Later bundle (not scheduled)
Evergreen re-share (A11), embedding and heading dedupe (A12), lead-weighted learning (A13), migration workflow (A14), video sitemap and VideoObject (A15), named author (A16), AI citation tracker (A17), backlink gap (A18), community queue (A19), focus-first expansion gate (T2.22), 16-month prune review (T2.17, not before the pages are old enough).

---

# Part C. What Joel needs to do or decide, and the first batch

## C1. Keys and accounts

| Need | For | Notes |
|---|---|---|
| Google Cloud API key for PageSpeed Insights | WP9 | Free. New env var, `.env.example` updated in the same change. |
| Confirm the Search Console service account is a user on the property and can use URL inspection | WP2 | Also confirm the property type matches `SEARCH_CONSOLE_SITE_URL` (unverified). |
| `BING_WEBMASTER_API_KEY` | Bing coverage, index ratio | In `.env.example` but dormant until set. Also submit the sitemap in Bing Webmaster Tools (T1.3, T1.14 are "?" in our status). |
| Change the apex-to-www redirect from temporary to permanent | T1.6 | Vercel domain setting. |
| Submit `sitemap-images.xml` in Search Console and Bing | WP8 | After it ships. |
| `OPENAI_API_KEY` set or not, plus a pgvector decision | A12 only | Not needed now. |
| Reddit OAuth keys | A19 only | Not needed now. |
| DataForSEO backlinks product | A18 only | Whether our plan includes it is unverified. |
| Supabase access token | A14 only | Not needed now. |

## C2. Decisions

1. AI crawlers: keep "allow all" and write it into `robots.ts`?
2. "Best X for Y" pages (master T6.9) versus our own rule that blocks superlatives and the word "best" on guides. Allow a careful "best for first-timers" style on posts only, with pros and cons? Right now the gates would fight it.
3. A named, real person as author (name, short bio, credentials, TICO number as the inventory says is owed). Needed for Person markup and trust (T9.8, T4.5).
4. Owner time for WP11: how many short questions a week?
5. Index-ratio throttle: alert only first, then a soft slowdown; which threshold (the hub's 80 percent is unmeasured)?
6. Switch state: are the CTR loop, cannibalisation links and the SEO topic push on in production? I could not read settings. If off, decide when to turn on.
7. Later: migration workflow, evergreen re-share, embeddings.
8. Ask the contribute session to correct PR 30 about the 500 error once WP1 shows the live site is clean.

## C3. Recommended first batch: WP1, WP2, WP4

1. **WP1, post-publish verify and cookie-less sweep.** Smallest, needs no key, and it proves the 500 fix and guards every later change. A broken page is the most expensive SEO mistake we can make.
2. **WP2, URL Inspection and index ratio (measure only).** The biggest blind spot in our own status file: we cannot say how many pages Google actually indexed. It also feeds WP3 later. Only a permission check from Joel.
3. **WP4, quality gate bundle.** Pure code, small, and it improves every future auto post at the gate where it is cheapest to fix. Set thresholds from real post data first.

Second batch: WP3, WP5, WP6, WP7, WP12. Third batch: WP8, WP9 (needs the key), WP10, WP11 (needs Joel's time).

Confidence: 68/100. The pipeline mapping comes from files I read, but several engines (heal loop, CTR loop, mining) were read only through headers and the hub's own descriptions, and no live behaviour, switch state or Search Console permission was checked.
