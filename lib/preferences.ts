import { cookies as nextCookies } from 'next/headers'

export type Language = 'en' | 'fr'
export type Currency = 'usd' | 'cad'

export const LANGUAGE_COOKIE = 'pref-language'
export const CURRENCY_COOKIE = 'pref-currency'
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365 // 1 year

export function isLanguage(value: unknown): value is Language {
  return value === 'en' || value === 'fr'
}

export function isCurrency(value: unknown): value is Currency {
  return value === 'usd' || value === 'cad'
}

function readCookie<T extends string>(key: string, validate: (value: unknown) => value is T, fallback: T): T {
  const store = nextCookies()
  const value = store.get(key)?.value
  return validate(value) ? value : fallback
}

export function getVisitorLanguage(): Language {
  return readCookie(LANGUAGE_COOKIE, isLanguage, 'en')
}

export function getVisitorCurrency(): Currency {
  return readCookie(CURRENCY_COOKIE, isCurrency, 'usd')
}

export function getVisitorPreferences() {
  return {
    language: getVisitorLanguage(),
    currency: getVisitorCurrency(),
  }
}

export function setPreferenceCookie(key: string, value: string) {
  nextCookies().set(key, value, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: COOKIE_MAX_AGE,
  })
}
