import type { SupabaseClient } from '@supabase/supabase-js'
import { getSetting, getSettingStrict, setSetting } from '@/lib/app-settings'

// Page copy (compare and best-time pages) that could not be written, remembered in app_settings. Same shape and
// same three jobs as lib/guide-failures.ts, under separate keys so a guide problem never pauses page copy and
// the other way round: skip a path after MAX_COPY_ATTEMPTS failures, pause the whole step when failures pile up
// (the breaker), and feed a "Needs attention" item in lib/issues.ts.
export const COPY_FAILURES_KEY = 'page_copy_compose_failures'
// Every failure time, newest last, NOT cleared by a later success. This is what the breaker counts.
export const COPY_FAILURE_LOG_KEY = 'page_copy_failure_log'
export const MAX_COPY_ATTEMPTS = 2
/** This many failures in the last COPY_BREAKER_HOURS pauses the step before any AI call. */
export const COPY_BREAKER_FAILURES = 3
export const COPY_BREAKER_HOURS = 24

export interface CopyFailure {
  /** How many times writing it failed. */
  n: number
  /** The page path, for example /compare/italy-vs-tahiti. */
  path: string
  /** The plain-English reason from the last failure. */
  last: string
  /** When the last failure happened (ISO). */
  at: string
}

export type CopyFailures = Record<string, CopyFailure>

function parseFailures(value: string | null): CopyFailures {
  if (!value) return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as CopyFailures) : {}
  } catch {
    return {}
  }
}

export async function readCopyFailures(admin: SupabaseClient): Promise<CopyFailures> {
  return parseFailures(await getSetting(admin, COPY_FAILURES_KEY))
}

/** Like readCopyFailures but a read error is reported, so a caller can tell "none" from "could not read". */
export async function readCopyFailuresChecked(admin: SupabaseClient): Promise<{ failures: CopyFailures; error?: string }> {
  const { value, error } = await getSettingStrict(admin, COPY_FAILURES_KEY)
  return error ? { failures: {}, error } : { failures: parseFailures(value) }
}

/** Bumps and returns the failure count for one path. A read error skips the write (returns 1). */
export async function recordCopyFailure(admin: SupabaseClient, path: string, reason: string): Promise<number> {
  const now = new Date().toISOString()
  const { failures, error } = await readCopyFailuresChecked(admin)
  if (error) return 1
  const n = (failures[path]?.n ?? 0) + 1
  failures[path] = { n, path, last: reason.slice(0, 300), at: now }
  await setSetting(admin, COPY_FAILURES_KEY, JSON.stringify(failures))

  const log = await getSettingStrict(admin, COPY_FAILURE_LOG_KEY)
  if (!log.error) {
    let times: string[] = []
    try {
      const parsed = JSON.parse(log.value || '[]')
      if (Array.isArray(parsed)) times = parsed.filter((t): t is string => typeof t === 'string')
    } catch {
      times = []
    }
    await setSetting(admin, COPY_FAILURE_LOG_KEY, JSON.stringify([...times, now].slice(-20)))
  }
  return n
}

/** Failures recorded in the last `hours` hours, or null when the log could not be read (callers fail closed). */
export async function recentCopyFailureCount(admin: SupabaseClient, hours = COPY_BREAKER_HOURS): Promise<number | null> {
  const { value, error } = await getSettingStrict(admin, COPY_FAILURE_LOG_KEY)
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

export async function clearCopyFailure(admin: SupabaseClient, path: string): Promise<void> {
  const { failures, error } = await readCopyFailuresChecked(admin)
  if (error || !(path in failures)) return
  delete failures[path]
  await setSetting(admin, COPY_FAILURES_KEY, JSON.stringify(failures))
}

/** Forgets every failure and the breaker's log (the "Dismiss" button on the issue). */
export async function clearAllCopyFailures(admin: SupabaseClient): Promise<{ error?: string }> {
  const a = await setSetting(admin, COPY_FAILURES_KEY, '')
  if (a.error) return a
  return setSetting(admin, COPY_FAILURE_LOG_KEY, '')
}
