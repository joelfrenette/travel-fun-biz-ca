// cache-routing.ts - decides which copy of a public page a request gets. Pure: no Next imports, so middleware.ts
// and scripts/check-cache-loop.ts share exactly the same code.
//
// The problem: every public page read the visitor's lang / currency cookie, so every request rendered fresh and
// nothing could sit in the CDN (first hits 3.5 to 7.5 seconds, Googlebot included).
//
// The design (docs/factory/CACHE-LOOP.md):
//   - The pages at their real addresses are untouched. They keep reading the cookies. A visitor who has chosen a
//     language or a currency gets them, exactly as before.
//   - app/x-cache/ holds a mirror of each cacheable page (one small file each, same page code, run through
//     runStatic() from lib/static-render.ts so it uses English and the site's currency and never reads a cookie).
//     These are ordinary cacheable pages (build-time or on-demand ISR, 5 minutes).
//   - middleware.ts sends a request with NO language / currency choice to the mirror (a rewrite: the address in the
//     browser, the canonical URL, the sitemap and every link stay the real address).
//   - CACHE_PUBLIC_PAGES=off (kill switch) stops the rewriting; the site is then exactly as it was.

/** The mirror folder. Never appears in a canonical, sitemap, robots rule, hreflang or link (scripts/check-cache-loop.ts). */
export const MIRROR_PREFIX = '/x-cache'

/** Kill switch. ON unless the env var CACHE_PUBLIC_PAGES is set to off / false / 0 / no. */
export function isCachingEnabled(envValue: string | undefined = process.env.CACHE_PUBLIC_PAGES): boolean {
  const v = (envValue ?? '').trim().toLowerCase()
  return !(v === 'off' || v === 'false' || v === '0' || v === 'no')
}

/** Guide pages: an index and one page per slug. */
export const GUIDE_KINDS = ['destinations', 'cruise-lines', 'hotels', 'resorts', 'river-cruises', 'ships', 'yachts'] as const

/** Public routes that have a mirror: [route folder under app/, matching path regex]. One entry per mirror page.tsx. */
export const MIRRORED_ROUTES: ReadonlyArray<{ folder: string; pattern: RegExp }> = [
  { folder: '', pattern: /^\/$/ },
  { folder: 'blog', pattern: /^\/blog$/ },
  { folder: 'blog/[slug]', pattern: /^\/blog\/[^/.]+$/ },
  { folder: 'compare/[pair]', pattern: /^\/compare\/[^/.]+$/ },
  { folder: 'best-time-to-visit/[destination]', pattern: /^\/best-time-to-visit\/[^/.]+$/ },
  { folder: 'from/[city]', pattern: /^\/from\/[^/.]+$/ },
  { folder: 'packages', pattern: /^\/packages$/ },
  { folder: 'who-we-are', pattern: /^\/who-we-are$/ },
  ...GUIDE_KINDS.flatMap((kind) => [
    { folder: kind, pattern: new RegExp(`^\\/${kind}$`) },
    { folder: `${kind}/[slug]`, pattern: new RegExp(`^\\/${kind}\\/[^/.]+$`) },
  ]),
]

/** Public page routes that deliberately have NO mirror, with the reason. Everything else under app/ that is a public page must be listed in one of the two lists. */
export const EXCLUDED_ROUTES: ReadonlyArray<{ folder: string; reason: string }> = [
  { folder: 'links', reason: 'reads ?src= (searchParams), so it is per-request by design; noindex bio page' },
  { folder: 'thank-you', reason: 'reads ?package= (searchParams), noindex confirmation page' },
  { folder: 'submit-trip/[token]', reason: 'private agent link, token in the path' },
  { folder: 'packages/[slug]', reason: 'two trip pages returned 500 to cookieless requests through the mirror on 2026-10-24 (fine with a cookie); served unmirrored until the cause is found' },
  { folder: 'recap/[token]', reason: 'private one-trip recap link for an agent or traveller, token in the path, noindex' },
]

export type RouteDecision =
  | { action: 'pass' }
  | { action: 'rewrite'; to: string }
  | { action: 'redirect'; to: string }

export interface DecisionInput {
  enabled: boolean
  method: string
  /** Path only (no query), as the browser asked for it. */
  pathname: string
  /** Value of the lang cookie, or undefined if the request has none. */
  langCookie: string | undefined
  /** Value of the currency cookie, or undefined if the request has none. */
  currencyCookie: string | undefined
  /** True when Next's draft / preview cookie is present. */
  previewCookie?: boolean
  /** The site's own currency (lib/site.ts), lower case. */
  defaultCurrency: string
}

/** True when the cookie's value is the same thing a visitor with no cookie would get. Anything else is "a real choice". */
export function langIsDefault(v: string | undefined): boolean {
  return v === undefined || v === 'en'
}
export function currencyIsDefault(v: string | undefined, defaultCurrency: string): boolean {
  return v === undefined || v.toLowerCase() === defaultCurrency.toLowerCase()
}

export function isMirroredPath(pathname: string): boolean {
  const p = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname
  return MIRRORED_ROUTES.some((r) => r.pattern.test(p))
}

/** Which copy of the page does this request get? The only function middleware.ts calls. */
export function decideRoute(input: DecisionInput): RouteDecision {
  const path = input.pathname.length > 1 && input.pathname.endsWith('/') ? input.pathname.slice(0, -1) : input.pathname

  // The mirror folder is internal. A direct visit goes to the real address, so it is never indexed or shared.
  if (path === MIRROR_PREFIX || path.startsWith(`${MIRROR_PREFIX}/`)) {
    const rest = path.slice(MIRROR_PREFIX.length) || '/'
    return { action: 'redirect', to: rest }
  }

  if (!input.enabled) return { action: 'pass' }
  const method = input.method.toUpperCase()
  if (method !== 'GET' && method !== 'HEAD') return { action: 'pass' }
  if (input.previewCookie) return { action: 'pass' }
  if (!isMirroredPath(path)) return { action: 'pass' }
  if (!langIsDefault(input.langCookie) || !currencyIsDefault(input.currencyCookie, input.defaultCurrency)) return { action: 'pass' }

  return { action: 'rewrite', to: path === '/' ? MIRROR_PREFIX : `${MIRROR_PREFIX}${path}` }
}
