import type { SupabaseClient } from '@supabase/supabase-js'

// WP8: conversion-weighted ranking. Lead and order results become a small, bounded TIE-BREAK for the topic, guide and trip-promotion
// orderings. It never replaces the existing signal (Search Console group, rank line, trip rotation); it only reorders items that the
// existing rules already treat as equal, and only when there are enough real results to mean something.
//
// Facts only: a lead counts 1, a lead the team marked booked counts 3, a paid order counts 5, a lost lead and a test row count 0.
// Nothing is guessed: with no data the signal is empty and every ordering is exactly what it was before.

export const LEAD_WEIGHT = 1
export const BOOKED_LEAD_WEIGHT = 3
export const ORDER_WEIGHT = 5
/** Below this score a page or destination has too little evidence to move anything (noise floor). */
export const MIN_SIGNAL_SCORE = 3
/** Each step above the floor needs this much more score. */
export const TIER_STEP = 3
/** The most places a conversion signal may lift an item inside its own group. */
export const MAX_TIER = 3
export const LEAD_WINDOW_DAYS = 90
export const ORDER_WINDOW_DAYS = 180
const MAX_ROWS = 5000

export interface ConversionSignal {
  /** Score per site path (for example /packages/<slug>). */
  byPath: Record<string, number>
  /** Score per lower-case destination name, summed from the trips that carry it. */
  byDestination: Record<string, number>
  /** How many lead and order rows fed the signal (for the decision line). */
  sample: number
}

export const EMPTY_SIGNAL: ConversionSignal = { byPath: {}, byDestination: {}, sample: 0 }

export interface SignalLead {
  page_path: string | null
  status?: string | null
}
export interface SignalOrder {
  package_slug: string | null
}
export interface SignalPackage {
  slug: string
  destination?: string | null
}

/** 0 when the score is under the noise floor, otherwise 1 to MAX_TIER. Pure. */
export function tierOf(score: number): number {
  if (!Number.isFinite(score) || score < MIN_SIGNAL_SCORE) return 0
  return Math.min(MAX_TIER, 1 + Math.floor((score - MIN_SIGNAL_SCORE) / TIER_STEP))
}

const cleanPath = (raw: string): string => {
  let p = raw.trim().split(/[?#]/)[0].replace(/\/+$/, '')
  if (/^https?:\/\//i.test(p)) {
    try {
      p = new URL(p).pathname.replace(/\/+$/, '')
    } catch {
      // keep as is
    }
  }
  return p === '' ? '/' : p.startsWith('/') ? p : `/${p}`
}

/** The trip page a path belongs to (`/packages/<slug>` or a deeper page under it), or null. */
export function packagePathOf(path: string): string | null {
  const m = /^\/packages\/([a-z0-9][a-z0-9-]*)/.exec(cleanPath(path))
  return m ? `/packages/${m[1]}` : null
}

const normDest = (s: string): string => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()

/** Builds the signal from plain rows. Pure. A lost lead and anything without a usable path adds nothing. */
export function buildSignal(input: { leads: SignalLead[]; orders: SignalOrder[]; packages: SignalPackage[] }): ConversionSignal {
  const byPath: Record<string, number> = {}
  let sample = 0
  const add = (path: string, w: number) => {
    if (w <= 0) return
    byPath[path] = (byPath[path] ?? 0) + w
    sample++
  }
  for (const l of input.leads) {
    if (!l.page_path) continue
    const w = l.status === 'lost' ? 0 : l.status === 'booked' ? BOOKED_LEAD_WEIGHT : LEAD_WEIGHT
    const p = cleanPath(l.page_path)
    add(p, w)
    // A lead on a page under /packages/<slug> also counts for the trip itself.
    const pkg = packagePathOf(p)
    if (pkg && pkg !== p) byPath[pkg] = (byPath[pkg] ?? 0) + w
  }
  for (const o of input.orders) {
    if (!o.package_slug) continue
    add(`/packages/${o.package_slug}`, ORDER_WEIGHT)
  }
  const byDestination: Record<string, number> = {}
  for (const pk of input.packages) {
    const d = normDest(pk.destination ?? '')
    const s = byPath[`/packages/${pk.slug}`] ?? 0
    if (d.length >= 4 && s > 0) byDestination[d] = (byDestination[d] ?? 0) + s
  }
  return { byPath, byDestination, sample }
}

/** Tier of one trip page. Pure. */
export function packageTier(signal: ConversionSignal | null | undefined, slug: string): number {
  return signal ? tierOf(signal.byPath[`/packages/${slug}`] ?? 0) : 0
}

/** Highest tier among the destinations that the given texts name (whole-word match). Pure. */
export function destinationTier(signal: ConversionSignal | null | undefined, texts: (string | null | undefined)[]): number {
  if (!signal) return 0
  const dests = Object.keys(signal.byDestination)
  if (dests.length === 0) return 0
  let best = 0
  for (const t of texts) {
    const hay = ` ${normDest(t ?? '')} `
    if (hay.trim() === '') continue
    for (const d of dests) if (hay.includes(` ${d} `)) best = Math.max(best, tierOf(signal.byDestination[d]))
  }
  return best
}

/** Tier of a blog topic: its own trip when it names one, otherwise the best destination its keyword set or angle mentions. Pure. */
export function topicTier(signal: ConversionSignal | null | undefined, item: { keyword: string; keywords?: string[] | null; angle?: string | null; package_slug?: string | null }): number {
  if (!signal || signal.sample === 0) return 0
  const own = item.package_slug ? packageTier(signal, item.package_slug) : 0
  return Math.max(own, destinationTier(signal, [item.keyword, ...(item.keywords ?? []), item.angle ?? '']))
}

/** One plain sentence on why a tier counts, for the decisions log. Pure. */
export function explainTier(signal: ConversionSignal, slug: string): string {
  const score = signal.byPath[`/packages/${slug}`] ?? 0
  return `its page earned a conversion score of ${score} (leads count 1, booked leads 3, paid orders 5; ${MIN_SIGNAL_SCORE} is the minimum before it counts) from ${signal.sample} recent lead and order rows`
}

// ---- loading -------------------------------------------------------------------------------------------------------------------

let cached: ConversionSignal = EMPTY_SIGNAL

/** The last signal loaded in this process (EMPTY_SIGNAL before any load). Lets the sync guide ordering use it without a database call. */
export function getCachedSignal(): ConversionSignal {
  return cached
}
/** For tests. */
export function setCachedSignal(s: ConversionSignal): void {
  cached = s
}

/** Reads recent leads (test leads excluded), paid orders (test orders excluded) and published trips, and builds the signal. Any read
 * failure gives the EMPTY signal, so an outage can only make the ordering plain, never wrong. Caches the result for getCachedSignal. */
export async function loadConversionSignal(admin: SupabaseClient, now: Date = new Date()): Promise<ConversionSignal> {
  try {
    const leadSince = new Date(now.getTime() - LEAD_WINDOW_DAYS * 86_400_000).toISOString()
    const orderSince = new Date(now.getTime() - ORDER_WINDOW_DAYS * 86_400_000).toISOString()
    const [leads, orders, pkgs] = await Promise.all([
      admin.from('leads').select('page_path, status').eq('is_test', false).gte('created_at', leadSince).limit(MAX_ROWS),
      admin.from('orders').select('package_slug').eq('status', 'paid').eq('is_test', false).gte('created_at', orderSince).limit(MAX_ROWS),
      admin.from('travel_packages').select('slug, destination').eq('status', 'published').limit(500),
    ])
    // The status column exists from migration 0055; before it, retry without it so leads still count.
    let leadRows = leads.data as SignalLead[] | null
    if (leads.error) {
      const plain = await admin.from('leads').select('page_path').eq('is_test', false).gte('created_at', leadSince).limit(MAX_ROWS)
      leadRows = plain.error ? null : (plain.data as SignalLead[] | null)
    }
    if (!leadRows || orders.error || pkgs.error) {
      cached = EMPTY_SIGNAL
      return cached
    }
    cached = buildSignal({ leads: leadRows, orders: (orders.data ?? []) as SignalOrder[], packages: (pkgs.data ?? []) as SignalPackage[] })
    return cached
  } catch {
    cached = EMPTY_SIGNAL
    return cached
  }
}
