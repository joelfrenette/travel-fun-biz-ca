import type { SupabaseClient } from '@supabase/supabase-js'
import { getGa4PageViews, isGa4Configured } from '@/lib/ga4'
import { isVisitTrackingOn } from '@/lib/visit-tracking'
import { readAllPages } from '@/lib/paged-read'
import { rangeDays, type DashRange } from '@/lib/dashboard-range'
import {
  aggregateTopPages, aggregateTopPosts,
  type Ga4PageRow, type SendRow, type SocialLeadRow, type SocialVisitRow, type SourceStatus, type TopPagesResult, type TopPostsResult, type VisitPageRow,
} from '@/lib/dashboard-top'

// Server-side reads for the dashboard "Top pages" and "Top posts by clicks" tables. Read-only. Every source reports its own
// status, so one failure shows "could not be read" for that column and never a zero.

const sinceIso = (range: DashRange): string | null => {
  const days = rangeDays(range)
  return days === null ? null : new Date(Date.now() - days * 86400000).toISOString()
}

export interface SourceInfo {
  status: SourceStatus
  error: string | null
}

export type TopPagesResponse = TopPagesResult & { range: DashRange; recorded: SourceInfo; ga4: SourceInfo; leads: SourceInfo }
export type TopPostsResponse = TopPostsResult & { range: DashRange; visits: SourceInfo; leads: SourceInfo; sends: SourceInfo }

async function trackingOn(admin: SupabaseClient): Promise<boolean> {
  try {
    return await isVisitTrackingOn(admin)
  } catch {
    return false
  }
}

export async function getTopPages(admin: SupabaseClient, range: DashRange): Promise<TopPagesResponse> {
  const since = sinceIso(range)
  const on = await trackingOn(admin)

  const recordedP: Promise<{ status: SourceStatus; error: string | null; rows: VisitPageRow[] }> = on
    ? readAllPages<VisitPageRow>((from, to) => {
        let q = admin.from('site_visits').select('landing_path, channel, source')
        if (since) q = q.gte('created_at', since)
        return q.order('created_at', { ascending: false }).range(from, to)
      }, 40).then((r) => (r.ok || r.capped ? { status: 'ok' as const, error: null, rows: r.rows } : { status: 'error' as const, error: r.error ?? 'read failed', rows: [] }))
    : Promise.resolve({ status: 'off' as const, error: null, rows: [] })

  const ga4P: Promise<{ status: SourceStatus; error: string | null; rows: Ga4PageRow[] }> = isGa4Configured()
    ? getGa4PageViews(range).then(
        (rows) => ({ status: 'ok' as const, error: null, rows }),
        (e) => ({ status: 'error' as const, error: e instanceof Error ? e.message : 'GA4 request failed', rows: [] }),
      )
    : Promise.resolve({ status: 'not_connected' as const, error: null, rows: [] })

  const leadsP = readAllPages<{ page_path: string | null }>((from, to) => {
    let q = admin.from('leads').select('page_path').eq('is_test', false)
    if (since) q = q.gte('created_at', since)
    return q.order('created_at', { ascending: false }).range(from, to)
  }, 40)

  const [recorded, ga4, leads] = await Promise.all([recordedP, ga4P, leadsP])
  const leadsStatus: SourceStatus = leads.ok || leads.capped ? 'ok' : 'error'
  const result = aggregateTopPages({
    recorded: { status: recorded.status, rows: recorded.rows },
    ga4: { status: ga4.status, rows: ga4.rows },
    leads: { status: leadsStatus, paths: leads.rows.map((r) => r.page_path) },
  })
  return {
    ...result,
    range,
    recorded: { status: recorded.status, error: recorded.error },
    ga4: { status: ga4.status, error: ga4.error },
    leads: { status: leadsStatus, error: leadsStatus === 'ok' ? null : leads.error ?? 'read failed' },
  }
}

export async function getTopPosts(admin: SupabaseClient, range: DashRange): Promise<TopPostsResponse> {
  const since = sinceIso(range)
  const on = await trackingOn(admin)

  const visits: { status: SourceStatus; error: string | null; rows: SocialVisitRow[] } = on
    ? await readAllPages<SocialVisitRow>((from, to) => {
        let q = admin.from('site_visits').select('campaign, source, medium, content').eq('medium', 'social').neq('campaign', '')
        if (since) q = q.gte('created_at', since)
        return q.order('created_at', { ascending: false }).range(from, to)
      }, 40).then((r) => (r.ok || r.capped ? { status: 'ok' as const, error: null, rows: r.rows } : { status: 'error' as const, error: r.error ?? 'read failed', rows: [] }))
    : { status: 'off', error: null, rows: [] }

  const leadsRes = await readAllPages<SocialLeadRow>((from, to) => {
    let q = admin.from('leads').select('utm_campaign, utm_source, utm_medium, utm_content').eq('is_test', false).eq('utm_medium', 'social').not('utm_campaign', 'is', null)
    if (since) q = q.gte('created_at', since)
    return q.order('created_at', { ascending: false }).range(from, to)
  }, 40)
  const leadsStatus: SourceStatus = leadsRes.ok || leadsRes.capped ? 'ok' : 'error'

  // Sends: one row per (post, network) that was actually sent in the range, with the hook style stored for that network.
  const dist = await readAllPages<{ slug: string; sent_platforms: string[] | null; title: string | null }>((from, to) => {
    let q = admin.from('post_distribution').select('slug, sent_platforms, title')
    if (since) q = q.gte('updated_at', since)
    return q.order('updated_at', { ascending: false }).range(from, to)
  }, 40)
  const tags = await readAllPages<{ slug: string; variant_tags: Record<string, unknown> | null }>((from, to) => admin.from('content_variants').select('slug, variant_tags').order('slug').range(from, to), 40)
  const sendsStatus: SourceStatus = (dist.ok || dist.capped) && (tags.ok || tags.capped) ? 'ok' : 'error'
  const sends: SendRow[] = []
  const tagBySlug = new Map(tags.rows.map((t) => [t.slug, t.variant_tags ?? {}]))
  for (const d of dist.rows) {
    const vt = tagBySlug.get(d.slug) ?? {}
    for (const p of d.sent_platforms ?? []) {
      const h = vt[`hook_style:${p}`]
      sends.push({ slug: d.slug, network: p, hookStyle: typeof h === 'string' ? h : null })
    }
  }

  // Titles: posts by slug, falling back to the distribution log's own title. Only slugs that appear in the rows matter.
  const slugs = [...new Set([...visits.rows.map((r) => (r.campaign ?? '').toLowerCase()), ...leadsRes.rows.map((r) => (r.utm_campaign ?? '').toLowerCase())].filter(Boolean))]
  const titles = new Map<string, string>()
  for (const d of dist.rows) if (d.title) titles.set(d.slug.toLowerCase(), d.title)
  for (let i = 0; i < slugs.length; i += 200) {
    try {
      const { data } = await admin.from('posts').select('slug, title').in('slug', slugs.slice(i, i + 200))
      for (const p of (data ?? []) as { slug: string; title: string | null }[]) if (p.title) titles.set(p.slug.toLowerCase(), p.title)
    } catch {
      // titles are cosmetic: the slug is shown when they cannot be read
    }
  }

  const result = aggregateTopPosts({
    visits: { status: visits.status, rows: visits.rows },
    leads: { status: leadsStatus, rows: leadsRes.rows },
    sends: { status: sendsStatus, rows: sends },
    titles,
  })
  return {
    ...result,
    range,
    visits: { status: visits.status, error: visits.error },
    leads: { status: leadsStatus, error: leadsStatus === 'ok' ? null : leadsRes.error ?? 'read failed' },
    sends: { status: sendsStatus, error: sendsStatus === 'ok' ? null : dist.error ?? tags.error ?? 'read failed' },
  }
}
