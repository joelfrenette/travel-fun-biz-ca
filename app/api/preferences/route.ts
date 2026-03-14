import { NextResponse } from 'next/server'
import { CURRENCY_COOKIE, LANGUAGE_COOKIE, isCurrency, isLanguage, setPreferenceCookie } from '@/lib/preferences'

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}))
    const { language, currency } = body as { language?: unknown; currency?: unknown }

    if (!language && !currency) {
      return NextResponse.json({ error: 'No preferences provided' }, { status: 400 })
    }

    if (language) {
      if (!isLanguage(language)) {
        return NextResponse.json({ error: 'Invalid language' }, { status: 400 })
      }
      setPreferenceCookie(LANGUAGE_COOKIE, language)
    }

    if (currency) {
      if (!isCurrency(currency)) {
        return NextResponse.json({ error: 'Invalid currency' }, { status: 400 })
      }
      setPreferenceCookie(CURRENCY_COOKIE, currency)
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('[preferences] Failed to update visitor preferences', error)
    return NextResponse.json({ error: 'Unable to save preferences' }, { status: 500 })
  }
}
