import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

const SUPPORTED_LOCALES = ['en', 'fr', 'es']
const DEFAULT_LOCALE = 'en'
const LANG_COOKIE = 'lang'

function getLocaleFromAcceptLanguage(header?: string | null) {
  if (!header) return DEFAULT_LOCALE
  const parts = header.split(',').map((p) => p.trim())
  for (const part of parts) {
    if (part.startsWith('es')) return 'es'
    if (part.startsWith('fr')) return 'fr'
    if (part.startsWith('en')) return 'en'
  }
  return DEFAULT_LOCALE
}

export function middleware(request: NextRequest) {
  const { nextUrl, headers, cookies } = request
  const pathname = nextUrl.pathname

  // Skip API, _next, static assets, and image routes
  if (
    pathname.startsWith('/api') ||
    pathname.startsWith('/_next') ||
    pathname.startsWith('/static') ||
    pathname.startsWith('/favicon') ||
    pathname.includes('.')
  ) {
    return NextResponse.next()
  }

  // If URL already contains a supported locale prefix, ensure cookie matches and continue
  const pathMatch = pathname.match(/^\/(en|fr|es)(?:\/|$)/i)
  if (pathMatch) {
    const locale = pathMatch[1].toLowerCase()
    const res = NextResponse.next()
    // set cookie so server components can read it consistently
    res.cookies.set(LANG_COOKIE, locale, { path: '/', maxAge: 60 * 60 * 24 * 365 })
    return res
  }

  // Determine locale: cookie -> Accept-Language -> default
  const cookieLocale = cookies.get(LANG_COOKIE)?.value
  const acceptLocale = getLocaleFromAcceptLanguage(headers.get('accept-language'))
  const locale = cookieLocale && SUPPORTED_LOCALES.includes(cookieLocale) ? cookieLocale : acceptLocale

  // Redirect to locale-prefixed path
  const destination = new URL(`/${locale}${pathname}`, request.url)
  destination.search = nextUrl.search
  const res = NextResponse.redirect(destination)
  res.cookies.set(LANG_COOKIE, locale, { path: '/', maxAge: 60 * 60 * 24 * 365 })
  return res
}

export const config = {
  matcher: ['/((?!api|_next|static|favicon.ico).*)'],
}
