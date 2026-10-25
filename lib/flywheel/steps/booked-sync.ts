import { NOT_BUILT, type FlywheelStep } from '@/lib/flywheel/types'

// WP2: Order to lead booked sync. PLACEHOLDER: the builder of this package fills in run() (and undo(), when it logs decisions with
// undo kind 'fw:booked_sync') in THIS file only; the registry and the pipeline are not edited.
// See docs/factory/AUTOPILOT-AUDIT.md and docs/factory/FLYWHEEL-REGISTRY.md.
export const bookedSyncStep: FlywheelStep = {
  id: 'booked_sync',
  policy: 'booked_sync',
  label: 'Order to lead booked sync',
  order: 20,
  floorMs: 5_000,
  run: async () => NOT_BUILT,
}
