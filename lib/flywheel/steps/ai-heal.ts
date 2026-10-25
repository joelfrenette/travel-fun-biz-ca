import { NOT_BUILT, type FlywheelStep } from '@/lib/flywheel/types'

// WP4: Scheduled AI auto-heal. PLACEHOLDER: the builder of this package fills in run() (and undo(), when it logs decisions with
// undo kind 'fw:ai_heal') in THIS file only; the registry and the pipeline are not edited.
// See docs/factory/AUTOPILOT-AUDIT.md and docs/factory/FLYWHEEL-REGISTRY.md.
export const aiHealStep: FlywheelStep = {
  id: 'ai_heal',
  policy: 'ai_heal',
  label: 'Scheduled AI auto-heal',
  order: 40,
  floorMs: 60_000,
  maxMs: 120_000,
  run: async () => NOT_BUILT,
}
