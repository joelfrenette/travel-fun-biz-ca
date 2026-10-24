import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { getSetting, setSetting } from '@/lib/app-settings'
import { TODAY_KINDS, actionFor, needsConfirm, parseCardId } from '@/lib/today-cards'
import {
  TODAY_LOG_KEY, TODAY_OPS, TODAY_SNOOZE_KEY, addSnooze, appendLog, isDuplicate, markUndone, parseLog, parseSnoozed, plain, removeSnooze, undoVerdict, type LogEntry, type TodayOp,
} from '@/lib/today-state'
import { buildTodayQueue, lastActionOf, readSystemCheck, readWins } from '@/lib/today-queue'
import { runCardAction, undoCardAction } from '@/lib/today-actions'
import { parseSnoozeDays } from '@/lib/today-card-actions'

import { getSystemCheck, loadFixes, readStoredCheck } from '@/lib/system-check-run'
import { summarizeCheck, type CheckSummary } from '@/lib/system-check'
import { summarizeFixes, type FixSummary } from '@/lib/system-check-fixes'
import { readFollowupsCount } from '@/lib/followups-run'
import type { Issue } from '@/lib/issues'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/** The system check summary for the strip: a 5 minute cached answer, or a fresh one; if that takes over 8 seconds, the last stored answer. */
async function readCheckSummary(admin: ReturnType<typeof getSupabaseAdmin>, issues: Issue[]): Promise<{ check: CheckSummary | null; fixes: FixSummary | null }> {
  try {
    const fresh = getSystemCheck(admin, { issues }).then((g) => g.result)
    const slow = new Promise<null>((resolve) => setTimeout(() => resolve(null), 8000))
    const result = (await Promise.race([fresh, slow])) ?? (await readStoredCheck(admin))
    if (!result) return { check: null, fixes: null }
    return { check: summarizeCheck(result), fixes: summarizeFixes(await loadFixes(admin, result)) }
  } catch {
    return { check: null, fixes: null }
  }
}

// GET   the Today queue: the cards to decide now (most urgent first), the counts, the last decision, the System check strip
//       and today's wins.
// POST  {id, kind, op: approve | reject | snooze, confirm?}  take one decision on one card.
//       {op: 'undo'}                                         take back the last decision, where it can be taken back.
// Every decision is written to a small log (app_settings.today_log, the last 50). A second identical tap is ignored.

export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const admin = getSupabaseAdmin()
    const queue = await buildTodayQueue(admin)
    const [system, wins, checked, followups] = await Promise.all([readSystemCheck(admin, queue.issues), readWins(admin), readCheckSummary(admin, queue.issues), readFollowupsCount(admin)])
    return NextResponse.json({
      check: checked.check,
      fixes: checked.fixes,
      followups,
      cards: queue.cards,
      count: queue.cards.length,
      total: queue.total,
      snoozedCount: queue.snoozedCount,
      lastAction: queue.lastAction,
      system,
      wins,
      problems: queue.problems,
      generatedAt: new Date().toISOString(),
    })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}

async function save(admin: ReturnType<typeof getSupabaseAdmin>, snoozed: ReturnType<typeof parseSnoozed> | null, log: LogEntry[] | null): Promise<string | null> {
  let problem: string | null = null
  if (snoozed) {
    const { error } = await setSetting(admin, TODAY_SNOOZE_KEY, JSON.stringify(snoozed))
    if (error) problem = error
  }
  if (log) {
    const { error } = await setSetting(admin, TODAY_LOG_KEY, JSON.stringify(log))
    if (error) problem = error
  }
  return problem
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const body = (await request.json().catch(() => null)) as { id?: unknown; kind?: unknown; op?: unknown; confirm?: unknown; title?: unknown; days?: unknown } | null
    if (!body || typeof body.op !== 'string' || !TODAY_OPS.includes(body.op)) return NextResponse.json({ error: 'op must be approve, reject, snooze or undo.' }, { status: 400 })
    const admin = getSupabaseAdmin()
    const now = Date.now()
    let log = parseLog(await getSetting(admin, TODAY_LOG_KEY).catch(() => null))
    let snoozed = parseSnoozed(await getSetting(admin, TODAY_SNOOZE_KEY).catch(() => null), now)

    // ---- Undo: the last decision that has not been undone, if it can be taken back.
    if (body.op === 'undo') {
      const verdict = undoVerdict(log)
      if (verdict.kind === 'none') return NextResponse.json({ error: 'There is nothing to undo.' }, { status: 409 })
      if (verdict.kind === 'cannot') return NextResponse.json({ error: `The last step (${verdict.entry.title || verdict.entry.id}) cannot be undone.`, cannotUndo: true }, { status: 409 })
      const e = verdict.entry
      const parsed = parseCardId(e.id)
      if (!parsed) return NextResponse.json({ error: 'The last step has an id that is not valid.' }, { status: 400 })
      let message = 'The card is back.'
      if (e.mode === 'run' && e.op !== 'snooze') {
        const r = await undoCardAction({ admin, request, kind: parsed.kind, key: parsed.key, op: e.op, prev: e.prev })
        if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status })
        message = r.message
      }
      snoozed = removeSnooze(snoozed, e.id)
      log = markUndone(log, e.n)
      const warn = await save(admin, snoozed, log)
      return NextResponse.json({ ok: true, undone: true, message, lastAction: lastActionOf(log), ...(warn ? { warning: `The decision log could not be saved (${warn}).` } : {}) })
    }

    // ---- A decision on one card.
    const parsed = parseCardId(body.id)
    if (!parsed) return NextResponse.json({ error: 'That is not a card id.' }, { status: 400 })
    if (body.kind !== undefined && body.kind !== parsed.kind) return NextResponse.json({ error: 'The kind does not match the card.' }, { status: 400 })
    const op = body.op as TodayOp
    const def = TODAY_KINDS[parsed.kind]
    const id = body.id as string

    if (isDuplicate(log, id, op, now)) return NextResponse.json({ ok: true, duplicate: true, message: 'Already done.', lastAction: lastActionOf(log) })

    const title = plain(typeof body.title === 'string' && body.title ? body.title : id).slice(0, 120)
    const entryBase = { id, kind: parsed.kind, op, title, at: new Date(now).toISOString() }
    let hideDays = 0
    let mode: LogEntry['mode'] = 'later'
    let undoable = true
    let prev: LogEntry['prev']
    let message = 'Later. It comes back tomorrow.'

    if (op === 'snooze') {
      // The Later menu sends 1, 3 or 7 days; nothing else is accepted. No days = the kind's own length.
      hideDays = parseSnoozeDays(body.days) ?? def.snoozeDays
      message = `Later. It comes back in ${hideDays} day${hideDays === 1 ? '' : 's'}.`
    } else {
      const action = actionFor(parsed.kind, op)
      if (!action) return NextResponse.json({ error: 'This card has only one button. Use Later for the other side.' }, { status: 400 })
      mode = action.mode
      if (action.mode === 'keep') {
        hideDays = def.keepDays ?? 7
        message = `Left as it is. The card is hidden for ${hideDays} days.`
      } else if (action.mode === 'open') {
        hideDays = def.openDays ?? 1
        message = 'Opening it. The card rests for a day.'
      } else {
        // A real action. One that cannot be taken back needs a confirm tap, checked here and not only in the browser.
        if (needsConfirm(parsed.kind, op) && body.confirm !== true) {
          return NextResponse.json({ error: `"${action.label}" cannot be undone. Tap it again to confirm.`, needsConfirm: true }, { status: 409 })
        }
        const r = await runCardAction({ admin, request, kind: parsed.kind, key: parsed.key, op })
        if (!r.ok) return NextResponse.json({ error: plain(r.error) }, { status: r.status })
        message = plain(r.message)
        prev = r.prev
        undoable = op === 'approve' ? def.undo.primary : def.undo.secondary
        if (r.noop) {
          // Nothing was changed (it was already handled elsewhere): not a decision, so nothing to log or undo.
          return NextResponse.json({ ok: true, noop: true, message, lastAction: lastActionOf(log) })
        }
      }
    }

    if (hideDays > 0) snoozed = addSnooze(snoozed, id, hideDays, now)
    const entry: Omit<LogEntry, 'n'> = { ...entryBase, mode, undoable: mode === 'run' ? undoable : true, ...(prev ? { prev } : {}) }
    log = appendLog(log, entry)
    const warn = await save(admin, hideDays > 0 ? snoozed : null, log)
    return NextResponse.json({ ok: true, message, lastAction: lastActionOf(log), ...(warn ? { warning: `The decision log could not be saved (${warn}).` } : {}) })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}
