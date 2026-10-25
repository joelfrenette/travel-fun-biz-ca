import type { SupabaseClient } from '@supabase/supabase-js'
import type { PolicyName } from '@/lib/auto-decisions'

// Shared types for the autopilot "flywheel" steps (docs/factory/FLYWHEEL-REGISTRY.md). Kept free of imports from the registry and the
// step files so every step can import it without a cycle.

/** What a step is handed. Built once per pass by the pipeline (see lib/flywheel/registry.ts, runFlywheelSteps). */
export interface FlywheelContext {
  admin: SupabaseClient
  /** The time of this pass. Use it, not new Date(), for "today" maths so a pass is consistent. */
  now: Date
  /** Date.now() when the pass started. */
  startedAt: number
  /** The whole pass budget in ms (the pipeline's TIME_BUDGET_MS). */
  budgetMs: number
  /** True when a rehearsal is running: a step must not write anything. The runner already skips steps in dry run, this is for safety. */
  dryRun: boolean
  /** Milliseconds left in the pass budget right now. */
  remainingMs: () => number
  /** Actions this step may still take today under its cap (set by the runner from the policy gate). */
  room: number
}

export interface FlywheelResult {
  /** True when the step did (or tried to do) real work this pass. A no-op returns false. */
  ran: boolean
  /** Plain reason, shown in the pass log. Required when ran is false. */
  reason?: string
  /** One short line about what happened, when something did. */
  note?: string
  /** How many things were changed (for the log). */
  acted?: number
}

export interface FlywheelStep {
  /** Stable id, equal to the policy name. */
  id: string
  /** Which policy gates it (kill switch, own switch, daily cap). */
  policy: PolicyName
  /** Plain label for logs. */
  label: string
  /** Lower runs first. */
  order: number
  /** Skip the step unless at least this many ms are left in the pass budget. */
  floorMs: number
  /** Hard stop for one run in ms; the runner moves on after this (default 60 000). */
  maxMs?: number
  /** True (default) when the step works unless its switch is exactly 'off'. False when it needs its switch to be exactly 'on' (the autonomy ladder). */
  defaultOn?: boolean
  run: (ctx: FlywheelContext) => Promise<FlywheelResult>
  /** Takes back one decision this step logged with undo kind `fw:<id>`. Optional; called from the Autopilot decisions Undo button. */
  undo?: (admin: SupabaseClient, ref: string) => Promise<{ ok: boolean; message: string }>
}

export type FlywheelOutcomeStatus = 'ran' | 'noop' | 'skipped' | 'error'

export interface FlywheelOutcome {
  id: string
  status: FlywheelOutcomeStatus
  reason: string
  note?: string
  acted?: number
  ms: number
}

/** A placeholder result for a step nobody has built yet. */
export const NOT_BUILT: FlywheelResult = { ran: false, reason: 'not built yet' }
