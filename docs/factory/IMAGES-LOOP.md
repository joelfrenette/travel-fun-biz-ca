# Images loop: audit and fixes

Goal: thumbnails and images done correctly for news articles, destination pages and all the autoblogging, so the site looks good and earns traffic.
Line numbers in "Found" are from the base commit (9cdbc0b), before this branch's edits.

## Found (with evidence)

| # | Finding | Where |
|---|---------|-------|
| 1 | News posts were saved with no cover and no alt (`cover_image_url: null`, `alt_text: null`), so every news card and the public hero fell back to a generic default SVG. | lib/news-publish.ts:~72-73 (`buildNewsPostRow`) |
| 2 | The share image route had no news design: a news post's `/og/blog/<slug>` drew the red brand card over its (null) cover. | app/og/[...path]/route.tsx:111-128, lib/og-image.ts:62-66, lib/og-path.ts:10-22 |
| 3 | Autoblog could publish with no cover at all: `attachAutoblogCoverImage` returns `null` when Pexels is off, empty, or the AI fallback is off, and autoblog stores `cover_image_url: image?.cover_image_url ?? null`. | lib/blog-image.ts:105, lib/autoblog-run.ts:538,544-545 |
| 4 | The Pexels search used only the first tag as the query, with no destination, so the ranked selector (lib/photo-score.ts) had less to match photo descriptions against. | lib/autoblog-run.ts:533,538, lib/blog-image.ts:69 |
| 5 | Alt text was Pexels' raw description or the bare keyword (`photo.alt \|\| keyword`): often generic or missing the place. | lib/blog-image.ts:80 |
| 6 | Blog post JSON-LD `image` was `[cover, DEFAULT_OG_IMAGE]`; with no cover it listed only the site-wide beach stock photo, and a site-relative cover would not be absolute. The blog index did the same per post. | app/blog/[slug]/page.tsx:58,106, app/blog/page.tsx:48 |
| 7 | Guide JSON-LD `image` fell back to the same stock photo; destination CollectionPage JSON-LD had no `image` at all. | components/guide-page.tsx:50, app/destinations/[slug]/page.tsx:120-141 |
| 8 | Guide and destination hero `<img>` had no width/height (layout shift), no `fetchPriority` on the LCP image, alt was `hero_alt \|\| name` (empty or "image" passed through), no decoding hint. Past-trip thumbnails had no size or lazy loading. | components/guide-page.tsx:244-255, app/destinations/[slug]/page.tsx:174-185,281, components/guide-header-feature.tsx:50,71-77, lib/guide-header.ts:122 |
| 9 | Blog list and "More stories" cards: no width/height, first row lazy-loaded. | app/blog/page.tsx:76, app/blog/[slug]/page.tsx:217 |
| 10 | No check anywhere for a bad cover (missing, SVG, tiny, wrong-subject alt, repeated, broken) and no admin counter. | (none) |
| 11 | `next/image` is not used because the hero hosts are Pexels (not in `next.config.mjs` remotePatterns, which allow only the Supabase project, travelfunbiz.com and www). Guide heroes already get a Pexels `srcset` (lib/guide-images.ts:20-38). | next.config.mjs:28-43 |
| 12 | OG images for all page families already point at the 1200x630 PNG route (`ogImageEntry`), not the SVGs. The default thumbnail SVGs (public/assets/defaults) are only used for lists and cards. Static pages (who-we-are, packages index, guide index pages) share `DEFAULT_OG_IMAGE`, a JPG (valid, but not page-specific). | lib/post-defaults.ts:11-16, app/blog/[slug]/page.tsx:37, lib/site.ts:122 |

## Changed

1. News: `lib/news-cover.ts` (pure card builder: kind storm / advisory / news, headline, source line). `lib/news-publish.ts` now stores `cover_image_url = <site>/og/news/<slug>` and `alt_text = headline` for drafts and live posts. The OG route draws a teal 1200x630 news card (no photo) for `/og/news/<slug>` and also for `/og/blog/<slug>` when the post is tagged travel-news. `lib/og-image.ts` never uses a rendered card as a photo (no self fetch).
2. Autoblog: the search now includes the grounding package's destination; alt text comes from `coverAlt` (place plus useful photo description, wrong subjects skipped); if no photo is found the post gets its branded card (`/og/blog/<slug>`) so it never publishes with no cover. The manual Pexels search route is unchanged (the card fallback is opt-in).
3. Backfill: `lib/cover-backfill.ts` (pure plan plus runner) and `scripts/backfill-covers.ts` (dry run by default, `--yes` to write, before/after saved to a JSON file). A good cover is never overwritten; guides with no hero are listed, not given a drawn card.
4. Pages: hero images get descriptive alt (`heroAlt`), width and height, `fetchPriority="high"` on the LCP image, `decoding="async"`; cards and thumbnails get sizes and lazy loading; JSON-LD `image` on blog, guide and destination pages is the real cover (absolute) plus the 1200x630 card (`structuredImages`).
5. Quality gate: `lib/image-quality.ts` (`assessCover`, `countWithoutGoodCover`). Counter "Posts without a good cover" on the Posts: Blog header (`countPostsWithoutGoodCover` in `lib/posts-page-summary.ts`).
6. Tests: `scripts/check-images-loop.ts`. Four older checks were updated to the new intended text (guide-header alt, blog-page JSON-LD, related-posts alt, heal-loop cover call).

## Not changed on purpose

- No `next/image` and no change to `next.config.mjs` (Pexels is not an allowed host; adding it would route every hero through Vercel image optimization and its quota). Heroes keep a Pexels `srcset`.
- No call to Pexels, any AI service, or the live database from this branch.
- Social files (shotstack, social captions, visual gate, distribution, carousel route) untouched.

## Dry run

`pnpm dlx tsx scripts/backfill-covers.ts`
