import { NOT_BUILT, type FlywheelStep } from '@/lib/flywheel/types'

// WP5: Dead-letter and stale-issue sweeper. PLACEHOLDER: the builder of this package fills in run() (and undo(), when it logs decisions with
// undo kind 'fw:dead_letter') in THIS file only; the registry and the pipeline are not edited.
// See docs/factory/AUTOPILOT-AUDIT.md and docs/factory/FLYWHEEL-REGISTRY.md.
export const deadLetterStep: FlywheelStep = {
  id: 'dead_letter',
  policy: 'dead_letter',
  label: 'Dead-letter and stale-issue sweeper',
  order: 50,
  floorMs: 10_000,
  run: async () => NOT_BUILT,
}
