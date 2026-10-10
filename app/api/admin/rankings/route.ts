import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { bestPairs, buildMovers, type RankRow } from '@/lib/rankings'
import { getPageMetrics, getQueryPagePairs } from '@/lib/search-console'
import { listSitePages } from '@/lib/site-pages'
import { RANKING_DAYS_TABLE, RANKINGS_TABLE } from '@/lib/rankings-snapshot'

// Factory Phase 8: reads what Phase 5's gsc-snapshot cron has been writing into
// gsc_ranking_days/gsc_rankings. Both tables are empty until CRON_SECRET is set and the cron
// actually fires - this route (and the page that calls it) handles that honestly rather than
// pretending there's data.
export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const admin = getSupabaseAdmin()
    const [days, rows] = await Promise.all([
      admin.from(RANKING_DAYS_TABLE).select('*').order('day', { ascending: true }).limit(90),
      admin.from(RANKINGS_TABLE).select('day, kind, key, position, clicks, impressions').order('day', { ascending: true }).limit(5000),
    ])
    if (days.error) throw new Error(days.error.message)
    if (rows.error) throw new Error(rows.error.message)

    const queryRows = (rows.data ?? []).filter((r) => r.kind === 'query') as RankRow[]
    const pageRows = (rows.data ?? []).filter((r) => r.kind === 'page') as RankRow[]

    // Which page ranks for which keyword (live from Search Console, cached an hour; empty if unavailable)
    const [sitePages, metrics, pairs] = await Promise.all([listSitePages(admin), getPageMetrics(), getQueryPagePairs()])
    const { pageForQuery, queryForPage } = bestPairs(pairs)
    // Every package, destination and blog page with its real 28-day Google numbers. A page Google has
    // not reported yet has position null ("not ranking yet"); it is still listed so nothing is missing.
    const byPath = new Map(metrics.map((x) => [x.path, x]))
    const pages = sitePages.map((p) => {
      const x = byPath.get(p.path)
      return { ...p, position: x?.position ?? null, clicks: x?.clicks ?? 0, impressions: x?.impressions ?? 0, topKeyword: queryForPage.get(p.path) ?? null }
    })
    return NextResponse.json({
      pages,
      days: days.data ?? [],
      queryMovers: buildMovers(queryRows).slice(0, 25).map((m) => ({ ...m, other: pageForQuery.get(m.key.toLowerCase()) ?? null })),
      pageMovers: buildMovers(pageRows).slice(0, 25).map((m) => ({ ...m, other: queryForPage.get(m.key.replace(/\/+$/, '')) ?? null })),
    })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}
