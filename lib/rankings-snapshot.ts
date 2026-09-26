import type { SupabaseClient } from '@supabase/supabase-js'
import { getSearchConsoleRankingSnapshot } from '@/lib/search-console'
import { bucketCounts, trackedPathOf } from '@/lib/rankings'

// Ported from Nomad Escape Plan's modules/marketing/rankings-snapshot.ts (Factory Phase 5:
// SEO/indexing), adapted to call this project's own lib/search-console.ts (shared Google
// service-account auth, already used by /admin/keywords) instead of porting Nomad's separate
// GSC_CLIENT_EMAIL/GSC_PRIVATE_KEY JWT client - that would have been a second, competing way to
// talk to the same Google API for no reason. trackedPathOf() also covers /packages/[slug], not
// just /blog/[slug], since this site's real product pages are worth ranking-tracking too.
const QUERY_ROWS_KEPT = 300
const CHUNK = 500

export const RANKING_DAYS_TABLE = 'gsc_ranking_days'
export const RANKINGS_TABLE = 'gsc_rankings'

/** Take today's ranking snapshot: the keyword counts for the day, one row per tracked page and
 * one per busy keyword. Re-running the same day overwrites it. Returns a one-line note for the
 * cron heartbeat; throws on a real failure. */
export async function takeRankingSnapshot(admin: SupabaseClient): Promise<string> {
  const snap = await getSearchConsoleRankingSnapshot()
  if (!snap) return "Search Console isn't configured"
  const day = new Date().toISOString().slice(0, 10)

  const counts = bucketCounts(snap.queries.map((q) => q.position))
  const daily = { day, ...counts, queries: snap.queries.length, clicks: Math.round(snap.totals.clicks), impressions: Math.round(snap.totals.impressions) }
  const { error: dayError } = await admin.from(RANKING_DAYS_TABLE).upsert(daily, { onConflict: 'day' })
  if (dayError) throw new Error(`${RANKING_DAYS_TABLE}: ${dayError.message}`)

  const rows: { day: string; kind: 'query' | 'page'; key: string; position: number; clicks: number; impressions: number }[] = []
  for (const q of [...snap.queries].sort((a, b) => b.impressions - a.impressions).slice(0, QUERY_ROWS_KEPT)) {
    if (q.key) rows.push({ day, kind: 'query', key: q.key, position: q.position, clicks: Math.round(q.clicks), impressions: Math.round(q.impressions) })
  }
  const pages = new Map<string, (typeof rows)[number]>()
  for (const p of snap.pages) {
    const path = p.key ? trackedPathOf(p.key) : null
    if (path && !pages.has(path)) pages.set(path, { day, kind: 'page', key: path, position: p.position, clicks: Math.round(p.clicks), impressions: Math.round(p.impressions) })
  }
  rows.push(...pages.values())

  for (let i = 0; i < rows.length; i += CHUNK) {
    const { error } = await admin.from(RANKINGS_TABLE).upsert(rows.slice(i, i + CHUNK), { onConflict: 'day,kind,key' })
    if (error) throw new Error(`${RANKINGS_TABLE}: ${error.message}`)
  }
  return `${counts.top10} keywords in the top 10, ${counts.top50} in the top 50, ${counts.top100} in the top 100; ${pages.size} tracked pages`
}
