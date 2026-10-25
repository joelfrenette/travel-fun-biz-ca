import { NOT_BUILT, type FlywheelStep } from '@/lib/flywheel/types'

// WP11: Autonomy ladder. PLACEHOLDER: the builder of this package fills in run() (and undo(), when it logs decisions with
// undo kind 'fw:autonomy_ladder') in THIS file only; the registry and the pipeline are not edited.
// defaultOn is false: the runner runs this step only when app_settings.auto_policy_autonomy_ladder is exactly 'on'.
// See docs/factory/AUTOPILOT-AUDIT.md and docs/factory/FLYWHEEL-REGISTRY.md.
export const autonomyStep: FlywheelStep = {
  id: 'autonomy_ladder',
  policy: 'autonomy_ladder',
  label: 'Autonomy ladder',
  order: 110,
  floorMs: 5_000,
  defaultOn: false,
  run: async () => NOT_BUILT,
}
