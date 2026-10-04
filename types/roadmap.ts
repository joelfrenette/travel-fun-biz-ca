// The Gantt's week 1 starts on this Monday; shared by server and client code.
export const PLAN_START = '2026-09-28'
export const PLAN_WEEKS = 16

export type UseCaseStatus = 'backlog' | 'in_progress' | 'done'
// P0 = immediate (added 2026-09-28 for backlog grooming); P1 = high ... P3 = keep pushing out / maybe never.
export type UseCasePriority = 'P0' | 'P1' | 'P2' | 'P3'
// Rough t-shirt size for the Project Tracker's cost-estimate column (migration 0020) - not a
// token-usage lookup, there's no real per-use-case historical ledger to derive one from.
export type UseCaseSize = 'S' | 'M' | 'L'

export interface RoadmapEpic {
  id: string
  code: string
  title: string
  goal: string
  sort_order: number
  start_week: number
  end_week: number
}

export interface RoadmapFeature {
  id: string
  epic_id: string
  title: string
  note: string | null
  sort_order: number
}

export interface RoadmapUseCase {
  id: string
  epic_id: string | null
  feature_id: string | null
  title: string
  note: string | null
  priority: UseCasePriority
  status: UseCaseStatus
  size_estimate: UseCaseSize | null
  source: string
  sort_order: number
  created_at: string
  updated_at: string
}

export interface Roadmap {
  epics: RoadmapEpic[]
  features: RoadmapFeature[]
  usecases: RoadmapUseCase[]
}
