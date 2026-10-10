# Growth Loop Brief (2026-10-09)

Shared contract for every builder and QA agent in the content-growth loop. The orchestrator
(main session) merges and pushes; agents never push to `main`.

## Goal, in one sentence

More Google traffic, more sign-ups, more sales, from: better keywords and topics, blog posts written
for SEO + GEO + AEO with full on-page work, social content that varies hooks and styles per network
and always links back, and many genuine destination / hotel / resort / cruise / river cruise / yacht
pages. Everything tracked so the system can see what works and lean into it.

Glossary (plain English): SEO = ranking in Google. GEO = being the source AI answer engines
(ChatGPT, Perplexity, Google AI Overviews) quote: clear definitions, stats with sources, named
entities, structured sections. AEO = answering the exact question directly in the first sentence,
FAQ blocks, FAQPage schema. On-page = title, meta description, OG tags, headings, alt text,
internal links, schema.org JSON-LD.

## Non-negotiable rules (break one and QA must fail the round)

1. **Never invent data.** No prices, dates, availability, room counts, star ratings, awards,
   distances, exact statistics, or "we were there" claims. General, guidebook-level knowledge only.
   A number in generated copy must come from a package row or be clearly general ("most people spend
   two or three days"). Every AI step keeps the existing `NO_FABRICATION` discipline and a mechanical
   quality gate (regex checks in plain code, never trusting the model).
2. **Every credit-costing automatic step is capped** (per day and per week) and admin-visible. New
   paid calls default to the existing Anthropic key only; no new vendors. Cap values are
   `app_settings` keys with safe defaults, shown on the Autopilot page, not new screens.
3. **No new cron, no new admin page, no new toggle** when a step inside `lib/pipeline.ts` or a card
   on `/admin/autopilot` can do it. Errors go through `lib/issues.ts` (Needs attention) with grade-5
   steps in `lib/plain-steps.ts`.
4. **Admin API routes** check `isAuthorized(request)` from `lib/admin-auth.ts` first. Public tables
   get RLS on with an anon `select` policy only for published rows; admin tables get RLS on and no
   policy (service role only, via `getSupabaseAdmin()`).
5. **Migrations** are numbered files under `supabase/migrations/` (use the number assigned to your
   work package). You write the file; the orchestrator applies it. Never run SQL against the live DB.
   Never change `app_settings` values or any live row.
6. **Code edits with Edit/Write only.** No heredocs or shell patches (they corrupt backslashes).
   Never start `next dev` or `next build`. Verify with
   `pnpm exec tsc --noEmit -p tsconfig.json` (run it alone, never piped inside `&&` chains).
7. **Copy style:** plain English, no em dashes anywhere (use commas or full stops), Canadian
   spelling is fine, warm and practical. Everything user-facing has an FR fallback only if the file
   you touch already does i18n; do not add i18n plumbing.
8. **Links back to the site always carry UTM tags** through `lib/utm.ts` (`utmLink`), with
   `utm_source` = network, `utm_medium` = social, `utm_campaign` = post slug, `utm_content` = the
   hook/style variant, so every click is attributable.
9. **Track every choice** through `tagVariant()` in `lib/content-variants.ts` (keys documented
   below) so a later feedback step can compare styles against real clicks, visits and leads.
10. Keep existing behaviour working: the live pipeline is posting to real accounts. Nothing you add
    may raise the number of posts, renders or social sends beyond today's caps (3 posts/week, 1/day,
    3 videos/week). New generated pages are not social-posted automatically in this wave.

## Variant tag keys (content_variants.variant_tags)

- `content_style`: listicle | how-to | comparison | faq-led | story-guide | myth-buster | checklist
- `cta_style`: soft-question | direct-book | compare | quiz-style | guide-download
- `hook_style:<network>`: question | number | contrarian | mistake | story | comparison | how-to
- `caption_style:<network>`: same set as hook_style
- `video_hook`: existing HOOK_FORMULAS value (already tagged)
- `cover_source`: pexels | ai | none (already tagged)

## Work packages (wave 1 runs WP1, WP2, WP4 in parallel; WP3 follows)

### WP1: Blog posts written for SEO + GEO + AEO (migration 0027)

Files: `lib/blog-composer.ts`, `lib/autoblog-run.ts`, `lib/posts.ts`, `app/blog/[slug]/page.tsx`,
`app/blog/page.tsx` (only if needed), `lib/markdown.ts` (only if needed), `lib/jsonld.ts`,
new `lib/content-styles.ts`, `supabase/migrations/0027_posts_seo_fields.sql`.

Deliverables:
- `posts` gains nullable columns: `content_style text`, `faq jsonb` (array of {q,a}),
  `key_takeaways text[]`, `og_title text`, `og_description text`, `primary_keyword text`,
  `secondary_keywords text[]`. All optional, old posts keep working.
- `lib/content-styles.ts`: the style catalogue (7 styles above) with a prompt fragment, a CTA
  catalogue (5 styles), and `pickStyle(recentStyles)` that rotates so the same style is not used
  twice in a row and under-used styles are preferred (exploration), deterministic and unit-testable.
- Composer writes, in one extra step or inside the body step: a direct-answer first sentence
  (already there), 3-5 FAQ pairs (real questions a searcher asks, answered in 1-3 sentences, no
  numbers not in the brief), 3-5 key takeaways (one line each), OG title (under 60 chars, may differ
  from SEO title: more curiosity, still honest), OG description (under 110 chars), primary and
  secondary keywords, and 1-2 internal links in the body to real site pages: the grounding package
  (if any), `/destinations/<slug>` for the destination (only if that destination has a published
  package; use `listSitePages` in `lib/site-pages.ts` or the package row), `/best-time-to-visit/<slug>`
  if it exists for that destination. Never link to a page that does not exist.
- Body length target 900-1400 words for story-guide and how-to, 700-1000 for the rest.
  Headings: H2s with the primary keyword in the first H2, at least one H3 under the longest section.
  Include one short "definition" sentence for the main concept (GEO), and one "Quick answer" line
  near the top (AEO). Mechanical gate extends `autoPublishBlockers`: missing FAQ, missing
  takeaways, a number in FAQ/takeaways that is not in the grounding text, a dead internal link
  (regex `/(packages|destinations|best-time-to-visit)/[^)]+` must resolve against the real slug
  list passed in), em dash present.
- `app/blog/[slug]/page.tsx`: render Key takeaways box under the hero, FAQ accordion-style list at
  the end (plain details/summary is fine), Article JSON-LD gains `wordCount`, `keywords`,
  `articleSection`, `inLanguage`; add FAQPage JSON-LD (only when faq is non-empty) and
  BreadcrumbList JSON-LD (Home > Blog > post). OG uses `og_title`/`og_description` when present.
  Add `speakable` with the quick-answer selector. Keep `jsonLdHtml`.
- `autoblog-run.ts`: passes recent posts' styles to `pickStyle`, saves the new fields, tags
  `content_style` and `cta_style` via `tagVariant`, keeps every existing guard. The CTA block from
  `appendCta` becomes style-aware (5 variants, all still grounded, still linking only to the real
  package or `/#contact`).
- A tiny pure-function test file is welcome if the repo has none: put it under `scripts/` as a
  node script runnable with `pnpm dlx tsx scripts/check-content-styles.ts` and say so in your report.

### WP2: Social content with varied hooks per network, all linking back (no migration)

Files: `lib/social-captions.ts`, `lib/distribution.ts` (where captions/links are built),
`lib/video-script.ts`, `lib/carousel.ts`, `lib/utm.ts` (read only unless a helper is missing).

Deliverables:
- Caption generation gets a hook style per network, rotated per post so consecutive posts on the
  same network do not open the same way (read the last 5 `content_variants` rows for that network).
  The prompt asks for: hook in the first line (style named), body adapted to the network, one CTA
  with a plain next step, hashtags per network rules (Instagram 3-8, TikTok 1-3, X 1-2, LinkedIn
  0-3, Pinterest keyword-rich, Bluesky 0-2, Facebook 0-2, YouTube description with timestamps not
  needed), no em dashes. Mechanical gate: limit fit (exists), hook not identical to title, no
  numbers outside the post title/summary/FAQ, link present and UTM-tagged (`utm_content` = hook
  style).
- Every outbound link, in captions, carousel last slide, video CTA description, goes through
  `utmLink` with source = network, medium = social, campaign = post slug, content = variant.
- Video: `generateVideoScript` accepts a `preferredFormula` chosen by rotation (same last-5 rule)
  and the hook catalogue grows with `question` and `story`; `coverTitle` style varies the same way.
  Carousel: slide 1 headline uses the hook style, final slide CTA style rotates (5 CTA styles).
- `tagVariant` records `hook_style:<network>`, `caption_style:<network>`, `video_hook`,
  `carousel_cta`.
- Do not change which networks are ticked, caps, or any posting call signature in a way that
  could double-post. Read `docs/factory/ADOPTION-LOG.md` 2026-10-08/09 entries before touching
  `distribution.ts`.

### WP4: Genuine guide pages: destinations, hotels, resorts, cruise lines, ships, river cruises, yachts (migration 0028)

Files: new `lib/guides.ts`, new `lib/guide-composer.ts`, new routes
`app/guides/[kind]/[slug]/page.tsx` plus thin kind indexes `app/guides/[kind]/page.tsx`, redirects or
aliases so `/destinations/<slug>` keeps working (extend the existing destination page to show the
guide body when a guide row exists; do not break it), `app/sitemap.ts`, `lib/site-pages.ts` (new
page type `guide`), `lib/pipeline.ts` (one capped step), `app/admin/destinations/page.tsx` or a
card on `/admin/autopilot` (list + "write one now" button + status), API routes under
`app/api/admin/guides/`, `supabase/migrations/0028_guides.sql`.

Kinds and public URL prefixes: `destinations` (existing prefix stays `/destinations/<slug>`),
`hotels`, `resorts`, `cruise-lines`, `ships`, `river-cruises`, `yachts`. Public URL for the new kinds:
`/guides/<kind>/<slug>` is acceptable, but `/<kind>/<slug>` is better for SEO; pick `/<kind>/<slug>`
only if it does not collide with existing routes (`/packages`, `/blog`, `/compare`,
`/best-time-to-visit`, `/destinations`, `/carousel`, `/go`, `/who-we-are`, `/thank-you`).

Table `guides`: id uuid pk, kind text check in the 7 kinds, slug text, name text, parent_slug text
null (a resort's destination, a ship's cruise line), summary text, body markdown text, sections jsonb
(array of {heading, body}), faq jsonb, key_takeaways text[], hero_image_url, hero_alt, meta_title,
meta_description, og_title, og_description, primary_keyword, secondary_keywords text[], related
package ids uuid[] (only real published packages), status text (draft|published), source text
(ai|manual), quality_notes text, created_at, updated_at, unique(kind, slug). RLS on, anon select
where status = published.

Generation (`guide-composer.ts`): one grounded brief per guide: kind, name, parent, which real
packages touch it (name, destination, category, short_description, dates year only), the keyword
list for it from `keyword_research` (if any), and the existing destination blurb. Output: summary,
6-9 sections (for destinations: why go, neighbourhoods or regions, what to do, food, when to go in
general terms, getting around, who it suits, how we take groups there; for hotels/resorts: setting,
style, who it suits, what to expect, nearby, how to visit with a group, never amenities counts or
ratings; for cruise lines/ships: style of ship, who it suits, typical itineraries in general terms,
dining and onboard life in general terms, tips; for river cruises/yachts: how it differs, routes in
general terms, cabin life, pace, who it suits), FAQ (4-6), key takeaways (3-5), meta/OG fields,
primary/secondary keywords, internal links to real pages only. Same mechanical gates as WP1 plus a
"no superlative claim about a named property" check (best, number one, award-winning, 5-star).
Word target 1200-1800.

Seeding: a function that proposes guide candidates from real data: every destination of a published
package, every package name that looks like a hotel/resort/ship/cruise line (use category and name),
plus a small curated list file `lib/guide-seeds.ts` of well-known Canadian-market picks per kind
(20-40 entries, names only, no facts). Candidates appear in the admin list with "write" buttons.

Pipeline step (inside `runPipeline`, after WRITE, before POST, budget-guarded): when autopilot is
on, write and publish at most `guides_per_day` (default 1) and `guides_per_week` (default 5) guides
from the candidate list, oldest-kind-first rotation so kinds interleave, skipping any that failed
twice. Logs a step `guides` in the run. Ping IndexNow for new pages. Errors to Needs attention.

Page: hero image via `findDestinationPhoto` (Pexels) with alt; H1 with the kind label; summary;
Key takeaways; sections; FAQ; related packages (`PackageCard`); links to the parent guide, to
`/best-time-to-visit/<slug>` when it exists, to sibling guides of the same kind; CTA (contact form
link and, when a package exists, the package). JSON-LD: TouristDestination for destinations,
Hotel/Resort (schema.org `Resort` is a subtype of `LodgingBusiness`) for hotels/resorts with only
name, description, url, image (no address or rating unless known), `BoatTrip`/`TouristTrip` style
for cruises and yachts, plus FAQPage and BreadcrumbList. Add the kind index pages (list of
published guides with summaries) and all to `sitemap.ts` and `listSitePages`.

### WP3 (wave 2, after WP1 merges): track and self-improve (migration 0029)

A `content_performance` daily snapshot (per path: GSC clicks/impressions/position via
`getPageMetrics`, GA4 sessions if per-page data exists, social sends and failures from
`post_distribution`/`content_pipeline`, leads attributed by landing path in `leads`), a
`style_scores` view joining `content_variants` so each style gets a clicks-per-post and
leads-per-post number, and `pickStyle` reads those scores: 70% best-known style, 30% exploration.
A "What is working" card on the Autopilot page. The daily brief gets one line per style.
Details to be briefed when wave 2 starts.

## QA agent standard

A QA agent reads the whole diff of the worktree against `main`, runs tsc, reads every new prompt
and gate, and tries to break it: fabricated numbers slipping through, a dead internal link, an em
dash, an uncapped loop, a route without `isAuthorized`, a public table without RLS, a migration
that breaks old rows, a change that could double-post, a prompt that could make the model claim
experience, a schema type that is wrong for the content, any `next build`-breaking pattern (client
hooks in server components, missing Suspense for `useSearchParams`). The QA report lists
findings ranked by severity with file:line and a concrete failure scenario, and a verdict:
SHIP, FIX-THEN-SHIP, or REWORK. QA never edits code.

## Reporting

Each builder's final report: what was built (files), what was verified (tsc output line), what was
NOT done and why, open questions for Joel (only things only he can do), and the branch name.
