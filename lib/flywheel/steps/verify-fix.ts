import { NOT_BUILT, type FlywheelStep } from '@/lib/flywheel/types'

// WP6: Publish-verify remediation. PLACEHOLDER: the builder of this package fills in run() (and undo(), when it logs decisions with
// undo kind 'fw:verify_fix') in THIS file only; the registry and the pipeline are not edited. (The audit also touches the runner part of lib/publish-verify.ts.)
// See docs/factory/AUTOPILOT-AUDIT.md and docs/factory/FLYWHEEL-REGISTRY.md.
export const verifyFixStep: FlywheelStep = {
  id: 'verify_fix',
  policy: 'verify_fix',
  label: 'Publish-verify remediation',
  order: 60,
  floorMs: 20_000,
  run: async () => NOT_BUILT,
}
