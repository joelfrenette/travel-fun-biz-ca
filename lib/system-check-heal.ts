import type { SupabaseClient } from '@supabase/supabase-js'
import { getSetting, setSetting } from '@/lib/app-settings'
import { isAutomationPaused } from '@/lib/automation-kill-switch'
import { runFunnelWatchdog } from '@/lib/funnel-watchdog'
import { runApproveSafeTopics, runRetryFailedPosts } from '@/lib/auto-policies'
import { runSiteCrawl } from '@/lib/site-crawl-run'
import type { HealReport, HealStep } from '@/lib/system-check-prompt'

// "Auto-heal" on the System check page: ONE pass through the safe, bounded repairs the site already makes on its own every day,
// started by a person. It adds no new autonomy: every step below is an existing function that checks the kill switch, its own
// on/off switch and its own daily cap, and logs what it did to the Autopilot decisions card with an Undo. It makes NO AI call of
// its own (so nothing here costs credits), posts nothing new, and publishes nothing. A second click inside the cooldown returns the
// last answer instead of running again.

export const HEAL_LAST_KEY = 'auto_heal_last'
export const HEAL_COOLDOWN_MS = 90_000
/** Time the site crawl step may use. The route has 60 seconds in total. */
export const HEAL_CRAWL_BUDGET_MS = 25_000

/** Seconds left of the cooldown (0 = free to run). Pure. */
export function cooldownLeftSeconds(lastAt: string | null | undefined, now: Date, cooldownMs: number = HEAL_COOLDOWN_MS): number {
  const t = Date.parse(lastAt ?? '')
  if (!Number.isFinite(t)) return 0
  const left = cooldownMs - (now.getTime() - t)
  return left > 0 ? Math.ceil(left / 1000) : 0
}

/** Reads a stored report back, or null when it is missing or damaged. Pure. */
export function parseHealReport(raw: string | null | undefined): HealReport | null {
  if (!raw) return null
  try {
    const p = JSON.parse(raw) as Partial<HealReport> | null
    if (!p || typeof p.at !== 'string' || !Array.isArray(p.steps)) return null
    const steps: HealStep[] = []
    for (const s of p.steps) {
      if (!s || typeof s.id !== 'string' || typeof s.label !== 'string') continue
      steps.push({ id: s.id, label: s.label, ran: s.ran === true, acted: Number.isFinite(s.acted) ? Number(s.acted) : 0, note: typeof s.note === 'string' ? s.note : '' })
    }
    return { at: p.at, paused: p.paused === true, steps }
  } catch {
    return null
  }
}

export interface HealDeps {
  now?: Date
  /** Test seams: replace the real repairs. */
  watchdog?: () => Promise<{ note: string; decisions: unknown[] }>
  retry?: () => Promise<{ acted: number; note: string }>
  topics?: () => Promise<{ acted: number; note: string }>
  crawl?: () => Promise<{ note: string; fixed: number; changedPaths: string[] }>
}

export interface HealRun {
  report: HealReport
  /** Pages whose cache the route should refresh (the crawl's repairs). */
  changedPaths: string[]
  /** True when the cooldown returned the last report and nothing ran. */
  cooledDown: boolean
  cooldownSeconds: number
}

async function step(id: string, label: string, fn: () => Promise<{ acted: number; note: string }>): Promise<HealStep> {
  try {
    const r = await fn()
    return { id, label, ran: true, acted: r.acted, note: r.note }
  } catch (e) {
    return { id, label, ran: true, acted: 0, note: `failed: ${e instanceof Error ? e.message : 'unknown error'}` }
  }
}

/** Runs the safe repairs once. Never throws. */
export async function runAutoHeal(admin: SupabaseClient, deps: HealDeps = {}): Promise<HealRun> {
  const now = deps.now ?? new Date()
  const last = parseHealReport(await getSetting(admin, HEAL_LAST_KEY).catch(() => null))
  const wait = cooldownLeftSeconds(last?.at, now)
  if (last && wait > 0) return { report: last, changedPaths: [], cooledDown: true, cooldownSeconds: wait }

  const paused = await isAutomationPaused(admin).catch(() => true)
  const labels = {
    watchdog: 'Funnel watchdog repairs',
    retry: 'Retry failed posts and resume stuck steps',
    topics: 'Approve safe blog topics',
    crawl: 'Site crawl safe repairs',
  }
  if (paused) {
    const report: HealReport = {
      at: now.toISOString(),
      paused: true,
      steps: Object.entries(labels).map(([id, label]) => ({ id, label, ran: false, acted: 0, note: 'automation is paused (kill switch)' })),
    }
    await setSetting(admin, HEAL_LAST_KEY, JSON.stringify(report)).catch(() => undefined)
    return { report, changedPaths: [], cooledDown: false, cooldownSeconds: 0 }
  }

  let changedPaths: string[] = []
  const steps: HealStep[] = []
  steps.push(
    await step('watchdog', labels.watchdog, async () => {
      const w = await (deps.watchdog ?? (() => runFunnelWatchdog(admin, { now })))()
      return { acted: w.decisions.length, note: w.note }
    }),
  )
  steps.push(await step('retry', labels.retry, deps.retry ?? (() => runRetryFailedPosts(admin, now))))
  steps.push(await step('topics', labels.topics, deps.topics ?? (() => runApproveSafeTopics(admin, now))))
  steps.push(
    await step('crawl', labels.crawl, async () => {
      const c = await (deps.crawl ?? (() => runSiteCrawl(admin, { deadlineMs: Date.now() + HEAL_CRAWL_BUDGET_MS })))()
      changedPaths = c.changedPaths
      return { acted: c.fixed, note: c.note }
    }),
  )
  const report: HealReport = { at: now.toISOString(), paused: false, steps }
  await setSetting(admin, HEAL_LAST_KEY, JSON.stringify(report)).catch(() => undefined)
  return { report, changedPaths, cooledDown: false, cooldownSeconds: 0 }
}
