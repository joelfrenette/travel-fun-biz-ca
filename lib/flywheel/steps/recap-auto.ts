import { NOT_BUILT, type FlywheelStep } from '@/lib/flywheel/types'

// WP10: Recap and testimonial auto-draft. PLACEHOLDER: the builder of this package fills in run() (and undo(), when it logs decisions with
// undo kind 'fw:recap_auto') in THIS file only; the registry and the pipeline are not edited.
// See docs/factory/AUTOPILOT-AUDIT.md and docs/factory/FLYWHEEL-REGISTRY.md.
export const recapAutoStep: FlywheelStep = {
  id: 'recap_auto',
  policy: 'recap_auto',
  label: 'Recap and testimonial auto-draft',
  order: 100,
  floorMs: 60_000,
  maxMs: 120_000,
  run: async () => NOT_BUILT,
}
