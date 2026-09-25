import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { listKeywords } from '@/lib/keywords'
import { getSearchConsoleQueries, isSearchConsoleConfigured, searchConsoleSiteUrl } from '@/lib/search-console'
import { getBingKeywordStats, isBingConfigured } from '@/lib/bing-webmaster'

// GET: queries Search Console already shows the site for that are not tracked yet (discovery).
export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const configured = { searchConsole: isSearchConsoleConfigured(), bing: isBingConfigured(), siteUrl: searchConsoleSiteUrl() }
  if (!configured.searchConsole) return NextResponse.json({ configured, untracked: [] })
  try {
    const [rows, tracked] = await Promise.all([getSearchConsoleQueries(28), listKeywords()])
    const trackedSet = new Set(tracked.map((k) => k.keyword))
    const untracked = rows
      .filter((r) => !trackedSet.has(r.query))
      .sort((a, b) => b.impressions - a.impressions)
      .slice(0, 25)
    return NextResponse.json({ configured, untracked })
  } catch (error) {
    return NextResponse.json({ configured, untracked: [], error: error instanceof Error ? error.message : 'Search data failed' }, { status: 502 })
  }
}

// POST: refresh Search Console and Bing numbers on every tracked phrase.
export async function POST(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const configured = { searchConsole: isSearchConsoleConfigured(), bing: isBingConfigured() }
  if (!configured.searchConsole && !configured.bing) {
    return NextResponse.json({ error: 'Neither Search Console nor Bing is configured' }, { status: 400 })
  }

  const tracked = await listKeywords()
  const errors: string[] = []
  const now = new Date().toISOString()
  let gscUpdated = 0
  let bingUpdated = 0

  if (configured.searchConsole) {
    try {
      const rows = await getSearchConsoleQueries(28)
      const byQuery = new Map(rows.map((r) => [r.query, r]))
      for (const k of tracked) {
        const r = byQuery.get(k.keyword)
        const { error } = await getSupabaseAdmin()
          .from('keyword_research')
          .update({
            gsc_clicks: r?.clicks ?? 0,
            gsc_impressions: r?.impressions ?? 0,
            gsc_position: r ? Math.round(r.position * 10) / 10 : null,
            gsc_fetched_at: now,
            updated_at: now,
          })
          .eq('id', k.id)
        if (error) errors.push(`Search Console save for "${k.keyword}": ${error.message}`)
        else gscUpdated += 1
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : 'Search Console failed')
    }
  }

  if (configured.bing) {
    for (const k of tracked) {
      try {
        const stats = await getBingKeywordStats(k.keyword, k.country)
        const { error } = await getSupabaseAdmin()
          .from('keyword_research')
          .update({ bing_impressions: stats.monthlyImpressions, bing_fetched_at: now, updated_at: now })
          .eq('id', k.id)
        if (error) errors.push(`Bing save for "${k.keyword}": ${error.message}`)
        else bingUpdated += 1
      } catch (error) {
        errors.push(`Bing "${k.keyword}": ${error instanceof Error ? error.message : 'failed'}`)
        if (errors.length > 5) break // an auth or quota problem repeats on every phrase; stop early
      }
    }
  }

  return NextResponse.json({ configured, tracked: tracked.length, gscUpdated, bingUpdated, errors, keywords: await listKeywords() })
}
