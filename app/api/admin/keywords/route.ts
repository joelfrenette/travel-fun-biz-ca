import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getCreditBalance, listKeywords, lookupKeywords, normalizeKeywords, trackKeyword } from '@/lib/keywords'

export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const [keywords, credits] = await Promise.all([listKeywords(), process.env.KEYWORD_DATA_API_KEY ? getCreditBalance() : null])
    return NextResponse.json({ keywords, credits, configured: !!process.env.KEYWORD_DATA_API_KEY })
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
    // track_only: add to the list without spending credits (used by the Search Console discovery panel).
    if (body.track_only === true) {
      const rows = []
      for (const kw of keywords) rows.push(await trackKeyword(kw, country))
      return NextResponse.json({ rows, requested: keywords.length, fetched: 0, cached: 0, creditsConsumed: 0, credits: null })
    }
    const result = await lookupKeywords(keywords, country, body.force === true)
    return NextResponse.json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Server error'
    const status = /not set|rejected|out of credits/i.test(message) ? 400 : 500
    return NextResponse.json({ error: message }, { status })
  }
}
