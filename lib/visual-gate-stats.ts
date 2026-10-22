import type { SupabaseClient } from '@supabase/supabase-js'
import { getSetting, setSetting } from '@/lib/app-settings'

// Counters for the Instagram visual quality gate (lib/visual-gate.ts), kept in ONE app_settings JSON value so no
// migration is needed. A skipped image is a silent, counted event: it shows in the Visual quality tile on the
// Content Autopilot page, never as a Needs attention alert. Every read and write is wrapped in try/catch and fails
// open: a counter problem must never block or change a post.

export const VISUAL_GATE_STATS_KEY = 'visual_gate_stats'
export const STATS_KEEP_DAYS = 14
export const STATS_WINDOW_DAYS = 7
export const RECENT_SKIPS_KEEP = 12

export type GateEvent = 'pass' | 'retry' | 'skip' | 'deferred'
export type GateSurface = 'feed' | 'carousel' | 'reel'

export interface DayCounts {
  pass: number
  retry: number
  skip: number
  deferred: number
}

export interface SkipEntry {
  at: string
  slug: string
  surface: GateSurface
  reason: string
}

export interface GateStats {
  days: Record<string, DayCounts>
  recentSkips: SkipEntry[]
}

const emptyDay = (): DayCounts => ({ pass: 0, retry: 0, skip: 0, deferred: 0 })
export const emptyStats = (): GateStats => ({ days: {}, recentSkips: [] })

export function parseStats(raw: string | null | undefined): GateStats {
  if (!raw) return emptyStats()
  try {
    const j = JSON.parse(raw) as Partial<GateStats> | null
    const days: Record<string, DayCounts> = {}
    for (const [k, v] of Object.entries(j?.days ?? {})) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(k) || !v || typeof v !== 'object') continue
      const d = v as Partial<DayCounts>
      days[k] = { pass: Number(d.pass) || 0, retry: Number(d.retry) || 0, skip: Number(d.skip) || 0, deferred: Number(d.deferred) || 0 }
    }
    const recentSkips = Array.isArray(j?.recentSkips) ? (j as Partial<GateStats>).recentSkips!.filter((s): s is SkipEntry => !!s && typeof s.slug === 'string').slice(0, RECENT_SKIPS_KEEP) : []
    return { days, recentSkips }
  } catch {
    return emptyStats()
  }
}

/** Pure: returns the stats with one event added for `now`'s day, days older than STATS_KEEP_DAYS dropped. */
export function bumpStats(stats: GateStats, event: GateEvent, now: Date, skip?: { slug: string; surface: GateSurface; reason: string }): GateStats {
  const day = now.toISOString().slice(0, 10)
  const days: Record<string, DayCounts> = { ...stats.days, [day]: { ...(stats.days[day] ?? emptyDay()) } }
  days[day][event] += 1
  const cutoff = now.getTime() - STATS_KEEP_DAYS * 86_400_000
  for (const k of Object.keys(days)) if (Date.parse(`${k}T00:00:00Z`) < cutoff) delete days[k]
  const recentSkips = skip ? [{ at: now.toISOString(), slug: skip.slug, surface: skip.surface, reason: skip.reason.slice(0, 200) }, ...stats.recentSkips].slice(0, RECENT_SKIPS_KEEP) : stats.recentSkips
  return { days, recentSkips }
}

/** Pure: totals over the last `windowDays` days including today. */
export function sumRecent(stats: GateStats, now: Date, windowDays = STATS_WINDOW_DAYS): DayCounts {
  const out = emptyDay()
  const cutoff = now.getTime() - windowDays * 86_400_000
  for (const [k, v] of Object.entries(stats.days)) {
    if (Date.parse(`${k}T23:59:59Z`) < cutoff) continue
    out.pass += v.pass
    out.retry += v.retry
    out.skip += v.skip
    out.deferred += v.deferred
  }
  return out
}

/** Adds one event. Read-modify-write on one row: two events in the same instant can lose one count, which is fine for
 * a health counter. Never throws. */
export async function recordGateEvent(admin: SupabaseClient, event: GateEvent, skip?: { slug: string; surface: GateSurface; reason: string }): Promise<void> {
  return recordGateEvents(admin, [event], skip)
}

/** Several events in one read and one write (a pass with retries). The skip detail is attached to the first 'skip' event. */
export async function recordGateEvents(admin: SupabaseClient, events: GateEvent[], skip?: { slug: string; surface: GateSurface; reason: string }): Promise<void> {
  if (events.length === 0) return
  try {
    let stats = parseStats(await getSetting(admin, VISUAL_GATE_STATS_KEY))
    const now = new Date()
    let attached = false
    for (const event of events) {
      const detail = event === 'skip' && !attached ? skip : undefined
      if (detail) attached = true
      stats = bumpStats(stats, event, now, detail)
    }
    const res = await setSetting(admin, VISUAL_GATE_STATS_KEY, JSON.stringify(stats))
    if (res.error) console.warn('[visual-gate] could not save the counter:', res.error)
  } catch (err) {
    console.warn('[visual-gate] counter failed:', err instanceof Error ? err.message : err)
  }
}

export interface VisualQuality {
  windowDays: number
  totals: DayCounts
  recentSkips: SkipEntry[]
  /** False when the counter could not be read (the tile then says so instead of showing zeros). */
  available: boolean
}

export async function readVisualQuality(admin: SupabaseClient): Promise<VisualQuality> {
  try {
    const stats = parseStats(await getSetting(admin, VISUAL_GATE_STATS_KEY))
    return { windowDays: STATS_WINDOW_DAYS, totals: sumRecent(stats, new Date()), recentSkips: stats.recentSkips, available: true }
  } catch {
    return { windowDays: STATS_WINDOW_DAYS, totals: emptyDay(), recentSkips: [], available: false }
  }
}
