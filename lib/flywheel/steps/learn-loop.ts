import type { SupabaseClient } from '@supabase/supabase-js'
import { revertLearnedEntry } from '@/lib/learn-loop-undo'
import { getSetting } from '@/lib/app-settings'
import { logDecision } from '@/lib/flywheel/ctx'
import { evolveAll, observe, readLedger, writeLedger, type FailureSurface, type LedgerEvent, type Observation } from '@/lib/learn-loop'
import { parseStats, VISUAL_GATE_STATS_KEY } from '@/lib/visual-gate-stats'
import type { FlywheelContext, FlywheelResult, FlywheelStep } from '@/lib/flywheel/types'

// Self-learning loop (policy learn_loop). Each 15 minute pass: collect the failures of generated content and social posting, add them to the
// ledger, and move every fingerprint along observe, apply a catalogued fix as a trial rule, monitor, then learn (permanent rule) or
// withdraw and mark for a code fix. See lib/learn-loop.ts for the lifecycle. It never posts, never calls a model, and never writes a rule
// that is not in the reviewed catalogue. Every rule change is one line in the Autopilot decisions log with an Undo (kind fw:learn_loop).

const LOOKBACK_MS = 3 * 86_400_000

async function collect(admin: SupabaseClient, now: Date): Promise<Observation[]> {
  const out: Observation[] = []
  const since = new Date(now.getTime() - LOOKBACK_MS).toISOString()
  try {
    const { data } = await admin.from('post_distribution').select('last_error, updated_at').eq('content_type', 'post').eq('stage', 'failed').gte('updated_at', since).limit(60)
    for (const r of (data ?? []) as { last_error: string | null; updated_at: string }[]) if (r.last_error) out.push({ surface: 'post', text: r.last_error, at: r.updated_at })
  } catch {
    /* a source that cannot be read adds nothing */
  }
  try {
    const { data } = await admin.from('content_pipeline').select('last_error, updated_at, video_stage').not('last_error', 'is', null).gte('updated_at', since).limit(60)
    for (const r of (data ?? []) as { last_error: string | null; updated_at: string; video_stage: string | null }[]) {
      if (r.last_error) out.push({ surface: (r.video_stage === 'failed' ? 'video' : 'carousel') as FailureSurface, text: r.last_error, at: r.updated_at })
    }
  } catch {
    /* same */
  }
  try {
    const stats = parseStats(await getSetting(admin, VISUAL_GATE_STATS_KEY))
    for (const s of stats.recentSkips) out.push({ surface: s.surface === 'reel' ? 'reel' : 'cover', text: s.reason, at: s.at })
  } catch {
    /* same */
  }
  return out
}

export async function runLearnLoop(ctx: FlywheelContext): Promise<FlywheelResult> {
  const { admin, now } = ctx
  const before = await readLedger(admin)
  const seen = observe(before, await collect(admin, now))
  const { ledger, events } = evolveAll(seen, now, Math.max(0, ctx.room))
  // Dry run: say what a real pass would do, write nothing (no ledger, no rule, no log line).
  if (ctx.dryRun) return { ran: false, reason: events.length ? `dry run, would: ${summarise(events)}` : 'dry run: nothing to change' }
  const changed = JSON.stringify(ledger) !== JSON.stringify(before)
  if (!changed) return { ran: false, reason: 'no new failures to learn from' }
  const saved = await writeLedger(admin, ledger)
  if (saved.error) return { ran: false, reason: `could not save the ledger (${saved.error})` }
  for (const ev of events) await logDecision(admin, 'learn_loop', ev.sig.slice(0, 120), ev.action, ev.reason, { kind: 'fw:learn_loop', ref: ev.sig }, now)
  if (events.length === 0) return { ran: false, reason: 'failures counted, nothing to change yet' }
  return { ran: true, acted: events.length, note: summarise(events) }
}

function summarise(events: LedgerEvent[]): string {
  const n = (a: LedgerEvent['action']) => events.filter((e) => e.action === a).length
  const bits = [['trial rule started', n('applied')], ['rule confirmed', n('learned')], ['rule withdrawn', n('withdrawn')], ['needs a code fix', n('escalated')]] as const
  return bits.filter(([, c]) => c > 0).map(([l, c]) => `${c} ${l}`).join(', ')
}

export const learnLoopStep: FlywheelStep = {
  id: 'learn_loop',
  policy: 'learn_loop',
  label: 'Learn from repeated content and posting failures',
  order: 95,
  // Opt-in: it changes what the caption and reel writers are told, so it stays off until the switch is exactly 'on'.
  defaultOn: false,
  floorMs: 20_000,
  maxMs: 30_000,
  run: runLearnLoop,
  undo: async (admin, ref) => revertLearnedEntry(admin, ref),
}
