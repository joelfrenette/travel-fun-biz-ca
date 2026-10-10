import type { SupabaseClient } from '@supabase/supabase-js'
import { getSetting, getSettingStrict, setSetting } from '@/lib/app-settings'

// Guides that could not be written, remembered in app_settings (JSON, same idea as autoblog_compose_failures).
// Three jobs: the pipeline skips a candidate after MAX_GUIDE_ATTEMPTS failures so one bad name cannot burn
// credits every day; a global breaker pauses the guides step when failures pile up across candidates; and
// lib/issues.ts turns any entry into a "Needs attention" item. Kept in its own tiny file so the issue list can
// read it without importing the whole guide writer.
export const GUIDE_FAILURES_KEY = 'guides_compose_failures'
// Every failure time, newest last, NOT cleared by a later success. This is what the breaker counts.
export const GUIDE_FAILURE_LOG_KEY = 'guides_failure_log'
export const MAX_GUIDE_ATTEMPTS = 2
/** This many failures in the last BREAKER_HOURS pauses the step before any AI call. */
export const BREAKER_FAILURES = 3
export const BREAKER_HOURS = 24

export interface GuideFailure {
  /** How many times writing it failed. */
  n: number
  name: string
  kind: string
  /** The plain-English reason from the last failure. */
  last: string
  /** When the last failure happened (ISO). */
  at: string
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

/** Like readGuideFailures but a read error is reported, so a writer can skip the write instead of replacing
 * the stored list with a partial one. */
async function readStrict(admin: SupabaseClient): Promise<{ failures: GuideFailures; error?: string }> {
  const { value, error } = await getSettingStrict(admin, GUIDE_FAILURES_KEY)
  if (error) return { failures: {}, error }
  if (!value) return { failures: {} }
  try {
    const parsed = JSON.parse(value)
    return { failures: parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as GuideFailures) : {} }
  } catch {
    return { failures: {} }
  }
}

/** Bumps and returns the failure count for one guide (`kind:slug`). A read error skips the write. */
export async function recordGuideFailure(admin: SupabaseClient, key: string, info: { name: string; kind: string; reason: string }): Promise<number> {
  const now = new Date().toISOString()
  const { failures, error } = await readStrict(admin)
  if (error) return 1
  const n = (failures[key]?.n ?? 0) + 1
  failures[key] = { n, name: info.name, kind: info.kind, last: info.reason.slice(0, 300), at: now }
  await setSetting(admin, GUIDE_FAILURES_KEY, JSON.stringify(failures))

  const log = await getSettingStrict(admin, GUIDE_FAILURE_LOG_KEY)
  if (!log.error) {
    let times: string[] = []
    try {
      const parsed = JSON.parse(log.value || '[]')
      if (Array.isArray(parsed)) times = parsed.filter((t): t is string => typeof t === 'string')
    } catch {
      times = []
    }
    await setSetting(admin, GUIDE_FAILURE_LOG_KEY, JSON.stringify([...times, now].slice(-20)))
  }
  return n
}

/** Failures recorded in the last `hours` hours, or null when the log could not be read (callers fail closed). */
export async function recentGuideFailureCount(admin: SupabaseClient, hours = BREAKER_HOURS): Promise<number | null> {
  const { value, error } = await getSettingStrict(admin, GUIDE_FAILURE_LOG_KEY)
  if (error) return null
  if (!value) return 0
  try {
    const parsed = JSON.parse(value)
    if (!Array.isArray(parsed)) return 0
    const since = Date.now() - hours * 3_600_000
    return parsed.filter((t) => typeof t === 'string' && Date.parse(t) >= since).length
  } catch {
    return 0
  }
}

export async function clearGuideFailure(admin: SupabaseClient, key: string): Promise<void> {
  const { failures, error } = await readStrict(admin)
  if (error || !(key in failures)) return
  delete failures[key]
  await setSetting(admin, GUIDE_FAILURES_KEY, JSON.stringify(failures))
}

/** Forgets every failure and the breaker's log (the "Dismiss" button on the issue). */
export async function clearAllGuideFailures(admin: SupabaseClient): Promise<{ error?: string }> {
  const a = await setSetting(admin, GUIDE_FAILURES_KEY, '')
  if (a.error) return a
  return setSetting(admin, GUIDE_FAILURE_LOG_KEY, '')
}
