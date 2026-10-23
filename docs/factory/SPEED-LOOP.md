# Speed loop (2026-10-22)

Goal: faster pages, backed by numbers. Slow pages hurt rankings and sign-ups.

## 1. Measurement status (read this first)

**Google PageSpeed Insights could not be used.** The keyless API answered 429 on every call:
"Quota exceeded for quota metric 'Queries' and limit 'Queries per day'" for the shared Google project. A retry
loop with back-off (15 s, 30 s, 45 s and so on) never got a 200. So there are **no PSI scores, no measured LCP,
CLS or TBT** in this report, and none are invented. Everything below is either:

- **MEASURED**: real requests to the live site with curl (HTML size, headers, response time, image bytes), and the real
  `next build` output (first-load JavaScript per route, gzipped).
- **STATIC / ESTIMATED**: read from the page HTML and the source (which element is the LCP candidate, what competes with it).

To get the real PSI table, call the same API with a free Google API key (add `&key=...`) or paste each URL into
pagespeed.web.dev. Joel-side step; a key costs nothing.

## 2. Baseline (before), measured on the live site

| Page | HTML (compressed) | Response time (curl, 1 request) | Cache-Control / Vercel cache | LCP candidate (from the HTML) |
|---|---|---|---|---|
| `/` | 29.9 kB | 3.5 s first hit, then 0.75 to 1.1 s | `private, no-cache, no-store` / MISS | Hero slide 1 (`group-of-mature-adults-enjoying-river-cruise-deck.jpg`, next/image, priority). 9 trip-card photos were also preloaded and competed with it. |
| `/blog` | 21.4 kB | 5.5 s first hit | no-store / MISS | First card, a generated `/og/news/...` PNG (199 kB, 1.1 s to generate on a cache miss), marked high priority |
| `/blog/rhine-vs-croatia-...` | 23.3 kB | 7.5 s first hit | no-store / MISS | Cover photo from Supabase, **942 kB JPEG** (1200x675), shown about 736 px wide |
| `/destinations/tahiti` | 28.2 kB | 0.8 s | no-store / MISS | Guide header photo (Pexels, srcset) or the Tahitian trip-card photo, which was preloaded without being asked |
| `/packages/australia-new-zealand` | 17.4 kB | 0.6 s | no-store / MISS | Hero photo from Supabase (71 kB WebP), no priority, no dimensions |
| `/from/toronto` | 16.7 kB | 0.4 s | no-store / MISS | The H1 heading (text), no hero image |
| `/links` | 6.1 kB | 0.5 to 6.9 s | no-store / MISS | Text, no image |

Notes:
- Response times are single curl requests from one machine, not lab-grade. The shape is what matters: every public
  page is rendered fresh on every visit (`no-store`, never a cache hit). That is because `app/layout.tsx` reads the
  `lang` cookie (`cookies()`), which makes the whole site dynamic. This is the largest remaining speed lever, see section 5.
- Fonts: Inter via `next/font` (self-hosted, `font-display: swap`, 5 weights listed, which made 35 `@font-face` rules for
  7 files). CSS is 15.7 kB compressed. No render-blocking third-party CSS.
- Third-party scripts: Google Analytics already loads only after consent (`components/consent-analytics.tsx`) and
  Vercel Analytics is a small deferred script. No chat widget or GHL form embed on public pages.
- Cache headers for `/og`, `/carousel`, `/social-cover` were already good (`s-maxage` 1 day plus
  `stale-while-revalidate` 7 days). No change.

### First-load JavaScript, baseline (`next build`, Next's own numbers, gzipped)

| Route | Before |
|---|---|
| `/` | 188 kB |
| `/blog` | 178 kB |
| `/blog/[slug]` | 187 kB |
| `/destinations/[slug]` | 187 kB |
| `/packages` | 181 kB |
| `/packages/[slug]` | 189 kB |
| `/from/[city]` | 184 kB |
| `/who-we-are`, `/thank-you` | 178 kB, 180 kB |
| `/links` | 87.7 kB |

Top opportunities (estimated savings; PSI was unavailable, so these come from the HTML and the build):

| Page | Top 5 opportunities |
|---|---|
| All pages | 1. Footer newsletter form (react-hook-form + zod) shipped in every page's JavaScript: about 25 kB gz. 2. Pages are never cached (TTFB 0.4 to 7 s). 3. 35 font-face rules (about 3 kB CSS). 4. Trip-card photos not lazy. 5. Photos served as WebP only (no AVIF). |
| `/` | Nine trip photos preloaded at the same time as the hero photo (LCP competition). |
| `/blog/[slug]`, `/blog` | 942 kB cover JPEG sent to phones; saves about 910 kB per post page. List page loads 12 full-size covers. |
| `/destinations/[slug]` | Related-trip card photos preloaded against the guide photo. |
| `/packages/[slug]` | Hero photo had no `fetchpriority`. |

## 3. What changed

| Change | File | Why |
|---|---|---|
| Blog cover photos now use resized copies (`/_next/image`, 640/828/1080/1200 wide, WebP or AVIF) with a `sizes` hint. Measured on the live optimiser: the Rhine cover is 942 kB original, **11 kB at 640 px, 18 kB at 828, 27 kB at 1080, 33 kB at 1200**. | `lib/post-image-srcset.ts` (new), `app/blog/[slug]/page.tsx`, `app/blog/page.tsx` | Biggest single LCP win on blog pages. Only our own `post-images` bucket is rewritten; `/og/...`, Pexels and other addresses are untouched. `src` is kept as the fallback. |
| Trip cards are lazy by default (`eager` prop for the guide header card). Added `width`/`height`/`decoding`. | `components/package-card.tsx`, `components/guide-header-feature.tsx` | Stops the 9 home-page and the related-trip photos from being preloaded against the main photo. |
| Trip page hero gets `fetchPriority="high"`. Gallery thumbnails, best-time and compare photos are lazy. | `app/packages/[slug]/page.tsx`, `components/trip-gallery.tsx`, `app/best-time-to-visit/[destination]/page.tsx`, `app/compare/[pair]/page.tsx` | LCP photo first; below-the-fold photos later. |
| Footer newsletter form loads when the footer is about to scroll into view (1200 px early), with a placeholder that holds its height. | `components/lazy-newsletter-form.tsx` (new), `components/footer.tsx` | Removes react-hook-form, zod and the resolver from the JavaScript of every page that does not also have the contact form. |
| Inter declared as a variable font (no weight list), `display: "swap"` explicit. | `app/layout.tsx` | 35 `@font-face` rules become 7, same look. |
| `images.formats = ['image/avif', 'image/webp']`. | `next.config.mjs` | Smaller hero photos (the home hero and every `next/image`). |
| Guard script. | `scripts/check-speed-budget.ts` (new) | See section 4. |

Not changed on purpose: copy, consent logic, tracking, layout, JSON-LD content, caching of `/og`, `/carousel`, `/social-cover`.

## 4. Result (after), measured with `next build`

| Route | Before | After | Change |
|---|---|---|---|
| `/blog` | 178 kB | 153 kB | -25 kB |
| `/who-we-are` | 178 kB | 153 kB | -25 kB |
| `/packages` | 181 kB | 157 kB | -24 kB |
| `/thank-you` | 180 kB | 170 kB | -10 kB |
| `/blog/[slug]` | 187 kB | 178 kB | -9 kB |
| `/destinations/[slug]` | 187 kB | 178 kB | -9 kB |
| `/best-time-to-visit/[destination]`, `/compare/[pair]` | 182 kB | 173 kB | -9 kB |
| `/packages/[slug]` | 189 kB | 188 kB | -1 kB |
| `/` | 188 kB | 188 kB | 0 (contact form needs the same libraries) |
| `/from/[city]` | 184 kB | 184 kB | 0 (same reason) |
| `/links` | 87.7 kB | 87.8 kB | 0 |

Expected effect on blog post pages (estimate, not measured by PSI): the LCP photo goes from about 942 kB to about
18 to 33 kB, which on a mid-range phone on 4G is roughly 1 to 2 seconds off LCP. Home page: fewer competing
preloads and AVIF should help LCP by a few hundred milliseconds. A real PSI run is the way to confirm.

`scripts/check-speed-budget.ts` (offline) fails with the file name when:
- the font loses `display: "swap"`, gets a weight list again, or is linked by hand;
- the hero image loses `priority`, or a main photo loses `fetchPriority="high"` or its width/height;
- `PackageCard` stops being lazy by default, or blog covers stop using resized copies;
- the footer, header or layout import the newsletter form, admin code, react-hook-form, zod or recharts;
- a `beforeInteractive` script, a script tag with `src`, or the Google tag outside the consent component appears;
- (when `.next` exists) a public route's gzipped first-load JavaScript, layout included, goes over its budget. Budgets
  are the measured baseline plus 10 percent (for example `/blog` 202 kB, `/` 213 kB, `/links` 140 kB). Since the
  savings above are real, the budgets can be tightened later.

## 5. Next levers (not done, with reasons)

1. **Make pages cacheable.** The root layout reads the `lang` cookie, so every page is rendered per request and Vercel
   never caches it (TTFB 0.4 to 7 s, MISS every time). Fix is to move language and currency out of server rendering
   (client-side switch, or per-language URLs). This changes behaviour, so it needs Joel's call. Expected: the largest
   LCP and TTFB gain on the site.
2. **Lazy-load the contact form** on `/`, `/from/[city]` and `/packages/[slug]` (about 25 kB gz). Skipped because it is the
   conversion element and `/#contact` anchor jumps would need care.
3. **Header language and currency dropdowns** use the Radix Select (about 40 kB gz). Replacing them with native selects
   would change the look.
4. **Generated `/og/news/...` cards as list thumbnails** are 199 kB PNGs; serving them as WebP through the image
   optimiser needs `www.travelfunbiz.ca` added to `remotePatterns`.
5. Run real PSI / CrUX data once a key exists, and record it in this file.

## 6. Risks

- Blog covers now go through Vercel's image optimiser. It counts unique source images against the plan's monthly
  limit; if the limit is hit, resized URLs can fail (the `src` fallback is only used by browsers without srcset
  support). Watch the Vercel "Image Optimization" usage after deploy. The home hero already used the same optimiser.
- AVIF encoding is slower on the first request for each size; later requests are cached.
- The newsletter form placeholder is a fixed 26rem tall; if the real form is a different height there can be a small
  shift low in the footer (far below the fold on normal pages).
- `loading="lazy"` on trip cards means the first row of the home page trips loads a moment later than before
  (browsers still fetch near-viewport lazy images early).
