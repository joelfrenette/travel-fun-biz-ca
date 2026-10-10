import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { listKeywords } from '@/lib/keywords'
import { getSearchConsoleQueries, isSearchConsoleConfigured, searchConsoleSiteUrl } from '@/lib/search-console'
import { refreshSearchConsoleRows } from '@/lib/keyword-intel'

export const maxDuration = 60

// Google only. (lib/bing-webmaster.ts stays in the repo for the IndexNow tools but is not used here.)

// GET: queries Search Console already shows the site for that are not tracked yet (discovery).
export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const configured = { searchConsole: isSearchConsoleConfigured(), siteUrl: searchConsoleSiteUrl() }
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

// POST: refresh the Search Console numbers on every tracked phrase.
export async function POST(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const configured = { searchConsole: isSearchConsoleConfigured() }
  if (!configured.searchConsole) return NextResponse.json({ error: 'Search Console is not connected' }, { status: 400 })
  const { tracked, updated, errors } = await refreshSearchConsoleRows(getSupabaseAdmin())
  return NextResponse.json({ configured, tracked, gscUpdated: updated, errors, keywords: await listKeywords() })
}
