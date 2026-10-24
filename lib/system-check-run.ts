import type { SupabaseClient } from '@supabase/supabase-js'
import { getSettingStrict, setSetting } from '@/lib/app-settings'
import { collectIssues, type Issue } from '@/lib/issues'
import { ORDER_WEBHOOK_ISSUE_ID } from '@/lib/plain-steps'
import { readCronRuns } from '@/lib/cron-heartbeat'
import { judgeCron } from '@/lib/cron-health'
import { WATCHDOG_LAST_KEY } from '@/lib/funnel-watchdog'
import { STATE_KEY as CRAWL_STATE_KEY, parseState as parseCrawlState, summarize as summarizeCrawl } from '@/lib/site-crawl'
import { loadView } from '@/lib/seo-playbook-view'
import { readStoredAiSpend } from '@/lib/ai-tripwire'
import { DECISIONS_KEY, parseDecisions } from '@/lib/auto-decisions'
import { VISUAL_GATE_STATS_KEY, parseStats, sumRecent } from '@/lib/visual-gate-stats'
import { readHotWait } from '@/lib/lead-desk-store'
import { readDone } from '@/lib/followups-run'
import { FOLLOWUPS_DONE_KEY, applyMark, serializeDone, siteDay } from '@/lib/followups'
import { buildFixList, fixIdOf, stageOfFixId, withMarks, type FixView } from '@/lib/system-check-fixes'
import {
  type StageId, SYSTEM_CHECK_KEY, SYSTEM_CHECK_STALE_MS, SYSTEM_CHECK_TTL_MS, evaluateCheck, isFresh, parseCheck, serializeCheck,
  type CheckFacts, type CheckResult, type JobFact, type WatchdogLike,
} from '@/lib/system-check'

// Reads every fact the system check needs, each on its own, so one that fails becomes "could not be read" (null) and never
// takes the page down or turns into a zero. The heavy checks (the funnel watchdog, the site crawl, the SEO audit) run in the
// daily step; this file only reads their stored answers, so a check is cheap and safe to run on a page view. Read only apart
// from saving its own answer. No AI call, nothing posted.

async function safe<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn()
  } catch {
    return null
  }
}

async function strict(admin: SupabaseClient, key: string): Promise<string | null | undefined> {
  const r = await getSettingStrict(admin, key)
  return r.error ? undefined : r.value
}

const hoursSince = (iso: string, now: Date): number | null => {
  const t = Date.parse(iso)
  return Number.isFinite(t) ? Math.max(0, (now.getTime() - t) / 3_600_000) : null
}

export interface CheckDeps {
  now?: Date
  /** The Needs attention list, when the caller already has it (the Today page does). */
  issues?: Issue[]
}

export async function readCheckFacts(admin: SupabaseClient, deps: CheckDeps = {}): Promise<CheckFacts> {
  const now = deps.now ?? new Date()

  const watchdog = await safe(async () => {
    const raw = await strict(admin, WATCHDOG_LAST_KEY)
    if (raw === undefined) throw new Error('unreadable')
    if (!raw) return { at: null as string | null, checks: [] as WatchdogLike[] }
    const v = JSON.parse(raw) as { at?: string; checks?: WatchdogLike[] } | null
    if (!v || typeof v.at !== 'string' || !Array.isArray(v.checks)) return { at: null as string | null, checks: [] as WatchdogLike[] }
    return { at: v.at, checks: v.checks }
  })

  const crawl = await safe(async () => {
    const raw = await strict(admin, CRAWL_STATE_KEY)
    if (raw === undefined) throw new Error('unreadable')
    const s = summarizeCrawl(parseCrawlState(raw), now)
    return { lastRun: s.lastRun, errors: s.errors, warnings: s.warnings }
  })

  const seo = await safe(async () => {
    const view = await loadView(admin)
    return { score: view.auditAt ? view.overall : null, failing: view.counts.fail }
  })

  const jobs = await safe(async () => {
    const runs = await readCronRuns(admin)
    const fact = (name: 'autopilot' | 'gsc-snapshot'): JobFact => {
      const run = runs[name]
      const j = judgeCron(name, run, now.getTime())
      return { light: j.light === 'green' ? 'green' : j.light === 'amber' ? 'amber' : 'gray', ageHours: run ? hoursSince(run.at, now) : null }
    }
    return { autopilot: fact('autopilot'), daily: fact('gsc-snapshot') }
  })

  const ai = await safe(async () => {
    const s = await readStoredAiSpend(admin, now.getTime())
    return { spend: s.spend, ceiling: s.ceiling }
  })

  const orders = await safe(async () => {
    const since = new Date(now.getTime() - 30 * 86_400_000).toISOString()
    const res = await admin.from('orders').select('id', { count: 'exact', head: true }).eq('is_test', false).eq('status', 'paid').gte('created_at', since)
    const paid30d = res.error ? null : res.count ?? 0
    const issues = deps.issues ?? (await safe(() => collectIssues(admin))) ?? []
    return { paid30d, webhookFailing: issues.some((i) => i.id === ORDER_WEBHOOK_ISSUE_ID) }
  })

  const gateSkips7d = await safe(async () => {
    const raw = await strict(admin, VISUAL_GATE_STATS_KEY)
    if (raw === undefined) throw new Error('unreadable')
    return sumRecent(parseStats(raw), now).skip
  })

  const decisions = await safe(async () => {
    const raw = await strict(admin, DECISIONS_KEY)
    if (raw === undefined) throw new Error('unreadable')
    return parseDecisions(raw)
  })

  // The lead desk: hot leads still waiting for an agent. Null before migration 0055 (the columns are not there), which just leaves the stage as it was.
  const hotLeads = await safe(() => readHotWait(admin, now))

  return { now, watchdog, crawl, seo, jobs, ai, orders, gateSkips7d, decisions, hotLeads }
}

/** Reads the facts and judges them. Never throws. */
export async function computeSystemCheck(admin: SupabaseClient, deps: CheckDeps = {}): Promise<CheckResult> {
  return evaluateCheck(await readCheckFacts(admin, deps))
}

/** The last stored answer of any age, or null. Cheap: one settings read. */
export async function readStoredCheck(admin: SupabaseClient): Promise<CheckResult | null> {
  try {
    return parseCheck(await strict(admin, SYSTEM_CHECK_KEY))
  } catch {
    return null
  }
}

export interface GotCheck {
  result: CheckResult
  /** True when the stored answer was young enough and nothing was re-read. */
  cached: boolean
  /** Set when the fresh answer could not be saved (the answer is still good). */
  saveWarning?: string
}

/** The check, from the 5 minute cache when possible. A stale or missing answer is recomputed and saved. Never throws. */
export async function getSystemCheck(admin: SupabaseClient, opts: CheckDeps & { force?: boolean; maxAgeMs?: number } = {}): Promise<GotCheck> {
  const now = opts.now ?? new Date()
  if (!opts.force) {
    const stored = await readStoredCheck(admin)
    if (stored && isFresh(stored.at, now.getTime(), opts.maxAgeMs ?? SYSTEM_CHECK_TTL_MS)) return { result: stored, cached: true }
  }
  const result = await computeSystemCheck(admin, { now, issues: opts.issues })
  const saved = await setSetting(admin, SYSTEM_CHECK_KEY, serializeCheck(result)).catch((e) => ({ error: e instanceof Error ? e.message : 'could not save' }))
  return { result, cached: false, ...(saved.error ? { saveWarning: saved.error } : {}) }
}

/** The fix list for a check result, with today's ticks. If the ticks cannot be read, every item shows as open. Never throws. */
export async function loadFixes(admin: SupabaseClient, result: CheckResult | null, now: Date = new Date()): Promise<FixView[]> {
  const items = buildFixList(result)
  if (items.length === 0) return []
  try {
    const { done } = await readDone(admin)
    return withMarks(items, done, siteDay(now))
  } catch {
    return withMarks(items, {}, siteDay(now))
  }
}

export type FixTickResult = { ok: true; fixes: FixView[] } | { ok: false; status: number; error: string }

/** Ticks one fix: done or later for today, or takes the tick back. Only a stage that is on the current fix list is accepted. */
export async function tickFix(admin: SupabaseClient, stage: unknown, op: 'done' | 'later' | 'reopen', now: Date = new Date()): Promise<FixTickResult> {
  const id = stage && typeof stage === 'string' ? fixIdOf(stage as StageId) : ''
  if (!stageOfFixId(id)) return { ok: false, status: 400, error: 'That is not a stage of the system check.' }
  const stored = await readStoredCheck(admin)
  if (!buildFixList(stored).some((f) => f.id === id)) return { ok: false, status: 404, error: 'That stage is not on the fix list any more. Check again.' }
  const { done, readable } = await readDone(admin)
  if (!readable) return { ok: false, status: 503, error: 'The saved ticks could not be read, so nothing was changed. Please try again.' }
  const saved = await setSetting(admin, FOLLOWUPS_DONE_KEY, serializeDone(applyMark(done, siteDay(now), { id, persist: false }, op)))
  if (saved.error) return { ok: false, status: 500, error: `The tick could not be saved (${saved.error}).` }
  return { ok: true, fixes: await loadFixes(admin, stored, now) }
}

/** For the 7 am brief: the daily step stored an answer a little while ago, and that is good enough. Only a missing or day-old one is recomputed. */
export async function getCheckForBrief(admin: SupabaseClient, opts: CheckDeps = {}): Promise<CheckResult> {
  return (await getSystemCheck(admin, { ...opts, maxAgeMs: SYSTEM_CHECK_STALE_MS })).result
}
