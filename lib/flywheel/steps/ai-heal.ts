import type { SupabaseClient } from '@supabase/supabase-js'
import { appendDecisions, type AutoDecision } from '@/lib/auto-decisions'
import { revertEdit } from '@/lib/content-edits'
import { enqueueReview, isFull, openCount, readQueue } from '@/lib/ai-heal-review'
import { readJsonSetting, writeJsonSetting } from '@/lib/flywheel/ctx'
import { pickKinds, runAiFixStep, type AiFixDeps, type ListedStage } from '@/lib/system-check-ai'
import type { AiFixReport } from '@/lib/system-check-prompt'
import type { FlywheelContext, FlywheelResult, FlywheelStep } from '@/lib/flywheel/types'

// WP4: Scheduled AI auto-heal (policy ai_heal, docs/factory/AUTOPILOT-AUDIT.md "WP4").
//
// The System check's AI fix step (lib/system-check-ai.ts runAiFixStep) used to run only when a person pressed Auto-heal. This step runs the
// SAME function on the 15 minute pass, with nothing forked. It reads the check the way the admin does (getSystemCheck, the 5 minute cache),
// and hands the listed stages to runAiFixStep, which itself:
//   - only considers stages that have a safe content fix (STAGE_AI_KINDS: quality, production, seo); everything else is never touched;
//   - touches at most 3 pages per run and each kind at most once per day (its own per-day cache);
//   - refuses when automation is paused, no AI key is set, the AI spend limit is reached or the heal loop's daily call budget is used up;
//   - makes every change through the existing repairs, each with its own quality gate and its own content_edits audit row.
// On top of that this step adds: the policy gate (kill switch, own switch, 3 a day), dry run = nothing runs, a gap of AI_HEAL_MIN_GAP_MS
// between attempts (so the 15 minute pass does not re-read the same queues all day), a tighter time limit than a click gets, and the
// decision log: each page the repair changed is one line under ai_heal, with an Undo that puts the old text back.
// It never assigns leads, sets prices or messages anyone.
// It also NEVER PUBLISHES a held draft (Joel's rule): it runs the repairs in review mode (publish: false). A draft whose text was improved
// stays HELD, the item goes into the app_settings queue ai_heal_review (lib/ai-heal-review.ts, at most 20 open), and a Today card
// "Auto-heal improved this: review" asks a person: swipe right publishes through the normal publish route (its gate still decides), swipe left
// keeps it held and puts the old text back with revertEdit. The System check Auto-heal BUTTON still publishes as before (a person pressed it).

export const AI_HEAL_LAST_KEY = 'ai_heal_last'
/** Minimum time between two attempts. The per-kind daily cache inside runAiFixStep already stops repeat AI spend; this stops repeat reads. */
export const AI_HEAL_MIN_GAP_MS = 2 * 3_600_000
/** The AI step never gets more than this of the step's own 120 s limit, and always leaves this much at the end. */
const MAX_RUN_MS = 120_000
const SAFETY_MS = 15_000

interface LastRun {
  at: string
  tried: number
  changed: number
  note: string
}

export interface AiHealDeps {
  /** The check as it stands, as the stages the AI step needs. Default: the admin's cached System check. */
  listed: (admin: SupabaseClient, now: Date) => Promise<ListedStage[]>
  /** The AI step. Default: the real runAiFixStep. */
  runAi: (admin: SupabaseClient, listed: ListedStage[], deps: AiFixDeps) => Promise<AiFixReport>
}

export const realDeps: AiHealDeps = {
  listed: async (admin, now) => {
    const { getSystemCheck } = await import('@/lib/system-check-run')
    return (await getSystemCheck(admin, { now })).result.stages.map((s) => ({ id: s.id, light: s.light }))
  },
  runAi: runAiFixStep,
}

/** Whole milliseconds left to wait before another attempt (0 = free to run). Pure. */
export function gapLeftMs(lastAt: string | null | undefined, now: Date, gapMs: number = AI_HEAL_MIN_GAP_MS): number {
  const t = Date.parse(lastAt ?? '')
  if (!Number.isFinite(t)) return 0
  return Math.max(0, gapMs - (now.getTime() - t))
}

/** Turns the lines runAiFixStep wrote for a person's click into lines for the unattended pass. Pure. */
export function relabel(entries: AutoDecision[]): AutoDecision[] {
  return entries.map((e) => ({
    ...e,
    policy: 'ai_heal',
    reason: e.reason.replace(/Started by (a person with )?Auto-heal( on the System check)?\./, 'Started automatically by the autopilot (scheduled AI auto-heal).').replace(/^Started by Auto-heal\./, 'Started automatically by the autopilot.'),
    undo: e.undo?.kind === 'revert-edit' ? { kind: 'fw:ai_heal', ref: e.undo.ref } : e.undo,
  }))
}

/** The work, with its collaborators passed in so the offline check can fake them. Never throws. */
export async function runAiHeal(ctx: FlywheelContext, deps: AiHealDeps = realDeps, aiDeps: AiFixDeps = {}): Promise<FlywheelResult> {
  if (ctx.dryRun) return { ran: false, reason: 'dry run: nothing is repaired' }
  if (ctx.room <= 0) return { ran: false, reason: 'the daily cap is used up' }
  const { admin, now } = ctx

  const last = await readJsonSetting<Partial<LastRun> | null>(admin, AI_HEAL_LAST_KEY, null)
  const wait = gapLeftMs(last?.at, now)
  if (wait > 0) return { ran: false, reason: `tried ${Math.round((AI_HEAL_MIN_GAP_MS - wait) / 60_000)} minutes ago; next try in about ${Math.ceil(wait / 60_000)} minutes` }

  // Nothing new is repaired while the review list is full: each repair would only add a card nobody has room to look at.
  const queue = await readQueue(admin)
  if (isFull(queue)) return { ran: false, reason: `${openCount(queue)} improved items are waiting for your review on Today; nothing new is repaired until some are decided` }

  const listed = await deps.listed(admin, now)
  if (pickKinds(listed).length === 0) return { ran: false, reason: 'the System check lists nothing with a safe AI content fix' }

  const entries: AutoDecision[] = []
  const budget = Math.min(ctx.remainingMs(), MAX_RUN_MS) - SAFETY_MS
  if (budget <= 0) return { ran: false, reason: 'not enough time left in this pass' }
  let queued = 0
  const report = await deps.runAi(admin, listed, {
    now,
    // Each held item the repairs improve is queued for a Today card ("Auto-heal improved this: review").
    onImproved: async (info) => {
      if ((await enqueueReview(admin, info, now)).queued) queued++
    },
    ...aiDeps,
    // The scheduled run NEVER publishes a held draft (Joel's rule). This is set after the spread so nothing can switch it back on.
    publish: false,
    deadlineMs: Date.now() + budget,
    // Every change gets a decision line under ai_heal with an Undo; nothing else is logged here.
    append: async (e) => {
      entries.push(...relabel(e))
      await appendDecisions(admin, relabel(e))
    },
  })

  const tried = report.items.filter((i) => i.status === 'fixed' || i.status === 'tried').length
  const changed = report.items.reduce((n, i) => n + (i.status === 'fixed' ? i.changed : 0), 0)
  const note = report.items.filter((i) => i.status !== 'skipped').map((i) => `${i.label}: ${i.status === 'fixed' ? `changed ${i.changed}` : 'changed nothing'}`).join('; ')
  // Remember the attempt only when the AI step really started (an unmet precondition, like a missing key, is re-checked next pass for free).
  if (report.skipped === '' && report.items.length > 0) await writeJsonSetting(admin, AI_HEAL_LAST_KEY, { at: now.toISOString(), tried, changed, note } satisfies LastRun)

  if (report.skipped) return { ran: false, reason: report.skipped }
  if (tried === 0) return { ran: false, reason: report.items[0]?.note || 'nothing was waiting for a repair' }
  return { ran: true, acted: changed, note: `AI repair tried ${tried} kind${tried === 1 ? '' : 's'} of page; ${note}${queued ? `; ${queued} improved item${queued === 1 ? '' : 's'} held for your review on Today` : ''}` }
}

/** Puts one page's old text back (ref = the content_edits row id). If a person changed the page since, it is left alone. */
async function undoAiHeal(admin: SupabaseClient, ref: string): Promise<{ ok: boolean; message: string }> {
  const r = await revertEdit(admin, ref)
  if (r.ok) return { ok: true, message: 'The page text is back as it was before the AI repair.' }
  if (r.needsForce) return { ok: false, message: `${r.error ?? 'The page changed since.'} It was left alone; use Content edits to revert it on purpose.` }
  return { ok: false, message: r.error ?? 'The page text could not be put back.' }
}

export const aiHealStep: FlywheelStep = {
  id: 'ai_heal',
  policy: 'ai_heal',
  label: 'Scheduled AI auto-heal',
  order: 40,
  floorMs: 60_000,
  maxMs: 120_000,
  run: (ctx) => runAiHeal(ctx),
  undo: undoAiHeal,
}
