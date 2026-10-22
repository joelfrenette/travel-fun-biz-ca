import type { SupabaseClient } from '@supabase/supabase-js'
import { getSetting, getSettingStrict, setSetting } from '@/lib/app-settings'
import { CAPTION_LOG_KEY, parseCaptionLog } from '@/lib/caption-plan'
import { rotateStyle } from '@/lib/hook-styles'
import { readAllPages } from '@/lib/paged-read'
import { isVisitTrackingOn } from '@/lib/visit-tracking'
import {
  OPTIMIZER_STATE_KEY,
  SETTLE_DAYS,
  allowedValues,
  decide,
  emptyState,
  ingest,
  parseState,
  serializeState,
  steerPick,
  stitchFunnel,
  summarize,
  type LeadRecord,
  type OptimizerState,
  type OptimizerSummary,
  type VisitRecord,
} from '@/lib/optimizer'

// The reading and writing around lib/optimizer.ts. Runs inside the daily gsc-snapshot cron (no new cron). Writes ONLY the app_settings
// key optimizer_state. Never calls an AI model, never posts, never changes a page. Every function here fails open: a problem means
// "use today's rotation", never a broken send.

const DAY = 86_400_000

/** The stored state, or null when it is missing, corrupt or cannot be read. Callers treat null as "use the normal rotation". Never throws. */
export async function loadOptimizerState(admin: SupabaseClient): Promise<OptimizerState | null> {
  try {
    return parseState(await getSetting(admin, OPTIMIZER_STATE_KEY))
  } catch {
    return null
  }
}

/** Like rotateStyle, but retired values are left out and, once the data is big enough, a learned pick is used some of the time. Any
 * failure gives exactly what rotateStyle gives. `network` is NETWORK_ALL ("all") for a carousel or reel, which go to every network in one send. */
export async function steeredRotate<T extends string>(admin: SupabaseClient, network: string, format: 'carousel' | 'reel' | 'post', recent: readonly string[], catalogue: readonly T[]): Promise<T> {
  try {
    const state = await loadOptimizerState(admin)
    if (state) {
      const allowed = allowedValues(state, network, format, 'hook', catalogue)
      const picked = steerPick(state, network, format, 'hook', allowed)
      if (picked) return picked
      return rotateStyle(recent, allowed)
    }
  } catch {
    // fall through to the plain rotation
  }
  return rotateStyle(recent, catalogue)
}

/** What the admin card shows. ok:false means the state could not be read (the card says so). A missing value is an empty summary. */
export async function readOptimizerSummary(admin: SupabaseClient): Promise<{ ok: true; summary: OptimizerSummary; corrupt: boolean } | { ok: false; reason: string }> {
  try {
    const r = await getSettingStrict(admin, OPTIMIZER_STATE_KEY)
    if (r.error) return { ok: false, reason: r.error }
    const state = parseState(r.value)
    return { ok: true, summary: summarize(state), corrupt: !!r.value && !state }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : 'read failed' }
  }
}

/** For the growth digest: how many styles are retired and how many are clear winners. */
export async function readLearningCounts(admin: SupabaseClient): Promise<{ ok: true; retired: number; winners: number } | { ok: false; reason: string }> {
  const r = await readOptimizerSummary(admin)
  return r.ok ? { ok: true, retired: r.summary.retired, winners: r.summary.winners } : r
}

const slugsOf = (list: { slug: string }[]) => [...new Set(list.map((s) => s.slug))]

/** The daily step. Reads sends, visits, leads, impressions and cover tags; counts newly settled sends; applies the weekly rules; saves.
 * Returns a short note for the cron result. Never throws. */
export async function runOptimizer(admin: SupabaseClient, now: Date = new Date()): Promise<string> {
  try {
    const stored = await getSettingStrict(admin, OPTIMIZER_STATE_KEY)
    if (stored.error) return `optimizer: could not read its saved state (${stored.error}), skipped`
    const parsed = parseState(stored.value)
    const reset = !!stored.value && !parsed
    const state0 = parsed ?? emptyState(now)

    const log = await getSettingStrict(admin, CAPTION_LOG_KEY)
    if (log.error) return `optimizer: could not read the caption log (${log.error}), skipped`
    const sends = parseCaptionLog(log.value).map((e) => ({ at: e.at, slug: e.slug, network: e.network, format: e.format, style: e.style }))
    if (!sends.length) return reset ? 'optimizer: saved state was unreadable and was reset; no sends logged yet' : 'optimizer: no sends logged yet'
    const slugs = slugsOf(sends)
    const oldest = Math.min(...sends.map((s) => Date.parse(s.at)).filter(Number.isFinite))
    const since = new Date((Number.isFinite(oldest) ? oldest : now.getTime()) - DAY).toISOString()

    // Visits: only when our own visit tracking is on; otherwise null (not measured), never zero.
    let visits: VisitRecord[] | null = null
    try {
      if (await isVisitTrackingOn(admin)) {
        const res = await readAllPages<{ source: string | null; campaign: string | null; content: string | null; created_at: string }>((from, to) => admin.from('site_visits').select('source, campaign, content, created_at').gte('created_at', since).order('created_at').range(from, to), 30)
        if (res.ok) visits = res.rows.map((r) => ({ at: r.created_at, source: r.source ?? '', campaign: r.campaign ?? '', content: r.content ?? '' }))
      }
    } catch {
      visits = null
    }

    let leads: LeadRecord[] | null = null
    try {
      const res = await readAllPages<{ utm_source: string | null; utm_campaign: string | null; utm_content: string | null; created_at: string }>((from, to) => admin.from('leads').select('utm_source, utm_campaign, utm_content, created_at').eq('is_test', false).gte('created_at', since).order('created_at').range(from, to), 30)
      if (res.ok) leads = res.rows.map((r) => ({ at: r.created_at, source: r.utm_source ?? '', campaign: r.utm_campaign ?? '', content: r.utm_content ?? '' }))
    } catch {
      leads = null
    }

    // Cover designs per slug (variant tags) and the newest Google impressions per blog page. Both are optional context.
    const covers: Record<string, Partial<Record<'feed' | 'carousel' | 'reel', string>>> = {}
    try {
      for (let i = 0; i < slugs.length; i += 100) {
        const { data } = await admin.from('content_variants').select('slug, variant_tags').in('slug', slugs.slice(i, i + 100))
        for (const row of (data ?? []) as { slug: string; variant_tags: Record<string, unknown> | null }[]) {
          const t = row.variant_tags ?? {}
          const pick = (k: string) => (typeof t[k] === 'string' && t[k] ? (t[k] as string) : undefined)
          covers[row.slug] = { feed: pick('cover_template:feed') ?? pick('cover_template'), carousel: pick('cover_template:carousel'), reel: pick('cover_template:reel') }
        }
      }
    } catch {
      // covers stay empty: cover arms simply do not grow
    }
    const impressions: Record<string, number | null> = {}
    try {
      const latest = await admin.from('content_performance').select('day').order('day', { ascending: false }).limit(1)
      const day = (latest.data?.[0] as { day?: string } | undefined)?.day
      if (day) {
        const paths = slugs.map((s) => `/blog/${s}`)
        const { data } = await admin.from('content_performance').select('path, impressions').eq('day', day).in('path', paths)
        for (const r of (data ?? []) as { path: string; impressions: number | null }[]) impressions[r.path.replace(/^\/blog\//, '')] = r.impressions
      }
    } catch {
      // impressions stay unknown (null)
    }

    const rows = stitchFunnel({ sends, covers, visits, leads, impressions, windowDays: SETTLE_DAYS })
    const ing = ingest(state0, rows, now)
    const out = decide(ing.state, now)
    const saved = await setSetting(admin, OPTIMIZER_STATE_KEY, serializeState(out.state))
    if (saved.error) return `optimizer: could not save its state (${saved.error})`
    const bits: string[] = []
    if (reset) bits.push('saved state was unreadable and was reset')
    bits.push(`${ing.counted} settled send${ing.counted === 1 ? '' : 's'} counted`)
    if (ing.skipped) bits.push(`${ing.skipped} skipped (visits not measured)`)
    for (const d of out.decisions) bits.push(d.text)
    return `optimizer: ${bits.join('; ')}`
  } catch (e) {
    return `optimizer: failed (${e instanceof Error ? e.message : 'error'}), rotation unchanged`
  }
}
