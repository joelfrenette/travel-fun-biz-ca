// "Fix these today": the amber and red stages of the system check, as one ordered to-do list. Pure: no database, no network, so
// scripts/check-admin-v2.ts tests it offline. The ticks (Done, Later) are kept in the SAME store as the daily follow-ups
// (app_settings followups_done), under ids like "weekly:fix-money", so a tick is for today only and the item comes back
// tomorrow if the stage is still not green. lib/system-check-run.ts reads and saves them.

import { markOf, type DoneState, type Mark } from './followups'
import { STAGE_IDS, type CheckResult, type Light, type StageId } from './system-check'

export const FIX_ID_PREFIX = 'weekly:fix-'
export const fixIdOf = (stage: StageId): string => `${FIX_ID_PREFIX}${stage}`
export function stageOfFixId(id: unknown): StageId | null {
  if (typeof id !== 'string' || !id.startsWith(FIX_ID_PREFIX)) return null
  const s = id.slice(FIX_ID_PREFIX.length)
  return (STAGE_IDS as readonly string[]).includes(s) ? (s as StageId) : null
}

/** How much a stage matters when it is not green. Higher is fixed first among stages with the same light. Money and leads first
 * (a lost sale or a lead nobody answers costs most), then the jobs that make everything else run, then the rest of the funnel. */
export const FIX_IMPACT: Record<StageId, number> = {
  conversion: 100,
  money: 95,
  jobs: 90,
  production: 85,
  distribution: 80,
  ai: 75,
  quality: 70,
  clicks: 65,
  discovery: 60,
  measurement: 55,
  seo: 50,
}

export interface FixItem {
  id: string
  stage: StageId
  label: string
  light: Exclude<Light, 'green'>
  /** The stage's one plain sentence. */
  sentence: string
  /** The page that fixes it. */
  to: { text: string; href: string }
}

export interface FixView extends FixItem {
  mark: Mark
}

const LIGHT_RANK: Record<Light, number> = { green: 0, amber: 1, red: 2 }

/** Red before amber, then by impact, then funnel order. A stage whose number could not be read stays below a stage with a known
 * problem of the same light, because "could not be read" is a smaller worry than "we can see it is broken". Empty when all is green. Pure. */
export function buildFixList(r: CheckResult | null): FixItem[] {
  if (!r) return []
  const order = (id: StageId) => (STAGE_IDS as readonly string[]).indexOf(id)
  return r.stages
    .filter((s) => s.light !== 'green')
    .map((s) => ({
      id: fixIdOf(s.id),
      stage: s.id,
      label: s.label,
      light: s.light as Exclude<Light, 'green'>,
      sentence: s.sentence,
      to: s.needs ?? { text: 'Open the system check', href: '/admin/system-check' },
      _read: s.read,
    }))
    .sort((a, b) => LIGHT_RANK[b.light] - LIGHT_RANK[a.light] || Number(b._read) - Number(a._read) || FIX_IMPACT[b.stage] - FIX_IMPACT[a.stage] || order(a.stage) - order(b.stage))
    .map(({ _read, ...item }) => item)
}

/** Adds today's tick to each item. Pure. */
export function withMarks(items: FixItem[], done: DoneState, day: string): FixView[] {
  return items.map((i) => ({ ...i, mark: markOf(done, day, i.id) }))
}

/** The first n fixes still open (not ticked, not pushed to Later). Pure. */
export function topOpenFixes(items: FixView[], n = 3): FixView[] {
  return items.filter((i) => i.mark === 'open').slice(0, n)
}

export const openFixCount = (items: FixView[]): number => items.filter((i) => i.mark === 'open').length

/** What the Today strip and the page get: the top fixes and the counts. */
export interface FixSummary {
  top: FixView[]
  open: number
  total: number
}

export function summarizeFixes(items: FixView[], n = 3): FixSummary {
  return { top: topOpenFixes(items, n), open: openFixCount(items), total: items.length }
}
