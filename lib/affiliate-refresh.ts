import type { SupabaseClient } from '@supabase/supabase-js'
import { clearAffiliateRulesCache } from '@/lib/affiliate-rules'
import { rescanSite } from '@/lib/affiliate-usage'

// WP22: every create, edit, ON, OFF and delete of an affiliate link or a word-link rule must show on the whole site at once.
// Pages link words at display time, so nothing stored changes; what has to be refreshed is (1) the in-memory rules read of
// this server, (2) the cached pages (Incremental Static Regeneration), and (3) the usage report.
//
// (1) and (2) happen on every change. (3) reads up to 500 documents, so it runs at most once a minute: a change inside that
// minute only raises a "pending" flag, and one deferred scan runs when the minute is over (a timer on this server, or the
// next time the admin screen loads, whichever comes first). The Rescan button always scans at once.

export const USAGE_MIN_GAP_MS = 60_000

export interface RefreshDeps {
  /** Drops cached pages. Default: revalidatePath('/', 'layout') from next/cache. */
  revalidate?: () => void | Promise<void>
  /** Recomputes the usage report. Default: rescanSite. */
  rescan?: (admin: SupabaseClient) => Promise<{ ok: boolean }>
  /** The clock, in milliseconds. Default: Date.now. */
  now?: () => number
  /** Schedules the deferred scan. Default: an unreferenced setTimeout. */
  schedule?: (run: () => void, delayMs: number) => void
}

async function defaultRevalidate(): Promise<void> {
  const { revalidatePath } = await import('next/cache')
  revalidatePath('/', 'layout')
}

let lastScanAt = 0
let pending = false
let timerSet = false

/** For tests: forget the last scan and any pending flag. */
export function resetUsageDebounce(): void {
  lastScanAt = 0
  pending = false
  timerSet = false
}

export const usageRefreshPending = (): boolean => pending

/** Call after a scan made some other way (the Rescan button), so the next change does not scan again straight away. */
export function noteUsageScanned(now: number = Date.now()): void {
  lastScanAt = now
  pending = false
}

async function runScan(admin: SupabaseClient, deps: RefreshDeps): Promise<boolean> {
  lastScanAt = (deps.now ?? Date.now)()
  let ok = false
  try {
    ok = (await (deps.rescan ?? rescanSite)(admin)).ok
  } catch {
    ok = false
  }
  pending = !ok // a failed scan stays pending so the next flush tries again
  return ok
}

/** Runs the deferred scan if one is waiting and the minute is over. Never throws. */
export async function flushPendingUsage(admin: SupabaseClient, deps: RefreshDeps = {}): Promise<boolean> {
  if (!pending) return false
  const now = (deps.now ?? Date.now)()
  if (now - lastScanAt < USAGE_MIN_GAP_MS) return false
  return runScan(admin, deps)
}

export interface RefreshResult {
  rules: true
  pages: boolean
  /** The usage report was recomputed now. */
  usage: boolean
  /** The report will be recomputed later (a scan already ran in the last minute). */
  deferred: boolean
}

/** Never throws: a failed refresh must not turn a saved change into an error. The result says what worked. */
export async function refreshAfterChange(admin: SupabaseClient, deps: RefreshDeps = {}): Promise<RefreshResult> {
  clearAffiliateRulesCache()
  let pages = false
  try {
    await (deps.revalidate ?? defaultRevalidate)()
    pages = true
  } catch {
    pages = false
  }
  const now = (deps.now ?? Date.now)()
  if (now - lastScanAt >= USAGE_MIN_GAP_MS) {
    return { rules: true, pages, usage: await runScan(admin, deps), deferred: false }
  }
  pending = true
  if (!timerSet) {
    timerSet = true
    const delay = Math.max(1000, USAGE_MIN_GAP_MS - (now - lastScanAt) + 1000)
    const schedule = deps.schedule ?? ((run, ms) => {
      const t = setTimeout(run, ms) as unknown as { unref?: () => void }
      t.unref?.()
    })
    try {
      schedule(() => {
        timerSet = false
        void flushPendingUsage(admin, deps)
      }, delay)
    } catch {
      timerSet = false
    }
  }
  return { rules: true, pages, usage: false, deferred: true }
}
