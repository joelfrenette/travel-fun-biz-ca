# Staging loop log

One entry per improvement committed on branch `staging` by the unattended loop. Nothing here is on main until Joel pushes it.

## Blog post CTA, freshness and cover image hints

- What changed (`app/blog/[slug]/page.tsx`): the compact `GuideCta` now sits right under the key-takeaways box; the end block shows the full `GuideCta` when no package is related (package cards stay when packages exist). The CTA names the linked package destination, else the post primary keyword, else the title. The phone comes only from `site.phone` through the component. Publish date is wrapped in `<time dateTime>`, and "Updated <date>" shows only when `updated_at` is more than one day after `publish_date`. JSON-LD is now `BlogPosting` with author and publisher `url`, `image` as `[cover, DEFAULT_OG_IMAGE]`, `about` (primary keyword) and `isPartOf` (Blog, /blog). The cover image has `width=1200 height=675 fetchPriority="high" decoding="async"`.
- Why it helps traffic: a call to action above the fold and at the end turns blog readers into enquiries and calls; the Updated date and `<time>` give search and AI engines a freshness signal; BlogPosting, `about` and `isPartOf` give clearer entity data; the sized, high-priority cover image improves layout stability and LCP.
- Offline check: `pnpm dlx tsx scripts/check-blog-page.ts` (18 checks, reads file text only).
- How to UAT on the staging preview: open any blog post. Check the compact "Call or text our AI agent" line under the key takeaways. On a post with no related package, check the full "Thinking about ...?" box at the end. On an edited post (updated more than a day after publishing) check "Updated <date>" beside the date. View source and look for `"@type":"BlogPosting"` and the cover image `fetchpriority="high"`.

## Guides block on trip (package) pages

- What changed (`app/packages/[slug]/page.tsx`): `listGuidesForPackage({ id, destination })` from `lib/guides.ts` joins the existing `Promise.all`, and a "Guides for this trip" aside lists up to 4 published guides (destination guide first, then guides that list this trip, then guides under the destination), same markup and `guidePath()` / `guideKinds[kind].guideLabel` labels as the blog post block. Nothing renders when the list is empty. Stored data only, no new query shape, no AI. `scripts/check-guide-pages.ts` no longer lists the trip page as a forbidden file, since this change is the intended edit.
- Why it helps traffic: trip pages now link to the destination and property guides, so guide pages get an internal link back from the pages that convert, fixing orphan guides and passing relevance to both sides.
- Offline check: `pnpm dlx tsx scripts/check-package-guides.ts` (pure ordering on fixtures plus file text).
- How to UAT on the staging preview: open a trip whose destination has a published guide. Check the "Guides for this trip" box with the destination guide first and working links. Open a trip with no matching guide and check no empty box shows.

## Destination page parity with guide pages, visible freshness, richer Article schema

- What changed: `RelatedGuidesSection` and `BlogStoriesSection` moved into `components/guide-parts.tsx` (plain props, no data imports, so the admin preview stays client safe) and are used by both `components/guide-page.tsx` and `app/destinations/[slug]/page.tsx`. On a destination with a guide, the page now loads `listPostsForGuide(guide, 3)` and `pickRelatedGuides(guide, allGuides, 6)`, shows both sections, and puts a compact `GuideCta` under the header summary. Both pages show `<time dateTime=updated_at>Updated <date></time>` under the H1 using the new pure `formatDate` in `lib/site.ts` (null for empty or bad input, so the line is simply left out). Guide Article JSON-LD now uses one shared Organization (name, url, logo) for author and publisher and adds `datePublished` from `created_at`; the destination branch gets `dateModified` from `updated_at`. Dates come only from stored columns, never `new Date()`. `scripts/check-guide-pages.ts` no longer lists `lib/site.ts` as forbidden, since this is the intended additive edit.
- Why it helps traffic: destination pages are the strongest entry pages, and now they link out to related guides and blog posts like every other guide (more crawl paths and internal links), convert with an above-the-fold CTA, and send clear freshness and publisher signals to Google and AI answer engines.
- Offline check: `pnpm dlx tsx scripts/check-guide-parity.ts` (source text plus pure helpers).
- How to UAT on the staging preview: open a destination that has a guide. Check "Updated <date>" under the heading, the compact "Call or text our AI agent" line under the summary, and the "Related guides" and "From the blog" blocks near the bottom of the guide. Open any hotel or resort guide and check the same date line. View source and look for `datePublished` and the Organization `url` and `logo` in the Article JSON-LD.

## Hook + CTA fallback captions on every default send path

- What changed: new pure `buildFallbackCaption(facts, network, link, opts)` in `lib/social-captions.ts`. Line 1 is the first stored FAQ question (else the first key takeaway), line 2 one short line from the meta description, line 3 a fixed "Read the full guide:" line, then the link, then 0 to 3 hashtags from stored tags/category (new `normaliseHashtags`, `hashtagCapFor`, `HASHTAG_CAPS` in `lib/hook-styles.ts`). It runs through `captionProblems` and returns null on any problem, so callers keep today's title + description text. Used for the shared photo/text caption in `lib/distribution.ts` and the carousel caption in `lib/autopilot.ts`; guides now expose `faqQuestions` and `keyTakeaways` from `lib/guide-post-source.ts`. Video script hashtags pass through `normaliseHashtags`. Instagram and TikTok keep today's link behaviour. No UTM change, no new network call.
- Why it helps traffic: when the AI caption step is off or fails, posts used to open with the plain title. Now they open with a real question from the post, which stops the scroll, and end with a clear call to action and the link, with clean capped hashtags.
- Offline check: `pnpm dlx tsx scripts/check-fallback-caption.ts`.
- How to UAT on staging: with tailored captions off, let one blog post and one guide go out (or read the queued caption). Check line 1 is a question from the post's FAQ, then one description line, "Read the full guide:", the link, then up to 3 hashtags. Check a post with no FAQ and no takeaways still sends the old title + description text.

## Related posts block on blog posts

- What changed: new pure `pickRelatedPosts(post, allPublished, limit=3)` in `lib/posts.ts`. Score is 2 per shared tag, 3 for the same linked package, 1 per shared primary-keyword word of 4+ letters. Self and unpublished are skipped, ties go to the newest publish_date, and it returns an empty list when nothing scores (never padded). `app/blog/[slug]/page.tsx` adds `getPublishedPosts()` to the existing `Promise.all` and renders a "More stories" aside after the FAQ (title link to /blog/<slug>, lazy cover thumbnail with alt text, one-line stored meta description). Nothing renders when the list is empty. Stored data only, no AI. The posts table has no separate excerpt column, so the stored meta_description is the one-line excerpt.
- Why it helps traffic: blog posts now link to each other, which adds crawl paths, spreads link value to newer posts and keeps readers on the site longer.
- Offline check: `pnpm dlx tsx scripts/check-related-posts.ts`.
- How to UAT on the staging preview: open a post that shares a tag or linked trip with another post. Check "More stories" under the FAQ with up to 3 cards and working links. Open a post that shares nothing and check no empty box shows.

## Guide and destination schema (speakable, WebPage entity) plus enquiry CTA prefill

- What changed: the key-takeaways aside now has `id="key-takeaways"`. `guideJsonLd` adds `inLanguage` (from SITE_LOCALE), `isPartOf` (the WebSite) and a `speakable` SpeakableSpecification that lists `#key-takeaways` and `#guide-faq` only when that content exists. A destination guide now emits a `WebPage` (url, name, description, stored dates, publisher, inLanguage) whose `mainEntity` is the `TouristDestination` (name, description, image, url); `dateModified` moved up to the WebPage. When a guide exists, the destination CollectionPage `about` and `isPartOf` point at the guide URL so there is one primary entity. `GuideCta` takes an optional `packageName`; links go to `/?package=<name>#contact` (fallback `Custom Package`) through the new pure `enquiryHref` in `lib/guide-facts.ts`. Guide pages pass the first related trip, destination pages the first upcoming trip. Phone still comes from site.phone.
- Why it helps traffic: speakable and a clear WebPage/entity split help Google and AI answer engines pick the direct-answer blocks and cite the right entity. The prefilled enquiry form removes a step for the visitor, which lifts conversions from guide traffic.
- Offline check: `pnpm dlx tsx scripts/check-guide-schema.ts`.
- How to UAT on the staging preview: open a destination guide, view source, and find `"@type":"WebPage"` with a `TouristDestination` mainEntity and a `speakable` block. Click "Ask us about your trip" on a guide with a related trip and check the contact form opens with that trip chosen; on a blog post with no trip it should show Custom Package.

## Instagram/TikTok link-in-bio CTA wording

- What changed: new pure `fallbackCtaFor(networks)` in `lib/social-captions.ts`. When every target network is Instagram or TikTok (links are not tappable there), the fallback caption ends with the fixed line "Full guide: link in our bio." and leaves the raw URL out. Any clickable network in the list (Facebook, X, LinkedIn and so on) keeps "Read the full guide:" plus the UTM link. `buildFallbackCaption` takes a new `networks` option, and `lib/distribution.ts` and `lib/autopilot.ts` pass their target list so a mixed shared caption keeps the link. No new fact, number or claim.
- Why it helps traffic: a pasted URL on Instagram and TikTok cannot be tapped and wastes caption space. Telling people to use the bio link sends them to the one place that works.
- Offline check: `pnpm dlx tsx scripts/check-fallback-caption.ts`.
- How to UAT on staging: queue a post to Instagram only and read the caption: it ends with "Full guide: link in our bio." and has no http link. Queue Instagram plus Facebook and check the caption still has the link. Check the bio link of the account points to the site.

## Honest sitemap lastModified

- What changed: new pure helpers in `lib/sitemap-dates.ts` (`maxIso`, `lastModOrUndefined`, `lastModField`). `app/sitemap.ts` no longer uses `new Date()` anywhere. Destination, best-time and compare entries take the stored `updated_at` of the matching destination guide (compare uses the newer of its two); index pages (destinations, each guide kind, packages, blog) use the max stored timestamp of their items. Where no stored timestamp exists the field is omitted. No new queries.
- Why it helps traffic: a lastmod that changes on every request teaches Google to ignore it. Honest dates let crawlers re-fetch pages that really changed, so fresh guides get re-indexed sooner.
- Offline check: `pnpm dlx tsx scripts/check-sitemap-lastmod.ts`.
- How to UAT on staging: open /sitemap.xml. A destination with a published guide shows a lastmod equal to that guide's updated date; home and who-we-are show no lastmod; reload and confirm dates do not change to the current time.
