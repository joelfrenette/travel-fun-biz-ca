import type { SupabaseClient } from '@supabase/supabase-js'
import { getSetting, setSetting } from '@/lib/app-settings'
import { isAutomationPaused } from '@/lib/automation-kill-switch'
import { isAiConfigured } from '@/lib/ai-verify'
import { overCeiling, readStoredAiSpend, usd } from '@/lib/ai-tripwire'
import { appendDecisions, decision, type AutoDecision } from '@/lib/auto-decisions'
import { listEdits, repairDay } from '@/lib/content-edits'
import type { HealBudget } from '@/lib/heal-loop'
import type { AiFixItem, AiFixReport } from '@/lib/system-check-prompt'
import type { Light, StageId } from '@/lib/system-check'
import type { ImprovedInfo } from '@/lib/ai-heal-review'

// The ONE bounded AI step of the System check's Auto-heal ("rerun AI to try and fix everything listed").
//
// It adds no new autonomous behavior. After the plain repairs, for at most AI_ITEMS_PER_CLICK pages per click, and only for stages the
// check STILL lists as amber or red, it calls repair functions the daily self-heal already runs (the held-post re-heal, the heal loop for
// held guides and held page copy). Each of those keeps its own caps, its own quality gate and its own content_edits audit log, so every
// change can be undone. This file only decides WHICH of them to start, and refuses to start any when:
//   - automation is paused (kill switch), or no AI key is set;
//   - the AI spend tripwire is over its daily limit;
//   - the heal loop's daily call budget (setting heal_loop_calls_per_day) is used up or cannot be read (fail closed);
//   - the same item was already tried today (cached per item per day: a repeat click costs nothing).
// Each change is also written to the Autopilot decisions log with an Undo (policy system_check_ai).

/** At most this many pages are given an AI repair per click. */
export const AI_ITEMS_PER_CLICK = 3
/** Time the AI step may use (the route has 300 seconds in total; a model call needs 50 seconds left to start). */
export const AI_BUDGET_MS = 200_000
/** Log lines (each with an Undo) written per item. */
const MAX_LOGGED_EDITS = 10
export const AI_CACHE_PREFIX = 'auto_heal_ai'

export type AiKind = 'posts' | 'guides' | 'copy'

const KINDS: Record<AiKind, { label: string; type: 'post' | 'guide' | 'page_copy'; /** Pages one run may touch at most. */ slots: number }> = {
  posts: { label: 'Held blog posts (below the quality bar)', type: 'post', slots: 2 },
  guides: { label: 'Held guides (below the quality bar)', type: 'guide', slots: 1 },
  copy: { label: 'Held page copy (below the quality bar)', type: 'page_copy', slots: 1 },
}

/** Which safe repair belongs to which listed stage. A stage not here has no safe content fix, so the AI never touches it. */
export const STAGE_AI_KINDS: Partial<Record<StageId, AiKind[]>> = {
  quality: ['posts', 'guides', 'copy'],
  production: ['posts'],
  seo: ['copy', 'guides'],
}

export interface ListedStage {
  id: StageId
  light: Light
}

/** The repairs to consider, in order: red stages first, each kind once. Pure. */
export function pickKinds(listed: ListedStage[]): AiKind[] {
  const out: AiKind[] = []
  const ranked = [...listed].filter((s) => s.light !== 'green').sort((a, b) => Number(b.light === 'red') - Number(a.light === 'red'))
  for (const s of ranked) for (const k of STAGE_AI_KINDS[s.id] ?? []) if (!out.includes(k)) out.push(k)
  return out
}

export const aiCacheKey = (kind: AiKind, now: Date) => `${AI_CACHE_PREFIX}:${repairDay(now)}:${kind}`

export interface RepairOutcome {
  /** Pages the repair looked at (and so may have spent AI calls on). */
  tried: number
  /** Pages it changed. */
  changed: number
  calls: number
  note: string
}

export interface AiEditLike {
  id: string
  path: string
  field: string
  reason: string
  reverted_at: string | null
}

export interface AiFixDeps {
  now?: Date
  /** Test seams: replace the real checks and repairs. */
  aiConfigured?: () => boolean
  spend?: () => Promise<{ spend: number | null; ceiling: number }>
  budget?: () => Promise<HealBudget>
  repairs?: Partial<Record<AiKind, (ctx: { limit: number; budget: HealBudget; deadlineMs: number }) => Promise<RepairOutcome>>>
  edits?: (type: 'post' | 'guide' | 'page_copy', sinceIso: string) => Promise<AiEditLike[]>
  append?: (entries: AutoDecision[]) => Promise<void>
  /** Absolute time (Date.now() ms) the repairs must stop by. Default: now + AI_BUDGET_MS. The unattended flywheel step passes a tighter one. */
  deadlineMs?: number
  /** Default true: the repairs publish a held draft that passes the gate (the System check Auto-heal button, as always). The scheduled
   * ai_heal step passes false: repair only, the draft stays HELD, and each improved item is reported to `onImproved`. */
  publish?: boolean
  onImproved?: (info: ImprovedInfo) => Promise<void> | void
}

const done = (skipped: string): AiFixReport => ({ items: [], calls: 0, skipped })

/** The real repairs: the same functions the daily self-heal calls, each with its own caps and its own audit log. */
function realRepairs(admin: SupabaseClient, now: Date, mode: { publish?: boolean; onImproved?: AiFixDeps['onImproved'] } = {}): Required<AiFixDeps>['repairs'] {
  const { publish, onImproved } = mode
  return {
    posts: async ({ deadlineMs }) => {
      const { buildSiteIndex } = await import('@/lib/content-heal-run')
      const { rehealStuckDrafts } = await import('@/lib/blog-reheal')
      const idx = await buildSiteIndex(admin)
      // refresh:false = only the stuck drafts, never a rewrite of an already published post.
      const r = await rehealStuckDrafts(admin, { existing: idx.existing, now, deadlineMs, refresh: false, publish, onImproved })
      return { tried: r.tried, changed: r.published + r.repaired, calls: r.calls, note: r.note || (r.problems[0] ?? '') }
    },
    guides: async ({ limit, budget, deadlineMs }) => {
      const { healHeldGuides } = await import('@/lib/heal-drafts')
      const r = await healHeldGuides(admin, { now, limit, budget, deadlineMs, publish, onImproved })
      return { tried: r.tried, changed: r.published + r.healedDraft, calls: r.calls, note: r.note || (r.problems[0] ?? '') }
    },
    copy: async ({ limit, budget, deadlineMs }) => {
      const { healHeldCopy } = await import('@/lib/heal-drafts')
      const r = await healHeldCopy(admin, { now, limit, budget, deadlineMs, publish, onImproved })
      return { tried: r.tried, changed: r.published + r.healedDraft, calls: r.calls, note: r.note || (r.problems[0] ?? '') }
    },
  }
}

interface CachedItem {
  at: string
  status: AiFixItem['status']
  changed: number
  note: string
}

function parseCached(raw: string | null): CachedItem | null {
  if (!raw) return null
  try {
    const p = JSON.parse(raw) as Partial<CachedItem> | null
    if (!p || typeof p.at !== 'string') return null
    return { at: p.at, status: p.status === 'fixed' ? 'fixed' : 'tried', changed: Number.isFinite(p.changed) ? Number(p.changed) : 0, note: typeof p.note === 'string' ? p.note : '' }
  } catch {
    return null
  }
}

/** Runs the bounded AI step once. `listed` is the check as it stands AFTER the plain repairs. Never throws. */
export async function runAiFixStep(admin: SupabaseClient, listed: ListedStage[], deps: AiFixDeps = {}): Promise<AiFixReport> {
  try {
    const now = deps.now ?? new Date()
    const kinds = pickKinds(listed)
    // Nothing listed that has a safe content fix: no database read, no AI.
    if (kinds.length === 0) return done('Nothing the check lists has a safe AI content fix, so no AI call was made.')
    if (await isAutomationPaused(admin).catch(() => true)) return done('Automation is paused (kill switch), so no AI call was made.')
    if (!(deps.aiConfigured ?? isAiConfigured)()) return done('No AI key is set on this site, so no AI call was made.')
    const spend = await (deps.spend ?? (() => readStoredAiSpend(admin)))().catch(() => ({ spend: null, ceiling: 0 }))
    if (spend.spend !== null && overCeiling(spend.spend, spend.ceiling)) return done(`The AI spend limit is reached (${usd(spend.spend)} of ${usd(spend.ceiling)}), so no AI call was made.`)
    const budget = await (deps.budget ?? (async () => (await import('@/lib/heal-loop')).openBudget(admin, now)))()
    if (!budget.readable) return done(`The daily AI repair limit could not be read (${budget.reason ?? 'unknown'}), so no AI call was made.`)
    if (budget.remaining() < 1) return done(`The daily AI repair limit is used up (${budget.used} of ${budget.cap} calls today), so no AI call was made.`)

    const repairs = { ...realRepairs(admin, now, { publish: deps.publish, onImproved: deps.onImproved }), ...(deps.repairs ?? {}) }
    const startedIso = now.toISOString()
    const deadlineMs = deps.deadlineMs ?? Date.now() + AI_BUDGET_MS
    const items: AiFixItem[] = []
    const entries: AutoDecision[] = []
    let slotsLeft = AI_ITEMS_PER_CLICK
    let calls = 0

    for (const kind of kinds) {
      const meta = KINDS[kind]
      const skip = (note: string) => items.push({ kind, label: meta.label, status: 'skipped', changed: 0, calls: 0, note })
      const cached = parseCached(await getSetting(admin, aiCacheKey(kind, now)).catch(() => null))
      if (cached) {
        skip(`Already tried today at ${cached.at.slice(11, 16)} UTC (${cached.status === 'fixed' ? `changed ${cached.changed}` : 'changed nothing'}); a repeat click costs nothing.${cached.note ? ` ${cached.note}` : ''}`)
        continue
      }
      if (slotsLeft < meta.slots) {
        skip(`The limit of ${AI_ITEMS_PER_CLICK} AI fixes per click was reached.`)
        continue
      }
      if (budget.remaining() < 1) {
        skip(`The daily AI repair limit is used up (${budget.used} of ${budget.cap} calls today).`)
        continue
      }
      let out: RepairOutcome
      try {
        out = await repairs[kind]!({ limit: Math.min(slotsLeft, meta.slots), budget, deadlineMs })
      } catch (e) {
        skip(`The repair failed: ${e instanceof Error ? e.message : 'unknown error'}`)
        continue
      }
      if (out.tried === 0) {
        // Nothing of this kind is waiting: no AI was spent, nothing to remember, no slot used.
        skip(out.note || 'Nothing of this kind is waiting for a repair, so there was no safe fix to run.')
        continue
      }
      slotsLeft -= Math.min(out.tried, meta.slots)
      calls += out.calls
      const status: AiFixItem['status'] = out.changed > 0 ? 'fixed' : 'tried'
      items.push({ kind, label: meta.label, status, changed: out.changed, calls: out.calls, note: out.note })
      await setSetting(admin, aiCacheKey(kind, now), JSON.stringify({ at: now.toISOString(), status, changed: out.changed, note: out.note.slice(0, 200) } satisfies CachedItem)).catch(() => undefined)
      // Every change the repair logged to content_edits gets a line in the decisions log with the same Undo.
      const edits = ((await (deps.edits ?? defaultEdits(admin))(meta.type, startedIso).catch(() => [])) as AiEditLike[]).filter((e) => !e.reverted_at)
      for (const e of edits.slice(0, MAX_LOGGED_EDITS)) {
        entries.push(decision('system_check_ai', e.path, `AI fixed ${e.field} on ${e.path} (${meta.label.toLowerCase()})`, `Started by a person with Auto-heal on the System check. ${e.reason || 'It failed the quality check.'}`.trim(), { kind: 'revert-edit', ref: e.id }, now))
      }
      if (out.changed > 0 && edits.length === 0) entries.push(decision('system_check_ai', kind, `AI changed ${out.changed} page(s) (${meta.label.toLowerCase()})`, 'Started by Auto-heal. The audit log lines could not be read back, so open Content edits to undo it.', null, now))
    }
    await (deps.append ?? ((e: AutoDecision[]) => appendDecisions(admin, e)))(entries)
    return { items, calls, skipped: '' }
  } catch (e) {
    return done(`The AI step failed and was stopped: ${e instanceof Error ? e.message : 'unknown error'}`)
  }
}

function defaultEdits(admin: SupabaseClient) {
  return async (type: 'post' | 'guide' | 'page_copy', sinceIso: string): Promise<AiEditLike[]> => {
    const r = await listEdits(admin, { type, sinceIso, limit: 50 })
    return r.edits.map((e) => ({ id: e.id, path: e.path, field: e.field, reason: e.reason, reverted_at: e.reverted_at }))
  }
}
