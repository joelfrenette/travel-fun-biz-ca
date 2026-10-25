import { NOT_BUILT, type FlywheelStep } from '@/lib/flywheel/types'

// WP8: Conversion-weighted promote pick. PLACEHOLDER: the builder of this package fills in run() (and undo(), when it logs decisions with
// undo kind 'fw:promote_pick') in THIS file only; the registry and the pipeline are not edited. (The audit also edits the ordering functions
// in lib/blog-topics.ts, lib/guide-plan.ts and lib/promotion.ts.)
// See docs/factory/AUTOPILOT-AUDIT.md and docs/factory/FLYWHEEL-REGISTRY.md.
export const promotePickStep: FlywheelStep = {
  id: 'promote_pick',
  policy: 'promote_pick',
  label: 'Conversion-weighted promote pick',
  order: 80,
  floorMs: 10_000,
  run: async () => NOT_BUILT,
}
