import type { SupabaseClient } from '@supabase/supabase-js'
import { getSettingStrict, setSetting } from '@/lib/app-settings'

// A network that keeps failing is put on a short pause by the funnel watchdog (lib/funnel-watchdog.ts): for that time posts
// skip it, then it is tried again by itself (the "auto-test"). One small JSON row in app_settings, so nothing is deleted and the
// pause ends on its own even if nobody looks. The posting target (lib/social-provider.ts) reads it; a pause that cannot be read
// pauses nothing (a missing pause must never stop posting).

export const NETWORK_PAUSES_KEY = 'network_pauses'
export const NETWORK_PAUSE_HOURS = 24

export interface NetworkPause {
  /** Pause ends at this time. */
  until: string
  /** When this pause began. */
  since: string
  /** How many pauses this network has had in a row without a clean send between them. */
  strikes: number
}

export type NetworkPauses = Record<string, NetworkPause>

/** Reads the stored map. Anything that is not the expected shape is dropped. Pure. */
export function parsePauses(raw: string | null | undefined): NetworkPauses {
  if (!raw) return {}
  try {
    const v = JSON.parse(raw) as unknown
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
    const out: NetworkPauses = {}
    for (const [net, p] of Object.entries(v as Record<string, unknown>)) {
      const o = p as Partial<NetworkPause> | null
      if (o && typeof o.until === 'string' && Number.isFinite(Date.parse(o.until)) && typeof o.since === 'string') out[net] = { until: o.until, since: o.since, strikes: typeof o.strikes === 'number' && o.strikes > 0 ? Math.floor(o.strikes) : 1 }
    }
    return out
  } catch {
    return {}
  }
}

/** Networks that are paused at `now`. Pure. */
export function pausedNow(pauses: NetworkPauses, now: Date = new Date()): string[] {
  return Object.entries(pauses)
    .filter(([, p]) => Date.parse(p.until) > now.getTime())
    .map(([n]) => n)
}

export async function readPauses(admin: SupabaseClient): Promise<NetworkPauses | null> {
  try {
    const r = await getSettingStrict(admin, NETWORK_PAUSES_KEY)
    return r.error ? null : parsePauses(r.value)
  } catch {
    return null
  }
}

/** The networks paused right now. [] when the row cannot be read. */
export async function pausedNetworks(admin: SupabaseClient, now: Date = new Date()): Promise<string[]> {
  const p = await readPauses(admin)
  return p ? pausedNow(p, now) : []
}

export async function writePauses(admin: SupabaseClient, pauses: NetworkPauses): Promise<{ error?: string }> {
  return setSetting(admin, NETWORK_PAUSES_KEY, JSON.stringify(pauses))
}
