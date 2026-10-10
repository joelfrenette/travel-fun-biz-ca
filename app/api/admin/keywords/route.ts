import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { listSitePages } from '@/lib/site-pages'
import { connectKeywordsToRankingPages, rankedPageByKeyword } from '@/lib/keyword-pages'
import { nextUp, rankKeywords, type ScorePackage } from '@/lib/keyword-score'
import { collectIdeas, dropIdea, readIdeas, readTrendPeaks, refreshTrendPeaksIfDue } from '@/lib/keyword-ideas'
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
    // The score (lib/keyword-score.ts) for every phrase, and the topics that would be written next.
    const { data: pk } = await getSupabaseAdmin().from('travel_packages').select('slug, name, destination, available_from, available_to').eq('status', 'published')
    const admin0 = getSupabaseAdmin()
    const [peaks, ideas] = await Promise.all([readTrendPeaks(admin0), readIdeas(admin0)])
    const scored = rankKeywords(keywords.filter((k) => k.country === 'ca' || k.country === 'us'), (pk ?? []) as ScorePackage[], new Date(), peaks)
    const scores = Object.fromEntries(scored.map((s) => [s.keyword, { score: s.score, parts: s.parts, eligible: s.eligible, reasons: s.reasons, packageName: s.packageName, primary: s.primary, secondary: s.secondary }]))
    return NextResponse.json({ keywords, balanceUsd, configured: isKeywordDataConfigured(), pages, rankedOn: Object.fromEntries(ranked), scores, nextUp: nextUp(scored, 5), ideas: ideas.slice(0, 60), trendsKnown: Object.keys(peaks).length })
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
    // Look for new keyword ideas now (autocomplete, questions, Reddit if set up) and refresh the trend peaks.
    // Capped at a few cents; the same thing also runs by itself once a week.
    if (body.collectIdeas === true) {
      const admin1 = getSupabaseAdmin()
      const ideasNote = await collectIdeas(admin1, { force: true })
      const trendsNote = await refreshTrendPeaksIfDue(admin1)
      return NextResponse.json({ note: [ideasNote, trendsNote].filter(Boolean).join(' | ') || 'nothing to collect', ideas: (await readIdeas(admin1)).slice(0, 60) })
    }
    if (typeof body.dropIdea === 'string') {
      await dropIdea(getSupabaseAdmin(), body.dropIdea)
      return NextResponse.json({ ok: true })
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
