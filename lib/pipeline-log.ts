import type { SupabaseClient } from '@supabase/supabase-js'
import { getSetting } from '@/lib/app-settings'

// The record of the last pipeline pass, kept apart from pipeline.ts so lib/issues.ts can read it
// without importing the pipeline itself.
export const PIPELINE_LAST_RUN_KEY = 'pipeline_last_run'

export interface PipelineStep {
  step: 'keywords' | 'write' | 'post' | 'repurpose'
  ok: boolean
  note: string
}

export interface PipelineRun {
  at: string
  trigger: 'schedule' | 'button'
  steps: PipelineStep[]
}

export async function readLastPipelineRun(admin: SupabaseClient): Promise<PipelineRun | null> {
  try {
    return JSON.parse((await getSetting(admin, PIPELINE_LAST_RUN_KEY)) ?? 'null') as PipelineRun | null
  } catch {
    return null
  }
}
