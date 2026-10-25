import { NOT_BUILT, type FlywheelStep } from '@/lib/flywheel/types'

// WP3: Lead to GHL retry ladder. PLACEHOLDER: the builder of this package fills in run() (and undo(), when it logs decisions with
// undo kind 'fw:lead_retry') in THIS file only; the registry and the pipeline are not edited. (The audit also edits healLeads in lib/heal.ts.)
// See docs/factory/AUTOPILOT-AUDIT.md and docs/factory/FLYWHEEL-REGISTRY.md.
export const leadRetryStep: FlywheelStep = {
  id: 'lead_retry',
  policy: 'lead_retry',
  label: 'Lead to GHL retry ladder',
  order: 30,
  floorMs: 10_000,
  run: async () => NOT_BUILT,
}
