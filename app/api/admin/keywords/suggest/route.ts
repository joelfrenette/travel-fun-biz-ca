import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { suggestKeywords, saveSuggestedKeyword, type KeywordSuggestion } from '@/lib/keywords'

// POST { seed, country }: real keyword ideas from a seed phrase (DataForSEO Labs) - genuinely new
// suggestions, never saved automatically. PATCH { suggestion, country }: save one the admin picked.
export async function POST(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const body = await request.json()
    const seed = typeof body.seed === 'string' ? body.seed.trim() : ''
    if (seed.length < 2) return NextResponse.json({ error: 'Enter a seed phrase (2+ characters)' }, { status: 400 })
    const country = body.country === 'us' ? 'us' : 'ca'
    const result = await suggestKeywords(seed, country)
    return NextResponse.json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Server error'
    const status = /not set|rejected|insufficient balance/i.test(message) ? 400 : 500
    return NextResponse.json({ error: message }, { status })
  }
}

export async function PATCH(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const body = await request.json()
    const raw = body.suggestion
    const isNumOrNull = (v: unknown) => v === null || typeof v === 'number'
    if (
      !raw ||
      typeof raw.keyword !== 'string' ||
      !raw.keyword.trim() ||
      !isNumOrNull(raw.volume) ||
      !isNumOrNull(raw.cpc) ||
      !isNumOrNull(raw.competition) ||
      !Array.isArray(raw.trend)
    ) {
      return NextResponse.json({ error: 'A valid suggestion is required' }, { status: 400 })
    }
    const suggestion: KeywordSuggestion = { keyword: raw.keyword, volume: raw.volume, cpc: raw.cpc, competition: raw.competition, trend: raw.trend }
    const country = body.country === 'us' ? 'us' : 'ca'
    const row = await saveSuggestedKeyword(suggestion, country)
    return NextResponse.json({ row })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}
