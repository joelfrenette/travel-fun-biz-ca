import type { SupabaseClient } from '@supabase/supabase-js'
import { getSetting, setSetting } from '@/lib/app-settings'

// Guides that could not be written, remembered in app_settings (JSON, same idea as autoblog_compose_failures).
// Two jobs: the pipeline skips a candidate after MAX_GUIDE_ATTEMPTS failures so one bad name cannot burn
// credits every day, and lib/issues.ts turns any entry into a "Needs attention" item. Kept in its own tiny
// file so the issue list can read it without importing the whole guide writer.
export const GUIDE_FAILURES_KEY = 'guides_compose_failures'
export const MAX_GUIDE_ATTEMPTS = 2

export interface GuideFailure {
  /** How many times writing it failed. */
  n: number
  name: string
  kind: string
  /** The plain-English reason from the last failure. */
  last: string
}

export type GuideFailures = Record<string, GuideFailure>

export async function readGuideFailures(admin: SupabaseClient): Promise<GuideFailures> {
  const raw = await getSetting(admin, GUIDE_FAILURES_KEY)
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as GuideFailures) : {}
  } catch {
    return {}
  }
}

/** Bumps and returns the failure count for one guide (`kind:slug`). */
export async function recordGuideFailure(admin: SupabaseClient, key: string, info: { name: string; kind: string; reason: string }): Promise<number> {
  const all = await readGuideFailures(admin)
  const n = (all[key]?.n ?? 0) + 1
  all[key] = { n, name: info.name, kind: info.kind, last: info.reason.slice(0, 300) }
  await setSetting(admin, GUIDE_FAILURES_KEY, JSON.stringify(all))
  return n
}

export async function clearGuideFailure(admin: SupabaseClient, key: string): Promise<void> {
  const all = await readGuideFailures(admin)
  if (!(key in all)) return
  delete all[key]
  await setSetting(admin, GUIDE_FAILURES_KEY, JSON.stringify(all))
}

/** Forgets every failure (the "Dismiss" button on the issue). */
export async function clearAllGuideFailures(admin: SupabaseClient): Promise<{ error?: string }> {
  return setSetting(admin, GUIDE_FAILURES_KEY, '')
}
