import type { SupabaseClient } from '@supabase/supabase-js'
import { readFeedState } from '@/lib/news-feed'
import { newsTableReady, type NewsStatus } from '@/lib/news-ingest'
import { getNewsMode, getNewsPerDay, NEWS_PER_DAY_DEFAULT, NEWS_PER_DAY_HARD_MAX, type NewsMode } from '@/lib/news-settings'
import { NEWS_SOURCES } from '@/lib/news-sources'

// What the Travel news section of the Content Autopilot page shows: the two switches, how each source is doing, and the last
// 10 news items with their status and reason. No new page. Read only; the switches are changed through the admin API route.

export interface NewsCardItem {
  id: string
  title: string
  source: string
  tier: number
  status: NewsStatus
  reason: string | null
  postSlug: string | null
  url: string
  at: string
}

export interface NewsCardSource {
  key: string
  name: string
  tier: number
  enabled: boolean
  confidence: string
  fails: number
  lastError: string | null
  lastOkAt: string | null
}

export interface NewsCard {
  mode: NewsMode
  perDay: number | null
  perDayDefault: number
  perDayMax: number
  needsMigration: boolean
  items: NewsCardItem[]
  sources: NewsCardSource[]
}

export async function newsCard(admin: SupabaseClient): Promise<NewsCard> {
  const mode = await getNewsMode(admin)
  const perDay = await getNewsPerDay(admin)
  const ready = await newsTableReady(admin)
  const sources: NewsCardSource[] = []
  for (const s of NEWS_SOURCES) {
    const st = await readFeedState(admin, s.key)
    sources.push({ key: s.key, name: s.name.replace(/^the /i, ''), tier: s.tier, enabled: s.enabled, confidence: s.confidence, fails: st.fails, lastError: st.lastError ?? null, lastOkAt: st.lastOkAt ?? null })
  }
  let items: NewsCardItem[] = []
  if (ready.ok) {
    const { data } = await admin.from('news_items').select('id, title, source_key, tier, status, reject_reason, post_slug, url, created_at, decided_at').order('created_at', { ascending: false }).limit(10)
    items = ((data ?? []) as { id: string; title: string; source_key: string; tier: number; status: NewsStatus; reject_reason: string | null; post_slug: string | null; url: string; created_at: string; decided_at: string | null }[]).map((r) => ({
      id: r.id,
      title: r.title,
      source: NEWS_SOURCES.find((s) => s.key === r.source_key)?.name.replace(/^the /i, '') ?? r.source_key,
      tier: r.tier,
      status: r.status,
      reason: r.reject_reason,
      postSlug: r.post_slug,
      url: r.url,
      at: r.decided_at ?? r.created_at,
    }))
  }
  return { mode, perDay, perDayDefault: NEWS_PER_DAY_DEFAULT, perDayMax: NEWS_PER_DAY_HARD_MAX, needsMigration: !ready.ok, items, sources }
}
