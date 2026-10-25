import { NOT_BUILT, type FlywheelStep } from '@/lib/flywheel/types'

// WP9: Keyword target-page auto-assignment. PLACEHOLDER: the builder of this package fills in run() (and undo(), when it logs decisions with
// undo kind 'fw:keyword_assign') in THIS file only; the registry and the pipeline are not edited. (The audit also touches lib/keyword-pages.ts.)
// See docs/factory/AUTOPILOT-AUDIT.md and docs/factory/FLYWHEEL-REGISTRY.md.
export const keywordAssignStep: FlywheelStep = {
  id: 'keyword_assign',
  policy: 'keyword_assign',
  label: 'Keyword target-page auto-assignment',
  order: 90,
  floorMs: 10_000,
  run: async () => NOT_BUILT,
}
