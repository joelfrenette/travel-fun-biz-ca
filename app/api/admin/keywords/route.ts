import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { listSitePages } from '@/lib/site-pages'
import { connectKeywordsToRankingPages, rankedPageByKeyword } from '@/lib/keyword-pages'
import { getAccountBalance, isKeywordDataConfigured, listKeywords, lookupKeywords, normalizeKeywords, trackKeyword } from '@/lib/keywords'

export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const [keywords, balanceUsd, pages, ranked] = await Promise.all([
      listKeywords(),
      isKeywordDataConfigured() ? getAccountBalance() : null,
      listSitePages(getSupabaseAdmin()),
      rankedPageByKeyword(),
    ])
    // pages: every package, destination and blog page (for the target dropdown); rankedOn: the page
    // Google really shows for each keyword (from Search Console), keyed by lowercase keyword.
    return NextResponse.json({ keywords, balanceUsd, configured: isKeywordDataConfigured(), pages, rankedOn: Object.fromEntries(ranked) })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const body = await request.json()
    // Connect every keyword with no target page to the page Google really shows for it (never
    // overwrites a page chosen by hand). The daily ranking snapshot does the same automatically.
    if (body.connectAll === true) {
      const connected = await connectKeywordsToRankingPages(getSupabaseAdmin())
      return NextResponse.json({ connected, keywords: await listKeywords() })
    }
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
