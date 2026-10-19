import type { SupabaseClient } from '@supabase/supabase-js'
import { readCronRuns } from '@/lib/cron-heartbeat'
import { judgeCron, type CronStatus } from '@/lib/cron-health'
import { getSetting } from '@/lib/app-settings'
import { sendThrottledAlert } from '@/lib/alerts'

// The 15-minute autopilot cron is what runs every other step. If it stops (a bad deploy, a missing
// CRON_SECRET, a dropped schedule) nothing else reports it, because the thing that reports is the
// thing that stopped. The daily gsc-snapshot cron is a separate schedule, so it can watch it.

export interface WatchdogAlert {
  subject: string
  steps: string[]
}

/** Pure: an alert only when the light is amber because the run is stale, Autopilot is on, and the
 * kill switch is not set. A missing heartbeat (gray) never alerts: it may simply be new. */
export function decideWatchdog(judgement: CronStatus | null | undefined, autopilotMode: string | null | undefined, paused: boolean): WatchdogAlert | null {
  if (!judgement || judgement.light !== 'amber' || !judgement.stale) return null
  if (autopilotMode !== 'on' || paused) return null
  return {
    subject: 'Autopilot has stopped running',
    steps: [
      'Open your Vercel project, then click the Cron tab, and look for the autopilot job. See if it shows errors.',
      'Open Settings, then Environment Variables, and check that CRON_SECRET is there with a value.',
      'Go to Deployments and click Redeploy on the latest one. This starts the schedule again.',
    ],
  }
}

/** Reads the autopilot heartbeat and emails once (throttled) when it has gone quiet. Never throws. */
export async function runCronWatchdog(admin: SupabaseClient, now: number = Date.now()): Promise<string> {
  try {
    const runs = await readCronRuns(admin)
    const judgement = judgeCron('autopilot', runs.autopilot, now)
    const mode = await getSetting(admin, 'autopilot_mode')
    const paused = (await getSetting(admin, 'automation_paused')) === 'true'
    const alert = decideWatchdog(judgement, mode, paused)
    if (!alert) return ''
    const sent = await sendThrottledAlert(admin, alert.subject, [
      `${judgement.label}. The autopilot job should run every 15 minutes.`,
      '',
      ...alert.steps.map((s, i) => `${i + 1}) ${s}`),
    ])
    return `watchdog: autopilot stale, alert ${sent}`
  } catch (e) {
    console.error('[cron:gsc-snapshot] watchdog failed:', e)
    return ''
  }
}
