# Staging loop report

Branch: `staging`. Three rounds, 12 commits (41273a8 to 80f7ef5), all QA passed. Details per change are in `docs/factory/STAGING-LOOP-LOG.md`.

## What each round changed

Round 1 (blog and trip pages)
- 41273a8 Blog post: compact and full guide CTA, visible "Updated" date, richer BlogPosting schema, sized cover image.
- a62ac72 Trip pages: "Guides for this trip" block linking to destination and trip guides.
- e63f583 Destination pages: same related guides, stories, CTA and Updated date as guide pages, richer Article schema.
- 8f0bd49 Social: fallback captions open with a real FAQ question, then one description line, a call to action, the link and up to 3 hashtags.

Round 2 (links, schema, captions)
- fc03a9f Blog: "More stories" related posts block.
- b125c97 Guides and destinations: speakable, WebPage entity, key takeaways anchor, trip-prefilled enquiry link.
- 8d55b56 Instagram and TikTok captions say "link in our bio" and drop the dead URL.
- 2c96711 Sitemap: honest lastmod from stored dates only.

Round 3 (distribution and conversion)
- de36dc5 One caption per network, each at its own length limit with its own UTM source.
- 9a1a66f Destination page: H1 matches the guide title, guide content above the trip grid.
- 01d2ecd Guide CTA on best-time, compare and guide index pages.
- 80f7ef5 Reel scripts use stored key takeaways and FAQ answers.

## Expected effect

- More organic traffic: more internal links in both directions (trips, destinations, guides, blog), cleaner schema for Google and AI answer engines, honest freshness dates, and a title-matching H1 with answers at the top of destination pages.
- More conversions: a call or enquiry box on every guide-type page, with the enquiry form preselecting the trip.
- More social traffic: stronger hooks, correct bio-link wording, longer captions on LinkedIn and Facebook, per-network UTM tags so each visit is credited to the right network, and more concrete reel hooks.

## UAT steps for Joel (staging preview)

1. Open a blog post. Look for a box under the key takeaways with the call line, a date saying "Updated", and a "More stories" section after the FAQ. Open a post that shares nothing with others: no empty box should show.
2. Open a trip page. Look for "Guides for this trip".
3. Open a destination that has a guide. The big title should read "Place: Travel Guide". Key takeaways and the article come first, trip cards after. View source and search for `speakable` and `WebPage`.
4. Open a best-time page, a compare page, and /destinations or /cruises. Each should end with a "Thinking about...?" box. Click "Ask us about your trip": the form should open with the trip chosen (Custom Package if none).
5. Open /sitemap.xml. Home and who-we-are show no date. Reload and check dates do not change to now.
6. In the admin, with tailored captions off, look at a queued post caption. Line 1 is a question from the post. Instagram-only captions say "Full guide: link in our bio." with no link. LinkedIn and Facebook captions can be longer than X.
7. Check the CTA phone shows (833) 878-5386 everywhere.
8. Generate a reel for a post with key takeaways: the hook should reuse real details from the post.

## Migrations required before merging

None. `git diff main..staging` touches no migration files. The newest on staging is `0043_content_edits_status.sql`, already part of main.

## Known risks (all MINOR, from final QA)

- Upload-Post sends can now be several calls per post (one per group of networks with the same limit, hashtag cap and link type). Spend per post rises slightly, bounded by network count.
- Twitter and x share one send group, so both use the first network's UTM tag. Attribution is slightly blurry.
- A destination with no guide and no page now reads "Place Trips" instead of "Place: Travel Guide". Probably unreachable.
- Two older check scripts had stale guards updated (check-guide-pages, check-guide-parity) to match intended changes. The phone constant in `lib/site.ts` was not touched.
- Nothing was tested in a live browser, with real data, or against live social APIs. All verification was offline.

## Next loop round should target

- Per-run cap or note on Upload-Post groups.
- A real browser pass on staging (rendered schema validation, Rich Results Test, mobile layout of the new CTA boxes).
- Destination and blog hubs: category and tag pages with internal links, plus links from blog posts to the matching destination guide.
- Social formats: carousel and reel hook/CTA wording per network, image size audit per network, UTM content tag for carousel versus reel.
- Freshness: use stored update dates to queue stale guides for refresh through the existing heal loop.
- Measure: once on main, compare GA4 visits per network by the new UTM sources.

## Final verification (this run)

- tsc: pass (0 errors).
- scripts/check-*.ts: 29 run, 0 failed.
