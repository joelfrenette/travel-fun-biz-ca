// preferences.ts - read/write visitor language & currency preferences
import { cookies } from 'next/headers'
import type { Currency } from '@/lib/currency'
import { site } from '@/lib/site'
import { isStaticRender } from '@/lib/static-render'

export type Language = 'en' | 'fr' | 'es'

const LANGUAGE_COOKIE = 'lang'
const CURRENCY_COOKIE = 'currency'
const COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: process.env.NODE_ENV === 'production',
  path: '/',
  maxAge: 60 * 60 * 24 * 365,
}

export function normalizeLanguage(value?: string | null): Language {
  if (value === 'fr') return 'fr'
  if (value === 'es') return 'es'
  return 'en'
}

export function normalizeCurrency(value?: string | null): Currency {
  // Accept known currency codes; a first-time visitor gets the site's own currency.
  if (!value) return site.defaultCurrency
  const v = value.toLowerCase()
  if (v === 'cad' || v === 'aud' || v === 'eur' || v === 'usd') return v as Currency
  return site.defaultCurrency
}

export function getVisitorPreferences() {
  // Inside the cacheable default render (the mirror pages, lib/cache-routing.ts) there is no visitor: English and the site's currency, and
  // cookies() is never called, so the page can be cached. See lib/static-render.ts.
  if (isStaticRender()) return { language: 'en' as Language, currency: site.defaultCurrency }
  const cookieStore = cookies()
  const language = normalizeLanguage(cookieStore.get(LANGUAGE_COOKIE)?.value)
  const currency = normalizeCurrency(cookieStore.get(CURRENCY_COOKIE)?.value)
  return { language, currency }
}

export function setVisitorLanguage(language: Language) {
  cookies().set(LANGUAGE_COOKIE, language, COOKIE_OPTIONS)
}

export function setVisitorCurrency(currency: Currency) {
  cookies().set(CURRENCY_COOKIE, currency, COOKIE_OPTIONS)
}