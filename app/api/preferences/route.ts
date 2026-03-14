import { NextResponse } from 'next/server'
import { normalizeCurrency, normalizeLanguage, setVisitorCurrency, setVisitorLanguage } from '@/lib/preferences'

export async function POST(request: Request) {
  try {
    const body = await request.json()
    if (body.language) {
      setVisitorLanguage(normalizeLanguage(body.language))
    }
    if (body.currency) {
      setVisitorCurrency(normalizeCurrency(body.currency))
    }
    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('[preferences] Failed to update preferences', error)
    return NextResponse.json({ error: 'Unable to update preferences' }, { status: 400 })
  }
}
