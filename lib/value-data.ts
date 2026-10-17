import type { SupabaseClient } from '@supabase/supabase-js'
import { isGa4Configured, getGa4Report } from '@/lib/ga4'
import { readLastPipelineRun } from '@/lib/pipeline-log'
import { isAutopilotOn } from '@/lib/autopilot'
import { readAllPages } from '@/lib/paged-read'
import { isVisitTrackingOn } from '@/lib/visit-tracking'
import { latestDayRows, type ContentCount, type Inputs, type ValueData } from '@/lib/value'

// Reads every source the Website Value page needs. Read-only. Each source is read on its own and a
// failed read becomes "no data" for that tile (never a made-up zero), so one missing table, for
// example before migration 0044 or 0045 is applied, only greys out its own tiles.
//
// PostgREST stops any single response at 1000 rows whatever .limit() says, so every list that feeds a
// total is read page by page (lib/paged-read.ts). If any page fails, or the page ceiling is hit, the
// source counts as not tracked: a partial sum would overstate profit and get frozen into a snapshot.

const DAY = 86_400_000

async function safe<T>(fn: () => PromiseLike<T>): Promise<T | null> {
  try {
    return await fn()
  } catch {
    return null
  }
}

export async function readInputs(admin: SupabaseClient): Promise<Inputs> {
  const res = await safe(() => admin.from('value_inputs').select('key, value, as_of, note'))
  const out: Inputs = {}
  for (const r of (res?.data ?? []) as { key: string; value: string | null; as_of: string | null; note: string | null }[]) {
    out[r.key] = { value: r.value, as_of: r.as_of, note: r.note }
  }
  return out
}

async function contentCount(admin: SupabaseClient, table: string, statusCol = 'status'): Promise<ContentCount | null> {
  const res = await safe(() => readAllPages<{ created_at: string }>((from, to) => admin.from(table).select('created_at').eq(statusCol, 'published').order('created_at', { ascending: true }).range(from, to), 50))
  if (!res || !res.ok) return null
  const rows = res.rows
  return { count: rows.length, oldest: rows[0]?.created_at ?? null, newest: rows[rows.length - 1]?.created_at ?? null }
}

export async function collectValueData(admin: SupabaseClient, now: Date = new Date()): Promise<ValueData> {
  const since12m = new Date(now.getTime() - 365 * DAY).toISOString()
  const since30d = new Date(now.getTime() - 30 * DAY).toISOString()
  const since28d = new Date(now.getTime() - 28 * DAY).toISOString()

  const [inputs, ordersRes, apiRes, visitsRes, gscRes, leadsRes, posts, guides, packages, pipeline, autopilotOn] = await Promise.all([
    readInputs(admin),
    safe(() => readAllPages<NonNullable<ValueData['orders']>[number]>((from, to) => admin.from('orders').select('amount_cents, currency, status, is_test, paid_at, created_at').gte('created_at', since12m).order('created_at', { ascending: false }).range(from, to), 100)),
    safe(() => readAllPages<{ ts: string; est_cost_usd: number | string }>((from, to) => admin.from('api_calls').select('ts, est_cost_usd').gte('ts', since12m).order('ts', { ascending: false }).range(from, to), 500)),
    // The visit log is read only while visit tracking is switched on, the same gate the funnel uses.
    safe(async () => ((await isVisitTrackingOn(admin)) ? readAllPages<{ channel: string }>((from, to) => admin.from('site_visits').select('channel').gte('created_at', since28d).order('created_at', { ascending: false }).range(from, to), 100) : null)),
    safe(() => admin.from('gsc_ranking_days').select('day, clicks, impressions, top10').order('day', { ascending: false }).limit(5)),
    safe(() => admin.from('leads').select('id', { count: 'exact', head: true }).eq('is_test', false).gte('created_at', since12m)),
    contentCount(admin, 'posts'),
    contentCount(admin, 'guides'),
    contentCount(admin, 'travel_packages'),
    safe(() => readLastPipelineRun(admin)),
    safe(() => isAutopilotOn(admin)),
  ])

  // AI cost: null (not tracked) unless the meter has recorded at least one call.
  // A read that did not finish (a failed page, or the page ceiling) counts as no data, never a partial total.
  const apiRows = apiRes && apiRes.ok ? apiRes.rows : []
  const cost = (r: { est_cost_usd: number | string }) => Number(r.est_cost_usd) || 0
  const aiCost12mUsd = apiRows.length ? apiRows.reduce((s, r) => s + cost(r), 0) : null
  const aiCost30dUsd = apiRows.length ? apiRows.filter((r) => r.ts >= since30d).reduce((s, r) => s + cost(r), 0) : null
  const aiFirstTs = apiRows.length ? apiRows.reduce((a, r) => (r.ts < a ? r.ts : a), apiRows[0].ts) : null

  // Traffic: GA4 when connected (its failure falls back to the visit log), else the visit log.
  let ga4: ValueData['ga4'] = null
  if (isGa4Configured()) {
    const rep = await safe(() => getGa4Report(28))
    if (rep && rep.totals.sessions > 0) {
      ga4 = { sessions: rep.totals.sessions, organicSearch: rep.totals.organicSearch, social: rep.totals.social, windowDays: rep.days.length || 28, fetchedAt: rep.fetchedAt }
    }
  }
  let visitsByChannel: Record<string, number> | null = null
  const visitRows = visitsRes && visitsRes.ok ? visitsRes.rows : []
  if (visitRows.length) {
    visitsByChannel = {}
    for (const v of visitRows) visitsByChannel[v.channel || 'unknown'] = (visitsByChannel[v.channel || 'unknown'] ?? 0) + 1
  }

  const gscDays = (gscRes && !gscRes.error ? gscRes.data ?? [] : []) as ValueData['gscDays']

  // content_performance holds a rolling 28-day total per page per day: read the latest day only.
  let contentPerfLatest: ValueData['contentPerfLatest'] = []
  const latest = await safe(() => admin.from('content_performance').select('day').order('day', { ascending: false }).limit(1))
  const latestDay = (latest?.data as { day: string }[] | null | undefined)?.[0]?.day
  if (latestDay) {
    const rows = await safe(() => readAllPages<ValueData['contentPerfLatest'][number]>((from, to) => admin.from('content_performance').select('day, path, clicks').eq('day', latestDay).order('path', { ascending: true }).range(from, to), 50))
    contentPerfLatest = rows && rows.ok ? latestDayRows(rows.rows) : []
  }

  return {
    inputs,
    orders: ordersRes && ordersRes.ok ? ordersRes.rows : null,
    aiCost12mUsd,
    aiCost30dUsd,
    aiFirstTs,
    ga4,
    visitsByChannel,
    gscDays,
    contentPerfLatest,
    leads12m: leadsRes && !leadsRes.error ? (leadsRes.count ?? 0) : null,
    posts,
    guides,
    packages,
    pipeline: pipeline
      ? { at: pipeline.at, stepsTotal: pipeline.steps.length, stepsOk: pipeline.steps.filter((s) => s.ok).length }
      : null,
    autopilotOn,
  }
}
