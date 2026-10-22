import type { SupabaseClient } from '@supabase/supabase-js'
import { readPublishEvents } from '@/lib/publish-cadence'

// "AI spend last 7 days: compose / heal / published guides", for the Posts: Guides automation card. It exists to show whether the self-heal
// is costing more than the writing it repairs. Read only. Every number is an ESTIMATE from the usage meter (api_calls, lib/ai-meter.ts), not
// an invoice. A number that could not be read is null and shown as "could not be read", never as a made-up zero.

/** The meter's feature tags for the guide writer, and for every repair or heal call. The heal tags are shared by all content (guides, blog
 * posts, page copy, news), because the meter does not record which page a call was for; the card says so. */
export const COMPOSE_FEATURES = ['guide-composer'] as const
export const HEAL_FEATURES = ['heal-loop', 'content-repair', 'content-heal'] as const

export interface GuideSpend {
  /** Estimated US dollars over the last 7 days; null when the meter could not be read. */
  composeUsd: number | null
  healUsd: number | null
  /** Guides that went live in the last 7 days; null when it could not be read. */
  published: number | null
  /** (compose + heal) / published, to the cent; null when either part is unknown or nothing was published. */
  perPublishedUsd: number | null
}

interface Row {
  feature: string | null
  est_cost_usd: number | string | null
}

/** Sums the rows of a feature list. Pure. */
export function sumFeatures(rows: readonly Row[], features: readonly string[]): number {
  let total = 0
  for (const r of rows) {
    if (!r.feature || !features.includes(r.feature)) continue
    const v = Number(r.est_cost_usd)
    if (Number.isFinite(v) && v > 0) total += v
  }
  return Math.round(total * 100) / 100
}

/** The per-guide figure. Null when a part is unknown or no guide was published (dividing by zero would invent a number). Pure. */
export function perPublished(composeUsd: number | null, healUsd: number | null, published: number | null): number | null {
  if (composeUsd === null || healUsd === null || published === null || published <= 0) return null
  return Math.round(((composeUsd + healUsd) / published) * 100) / 100
}

async function readRows(admin: SupabaseClient, features: readonly string[], sinceIso: string): Promise<Row[] | null> {
  const all: Row[] = []
  for (let from = 0; from < 20_000; from += 1000) {
    const { data, error } = await admin.from('api_calls').select('feature, est_cost_usd').in('feature', [...features]).gte('ts', sinceIso).range(from, from + 999)
    if (error) return null
    const rows = (data ?? []) as Row[]
    all.push(...rows)
    if (rows.length < 1000) break
  }
  return all
}

/** Last 7 days of guide AI spend, read only. Never throws; each part that fails to read is null. */
export async function readGuideSpend(admin: SupabaseClient, now: number = Date.now()): Promise<GuideSpend> {
  const since = new Date(now - 7 * 86_400_000).toISOString()
  let composeUsd: number | null = null
  let healUsd: number | null = null
  let published: number | null = null
  try {
    const rows = await readRows(admin, [...COMPOSE_FEATURES, ...HEAL_FEATURES], since)
    if (rows) {
      composeUsd = sumFeatures(rows, COMPOSE_FEATURES)
      healUsd = sumFeatures(rows, HEAL_FEATURES)
    }
  } catch {
    // stays null
  }
  try {
    const events = await readPublishEvents(admin, 'guide', now)
    if (events) published = events.filter((e) => now - e.at < 7 * 86_400_000).length
  } catch {
    // stays null
  }
  return { composeUsd, healUsd, published, perPublishedUsd: perPublished(composeUsd, healUsd, published) }
}

const money = (n: number | null) => (n === null ? 'could not be read' : `$${n.toFixed(2)}`)

/** The line for the card. Pure. */
export function describeGuideSpend(s: GuideSpend | null): string {
  if (!s) return 'AI spend last 7 days: could not be read'
  const published = s.published === null ? 'could not be read' : String(s.published)
  const per = s.perPublishedUsd === null ? '' : ` (about ${money(s.perPublishedUsd)} per published guide)`
  return `AI spend last 7 days (estimate): compose ${money(s.composeUsd)} / heal ${money(s.healUsd)} / published guides ${published}${per}`
}
