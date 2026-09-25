// The Gantt's week 1 starts on this Monday; shared by server and client code.
export const PLAN_START = '2026-09-28'
export const PLAN_WEEKS = 16

export type UseCaseStatus = 'backlog' | 'in_progress' | 'done'
export type UseCasePriority = 'P1' | 'P2' | 'P3'

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
