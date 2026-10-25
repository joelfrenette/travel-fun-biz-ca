import type { SupabaseClient } from '@supabase/supabase-js'
import { isVetoedIn, readVetoes } from '@/lib/auto-decisions'
import { MAX_AUTO_RETRIES, postRetryVerdict, RETRY_STATE_KEY, stepResumeVerdict, type FailedPostRow } from '@/lib/auto-policies'
import { getDistributionMode } from '@/lib/distribution'
import { isDryRunActive } from '@/lib/dry-run'
import { logDecision, readJsonSetting, writeJsonSetting } from '@/lib/flywheel/ctx'
import type { FlywheelContext, FlywheelResult, FlywheelStep } from '@/lib/flywheel/types'

// WP5: Dead-letter and stale-issue sweeper (policy dead_letter, docs/factory/AUTOPILOT-AUDIT.md).
//
// Some failures can never get better by themselves, and today each one sits on the Today page as a card for ever. This step retires them:
//  (a) a failed carousel or video row whose automatic resume is spent (or never coming) and that has sat for 3 days is moved to the
//      terminal "skipped" stage, exactly what the Dismiss button does. The blog post itself stays published, only without that format;
//  (b) a failed social post whose retry ladder is spent (or never runs) and that has sat for 3 days is closed as "done" with a plain
//      "Retired:" note (the stage list has no other terminal stage, and "done" with a "Skipped:" note is already how the posting code
//      closes rows it will not send). A rejected or never-fixable post stops showing as a failed post;
//  (c) an issue whose subject no longer exists is resolved: a carousel or video row for a blog post that was deleted, and a row the
//      autopilot dropped from its 7-day window while it still showed "is having trouble".
// Every retirement is logged with an Undo (kind fw:dead_letter) that puts the row back exactly as it was and adds the subject to the veto
// list. Capped per day by the policy cap; a dry run, Pause all automation and the policy switch stop it (the runner checks them first).
// One weekly digest line replaces the cards. It never touches a trip, a price, a lead or a message, and it never posts anything.

export const DEAD_LETTER_STATE_KEY = 'flywheel_dead_letter_state'
const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000
/** A row must have sat untouched this long before it can be retired. A person pressing Retry refreshes updated_at, which restarts the clock. */
export const RETIRE_AFTER_MS = 3 * DAY_MS
/** The autopilot only works rows created in the last 7 days (lib/autopilot.ts ACTIVE_WINDOW_DAYS). Older ones are never touched again. */
export const PIPELINE_WINDOW_MS = 7 * DAY_MS
/** Whatever the ladder says, a failed row this old is retired. */
export const HARD_LIMIT_MS = 14 * DAY_MS
/** A row for a deleted blog post waits this long first, so a post that is being re-created is not caught half way. */
export const ORPHAN_GRACE_MS = HOUR_MS
/** At most this many retirements in one pass (the daily cap is the real limit). */
export const PER_PASS_MAX = 5
export const RETIRED_PREFIX = 'Retired: '

export type RetireKind = 'failed-post' | 'failed-step' | 'stuck-step' | 'gone-post'
export type RetireVerdict = { act: 'retire'; kind: RetireKind; why: string } | { act: 'keep'; why: string }

export interface StepPart {
  slug: string
  part: 'carousel' | 'video'
  /** This part's stage. */
  stage: string
  /** The other part's stage. */
  otherStage: string
  last_error: string | null
  created_at: string
  updated_at: string
  /** Networks this part already reached. */
  sent: string[]
}

const NON_TERMINAL = ['pending', 'generated', 'rendering', 'rendered']
const days = (ms: number): number => Math.max(1, Math.round(ms / DAY_MS))

/** Should this carousel or video part be retired now? `resumes` is how many automatic resumes it has had; `postExists` is null when unknown. Pure. */
export function stepRetireVerdict(p: StepPart, resumes: number, postExists: boolean | null, now: Date, vetoed: boolean): RetireVerdict {
  if (vetoed) return { act: 'keep', why: 'a person undid an earlier retirement of this step' }
  if (p.stage !== 'failed' && !NON_TERMINAL.includes(p.stage)) return { act: 'keep', why: `the ${p.part} is ${p.stage}` }
  if (!p.last_error) return { act: 'keep', why: 'no problem is recorded on it' }
  const age = now.getTime() - Date.parse(p.updated_at)
  if (!Number.isFinite(age)) return { act: 'keep', why: 'the last change time is not readable' }
  if (postExists === false && age >= ORPHAN_GRACE_MS) return { act: 'retire', kind: 'gone-post', why: `the blog post "${p.slug}" no longer exists, so its ${p.part} can never be posted` }
  if (age < RETIRE_AFTER_MS) return { act: 'keep', why: 'it has not sat for 3 days yet' }
  const created = Date.parse(p.created_at)
  const outsideWindow = Number.isFinite(created) && now.getTime() - created > PIPELINE_WINDOW_MS
  if (p.stage === 'failed') {
    if (age >= HARD_LIMIT_MS) return { act: 'retire', kind: 'failed-step', why: `the ${p.part} failed ${days(age)} days ago and is still failed` }
    const v = stepResumeVerdict({ slug: p.slug, part: p.part, last_error: p.last_error, updated_at: p.updated_at, sent: p.sent }, resumes, now, false)
    if (!outsideWindow && (v.act === 'retry' || v.act === 'wait')) return { act: 'keep', why: 'its automatic resume is still to come' }
    if (v.act === 'skip') return { act: 'keep', why: v.why }
    return { act: 'retire', kind: 'failed-step', why: `the ${p.part} failed ${days(age)} days ago and ${outsideWindow ? 'is past the autopilot\'s 7-day working window' : v.why}` }
  }
  if (!outsideWindow) return { act: 'keep', why: 'it is inside the 7-day window, so the autopilot is still working on it' }
  return { act: 'retire', kind: 'stuck-step', why: `the ${p.part} has been "${p.stage}" with a problem for ${days(age)} days and is past the autopilot's 7-day working window, so nothing will ever finish it` }
}

/** Should this failed social post be closed now? `n` is how many automatic retries it had; `ladderRuns` is true when the retry ladder is working at
 * all (distribution mode auto). `retryVetoed` is the veto list entry of the retry policy (a person put it back on purpose). Pure. */
export function postRetireVerdict(row: FailedPostRow, n: number, now: Date, vetoed: boolean, retryVetoed: boolean, ladderRuns: boolean): RetireVerdict {
  if (vetoed) return { act: 'keep', why: 'a person undid an earlier retirement of this post' }
  if (retryVetoed) return { act: 'keep', why: 'a person put this post back to failed on purpose' }
  if (row.stage !== 'failed') return { act: 'keep', why: `the post is ${row.stage}, not failed` }
  const age = now.getTime() - Date.parse(row.updated_at)
  if (!Number.isFinite(age)) return { act: 'keep', why: 'the failure time is not readable' }
  if (age < RETIRE_AFTER_MS) return { act: 'keep', why: 'it has not sat for 3 days yet' }
  if (age >= HARD_LIMIT_MS) return { act: 'retire', kind: 'failed-post', why: `it failed ${days(age)} days ago and is still failed` }
  const v = postRetryVerdict(row, n, now, false)
  if (v.act === 'skip') return { act: 'keep', why: v.why }
  if (v.act === 'card') return { act: 'retire', kind: 'failed-post', why: `it failed ${days(age)} days ago and ${v.why}` }
  if (ladderRuns) return { act: 'keep', why: 'an automatic retry is still to come' }
  if (age >= PIPELINE_WINDOW_MS) return { act: 'retire', kind: 'failed-post', why: `it failed ${days(age)} days ago and automatic retries are not running (posting is not in auto mode)` }
  return { act: 'keep', why: 'automatic retries are not running, but it has not sat for a week yet' }
}

/** Monday (UTC) of the week of `now`, as YYYY-MM-DD. The weekly digest is keyed by it. Pure. */
export function weekKey(now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7))
  return d.toISOString().slice(0, 10)
}

interface SweepState {
  week: string
  count: number
  kinds: Partial<Record<RetireKind, number>>
}

const KIND_LABEL: Record<RetireKind, string> = { 'failed-post': 'failed social post', 'failed-step': 'failed carousel/video', 'stuck-step': 'stuck carousel/video', 'gone-post': 'row for a deleted post' }

/** The one digest sentence for a finished week. Pure. */
export function digestLine(s: SweepState): string {
  const parts = (Object.keys(KIND_LABEL) as RetireKind[]).filter((k) => (s.kinds[k] ?? 0) > 0).map((k) => `${s.kinds[k]} ${KIND_LABEL[k]}${(s.kinds[k] ?? 0) === 1 ? '' : 's'}`)
  return `Week of ${s.week}: ${s.count} dead item${s.count === 1 ? '' : 's'} retired (${parts.join(', ') || 'none'}). Each has an Undo in this log.`
}

function parseState(raw: unknown, now: Date): SweepState {
  const v = (raw && typeof raw === 'object' ? raw : {}) as Partial<SweepState>
  return { week: typeof v.week === 'string' ? v.week : weekKey(now), count: typeof v.count === 'number' && v.count >= 0 ? v.count : 0, kinds: v.kinds && typeof v.kinds === 'object' ? v.kinds : {} }
}

// ---------------------------------------------------------------------------------------------------
// Undo refs (stored on the decision, JSON, small)
// ---------------------------------------------------------------------------------------------------

interface PostRef {
  k: 'post'
  s: string
  e: string | null
  c: RetireKind
}
interface StepRef {
  k: 'step'
  s: string
  p: 'carousel' | 'video'
  st: string
  e: string | null
  c: RetireKind
}
const KINDS: readonly string[] = ['failed-post', 'failed-step', 'stuck-step', 'gone-post']
const kindOf = (c: unknown, fallback: RetireKind): RetireKind => (typeof c === 'string' && KINDS.includes(c) ? (c as RetireKind) : fallback)
type Ref = PostRef | StepRef

const clip = (t: string | null, n: number): string | null => (t ? t.slice(0, n) : null)
const stageKeyOf = (part: 'carousel' | 'video') => (part === 'video' ? 'video_stage' : 'carousel_stage')

function parseRef(ref: string): Ref | null {
  try {
    const v = JSON.parse(ref) as Partial<Ref> | null
    if (v && v.k === 'post' && typeof v.s === 'string') return { k: 'post', s: v.s, e: typeof v.e === 'string' ? v.e : null, c: kindOf(v.c, 'failed-post') }
    if (v && v.k === 'step' && typeof v.s === 'string' && (v.p === 'carousel' || v.p === 'video') && typeof v.st === 'string') return { k: 'step', s: v.s, p: v.p, st: v.st, e: typeof v.e === 'string' ? v.e : null, c: kindOf(v.c, 'failed-step') }
  } catch {
    // fall through
  }
  return null
}

async function bumpDigest(admin: SupabaseClient, kind: RetireKind, delta: 1 | -1, now: Date): Promise<void> {
  const s = parseState(await readJsonSetting<unknown>(admin, DEAD_LETTER_STATE_KEY, null), now)
  s.count = Math.max(0, s.count + delta)
  s.kinds[kind] = Math.max(0, (s.kinds[kind] ?? 0) + delta)
  await writeJsonSetting(admin, DEAD_LETTER_STATE_KEY, s)
}

/** Takes one retirement back: the row goes to exactly the stage and error it had. Never throws. */
export async function undoDeadLetter(admin: SupabaseClient, refText: string): Promise<{ ok: boolean; message: string }> {
  try {
    const ref = parseRef(refText)
    if (!ref) return { ok: false, message: 'The undo record could not be read, so nothing was changed.' }
    const now = new Date().toISOString()
    if (ref.k === 'post') {
      const { data, error } = await admin.from('post_distribution').select('stage, last_error').eq('content_type', 'post').eq('slug', ref.s).maybeSingle()
      if (error) return { ok: false, message: `Could not read the post (${error.message}).` }
      const row = data as { stage: string; last_error: string | null } | null
      if (!row) return { ok: false, message: 'That post is no longer in the posting list.' }
      if (row.stage !== 'done' || !(row.last_error ?? '').startsWith(RETIRED_PREFIX)) return { ok: false, message: `It is ${row.stage} now and was changed since, so it was left alone.` }
      const { error: e2 } = await admin.from('post_distribution').update({ stage: 'failed', last_error: ref.e ?? 'Put back to failed by a person (a retirement was undone). It will not be retired again.', updated_at: now }).eq('content_type', 'post').eq('slug', ref.s).eq('stage', 'done')
      if (e2) return { ok: false, message: e2.message }
      await bumpDigest(admin, ref.c, -1, new Date()).catch(() => undefined)
      return { ok: true, message: 'The post is back to failed and will not be retired again.' }
    }
    const stageKey = stageKeyOf(ref.p)
    const { data, error } = await admin.from('content_pipeline').select(`slug, ${stageKey}, last_error`).eq('slug', ref.s).maybeSingle()
    if (error) return { ok: false, message: `Could not read the ${ref.p} (${error.message}).` }
    const row = data as Record<string, string | null> | null
    if (!row) return { ok: false, message: 'That post is no longer in the pipeline.' }
    if (row[stageKey] !== 'skipped') return { ok: false, message: `The ${ref.p} is ${row[stageKey]} now and was changed since, so it was left alone.` }
    const { error: e2 } = await admin.from('content_pipeline').update({ [stageKey]: ref.st, last_error: row.last_error ?? ref.e, updated_at: now }).eq('slug', ref.s).eq(stageKey, 'skipped')
    if (e2) return { ok: false, message: e2.message }
    await bumpDigest(admin, ref.c, -1, new Date()).catch(() => undefined)
    return { ok: true, message: `The ${ref.p} is back as ${ref.st} and will not be retired again.` }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'The undo failed.' }
  }
}

// ---------------------------------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------------------------------

interface PipelineRowRead {
  slug: string
  carousel_stage: string
  video_stage: string
  last_error: string | null
  created_at: string
  updated_at: string
  carousel_sent: string[] | null
  video_sent: string[] | null
}

interface RetryStateRead {
  retries?: Record<string, { n?: number }>
}

const nOf = (state: RetryStateRead, subject: string): number => {
  const n = state.retries?.[subject]?.n
  return typeof n === 'number' && Number.isFinite(n) ? Math.min(n, MAX_AUTO_RETRIES) : 0
}

/** The sweep itself, callable from the check with a fake. Never throws past the caller's try; each retirement is isolated. */
export async function sweepDeadLetters(ctx: FlywheelContext): Promise<FlywheelResult> {
  if (ctx.dryRun || isDryRunActive()) return { ran: false, reason: 'dry run' }
  const { admin, now } = ctx
  let room = Math.min(ctx.room, PER_PASS_MAX)
  if (room <= 0) return { ran: false, reason: 'no room left under today\'s limit' }

  const vetoes = await readVetoes(admin)
  const retryState = await readJsonSetting<RetryStateRead>(admin, RETRY_STATE_KEY, {})
  const notes: string[] = []
  let acted = 0
  const state = parseState(await readJsonSetting<unknown>(admin, DEAD_LETTER_STATE_KEY, null), now)
  const thisWeek = weekKey(now)
  let stateDirty = false

  // A finished week with retirements gets its one digest line first (it counts as one action under the cap).
  if (state.week !== thisWeek) {
    if (state.count > 0 && room > 0) {
      await logDecision(admin, 'dead_letter', `digest ${state.week}`, `Weekly digest: ${state.count} dead item${state.count === 1 ? '' : 's'} retired`, digestLine(state), null, now)
      room--
      acted++
      notes.push('weekly digest')
      state.week = thisWeek
      state.count = 0
      state.kinds = {}
      stateDirty = true
    } else if (state.count === 0) {
      state.week = thisWeek
      state.kinds = {}
      stateDirty = true
    }
  }

  const record = async (kind: RetireKind): Promise<void> => {
    state.count++
    state.kinds[kind] = (state.kinds[kind] ?? 0) + 1
    stateDirty = true
  }

  // (b) failed social posts whose ladder is spent.
  if (room > 0) {
    let ladderRuns = false
    try {
      ladderRuns = (await getDistributionMode(admin)) === 'auto'
    } catch {
      ladderRuns = true // unknown: assume the ladder may still run, which keeps rows rather than retiring them
    }
    const cutoff = new Date(now.getTime() - RETIRE_AFTER_MS).toISOString()
    const { data, error } = await admin.from('post_distribution').select('slug, stage, last_error, sent_platforms, updated_at').eq('content_type', 'post').eq('stage', 'failed').lt('updated_at', cutoff).order('updated_at', { ascending: true }).limit(40)
    if (!error) {
      for (const row of (data ?? []) as FailedPostRow[]) {
        if (room <= 0 || ctx.remainingMs() < 3_000) break
        const v = postRetireVerdict(row, nOf(retryState, row.slug), now, isVetoedIn(vetoes, 'dead_letter', row.slug), isVetoedIn(vetoes, 'retry_failed_posts', row.slug), ladderRuns)
        if (v.act !== 'retire') continue
        try {
          const prior = clip(row.last_error, 200)
          const note = `${RETIRED_PREFIX}this post could not be posted and was left alone for ${days(now.getTime() - Date.parse(row.updated_at))} days. Was: ${prior ?? 'no reason recorded'}`.slice(0, 300)
          const { data: changed, error: e2 } = await admin.from('post_distribution').update({ stage: 'done', last_error: note, updated_at: now.toISOString() }).eq('content_type', 'post').eq('slug', row.slug).eq('stage', 'failed').select('slug')
          if (e2 || !((changed ?? []) as unknown[]).length) continue
          await logDecision(admin, 'dead_letter', row.slug, 'Retired a failed social post (no more retries)', v.why, { kind: 'fw:dead_letter', ref: JSON.stringify({ k: 'post', s: row.slug, e: prior, c: v.kind } satisfies PostRef) }, now)
          await record(v.kind)
          room--
          acted++
        } catch {
          // one row failing never stops the others
        }
      }
    }
  }

  // (a) and (c): carousel and video rows.
  if (room > 0 && ctx.remainingMs() >= 3_000) {
    const { data, error } = await admin.from('content_pipeline').select('slug, carousel_stage, video_stage, last_error, created_at, updated_at, carousel_sent, video_sent').not('last_error', 'is', null).order('updated_at', { ascending: true }).limit(100)
    if (!error) {
      const rows = (data ?? []) as PipelineRowRead[]
      let existing: Set<string> | null = null
      if (rows.length) {
        const { data: posts, error: pe } = await admin.from('posts').select('slug').in('slug', rows.map((r) => r.slug))
        existing = pe ? null : new Set(((posts ?? []) as { slug: string }[]).map((p) => p.slug))
      }
      for (const row of rows) {
        for (const part of ['carousel', 'video'] as const) {
          if (room <= 0 || ctx.remainingMs() < 3_000) break
          const stageKey = stageKeyOf(part)
          const stage = row[stageKey]
          const subject = `${row.slug}:${part}`
          const other = row[stageKeyOf(part === 'video' ? 'carousel' : 'video')]
          const v = stepRetireVerdict(
            { slug: row.slug, part, stage, otherStage: other, last_error: row.last_error, created_at: row.created_at, updated_at: row.updated_at, sent: (part === 'video' ? row.video_sent : row.carousel_sent) ?? [] },
            nOf(retryState, subject),
            existing ? existing.has(row.slug) : null,
            now,
            isVetoedIn(vetoes, 'dead_letter', subject),
          )
          if (v.act !== 'retire') continue
          try {
            // last_error is shared by both parts: keep it while the other part is still failed, clear it (as Dismiss does) otherwise.
            const priorErr = clip(row.last_error, 200)
            const patch: Record<string, unknown> = { [stageKey]: 'skipped', updated_at: now.toISOString() }
            if (other !== 'failed') patch.last_error = null
            const { data: changed, error: e2 } = await admin.from('content_pipeline').update(patch).eq('slug', row.slug).eq(stageKey, stage).select('slug')
            if (e2 || !((changed ?? []) as unknown[]).length) continue
            row[stageKey] = 'skipped'
            if (other !== 'failed') row.last_error = null
            await logDecision(admin, 'dead_letter', subject, `Retired a ${v.kind === 'gone-post' ? 'row for a deleted post' : part === 'video' ? 'stuck video' : 'stuck carousel'} (the post stays as it is)`, v.why, { kind: 'fw:dead_letter', ref: JSON.stringify({ k: 'step', s: row.slug, p: part, st: stage, e: priorErr, c: v.kind } satisfies StepRef) }, now)
            await record(v.kind)
            room--
            acted++
          } catch {
            // one row failing never stops the others
          }
        }
      }
    }
  }

  if (stateDirty) await writeJsonSetting(admin, DEAD_LETTER_STATE_KEY, state)
  if (!acted) return { ran: false, reason: 'nothing dead to retire' }
  const retired = acted - (notes.includes('weekly digest') ? 1 : 0)
  return { ran: true, acted, note: `${[retired ? `retired ${retired}` : '', ...notes].filter(Boolean).join(', ')}` }
}

export const deadLetterStep: FlywheelStep = {
  id: 'dead_letter',
  policy: 'dead_letter',
  label: 'Dead-letter and stale-issue sweeper',
  order: 50,
  floorMs: 10_000,
  run: sweepDeadLetters,
  undo: undoDeadLetter,
}
