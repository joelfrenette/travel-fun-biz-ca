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
    const suggestion = body.suggestion as KeywordSuggestion | undefined
    if (!suggestion || typeof suggestion.keyword !== 'string' || !suggestion.keyword.trim()) {
      return NextResponse.json({ error: 'A valid suggestion is required' }, { status: 400 })
    }
    const country = body.country === 'us' ? 'us' : 'ca'
    const row = await saveSuggestedKeyword(suggestion, country)
    return NextResponse.json({ row })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}
