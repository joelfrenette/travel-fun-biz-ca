import { NOT_BUILT, type FlywheelStep } from '@/lib/flywheel/types'

// WP7: Network un-pause and reconnect re-probe. PLACEHOLDER: the builder of this package fills in run() (and undo(), when it logs decisions with
// undo kind 'fw:network_recover') in THIS file only; the registry and the pipeline are not edited.
// See docs/factory/AUTOPILOT-AUDIT.md and docs/factory/FLYWHEEL-REGISTRY.md.
export const networkRecoverStep: FlywheelStep = {
  id: 'network_recover',
  policy: 'network_recover',
  label: 'Network un-pause and reconnect re-probe',
  order: 70,
  floorMs: 15_000,
  run: async () => NOT_BUILT,
}
