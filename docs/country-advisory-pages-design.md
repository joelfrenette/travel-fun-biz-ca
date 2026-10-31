# Country advisory pages: design

Status: proposal only. Nothing in this document is built. Written 2026-10-31 from the code and the live database (read only).

## 0. The short version

- Replace the dated "News: Canada travel advisory update for X" posts with one evergreen page per country: /travel-advisories/[country], plus an index at /travel-advisories.
- Each page shows the CURRENT official advisory, names and links the source, and keeps a dated update log on the same page.
- Everything sits behind an app_settings switch that is OFF by default. Old posts are only touched in the last step, and every step can be undone.
- Honest caveat: the site gets about 9 visits a day and 0 clicks. A better page structure does not create demand. It removes duplicate pages and makes one thing worth linking to. Do not expect traffic from this alone.

## 1. How news posts work today (what I read)

Numbers below come from the live database on 2026-10-31.

**Counts.** 45 published posts. 30 are news posts (slug starts "news-", tag "travel-news"; the two sets are identical). The brief said 35; the database says 30. The other 15 are normal posts.
- Canada advisory posts: 14, covering 11 countries. Tanzania, Saudi Arabia and Jordan each have 2 posts, so the duplicate-page problem is already real.
- UK advice posts: 3 (Colombia, Turkey, Yemen).
- Hurricane centre (NHC) posts: 13, all about named storms (Vance, Trudy, Josephine), not countries.

**Pipeline (feed to post).**
1. The allowlist of feeds is lib/news-sources.ts lines 37 to 129. Canada is a JSON snapshot of every country (lines 82 to 95), UK is an Atom feed (lines 71 to 81), NHC is RSS (lines 38 to 59).
2. lib/news-feed.ts `parseAdvisoryJson` (lines 354 to 420) reads Canada: country name, ISO code, one-line level text ("Exercise a high degree of caution"), a date, a short description, and a travel.gc.ca link. Only these fields are used. Article pages are never fetched.
3. lib/news-ingest.ts `selectChangedAdvisories` (lines 98 to 139) compares the snapshot with a saved state. That state is only a hash and the level text per country, kept in one app_settings row (key news_gac_state, line 80, written at line 295). A country becomes an item only if its level text changed, or its level is above "normal precautions" and its text or date changed. First run is a silent baseline.
4. Items are stored in table news_items (supabase/migrations/0047_news_items.sql lines 8 to 26): source_key, guid, url, title, summary_raw (600 characters max, "never displayed publicly"), published_at, status, post_slug.
5. lib/news-run.ts lines 337 to 358 builds the post text with plain code, no AI, for UK (lib/news-uk.ts) and Canada (lib/news-ca.ts `buildCaBrief`, line 42) and NHC (lib/news-nhc.ts line 129). Every sentence passes the same word gate (`briefProblems`), so only words found in the notice get through.
6. lib/news-publish.ts `buildNewsPostRow` (lines 57 to 79) writes a normal row in `posts`. Slug is `news-<headline>-<6 characters of the item id>` (lib/news-post.ts lines 22 to 26). Title is "News: <headline>" capped at 60 characters. Body is one "What happened" line, 1 to 3 "means" sentences, a source link, and a "Reported <date> by <source>" line (news-post.ts lines 82 to 99).

**Rendering and indexing.**
- Route: app/blog/[slug]/page.tsx, the same route as every blog post. No news-specific route.
- Indexable. generateMetadata (lines 39 to 55) sets a self-pointing canonical and no robots tag. The only noindex is for a missing post (line 41). app/robots.ts line 6 blocks only /admin, /api/, /go.
- In the sitemap. app/sitemap.ts lines 107 to 112 lists every published post, news included, at priority 0.5.
- Markup (page.tsx lines 111 to 131): BlogPosting, with articleSection "Travel news", `isBasedOn` and `citation` pointing to the official source, plus speakable and a BreadcrumbList. A post older than 30 days (storm: 48 hours) is only labelled "Archived news" in its heading (news-post.ts lines 118 to 130). It stays indexable.

**Social.** A published news post is enrolled in the same post_distribution ledger as blog posts (lib/news-distribution.ts lines 48 to 81; called from lib/auto-policies.ts line 539). Limits: a per-day news number, and a shared ceiling of 6 enrolments per UTC day across all content (line 13). Gated by app_settings keys travel_news_mode, travel_news_per_day, news_social_posts (lib/news-settings.ts lines 7, 45, 68). I did not check whether news social posting is switched on today.

**Search data (content_performance, 2026-10-10 to 2026-10-31).** Whole site: 112 paths, 661 impressions, 0 clicks. News posts: 38 impressions on 4 posts, 0 clicks. The other 26 news posts have none.

| Post (slug, shortened) | Impressions | Avg position |
|---|---|---|
| news-canada-travel-advisory-update-for-tanzania-b07f07 | 14 | 4.5 |
| news-canada-travel-advisory-update-for-saudi-arabia-3d9939 | 9 | 12.2 |
| news-canada-travel-advisory-update-for-france-f0b456 | 8 | 8.2 |
| news-canada-travel-advisory-update-for-el-salvador-155743 | 7 | 3.6 |

All four are Canada posts. Position 3.6 and 4.5 with no clicks suggests the title is weak or the searches are rare. I cannot tell which from this data.

## 2. The design

### 2.1 URLs
- /travel-advisories : index, one row per country that has an advisory on file, with level and last update date.
- /travel-advisories/[country] : e.g. /travel-advisories/mexico. Slug is the plain country name, never a date or id.
- Page title pattern: "Mexico travel advisory (Canada and UK), updated <date>". Under 60 characters, following the existing title rule.

### 2.2 Data model: two new tables, news_items stays as is
news_items is a working queue that expires items after 7 days (lib/news-sources.ts line 146). It cannot be the permanent record. Add:

**country_advisories** (one row per country, the CURRENT state)
- slug, name, iso (Canada's code), guide_slug (nullable, hand-set, see 2.6)
- ca_level, ca_text, ca_source_url, ca_source_published_at, ca_checked_at
- uk_text, uk_source_url, uk_source_published_at, uk_checked_at (UK gives an update line, not a level: see section 7)
- status: draft or published (default draft)

**country_advisory_log** (append only, the dated update log)
- country_slug, source_key, guid (unique with source_key, so a re-read never double-logs), kind (level_change or text_update), level_from, level_to, text, source_url, source_published_at, news_item_id, created_at

Both tables get RLS on with no policy, service role only, like every admin table. The public page reads through a server function using the admin client and shows published rows only. Migration number would be 0062 (last is 0061). Per project habit, Joel runs it in the Supabase SQL editor.

### 2.3 How the feeds update a page
- Canada: where `selectChangedAdvisories` already finds a changed country, also upsert country_advisories (ca_*) and append one log row. Level history is cheap because the code already computes level from and to (news-ingest.ts line 125).
- UK: same, from the UK item (ukCountryOf, news-uk.ts line 29). Set uk_* and append a log row.
- NHC: leave alone. A hurricane bulletin is about a storm, not a country, and the feed does not give countries in a structured field. Matching storm text to countries would be guessing. Storm posts stay as they are (see 3.4).
- Country matching is by an explicit table (Canada ISO code to our slug, UK name to our slug). A name that does not match is NOT guessed. It is logged to Needs attention and no page is made. Known risk: UK and Canada spell some countries differently (Turkey/Turkiye, Congo, Eswatini). I have not compared the two lists.

### 2.4 Keeping it factual (the never-invent rule)
- The page body is built only from fields the feed gave: level text, update text, date, source link. Fixed framing words come from the existing allowed list (TEMPLATE_FRAMING_WORDS, lib/news-brief.ts). The same `briefProblems` gate runs on every sentence before it is stored, as today.
- Every block says "The Government of Canada says" or "The UK FCDO says", shows "Last checked <date>" and "Source published <date>", and links the official page. If a field is empty it is not shown. No "overall risk" line, no advice, no summary of the two sources.
- No level is shown for UK, because the feed has none.
- Stale guard: if ca_checked_at is older than 3 days, the page says "We could not confirm this today. Check the official source." The page must never look current when the feed is down.
- Cost: no AI, no new API key, no new credit-costing call. This stays plain code.

### 2.5 Page layout and markup
- Top: one sentence on what the page is, then two source blocks (Canada, UK), then "Update log" (newest first, all rows), then links.
- Markup: WebPage with `about` (Country), `dateModified` (latest real change), `isBasedOn` and `citation` for each source, plus BreadcrumbList (existing helper buildBreadcrumbJsonLd in lib/jsonld.ts line 74). No FAQ markup unless real questions exist. Not using SpecialAnnouncement: Google limits it to COVID.
- Self canonical. Indexable only when the switch is fully on and the row is published.

### 2.6 Sitemap and internal links
- Sitemap: add the index and the published country pages next to the posts entries in app/sitemap.ts (around line 106), only when the switch is on. lastmod comes from the newest log row, never from "now" (same rule as scripts/check-sitemap-lastmod.ts).
- Links in: from a destination guide or a trip page to its country page. The guides table has no country column that I could find (0028_guides.sql), so the link needs a hand-made map country slug to guide slug. I did not verify how many of the 14 countries have a guide. Expect few. Do not link where no real guide exists.
- Links out: each country page links to its guide and to packages for that country if any exist. Not shown otherwise.
- Add to llms.txt only after the pages are live.

### 2.7 Social without spam
- One social post per country page per real change, not per feed read. Trigger only on a level change (a log row with kind level_change), not on a text edit.
- One post per country per 14 days at most. Use the existing shared ceiling of 6 a day and the existing news per-day number, so the new path cannot add volume.
- Link goes to the country page with the same UTM tags as today.
- Unverified: lib/distribution.ts loads posts by slug from `posts` for content_type 'post'. A country page is not a post, so the posting pass needs a small addition (or a content_type). I did not size this beyond the evergreen re-share precedent (lib/evergreen-reshare.ts). Build it last, and default it off.

## 3. What happens to the existing news posts

Options for the 17 Canada and UK posts:

| Option | Good | Risk |
|---|---|---|
| A. 301 each post to its country page | Merges signals, removes duplicates, clean | The 4 posts with impressions lose their own listing. A redirect to a page that is not yet indexed can lose ranking for weeks. Social links from the past also redirect (fine). |
| B. Keep, canonical to the country page | Reversible, no URL change | Google may ignore a canonical when the pages differ. Duplicates stay in the sitemap unless removed. |
| C. noindex | Simple | Throws away the page's small history and passes nothing on. Worst for the 4 earning ones. |

Recommendation: B first, A later.
1. When the country page is live and in the sitemap, set each Canada or UK post's canonical to its country page and drop those posts from the sitemap.
2. After 4 to 6 weeks, if the country page is indexed, 301 each post to it. Check the 4 posts with impressions first (table in section 1). Their targets are Tanzania, Saudi Arabia, France and El Salvador, so those four country pages should go live and be indexed first.
3. Redirect target must be the matching country, never the index or the home page.
4. A post whose country cannot be matched is left alone.

Mechanism for A: a runtime redirect inside the blog page (permanentRedirect) driven by a lookup, not a static list in next.config.mjs. The static list there (lines 19 to 41) is fixed at build time and would need an edit for each new post. Note: Next sends 308 not 301. Google treats both as permanent.

3.4 NHC storm posts (13): not part of this change. They already carry a 48 hour archive label. Separate small idea, not in scope: noindex a storm post once superseded. None of them has impressions.

## 4. Rollout behind a switch

Switch: app_settings key `country_advisories_mode`, read with getSettingStrict (lib/app-settings.ts line 19). Values: `off` (default, and anything unreadable or unrecognised counts as off), `log` (collect rows, show nothing public), `on` (pages public, indexable). Same exact-match style as news_social_posts. Run checks with: `npx --yes tsx --tsconfig tsconfig.json scripts/<x>.ts`.

| Step | What ships | Proof (new check script) | Rollback |
|---|---|---|---|
| 1 | Migration 0062, pure helper lib/country-advisory.ts (name to slug map, level text cleaner, page text builder) | check-country-advisory-map.ts: all 14 current countries map; unknown name returns null; no dash characters; empty field not rendered | Drop the two tables (nothing reads them) |
| 2 | Dual write in ingest and run, only when mode is `log` or `on`. Old posts still created | check-country-advisory-ingest.ts with fake-admin: one change makes one log row; same guid twice makes one; mode `off` writes nothing | Set mode `off`; delete rows |
| 3 | Backfill from news_items (status published, Canada and UK) and the existing post bodies | check-country-advisory-backfill.ts: counts match (12 Canada, 3 UK items), source URLs only on allowed hosts | Truncate the two tables |
| 4 | Page and index, noindex unless mode is `on` and row published, with stale guard and markup | check-country-advisory-page.ts: markup has citation, no field invented, stale text appears at 4 days, index lists only published | Mode `off` returns 404 |
| 5 | Sitemap entries, internal links, llms.txt line | check-country-advisory-sitemap.ts: entries only when on; lastmod from log; no link without a real guide | Mode `off` removes them |
| 6 | Canonical on old Canada and UK posts, sitemap removal for those | check-country-advisory-canonical.ts: every changed post has a matched country; the 4 with impressions listed | Remove lookup, canonical returns to self |
| 7 | With mode `on`, stop creating NEW Canada and UK posts (log row only) | check-country-advisory-stop-posts.ts: Canada item makes no post, NHC still does | Mode `log` restores posts |
| 8 | Social for level changes | check-country-advisory-social.ts: one enrolment per change, 14 day gap, ceiling of 6 respected | news_social_posts off, or mode `log` |
| 9 | After 4 to 6 weeks and Joel's yes: 301 old posts | check-country-advisory-redirects.ts: every redirect has a matching country and no loop | Remove the lookup |

Do not use `next build` or `next dev` for verification while the other is running (project rule). Steps 4 and 5 also need a real browser pass.

## 5. Effort (hours, build plus check, my estimate)

| Step | Hours |
|---|---|
| 1 | 3 |
| 2 | 4 |
| 3 | 2 |
| 4 | 6 |
| 5 | 3 |
| 6 | 3 |
| 7 | 2 |
| 8 | 4 |
| 9 | 2 |
| Total | about 29 |

Steps 1 to 5 (about 18 hours) are the useful core. Steps 6 to 9 are cleanup and distribution.

## 6. Risks

- Thin page risk moves, it does not vanish. A country page with one level and one sentence is still thin. It is better than 2 or 3 dated copies, but it will not rank on its own. Its value is being one stable URL others can link to.
- Coverage is small and slow. Only countries that CHANGED have data (Canada's snapshot lists all countries, but the saved state keeps no text for unchanged ones). At the pace seen so far that is about 11 countries in 3 weeks. The index page would look sparse. A live read of the full snapshot could fill every country, but it is more content, more thin pages, and more to keep correct. I recommend not doing it yet.
- Source wording. The pages quote government text. Existing posts already do this under the same gate, but a permanent page makes the quote more visible. Keep quotes short and attributed.
- Wrong match. A mismatch between spellings could put one country's advisory on another's page. The map must be explicit and the check must list every pair.
- Redirect timing. Redirecting before the new page is indexed can drop the 4 listed posts for weeks.
- Silent staleness. If the Canada feed breaks, a "current" page would be wrong. The stale guard is mandatory, not optional.
- Not verified: whether news social posts are switched on, how the blog index lists news posts, how many countries have a destination guide, UK and Canada country spelling differences, and whether the 4 listed posts get impressions from branded or generic searches.

## 7. Decisions only Joel can make

1. Go or no-go. With 9 visits a day, is about 18 hours on the core steps worth it, or should the 17 old posts simply be set to canonical (step 6 alone, about 3 hours, plus the lookup)?
2. UK shows no level. Show the UK update line only, or leave the UK out of v1?
3. Is a quoted government sentence on a permanent page acceptable, or only a level plus link?
4. Redirect policy: wait 4 to 6 weeks (recommended), or redirect sooner?
5. Social: allow posts on level changes only (recommended), or none for these pages?
6. Should the .com replica show Canadian advisories? A US company may prefer the US State Department feed (already allowlisted, key us-state-dept, not used for posts here). This affects the table design, so decide before step 1.
7. Page name: "travel advisories" (matches search wording) or something softer.
8. Applying migration 0062 in the Supabase editor, as with earlier migrations.

Confidence: 80/100 on how the current code works (read directly, line numbers cited). 55/100 on effort and on any traffic benefit.
