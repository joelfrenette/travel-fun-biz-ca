import { NextResponse } from 'next/server'
import { validateToken } from '@/lib/admin-auth'
import { getCreditBalance, listKeywords, lookupKeywords, normalizeKeywords } from '@/lib/keywords'

function isAuthorized(request: Request): boolean {
  const token = request.headers.get('authorization')?.replace('Bearer ', '') || ''
  return !!validateToken(token)
}

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
    const result = await lookupKeywords(keywords, country, body.force === true)
    return NextResponse.json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Server error'
    const status = /not set|rejected|out of credits/i.test(message) ? 400 : 500
    return NextResponse.json({ error: message }, { status })
  }
}
