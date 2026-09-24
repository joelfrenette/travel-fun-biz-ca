import { supabaseAdmin } from '@/lib/supabase-admin'
import type { Roadmap, RoadmapUseCase } from '@/types/roadmap'

export const PLAN_START = '2026-09-28'
export const PLAN_WEEKS = 16

export async function getRoadmap(): Promise<Roadmap> {
  const [epics, features, usecases] = await Promise.all([
    supabaseAdmin.from('roadmap_epics').select('*').order('sort_order'),
    supabaseAdmin.from('roadmap_features').select('*').order('sort_order'),
    supabaseAdmin.from('roadmap_usecases').select('*').order('sort_order').order('created_at'),
  ])
  const failed = [epics, features, usecases].find((r) => r.error)
  if (failed?.error) throw new Error(failed.error.message)
  return { epics: epics.data || [], features: features.data || [], usecases: usecases.data || [] }
}

export async function createUseCase(input: Partial<RoadmapUseCase>): Promise<RoadmapUseCase> {
  const { data, error } = await supabaseAdmin.from('roadmap_usecases').insert(input).select().single()
  if (error) throw new Error(error.message)
  return data
}

export async function updateUseCase(id: string, patch: Partial<RoadmapUseCase>): Promise<RoadmapUseCase> {
  const { data, error } = await supabaseAdmin
    .from('roadmap_usecases')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single()
  if (error) throw new Error(error.message)
  return data
}

export async function deleteUseCase(id: string): Promise<void> {
  const { error } = await supabaseAdmin.from('roadmap_usecases').delete().eq('id', id)
  if (error) throw new Error(error.message)
}
