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
