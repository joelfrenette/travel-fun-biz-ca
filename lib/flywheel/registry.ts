import type { SupabaseClient } from '@supabase/supabase-js'
import { getSettingStrict, setSetting } from '@/lib/app-settings'
import { policyGate, policyKey } from '@/lib/auto-decisions'
import { isDryRunActive } from '@/lib/dry-run'
import type { PipelineRun } from '@/lib/pipeline-log'
import type { FlywheelContext, FlywheelOutcome, FlywheelResult, FlywheelStep } from '@/lib/flywheel/types'
import { bookedSyncStep } from '@/lib/flywheel/steps/booked-sync'
import { leadRetryStep } from '@/lib/flywheel/steps/lead-retry'
import { aiHealStep } from '@/lib/flywheel/steps/ai-heal'
import { deadLetterStep } from '@/lib/flywheel/steps/dead-letter'
import { verifyFixStep } from '@/lib/flywheel/steps/verify-fix'
import { networkRecoverStep } from '@/lib/flywheel/steps/network-recover'
import { promotePickStep } from '@/lib/flywheel/steps/promote-pick'
import { keywordAssignStep } from '@/lib/flywheel/steps/keyword-assign'
import { recapAutoStep } from '@/lib/flywheel/steps/recap-auto'
import { autonomyStep } from '@/lib/flywheel/steps/autonomy'

// The flywheel registry: the ONE list of autopilot "flywheel steps" and the ONE runner for them (docs/factory/FLYWHEEL-REGISTRY.md).
// lib/pipeline.ts calls runFlywheelSteps once; a package (WP2 to WP11) lives entirely in its own lib/flywheel/steps/<name>.ts file and is
// already listed here, so nobody edits this file or the pipeline to add behaviour.
//
// What the runner guarantees for every step:
//  - kill switch, the step's own switch and its per-day cap come from the existing policyGate (lib/auto-decisions.ts);
//  - a dry run (ctx.dryRun, or a rehearsal in progress) runs nothing;
//  - the pass budget and the step's time floor are checked before it starts, and one run is cut off after step.maxMs (default 60 s);
//  - an error in one step is caught and reported for that step only; the others still run;
//  - a step that ran or failed leaves a heartbeat in app_settings (flywheel_last_run:<id>) and the pass log gets one summary line.

/** Every step, in the order they run (the runner sorts by `order`). */
export const FLYWHEEL_STEPS: readonly FlywheelStep[] = [bookedSyncStep, leadRetryStep, aiHealStep, deadLetterStep, verifyFixStep, networkRecoverStep, promotePickStep, keywordAssignStep, recapAutoStep, autonomyStep]

export const DEFAULT_STEP_MAX_MS = 60_000
export const heartbeatKey = (id: string): string => `flywheel_last_run:${id}`

export interface FlywheelRunInput {
  admin: SupabaseClient
  /** Date.now() when the pass started. */
  startedAt: number
  /** The whole pass budget in ms. */
  budgetMs: number
  now?: Date
  dryRun?: boolean
  /** The pass log; one summary line is added when something ran or failed. */
  run?: PipelineRun
  /** For tests: replaces Date.now(). */
  clock?: () => number
}

export interface FlywheelRunResult {
  outcomes: FlywheelOutcome[]
  /** One line for the pass log, or null when every step was a no-op or skipped quietly. */
  note: string | null
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const cutoff = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`stopped after ${Math.round(ms / 1000)} seconds`)), Math.max(1, ms))
  })
  return Promise.race([p, cutoff]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

async function stepGate(admin: SupabaseClient, step: FlywheelStep, now: Date): Promise<{ allowed: boolean; room: number; reason: string }> {
  const gate = await policyGate(admin, step.policy, now)
  if (!gate.allowed) return gate
  if (step.defaultOn === false) {
    // Opt-in step: its own switch must be exactly 'on'. An unreadable switch means no.
    const r = await getSettingStrict(admin, policyKey(step.policy)).catch(() => ({ value: null as string | null, error: 'unreadable' }))
    if (r.error || r.value !== 'on') return { allowed: false, room: 0, reason: 'this step is off until you switch it on' }
  }
  return gate
}

/** Runs every registered step once. Never throws. */
export async function runFlywheelSteps(input: FlywheelRunInput, steps: readonly FlywheelStep[] = FLYWHEEL_STEPS): Promise<FlywheelRunResult> {
  const clock = input.clock ?? Date.now
  const now = input.now ?? new Date()
  const dryRun = input.dryRun === true || isDryRunActive()
  const remainingMs = () => input.budgetMs - (clock() - input.startedAt)
  const outcomes: FlywheelOutcome[] = []

  for (const step of [...steps].sort((a, b) => a.order - b.order)) {
    const t0 = clock()
    const done = (status: FlywheelOutcome['status'], reason: string, extra: Partial<FlywheelOutcome> = {}): FlywheelOutcome => ({ id: step.id, status, reason, ms: clock() - t0, ...extra })
    try {
      if (dryRun) {
        outcomes.push(done('skipped', 'dry run'))
        continue
      }
      if (remainingMs() <= 0) {
        outcomes.push(done('skipped', 'the pass time budget is used up'))
        continue
      }
      if (remainingMs() < step.floorMs) {
        outcomes.push(done('skipped', `not enough time left (needs ${Math.round(step.floorMs / 1000)} s)`))
        continue
      }
      const gate = await stepGate(input.admin, step, now)
      if (!gate.allowed) {
        outcomes.push(done('skipped', gate.reason))
        continue
      }
      const ctx: FlywheelContext = { admin: input.admin, now, startedAt: input.startedAt, budgetMs: input.budgetMs, dryRun, remainingMs, room: gate.room }
      const result: FlywheelResult = await withTimeout(step.run(ctx), Math.min(step.maxMs ?? DEFAULT_STEP_MAX_MS, Math.max(1, remainingMs())))
      const outcome = result.ran ? done('ran', result.note ?? 'done', { note: result.note, acted: result.acted }) : done('noop', result.reason ?? 'nothing to do')
      outcomes.push(outcome)
      if (result.ran) await heartbeat(input.admin, step.id, { ok: true, note: result.note }, now)
    } catch (e) {
      const message = e instanceof Error ? e.message : 'the step failed'
      outcomes.push(done('error', message, { note: message }))
      await heartbeat(input.admin, step.id, { ok: false, note: message }, now)
    }
  }

  const interesting = outcomes.filter((o) => o.status === 'ran' || o.status === 'error')
  const note = interesting.length ? interesting.map((o) => (o.status === 'error' ? `${o.id} failed: ${o.reason}` : `${o.id}: ${o.note ?? 'done'}`)).join('; ') : null
  if (note && input.run) input.run.steps.push({ step: 'flywheel', ok: !outcomes.some((o) => o.status === 'error'), note })
  return { outcomes, note }
}

/** Writes the per-step heartbeat. A heartbeat is a side note: it never throws. */
async function heartbeat(admin: SupabaseClient, id: string, run: { ok: boolean; note?: string }, now: Date): Promise<void> {
  try {
    await setSetting(admin, heartbeatKey(id), JSON.stringify({ at: now.toISOString(), ok: run.ok, ...(run.note ? { note: run.note.slice(0, 300) } : {}) }))
  } catch {
    // a missed heartbeat is only a stale light later
  }
}

/** Hands an Autopilot decisions Undo (kind `fw:<id>`) to the step that logged it. Never throws. */
export async function undoFlywheel(admin: SupabaseClient, id: string, ref: string): Promise<{ ok: boolean; message: string }> {
  try {
    const step = FLYWHEEL_STEPS.find((s) => s.id === id)
    if (!step?.undo) return { ok: false, message: 'This decision cannot be undone from here.' }
    return await step.undo(admin, ref)
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'The undo failed.' }
  }
}
