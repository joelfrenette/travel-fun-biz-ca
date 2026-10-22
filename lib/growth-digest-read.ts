import type { SupabaseClient } from '@supabase/supabase-js'
import { buildGrowthDigest, pickGscDays, type AiRow, type BingInput, type DigestInput, type GrowthDigest, type GscDay, type GscRow, type LeadRow, type Read, type SendRow, type VisitRow } from '@/lib/growth-digest'
import { readAllPages } from '@/lib/paged-read'
import { getSettingStrict } from '@/lib/app-settings'
import { readBingCoverage } from '@/lib/bing-coverage'
import { CAPTION_LOG_KEY, parseCaptionLog } from '@/lib/caption-plan'
import { VISUAL_GATE_STATS_KEY, parseStats, sumRecent } from '@/lib/visual-gate-stats'
import { readPublishEvents } from '@/lib/publish-cadence'
import { getActivePlatforms } from '@/lib/social-provider'
import { VISIT_TRACKING_KEY } from '@/lib/visit-tracking'

// Reads every source the Growth digest needs (read only) and hands the raw results to the pure builder in lib/growth-digest.ts.
// Each source is read on its own: one that fails becomes { ok: false }, which the builder prints as "could not be read". Nothing
// here writes, sends or calls an AI model.

const DAY = 86_400_000
const fail = (e: unknown): Read<never> => ({ ok: false, reason: e instanceof Error ? e.message : String(e) })

async function safe<T>(fn: () => Promise<Read<T>>): Promise<Read<T>> {
  try {
    return await fn()
  } catch (e) {
    return fail(e)
  }
}

async function countRows(q: PromiseLike<{ count: number | null; error: { message: string } | null }>): Promise<Read<number>> {
  const r = await q
  return r.error ? { ok: false, reason: r.error.message } : { ok: true, value: r.count ?? 0 }
}

export async function readGrowthDigestInput(admin: SupabaseClient, now: Date = new Date()): Promise<DigestInput> {
  const since7 = new Date(now.getTime() - 7 * DAY).toISOString()
  const since14 = new Date(now.getTime() - 14 * DAY).toISOString()
  const since30 = new Date(now.getTime() - 30 * DAY).toISOString()

  const gscDays = await safe<GscDay[]>(async () => {
    const { data, error } = await admin.from('gsc_ranking_days').select('day, clicks, impressions, queries').order('day', { ascending: false }).limit(30)
    if (error) return { ok: false, reason: error.message }
    return { ok: true, value: ((data ?? []) as GscDay[]).map((d) => ({ day: d.day, clicks: Number(d.clicks) || 0, impressions: Number(d.impressions) || 0, queries: Number(d.queries) || 0 })) }
  })

  const gscRows = await safe<GscRow[]>(async () => {
    if (!gscDays.ok) return { ok: false, reason: 'the daily totals could not be read' }
    const { latest, before } = pickGscDays(gscDays.value)
    if (!latest || !before) return { ok: true, value: [] }
    const days = [latest.day, before.day]
    const res = await readAllPages<GscRow>((from, to) => admin.from('gsc_rankings').select('day, kind, key, position, clicks, impressions').in('day', days).order('day').order('kind').order('key').range(from, to))
    if (!res.ok) return { ok: false, reason: res.error }
    return { ok: true, value: res.rows.map((r) => ({ ...r, position: Number(r.position), clicks: Number(r.clicks) || 0, impressions: Number(r.impressions) || 0 })) }
  })

  const bing = await safe<BingInput>(async () => {
    const r = await readBingCoverage(admin)
    if (r.error) return { ok: false, reason: r.error }
    const c = r.coverage
    return { ok: true, value: { configured: !!process.env.BING_WEBMASTER_API_KEY || !!c, status: c?.status ?? null, crawled7d: c?.crawled7d ?? null, indexed: c?.indexed ?? null, asOf: c?.asOf ?? null } }
  })

  const postsWritten = await safe(() => countRows(admin.from('posts').select('id', { count: 'exact', head: true }).gte('created_at', since7)))
  const postsPublished = await safe(() => countRows(admin.from('posts').select('id', { count: 'exact', head: true }).eq('status', 'published').gte('created_at', since7)))
  const postsHeld = await safe(() => countRows(admin.from('posts').select('id', { count: 'exact', head: true }).neq('status', 'published').gte('created_at', since30)))
  const newsBriefs = await safe(() => countRows(admin.from('news_items').select('id', { count: 'exact', head: true }).eq('status', 'published').gte('decided_at', since7)))
  const guidesPublished = await safe(() => countRows(admin.from('guides').select('id', { count: 'exact', head: true }).eq('status', 'published').gte('created_at', since7)))
  const guidesFlagged = await safe(() => countRows(admin.from('guides').select('id', { count: 'exact', head: true }).eq('status', 'draft').not('quality_notes', 'is', null).neq('quality_notes', '')))
  const reels = await safe(() => countRows(admin.from('content_pipeline').select('slug', { count: 'exact', head: true }).eq('video_stage', 'posted').gte('updated_at', since7)))
  const carousels = await safe(() => countRows(admin.from('content_pipeline').select('slug', { count: 'exact', head: true }).eq('carousel_stage', 'posted').gte('updated_at', since7)))

  const sends = await safe<SendRow[]>(async () => {
    const r = await getSettingStrict(admin, CAPTION_LOG_KEY)
    if (r.error) return { ok: false, reason: r.error }
    return { ok: true, value: parseCaptionLog(r.value).map((e) => ({ at: e.at, network: e.network })) }
  })

  const gate = await safe<{ pass: number; retry: number; skip: number; deferred: number }>(async () => {
    const r = await getSettingStrict(admin, VISUAL_GATE_STATS_KEY)
    if (r.error) return { ok: false, reason: r.error }
    return { ok: true, value: sumRecent(parseStats(r.value), now) }
  })

  const cadence = await safe<{ guides: number; posts: number }>(async () => {
    const [g, p] = await Promise.all([readPublishEvents(admin, 'guide', now.getTime()), readPublishEvents(admin, 'post', now.getTime())])
    if (g === null || p === null) return { ok: false, reason: 'the publishing log could not be read' }
    const cut = now.getTime() - 7 * DAY
    return { ok: true, value: { guides: g.filter((e) => e.at >= cut).length, posts: p.filter((e) => e.at >= cut).length } }
  })

  const leads = await safe<LeadRow[]>(async () => {
    const res = await readAllPages<{ created_at: string; is_test: boolean; package: string | null }>((from, to) => admin.from('leads').select('created_at, is_test, package').gte('created_at', since14).order('created_at').range(from, to))
    if (!res.ok) return { ok: false, reason: res.error }
    // Newsletter and trip-alert signups are not "leads" in the brief's sense, so they are left out of this count.
    const rows = res.rows.filter((r) => r.package !== 'Newsletter signup' && !(r.package ?? '').startsWith('Trip alert:'))
    return { ok: true, value: rows.map((r) => ({ at: r.created_at, isTest: !!r.is_test, pkg: r.package })) }
  })

  const visits = await safe<VisitRow[]>(async () => {
    const res = await readAllPages<{ source: string | null; content: string | null }>((from, to) => admin.from('site_visits').select('source, content').gte('created_at', since7).order('created_at').range(from, to))
    if (!res.ok) return { ok: false, reason: res.error }
    return { ok: true, value: res.rows.map((r) => ({ source: r.source ?? '', content: r.content ?? '' })) }
  })

  const visitTrackingOn = await safe<boolean>(async () => {
    const r = await getSettingStrict(admin, VISIT_TRACKING_KEY)
    return r.error ? { ok: false, reason: r.error } : { ok: true, value: r.value === 'on' }
  })

  const ai = await safe<AiRow[]>(async () => {
    const res = await readAllPages<{ feature: string; est_cost_usd: number | string }>((from, to) => admin.from('api_calls').select('feature, est_cost_usd').gte('ts', since7).order('ts').range(from, to))
    if (!res.ok) return { ok: false, reason: res.error }
    return { ok: true, value: res.rows.map((r) => ({ feature: r.feature, costUsd: Number(r.est_cost_usd) || 0 })) }
  })

  const social = await safe<{ platforms: string[] }>(async () => {
    const a = await getActivePlatforms(admin)
    return { ok: true, value: { platforms: a.platforms } }
  })

  return { now, gscDays, gscRows, bing, postsWritten, postsPublished, newsBriefs, guidesPublished, guidesFlagged, postsHeld, reels, carousels, sends, gate, cadence, leads, visits, visitTrackingOn, ai, social }
}

/** The digest, never throwing: a total failure comes back as null so the caller can leave the section out. */
export async function readGrowthDigest(admin: SupabaseClient, now: Date = new Date()): Promise<GrowthDigest | null> {
  try {
    return buildGrowthDigest(await readGrowthDigestInput(admin, now))
  } catch {
    return null
  }
}
