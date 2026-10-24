# Cache loop (2026-10-23)

Goal: make the public pages cacheable at the CDN without breaking French, Spanish or currency choices.

## 1. Audit: what made every page "render per request"

Measured on the live site before this change: every public page answered `Cache-Control: no-store` with a Vercel cache MISS.
First hits took 3.5 to 7.5 s (a warm server 0.4 to 1 s). Googlebot and first-time visitors, who have no cookies, paid it too.

There were **three** causes, not one:

| # | Cause | Where | Effect |
|---|---|---|---|
| 1 | `cookies()` in the root layout (reads `lang` for `<html lang>` and the consent banner) | `app/layout.tsx` | Every route, including ones that never ask for the visitor's language, became per-request. |
| 2 | `cookies()` in `getVisitorPreferences()` (reads `lang` and `currency`) | `lib/preferences.ts`, called by 12 pages and 2 shared components | Same effect, and the text and prices really do depend on the cookie here. |
| 3 | The database client sends `cache: 'no-store'` on every request | `lib/supabase-admin.ts` (used by `lib/packages.ts`, `lib/posts.ts`, `lib/testimonials.ts`, `lib/fx.ts`, `lib/affiliate-rules.ts`, ...) | In Next 14 a `no-store` fetch during render also forces per-request rendering, so removing the cookie reads alone would NOT have been enough. It is deliberate for admin and cron code ("a stale answer wrote seven posts in a day"), so it cannot simply be removed. |

Other reads of request data in public routes (grep of `app/ components/ lib/` for `cookies(`, `headers(`, `searchParams`,
`useSearchParams`, `noStore`, `force-dynamic`, `revalidate`):

| Item | Where | Verdict |
|---|---|---|
| `cookies()` | `app/layout.tsx`, `lib/preferences.ts` (read and write) | Causes 1 and 2. |
| `searchParams` | `app/links/page.tsx` (`?src=`), `app/thank-you/page.tsx` (`?package=`) | Stay per-request on purpose (both are noindex). Listed in `EXCLUDED_ROUTES`. |
| `useSearchParams` | `components/contact-form.tsx` (client, inside `<Suspense>`), `components/package-card.tsx` (comment only), admin pages | Client side only; does not make a page per-request. Side effect noted in section 5. |
| `force-dynamic` | `/og`, `/social-cover`, `/go/*`, `/indexnow-key.txt` | Not pages. Untouched. |
| `revalidate = 300` (600 for `/links`) | 24 public pages | Already declared; it was being defeated by causes 1 to 3. |
| `headers()` | none in public code (`ghl-social.ts` has a local function with that name) | Nothing to do. |

What really needs the visitor's choice: the **language** (all copy, `<html lang>`, the consent banner text), the **currency** (prices
and the USD-to-target rate), and nothing else. Consent state is already client-only (`lib/consent`, localStorage). No visitor ids or
per-visitor data are rendered by any public page.

Public page routes (24 files in `app/`), and what happens to each:

| Route | Verdict |
|---|---|
| `/`, `/blog`, `/blog/[slug]`, `/compare/[pair]`, `/best-time-to-visit/[destination]`, `/from/[city]`, `/packages`, `/packages/[slug]`, `/who-we-are`, `/destinations`, `/destinations/[slug]`, `/cruise-lines`, `/cruise-lines/[slug]`, `/hotels`, `/hotels/[slug]`, `/resorts`, `/resorts/[slug]`, `/river-cruises`, `/river-cruises/[slug]`, `/ships`, `/ships/[slug]`, `/yachts`, `/yachts/[slug]` | **Cacheable** for visitors with no language / currency choice (23 mirror pages). |
| `/links`, `/thank-you` | Excluded: they read the query string. |
| `/submit-trip/[token]` | Excluded: private agent link. |

## 2. Design choice

Candidates, as asked:

- **(C) `Vary: Cookie` / cookie in the cache key.** Rejected. I cannot confirm from memory that the Vercel CDN honours `Vary: Cookie`
  (it is documented to ignore most `Vary` values for its own cache key), and a wrong-language cache hit is unacceptable.
- **(B) Client-side language and currency.** Rejected. It turns every text and price into a client render (worse SEO and a flash),
  and touches every component.
- **(A) Two copies of each page, chosen by middleware.** Chosen, in this form:
  - The pages at their real addresses are **unchanged**. They keep reading cookies. A visitor with a language or currency choice
    is served by them exactly as today.
  - `app/x-cache/...` holds a **mirror** of each cacheable page: a 12-line stub that imports the real page and renders it inside
    `runStatic()` (`lib/static-render.ts`). Inside `runStatic()`, `getVisitorPreferences()` returns English and the site's own
    currency without calling `cookies()`, and the database client reads through Next's data cache for 300 s (the same freshness
    as the pages' existing `revalidate = 300`). Outside it, nothing changes (admin, cron and API still read live).
  - `middleware.ts` rewrites a request to the mirror only when it is a GET/HEAD of a mirrored public path and has **no** lang or
    currency cookie (or a cookie whose value equals the default: `lang=en`, `currency=cad`). The address in the browser, the
    canonical URL, hreflang, sitemap and every link stay the real address.
  - **Kill switch**: env `CACHE_PUBLIC_PAGES=off` (default on). Then nothing is rewritten and the site is rendered as before.

Why not the first idea of moving the real pages into a route group with a second root layout: eight check scripts read
`app/**/page.tsx` by path, and moving the admin tree would be a very large diff for no benefit. The mirror approach adds
files and changes about 8, and the real pages are not touched.

Two details that matter:

1. **Root layout.** It can no longer read the cookie (cause 1), so `<html lang>` is always `en` in the HTML. `components/locale-effects.tsx`
   (drawn by the footer, which every public page has) sets `<html lang>` to `fr`/`es` right after load and draws the consent banner
   in the page's language. Search engines never send the cookie, so they see exactly what they saw before (English). Only the raw
   HTML `lang` attribute for French and Spanish visitors differs from before, and only until the page loads.
2. **Language and currency switchers** now do a full page reload after setting the cookie (`window.location.reload()` instead of
   `router.refresh()`), because the page now comes from a different copy once the cookie exists and a soft refresh cannot swap them.

## 3. What a request gets

| Request | Served by | Cache |
|---|---|---|
| Anonymous (no cookie, or `lang=en` / `currency=cad`), public page | `/x-cache/<path>` (English, CAD) | CDN + ISR, `revalidate = 300`, stale-while-revalidate |
| Any other `lang` or `currency` value | the real page, reads the cookie | per request, as before |
| Admin, API, `/links`, `/thank-you`, assets, `/og`, `/go`, sitemap, robots | untouched (middleware does not run, or passes through) | as before |
| Direct visit to `/x-cache/...` | 308 redirect to the real address | none |
| Kill switch off | nothing is rewritten | as before |

## 4. Files

- New: `middleware.ts`, `lib/cache-routing.ts` (pure decision function and route lists), `lib/static-render.ts`,
  `components/locale-effects.tsx`, 23 stubs under `app/x-cache/`, `scripts/check-cache-loop.ts`, this document.
- Changed: `app/layout.tsx` (no cookies), `components/footer.tsx`, `components/language-toggle.tsx`,
  `components/currency-toggle.tsx`, `lib/preferences.ts`, `lib/supabase-admin.ts`, `app/links/page.tsx` (draws its own banner), `.env.example`.

## 5. Known differences and risks

- **Contact form in the cached HTML.** `components/contact-form.tsx` uses `useSearchParams` inside `<Suspense fallback={null}>`. In a cached page that block
  is filled in by the browser after load instead of being in the HTML. Same form, same behaviour; it just appears a moment later.
- **Consent banner on admin and the agent submit-trip page** is no longer drawn (it came from the root layout). Neither has tracking
  without consent, and `/links` now draws its own.
- **Build now reads the database** for the no-parameter mirror pages (home, blog list, packages list, guide indexes, who-we-are).
  Vercel's build has the keys. If a read fails the page renders with whatever the code already falls back to, and is refreshed on the
  first request after 300 s.
- **Publishing delay**: a newly published post or trip can take up to 5 minutes to appear for anonymous visitors (it is the delay the
  pages already declared, now actually in effect). Cookie visitors still see changes at once.
- **Cache key correctness**: the cached copy lives at `/x-cache/...`, a different path from the cookie copy, so a French or USD visitor can
  never be handed the English copy.

**generateMetadata rule (2026-10-24).** `generateMetadata` runs outside the page render's async context, so a bare re-export reads the database
`no-store` and Next answers HTTP 500 ("Page changed from static to dynamic at runtime"). Every mirror stub whose real page has
`generateMetadata` must wrap it: `export function generateMetadata(...args: Parameters<typeof realGenerateMetadata>) { return runStatic(() => realGenerateMetadata(...args)) }`.
`scripts/check-cache-loop.ts` enforces this for every mirror. Pages with a static `metadata` const are re-exported as is.

## 6. Live checks after deploy

After a deploy run `pnpm dlx tsx scripts/sweep-cookieless.ts` (every sitemap URL, no cookies, prints non-200s). New pages are also checked
automatically by `lib/publish-verify.ts`.

See the report that accompanies this change (curl commands for en, fr and es, and the cache headers).
