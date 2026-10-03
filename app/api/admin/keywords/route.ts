import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getAccountBalance, isKeywordDataConfigured, listKeywords, lookupKeywords, normalizeKeywords, trackKeyword } from '@/lib/keywords'

export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const [keywords, balanceUsd] = await Promise.all([listKeywords(), isKeywordDataConfigured() ? getAccountBalance() : null])
    return NextResponse.json({ keywords, balanceUsd, configured: isKeywordDataConfigured() })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const body = await request.json()
    const keywords = normalizeKeywords(body.keywords ?? '')
    if (keywords.length === 0) return NextResponse.json({ error: 'Enter at least one keyword' }, { status: 400 })
    if (keywords.length > 500) return NextResponse.json({ error: 'At most 500 keywords per lookup' }, { status: 400 })
    const country = body.country === 'us' ? 'us' : 'ca'
    // track_only: add to the list without spending anything (used by the Search Console discovery panel).
    if (body.track_only === true) {
      const rows = []
      for (const kw of keywords) rows.push(await trackKeyword(kw, country))
      return NextResponse.json({ rows, requested: keywords.length, fetched: 0, cached: 0, costUsd: 0, balanceUsd: null })
    }
    const result = await lookupKeywords(keywords, country, body.force === true)
    return NextResponse.json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Server error'
    const status = /not set|rejected|insufficient balance/i.test(message) ? 400 : 500
    return NextResponse.json({ error: message }, { status })
  }
}
