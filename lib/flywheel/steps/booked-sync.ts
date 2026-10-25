import type { SupabaseClient } from '@supabase/supabase-js'
import { isVetoed, logDecision, readJsonSetting, writeJsonSetting } from '@/lib/flywheel/ctx'
import { setLeadStatus } from '@/lib/lead-desk-store'
import { isTestEmail } from '@/lib/test-data'
import type { FlywheelContext, FlywheelResult, FlywheelStep } from '@/lib/flywheel/types'

// WP2: Order to lead booked sync (policy booked_sync, docs/factory/AUTOPILOT-AUDIT.md "WP2").
//
// When a paid, non-test order is in the ledger (lib/purchase-ledger.ts recordOrder) and a lead with the same email is still open
// (new, assigned or contacted), the lead is marked booked through the existing setLeadStatus, once per order, with a decision-log line
// and an Undo that puts back the old status, note and first-contact time. Nothing else: no price is read or written, nobody is
// messaged, no lead is assigned, a lead a person marked lost is left alone, and an order with no matching lead logs nothing.
//
// "Once per order" is kept in app_settings.booked_sync_done (order id -> what was done), bounded, because the 100-line decision log is
// too short to rely on. A lead already booked is never touched again either, so a lost write of that map cannot double-apply.

export const DONE_KEY = 'booked_sync_done'
/** Orders older than this are not looked at (the webhook marks them within minutes; this only covers a long outage). */
export const ORDER_WINDOW_DAYS = 14
/** An order with no lead is re-checked each pass for this long, then remembered as "no lead" so it is not queried forever. */
export const NO_LEAD_RECHECK_DAYS = 2
const MAX_ORDERS_PER_PASS = 40
const MAX_DONE = 300
const OPEN_STATUSES = new Set(['new', 'assigned', 'contacted'])
const NOTE_MAX = 500

interface DoneEntry {
  at: string
  /** 'booked' = the lead was marked; 'no-lead' = no open lead was found after the re-check period. */
  result: 'booked' | 'no-lead'
  lead?: string
  prevStatus?: string
  prevNote?: string | null
  prevFirstContact?: string | null
  undone?: boolean
}
type DoneMap = Record<string, DoneEntry>

interface OrderRow {
  id: string
  email: string | null
  package_slug: string | null
  created_at: string | null
}
interface LeadRow {
  id: string
  status: string | null
  desk_note: string | null
  first_contact_at: string | null
}

const bound = (m: DoneMap): DoneMap => {
  const keys = Object.keys(m)
  if (keys.length <= MAX_DONE) return m
  const keep = keys.sort((a, b) => (m[a].at < m[b].at ? -1 : 1)).slice(keys.length - MAX_DONE)
  return Object.fromEntries(keep.map((k) => [k, m[k]]))
}

/** The desk note after a sync: the old note kept, then a short booked line (package slug only, no price). Pure. */
export function bookedNote(prev: string | null | undefined, slug: string | null | undefined): string {
  const line = `Marked booked automatically from a paid order${slug ? ` (package: ${String(slug).replace(/[^a-z0-9-_]/gi, '').slice(0, 80)})` : ''}.`
  const old = (prev ?? '').trim()
  if (!old) return line
  const room = NOTE_MAX - line.length - 3
  return room > 0 ? `${old.slice(0, room)} | ${line}` : line.slice(0, NOTE_MAX)
}

async function openLeadFor(admin: SupabaseClient, email: string): Promise<LeadRow | null> {
  const pattern = email.trim().replace(/[\\%_]/g, (m) => `\\${m}`)
  const { data, error } = await admin
    .from('leads')
    .select('id, status, desk_note, first_contact_at')
    .ilike('email', pattern)
    .eq('is_test', false)
    .order('created_at', { ascending: false })
    .limit(10)
  if (error) throw new Error(error.message)
  const rows = (Array.isArray(data) ? data : []) as LeadRow[]
  return rows.find((r) => OPEN_STATUSES.has(r.status ?? 'new')) ?? null
}

async function runBookedSync(ctx: FlywheelContext): Promise<FlywheelResult> {
  if (ctx.dryRun) return { ran: false, reason: 'dry run: nothing is written' }
  if (ctx.room <= 0) return { ran: false, reason: 'the daily limit is used up' }
  const { admin, now } = ctx

  const since = new Date(now.getTime() - ORDER_WINDOW_DAYS * 86_400_000).toISOString()
  const { data, error } = await admin
    .from('orders')
    .select('id, email, package_slug, created_at')
    .eq('status', 'paid')
    .eq('is_test', false)
    .gte('created_at', since)
    .order('created_at', { ascending: true })
    .limit(MAX_ORDERS_PER_PASS * 2)
  if (error) throw new Error(`could not read orders (${error.message})`)

  let done = await readJsonSetting<DoneMap>(admin, DONE_KEY, {})
  const orders = ((Array.isArray(data) ? data : []) as OrderRow[]).filter((o) => o.id && o.email && !isTestEmail(o.email) && !done[o.id]).slice(0, MAX_ORDERS_PER_PASS)
  if (!orders.length) return { ran: false, reason: 'no new paid orders to match' }

  let acted = 0
  let changedMap = false
  const failures: string[] = []
  for (const o of orders) {
    if (acted >= ctx.room) break
    if (ctx.remainingMs() < 2_000) break
    try {
      const lead = await openLeadFor(admin, o.email as string)
      if (!lead) {
        // Give a lead a couple of days to show up before the order is written off as "no lead".
        const age = now.getTime() - new Date(o.created_at ?? now).getTime()
        if (age > NO_LEAD_RECHECK_DAYS * 86_400_000) {
          done[o.id] = { at: now.toISOString(), result: 'no-lead' }
          changedMap = true
        }
        continue
      }
      if (await isVetoed(admin, 'booked_sync', lead.id)) continue

      const res = await setLeadStatus(admin, lead.id, 'booked', bookedNote(lead.desk_note, o.package_slug), now)
      if (!res.ok) {
        failures.push(res.error)
        continue
      }
      acted++
      done[o.id] = { at: now.toISOString(), result: 'booked', lead: lead.id, prevStatus: lead.status ?? 'new', prevNote: lead.desk_note ?? null, prevFirstContact: lead.first_contact_at ?? null }
      const saved = await writeJsonSetting(admin, DONE_KEY, bound(done))
      changedMap = false
      await logDecision(
        admin,
        'booked_sync',
        lead.id,
        'Marked the lead booked',
        `A paid order arrived for the same email${o.package_slug ? ` (package ${o.package_slug})` : ''}. The lead was ${lead.status ?? 'new'}.`,
        saved.error ? null : { kind: 'fw:booked_sync', ref: o.id },
        now,
      )
    } catch (e) {
      failures.push(e instanceof Error ? e.message : 'unknown error')
    }
  }
  if (changedMap) await writeJsonSetting(admin, DONE_KEY, bound(done))

  if (acted === 0 && failures.length === 0) return { ran: false, reason: 'no open lead matches a new paid order' }
  if (acted === 0) throw new Error(`could not mark any lead booked (${failures[0]})`)
  return { ran: true, acted, note: `marked ${acted} lead${acted === 1 ? '' : 's'} booked from paid orders${failures.length ? `, ${failures.length} failed` : ''}` }
}

async function undoBookedSync(admin: SupabaseClient, ref: string): Promise<{ ok: boolean; message: string }> {
  const done = await readJsonSetting<DoneMap>(admin, DONE_KEY, {})
  const e = done[ref]
  if (!e || e.result !== 'booked' || !e.lead) return { ok: false, message: 'There is no record of this sync, so it cannot be undone.' }
  if (e.undone) return { ok: false, message: 'This was already undone.' }
  const { data, error } = await admin.from('leads').select('id, status').eq('id', e.lead).maybeSingle()
  if (error) return { ok: false, message: `Could not read the lead (${error.message}).` }
  if (!data) return { ok: false, message: 'That lead is gone.' }
  if ((data as { status: string | null }).status !== 'booked') return { ok: false, message: `The lead is now ${(data as { status: string | null }).status ?? 'unknown'}, changed by a person, so it was left alone.` }
  const prev = e.prevStatus && OPEN_STATUSES.has(e.prevStatus) ? e.prevStatus : 'new'
  const { error: e2 } = await admin.from('leads').update({ status: prev, desk_note: e.prevNote ?? null, first_contact_at: e.prevFirstContact ?? null }).eq('id', e.lead).eq('status', 'booked')
  if (e2) return { ok: false, message: e2.message }
  // Keep the order marked as handled so the next pass does not book the lead again.
  done[ref] = { ...e, undone: true }
  await writeJsonSetting(admin, DONE_KEY, bound(done))
  return { ok: true, message: `The lead is back to ${prev}. It will not be booked again from this order.` }
}

export const bookedSyncStep: FlywheelStep = {
  id: 'booked_sync',
  policy: 'booked_sync',
  label: 'Order to lead booked sync',
  order: 20,
  floorMs: 5_000,
  run: runBookedSync,
  undo: undoBookedSync,
}
