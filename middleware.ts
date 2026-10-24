import { NextResponse, type NextRequest } from 'next/server'
import { decideRoute, isCachingEnabled } from '@/lib/cache-routing'
import { site } from '@/lib/site'

// Sends visitors with no language / currency choice to the cacheable copy of a public page (app/x-cache/).
// All the logic is in lib/cache-routing.ts (pure, tested by scripts/check-cache-loop.ts). Kill switch: set the
// env var CACHE_PUBLIC_PAGES=off on Vercel (or change isCachingEnabled's default) and no request is rewritten.
export function middleware(request: NextRequest) {
  const decision = decideRoute({
    enabled: isCachingEnabled(),
    method: request.method,
    pathname: request.nextUrl.pathname,
    langCookie: request.cookies.get('lang')?.value,
    currencyCookie: request.cookies.get('currency')?.value,
    previewCookie: request.cookies.has('__prerender_bypass') || request.cookies.has('__next_preview_data'),
    defaultCurrency: site.defaultCurrency,
  })

  if (decision.action === 'rewrite') {
    const url = request.nextUrl.clone()
    url.pathname = decision.to
    return NextResponse.rewrite(url)
  }
  if (decision.action === 'redirect') {
    const url = request.nextUrl.clone()
    url.pathname = decision.to
    return NextResponse.redirect(url, 308)
  }
  return NextResponse.next()
}

// Only the public page paths (plus the mirror folder, to keep it private). Admin, API, assets, images and every
// route handler never reach this function. Extra paths that match here but have no mirror (a file extension such as
// /blog/rss.xml, a deeper path) are passed straight through by decideRoute.
export const config = {
  matcher: [
    '/',
    '/x-cache/:path*', // = MIRROR_PREFIX (Next needs literal strings here; scripts/check-cache-loop.ts keeps them in step)
    '/blog/:path*',
    '/compare/:path*',
    '/best-time-to-visit/:path*',
    '/from/:path*',
    '/packages/:path*',
    '/who-we-are',
    '/destinations/:path*',
    '/cruise-lines/:path*',
    '/hotels/:path*',
    '/resorts/:path*',
    '/river-cruises/:path*',
    '/ships/:path*',
    '/yachts/:path*',
  ],
}
