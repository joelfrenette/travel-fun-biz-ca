// preferences.ts - read/write visitor language & currency preferences
import { cookies } from 'next/headers'
import type { Currency } from '@/lib/currency'

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
  // Accept known currency codes and default to 'usd'
  if (!value) return 'usd'
  const v = value.toLowerCase()
  if (v === 'cad' || v === 'aud' || v === 'eur' || v === 'usd') return v as Currency
  return 'usd'
}

export function getVisitorPreferences() {
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