import { CRON_NAMES, type CronName, type CronRun } from '@/lib/cron-heartbeat'

// Factory Phase 7 (speedometers/tasks), trimmed way down from Nomad's engine-health.ts. Their
// version judges two whole pipelines (autoblog + social distribution/reels) this project hasn't
// built - GHL Social Planner, Shotstack, post_distribution job states, Pinterest board checks.
// Building that judgement logic against pipelines that don't exist yet would just be misleading
// placeholders. What's genuinely useful right now, with zero new infrastructure: "is each
// registered cron actually firing, and did its last run report a problem" - the same heartbeat
// data lib/cron-heartbeat.ts (Phase 1) has been recording into all along, with nothing reading
// it back yet.
export type Light = 'green' | 'amber' | 'gray'

export interface CronStatus {
  name: CronName
  light: Light
  label: string
}

/** How long a cron can go quiet before its silence itself is the problem. Every registered cron
 * here runs at most daily today (autoblog, gsc-snapshot); a generous 26h margin (a day plus
 * slack) catches "stopped running" without false-alarming on ordinary scheduler jitter. */
const STALE_MS = 26 * 60 * 60 * 1000

function siteTime(iso: string): string {
  return new Date(iso).toLocaleString('en-CA', { timeZone: 'America/Toronto', dateStyle: 'medium', timeStyle: 'short' })
}

/** Judge one cron's status from its last recorded heartbeat. Pure - same input, same answer. */
export function judgeCron(name: CronName, run: CronRun | undefined, now: number = Date.now()): CronStatus {
  if (!run) return { name, light: 'gray', label: 'Never run since this was added' }
  const age = now - Date.parse(run.at)
  if (!Number.isFinite(age)) return { name, light: 'gray', label: 'Never run since this was added' }
  if (age > STALE_MS) return { name, light: 'amber', label: `Hasn't run since ${siteTime(run.at)}` }
  if (!run.ok) return { name, light: 'amber', label: `Last run (${siteTime(run.at)}) reported a problem${run.note ? `: ${run.note}` : ''}` }
  return { name, light: 'green', label: `Ran ${siteTime(run.at)}${run.note ? ` - ${run.note}` : ''}` }
}

/** Every registered cron's status, in CRON_NAMES order. */
export function judgeAllCrons(runs: Partial<Record<CronName, CronRun>>, now: number = Date.now()): CronStatus[] {
  return CRON_NAMES.map((name) => judgeCron(name, runs[name], now))
}
