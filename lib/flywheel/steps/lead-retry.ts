import type { SupabaseClient } from '@supabase/supabase-js'
import { sendThrottledAlert } from '@/lib/alerts'
import { isDryRunActive } from '@/lib/dry-run'
import { canResendLead, isNewsletterRow, LEAD_RESEND_COLUMNS, resendLeadRow, type LeadRow } from '@/lib/heal'
import { HEAL_TRIES, LADDER_TRIES, needsPerson, parseLeadMarker, retryDue, retryMarker, stripMarker } from '@/lib/lead-retry-ladder'
import { isVetoed, logDecision } from '@/lib/flywheel/ctx'
import type { FlywheelContext, FlywheelResult, FlywheelStep } from '@/lib/flywheel/types'

// WP3: the Lead to GoHighLevel retry ladder, with a hand-over to a person when it is spent (policy lead_retry).
//
// A lead is saved here BEFORE GoHighLevel is called (lib/leads.ts saveLeadFirst). If the send fails it stays "not sent yet" and the ladder
// (lib/lead-retry-ladder.ts) tries again as the lead ages: 5 minutes, 1 hour, 6 hours (healLeads in lib/heal.ts, every pass), then 24 hours
// and 72 hours (this step). A lead is retried for up to 7 days. When all five sends failed, or the lead is older than 7 days, this step
// marks it "[gave up]" (the Leads page, the Today "Needs a look" card and the Needs attention list show it) and sends ONE existing alert
// email that carries no name, email or phone.
//
// Rules kept: capped per day by the policy gate (each send attempt counts; the hand-over does not); nothing runs in a dry run, while
// everything is paused, or when the policy switch is off (all enforced by the runner); each failed attempt and each hand-over is logged
// with an Undo that stops the automation for that lead; a lead a person undid is never touched again (veto list); never assigns a lead,
// never sets a price, never messages the visitor. One lead failing never stops the others.

const POLICY = 'lead_retry' as const
/** Leads read per pass. Older than the 7 day window by up to a week, so a lead that ran out of time is still handed over. */
const READ_LIMIT = 40
const LOOKBACK_MS = 14 * 86_400_000
const MAX_HANDOVERS_PER_PASS = 5
/** A pass stops starting new sends when less than this is left in the budget (a send can take 20 s). */
const MIN_REMAINING_MS = 25_000

export interface LeadRetryDeps {
  /** Sends one saved row to GoHighLevel. */
  send: (row: LeadRow) => Promise<{ ok: boolean; error?: string }>
  /** The one existing alert email (shared throttle). */
  alert: (admin: SupabaseClient, subject: string, lines: string[]) => Promise<string>
  isDry: () => boolean
}

const defaultDeps: LeadRetryDeps = {
  send: resendLeadRow,
  alert: (admin, subject, lines) => sendThrottledAlert(admin, subject, lines),
  isDry: isDryRunActive,
}

async function adminUrl(): Promise<string> {
  try {
    return `${(await import('@/lib/site')).SITE_URL}/admin/leads`
  } catch {
    return '/admin/leads'
  }
}

export async function runLeadRetry(ctx: FlywheelContext, deps: LeadRetryDeps = defaultDeps): Promise<FlywheelResult> {
  if (ctx.dryRun || deps.isDry()) return { ran: false, reason: 'dry run' }
  const nowMs = ctx.now.getTime()
  const { data, error } = await ctx.admin
    .from('leads')
    .select(LEAD_RESEND_COLUMNS)
    .eq('forwarded_to_ghl', false)
    .eq('is_test', false)
    .lt('created_at', new Date(nowMs - 5 * 60_000).toISOString())
    .gt('created_at', new Date(nowMs - LOOKBACK_MS).toISOString())
    .order('created_at', { ascending: true })
    .limit(READ_LIMIT)
  if (error) return { ran: false, reason: `could not read the saved leads (${error.message})` }

  let attempts = 0
  let sent = 0
  let failedSends = 0
  let handedOver = 0
  let errors = 0
  for (const row of (data ?? []) as LeadRow[]) {
    if (ctx.remainingMs() < MIN_REMAINING_MS) break
    try {
      const marker = parseLeadMarker(row.ghl_error)
      if (marker.finished) continue
      const createdAt = Date.parse(row.created_at)
      if (!Number.isFinite(createdAt)) continue
      const spent = needsPerson(marker, createdAt, nowMs)
      // Tries 1 to 3 belong to healLeads; this step makes tries 4 and 5.
      const due = !spent && marker.tries >= HEAL_TRIES && retryDue(marker, createdAt, nowMs)
      if (!spent && !due) continue
      if (!canResendLead(row)) continue // a signup without a recorded consent is never re-sent and is not a lead for a person
      if (await isVetoed(ctx.admin, POLICY, row.id)) continue
      const what = isNewsletterRow(row) ? 'newsletter signup' : 'lead'

      if (spent) {
        if (handedOver >= MAX_HANDOVERS_PER_PASS) continue
        const previous = row.ghl_error ?? ''
        const { error: upErr } = await ctx.admin.from('leads').update({ ghl_error: `[gave up] ${previous}`.slice(0, 300) }).eq('id', row.id).eq('forwarded_to_ghl', false)
        if (upErr) throw new Error(upErr.message)
        handedOver++
        await logDecision(ctx.admin, POLICY, row.id, `Needs you: a saved ${what} never reached GoHighLevel`, marker.tries >= LADDER_TRIES ? `All ${LADDER_TRIES} automatic sends failed, so it is on your Leads page for you to add by hand.` : 'It is older than 7 days, so the automatic sends stopped and it is on your Leads page for you to add by hand.', { kind: 'fw:lead_retry', ref: `reopen:${row.id}` }, ctx.now)
        continue
      }

      if (attempts >= ctx.room) continue
      attempts++
      const result = await deps.send(row)
      if (result.ok) {
        const { error: upErr } = await ctx.admin.from('leads').update({ forwarded_to_ghl: true, ghl_error: null }).eq('id', row.id)
        sent++
        await logDecision(ctx.admin, POLICY, row.id, `Sent a saved ${what} to GoHighLevel`, `Try ${marker.tries + 1} of ${LADDER_TRIES} worked.${upErr ? ' The row could not be marked as sent, so check the Leads page.' : ''}`, null, ctx.now)
      } else {
        const tries = marker.tries + 1
        const { error: upErr } = await ctx.admin.from('leads').update({ ghl_error: retryMarker(tries, result.error ?? 'GoHighLevel did not accept it', ctx.now) }).eq('id', row.id).eq('forwarded_to_ghl', false)
        if (upErr) throw new Error(upErr.message)
        failedSends++
        await logDecision(ctx.admin, POLICY, row.id, `Tried a saved ${what} again; GoHighLevel still refused it`, tries >= LADDER_TRIES ? `Try ${tries} of ${LADDER_TRIES} failed. That was the last automatic try.` : `Try ${tries} of ${LADDER_TRIES} failed. The next try is later.`, { kind: 'fw:lead_retry', ref: `stop:${row.id}` }, ctx.now)
      }
    } catch {
      errors++ // one lead failing must never stop the next
    }
  }

  let alertNote = ''
  if (handedOver > 0) {
    try {
      const outcome = await deps.alert(ctx.admin, `${handedOver} lead${handedOver === 1 ? '' : 's'} never reached GoHighLevel`, [
        `${handedOver} saved lead${handedOver === 1 ? '' : 's'} could not be sent to GoHighLevel after the full retry ladder.`,
        'They are safe on the Leads page. Add them to GoHighLevel by hand and check the GoHighLevel keys in Vercel.',
        `Open: ${await adminUrl()}`,
      ])
      alertNote = `, alert email ${outcome}`
    } catch {
      alertNote = ', alert email failed'
    }
  }

  const acted = sent + failedSends + handedOver
  if (acted === 0 && errors === 0) return { ran: false, reason: 'no saved lead is due for a retry' }
  const parts = [sent ? `${sent} sent` : '', failedSends ? `${failedSends} still refused` : '', handedOver ? `${handedOver} handed to you` : '', errors ? `${errors} skipped after an error` : ''].filter(Boolean)
  return { ran: true, acted, note: `lead retry: ${parts.join(', ')}${alertNote}` }
}

/** Takes a lead_retry decision back. ref is "stop:<lead id>" (a failed try: stop retrying this lead) or "reopen:<lead id>" (a hand-over: put the
 * reason back as it was). Either way the Undo route adds the lead to the veto list, so this step never touches it again. Never sends anything. */
export async function undoLeadRetry(admin: SupabaseClient, ref: string): Promise<{ ok: boolean; message: string }> {
  const m = /^(stop|reopen):([A-Za-z0-9-]{8,64})$/.exec(ref)
  if (!m) return { ok: false, message: 'This decision cannot be undone from here.' }
  const [, kind, id] = m
  const { data, error } = await admin.from('leads').select('forwarded_to_ghl, ghl_error').eq('id', id).maybeSingle()
  if (error) return { ok: false, message: `Could not read the lead (${error.message}).` }
  const row = data as { forwarded_to_ghl: boolean; ghl_error: string | null } | null
  if (!row) return { ok: false, message: 'That lead is no longer in the list.' }
  if (row.forwarded_to_ghl) return { ok: true, message: 'The lead has reached GoHighLevel since, so there is nothing to undo.' }
  const marker = parseLeadMarker(row.ghl_error)
  if (kind === 'stop') {
    if (marker.finished) return { ok: true, message: 'The automatic tries for this lead had already stopped.' }
    const { error: e2 } = await admin.from('leads').update({ ghl_error: `[stopped] ${row.ghl_error ?? ''}`.slice(0, 300) }).eq('id', id).eq('forwarded_to_ghl', false)
    return e2 ? { ok: false, message: e2.message } : { ok: true, message: 'No more automatic tries for this lead. It stays on your Leads page.' }
  }
  if (marker.finished !== 'gave up') return { ok: false, message: 'This lead is no longer marked as handed over, so it was left alone.' }
  const { error: e3 } = await admin.from('leads').update({ ghl_error: stripMarker(row.ghl_error) || null }).eq('id', id).eq('forwarded_to_ghl', false)
  return e3 ? { ok: false, message: e3.message } : { ok: true, message: 'The reason is back as it was. The autopilot will not touch this lead again; it stays on your Leads page.' }
}

export const leadRetryStep: FlywheelStep = {
  id: 'lead_retry',
  policy: 'lead_retry',
  label: 'Lead to GHL retry ladder',
  order: 30,
  floorMs: 10_000,
  // A send can take 20 s; five of them plus the alert stay inside this.
  maxMs: 110_000,
  run: (ctx) => runLeadRetry(ctx),
  undo: undoLeadRetry,
}
