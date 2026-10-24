import type { SupabaseClient } from '@supabase/supabase-js'
import { getSetting, setSetting } from '@/lib/app-settings'
import { notifyTo } from '@/lib/alerts'
import { isAutomationPaused } from '@/lib/automation-kill-switch'
import { TODAY_LEADS_DONE_KEY, TODAY_LOG_KEY, addToIdList, appendLog, parseIdList, parseLog, plain } from '@/lib/today-state'
import {
  DESK_EMAILS_KEY, DESK_SMS_KEY, DESK_STATE_KEY, REMINDER_AFTER_MIN, REMINDER_WINDOW_MIN, agentTag, buildAgentEmail, buildDeskEmail, buildDeskSms,
  claimAlert, cleanAssignedBy, ghlAssignNote, isAssignableStatus, isLeadStatus, parseAlertState, parseDeskEmails, parseSmsContactIds,
  reminderDue, waitMinutes, type HotLeadInfo, type HotWait, type PickerAgent,
} from '@/lib/lead-desk'

// Database and network side of the lead desk. Server only; every function here is called by an admin route, the
// 15 minute autopilot pass, or the form routes (fire and forget). Nothing in here ever picks an agent for the office:
// assignLead only records the agent a person chose.
//
// PRIVACY: lead details and agents' private emails stay on this side. The desk email and text carry no name, email or
// phone (lib/lead-desk.ts). Only assignLead sends details, and only to the chosen agent's own roster address.

type Row = Record<string, unknown>
const str = (v: unknown) => (typeof v === 'string' ? v : '')

export interface DeskDeps {
  admin?: SupabaseClient
  fetchImpl?: typeof fetch
  get?: (key: string) => Promise<string | null>
  set?: (key: string, value: string) => Promise<unknown>
  now?: () => Date
  /** Sends one text to a GoHighLevel contact id. Defaults to the real helper. */
  sendSms?: (contactId: string, message: string) => Promise<{ ok: boolean }>
  adminUrl?: string
}

async function clientOf(deps: DeskDeps): Promise<SupabaseClient> {
  return deps.admin ?? (await import('@/lib/supabase-admin')).getSupabaseAdmin()
}

async function siteAdminUrl(deps: DeskDeps): Promise<string> {
  if (deps.adminUrl) return deps.adminUrl
  const { SITE_URL } = await import('@/lib/site')
  return `${SITE_URL}/admin`
}

function fromAddress(): string {
  return process.env.LEAD_DESK_FROM_EMAIL?.trim() || process.env.LEAD_ACK_FROM_EMAIL?.trim() || process.env.ALERT_FROM_EMAIL?.trim() || 'TravelFunBiz Autopilot <onboarding@resend.dev>'
}

async function sendMail(deps: DeskDeps, to: string[], subject: string, text: string): Promise<boolean> {
  const key = process.env.RESEND_API_KEY?.trim()
  if (!key || to.length === 0) return false
  const res = await (deps.fetchImpl ?? fetch)('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: fromAddress(), to, subject, text }),
    signal: AbortSignal.timeout(15_000),
  })
  return res.ok
}

// ---- the alert and the reminder --------------------------------------------------------------------------

export type DeskAlertStatus = 'sent' | 'test' | 'duplicate' | 'not-configured' | 'failed'
export interface DeskAlertResult {
  status: DeskAlertStatus
  email: 'sent' | 'failed' | 'not-configured'
  /** skipped = no contact ids are set (an amber setup item on the System check, never a failure). */
  sms: 'sent' | 'failed' | 'skipped'
}

/** Sends the desk email and text for a hot lead. Idempotent: each lead is claimed once for the alert ("a") and once for
 * the reminder ("r"); a second call for the same lead and kind does nothing. Never throws. */
export async function sendDeskAlert(info: HotLeadInfo, kind: 'a' | 'r', deps: DeskDeps = {}, waitedMinutes?: number): Promise<DeskAlertResult> {
  const none: DeskAlertResult = { status: 'failed', email: 'not-configured', sms: 'skipped' }
  try {
    if (!info.id) return { ...none, status: 'not-configured' }
    if (info.isTest) return { ...none, status: 'test' }
    const admin = deps.get && deps.set ? null : await clientOf(deps)
    const get = deps.get ?? (async (k: string) => getSetting(admin as SupabaseClient, k))
    const set = deps.set ?? (async (k: string, v: string) => setSetting(admin as SupabaseClient, k, v))
    const now = deps.now?.() ?? new Date()

    // Claim first: a retry or a double call for the same lead can never send twice.
    const claimed = claimAlert(parseAlertState(await get(DESK_STATE_KEY)), info.id, kind, now)
    if (!claimed) return { ...none, status: 'duplicate' }
    await set(DESK_STATE_KEY, JSON.stringify(claimed))

    const url = await siteAdminUrl(deps)
    const reminder = kind === 'r'
    const emails = parseDeskEmails(await get(DESK_EMAILS_KEY))
    const to = emails.length > 0 ? emails : [notifyTo()].filter(Boolean)
    let email: DeskAlertResult['email'] = 'not-configured'
    if (to.length > 0 && process.env.RESEND_API_KEY?.trim()) {
      const mail = buildDeskEmail(info, url, { reminder, waitedMinutes })
      email = (await sendMail(deps, to, mail.subject, mail.text).catch(() => false)) ? 'sent' : 'failed'
    }

    const ids = parseSmsContactIds(await get(DESK_SMS_KEY))
    let sms: DeskAlertResult['sms'] = 'skipped'
    if (ids.length > 0) {
      const send = deps.sendSms ?? (async (id: string, msg: string) => (await import('@/lib/gohighlevel')).sendGhlSms(id, msg))
      const text = buildDeskSms(info, url, { reminder })
      const results = await Promise.all(ids.map((id) => send(id, text).then((r) => r.ok).catch(() => false)))
      sms = results.some(Boolean) ? 'sent' : 'failed'
    }
    return { status: email === 'failed' || sms === 'failed' ? 'failed' : email === 'not-configured' && sms === 'skipped' ? 'not-configured' : 'sent', email, sms }
  } catch {
    return none
  }
}

/** The first alert for a hot lead that was just saved. */
export function announceHotLead(info: HotLeadInfo, deps: DeskDeps = {}): Promise<DeskAlertResult> {
  return sendDeskAlert(info, 'a', deps)
}

export interface ReminderLead {
  id: string
  created_at: string
  assigned_agent_id: string | null
  status: string | null
  is_test: boolean | null
  package: string | null
  page_path: string | null
  utm_source: string | null
  intent: string | null
  message: string | null
}

/** Pure-ish: which of these leads get the ONE reminder now. */
export function pickReminders(leads: ReminderLead[], state: ReturnType<typeof parseAlertState>, now: number): ReminderLead[] {
  return leads.filter((l) =>
    reminderDue({ createdAt: l.created_at, assignedAgentId: l.assigned_agent_id, status: l.status, isTest: l.is_test === true, alreadyReminded: !!state[l.id]?.r, now }),
  )
}

/** The 15 minute pass: ONE reminder per hot lead that is still unassigned after 15 minutes. Respects the pause switch.
 * Returns a short note when it did something, null when there was nothing to do. Never throws. */
export async function runHotLeadReminders(admin: SupabaseClient, deps: DeskDeps = {}): Promise<string | null> {
  try {
    if (await isAutomationPaused(admin)) return null
    const now = (deps.now?.() ?? new Date()).getTime()
    const oldest = new Date(now - REMINDER_WINDOW_MIN * 60_000).toISOString()
    const newest = new Date(now - REMINDER_AFTER_MIN * 60_000).toISOString()
    const { data, error } = await admin
      .from('leads')
      .select('id, created_at, assigned_agent_id, status, is_test, package, page_path, utm_source, intent, message')
      .eq('hot', true)
      .eq('is_test', false)
      .eq('status', 'new')
      .is('assigned_agent_id', null)
      .gte('created_at', oldest)
      .lte('created_at', newest)
      .order('created_at', { ascending: true })
      .limit(20)
    if (error) return null // before migration 0055 there is no hot column: nothing to remind about
    const state = parseAlertState(await getSetting(admin, DESK_STATE_KEY).catch(() => null))
    const due = pickReminders((data ?? []) as unknown as ReminderLead[], state, now)
    let sent = 0
    for (const l of due) {
      const r = await sendDeskAlert(
        { id: l.id, isTest: l.is_test === true, intent: l.intent, package: l.package, pagePath: l.page_path, utmSource: l.utm_source, message: l.message },
        'r',
        { ...deps, admin },
        waitMinutes(l.created_at, now),
      )
      if (r.status === 'sent' || r.status === 'failed') sent++
    }
    return sent > 0 ? `reminded the lead desk about ${sent} hot lead${sent === 1 ? '' : 's'} with no agent` : null
  } catch {
    return null
  }
}

// ---- reading the desk ------------------------------------------------------------------------------------

export const HOT_COLUMNS = 'id, name, email, phone, package, message, page_path, utm_source, intent, created_at, status, assigned_agent_id, assigned_at, assigned_by, first_contact_at, desk_note'

export interface HotLeadRecord {
  id: string
  name: string
  email: string
  phone: string | null
  package: string | null
  message: string | null
  page_path: string | null
  utm_source: string | null
  intent: string | null
  created_at: string
}

/** Hot leads still waiting for an agent, oldest first. Throws when the columns are not there yet (migration 0055). */
export async function listUnassignedHot(admin: SupabaseClient, limit = 50): Promise<HotLeadRecord[]> {
  const { data, error } = await admin
    .from('leads')
    .select('id, name, email, phone, package, message, page_path, utm_source, intent, created_at')
    .eq('hot', true)
    .eq('is_test', false)
    .eq('status', 'new')
    .is('assigned_agent_id', null)
    .order('created_at', { ascending: true })
    .limit(limit)
  if (error) throw new Error(error.message)
  return (data ?? []) as unknown as HotLeadRecord[]
}

/** The wait the System check reads. Count 0 when nothing is waiting. Throws when it cannot be read. */
export async function readHotWait(admin: SupabaseClient, now: Date = new Date()): Promise<HotWait> {
  const { data, error } = await admin.from('leads').select('created_at').eq('hot', true).eq('is_test', false).eq('status', 'new').is('assigned_agent_id', null).order('created_at', { ascending: true }).limit(50)
  if (error) throw new Error(error.message)
  const rows = (data ?? []) as unknown as Row[]
  if (rows.length === 0) return { count: 0, oldestMinutes: 0 }
  return { count: rows.length, oldestMinutes: waitMinutes(str(rows[0].created_at), now.getTime()) }
}

/** The agents the office can pick from. Draft, ready and published only; NEVER the private email, phone, address or notes. */
export async function listPickerAgents(admin: SupabaseClient): Promise<PickerAgent[]> {
  const { data, error } = await admin.from('agents').select('id, slug, display_name, specialties, status, region').in('status', ['draft', 'ready', 'published']).order('display_name', { ascending: true }).limit(1000)
  if (error) throw new Error(error.message)
  return ((data ?? []) as unknown as Row[]).map((r) => ({
    id: str(r.id),
    slug: str(r.slug),
    display_name: str(r.display_name),
    specialties: Array.isArray(r.specialties) ? (r.specialties as unknown[]).filter((s): s is string => typeof s === 'string') : [],
    status: str(r.status),
    region: typeof r.region === 'string' ? r.region : null,
  }))
}

/** Is the desk set up to text someone? Used for the amber setup item on Needs attention. */
export async function deskSmsConfigured(admin: SupabaseClient): Promise<boolean> {
  return parseSmsContactIds(await getSetting(admin, DESK_SMS_KEY).catch(() => null)).length > 0
}

// ---- assigning ---------------------------------------------------------------------------------------------

export type AssignResult = { ok: true; message: string; warnings: string[] } | { ok: false; status: number; error: string }

export interface AssignInput {
  leadId: string
  agentId: string
  assignedBy: string
  /** Allow moving a lead that already has an agent. */
  reassign?: boolean
}

/** Records the agent a PERSON chose: saves who and when, tags and notes the GoHighLevel contact, emails the agent at their private roster
 * address, and writes a line to the Today log. The GoHighLevel and email steps are best effort: a problem is returned as a warning and
 * never undoes the assignment. */
export async function assignLead(admin: SupabaseClient, input: AssignInput, deps: DeskDeps = {}): Promise<AssignResult> {
  const warnings: string[] = []
  const by = cleanAssignedBy(input.assignedBy)
  const now = deps.now?.() ?? new Date()

  const { data: leadRow, error: leadErr } = await admin.from('leads').select('id, name, email, phone, package, message, page_path, utm_source, intent, assigned_agent_id, is_test').eq('id', input.leadId).maybeSingle()
  if (leadErr) return { ok: false, status: 500, error: leadErr.message }
  const lead = leadRow as Row | null
  if (!lead) return { ok: false, status: 404, error: 'That lead is gone.' }

  const { data: agentRow, error: agentErr } = await admin.from('agents').select('id, slug, display_name, status, email').eq('id', input.agentId).maybeSingle()
  if (agentErr) return { ok: false, status: 500, error: agentErr.message }
  const agent = agentRow as Row | null
  if (!agent) return { ok: false, status: 404, error: 'That agent is not on the roster.' }
  if (!isAssignableStatus(agent.status)) return { ok: false, status: 400, error: 'That agent cannot be given leads.' }

  if (lead.assigned_agent_id && !input.reassign) {
    return { ok: false, status: 409, error: 'This lead already has an agent. Someone else may have just assigned it.' }
  }

  // The write only lands while the lead still has no agent (unless the office is moving it on purpose), so two people
  // pressing Assign at the same moment cannot both win.
  let up = admin.from('leads').update({ assigned_agent_id: input.agentId, assigned_at: now.toISOString(), assigned_by: by, status: 'assigned' }).eq('id', input.leadId)
  if (!input.reassign) up = up.is('assigned_agent_id', null)
  const { data: updated, error: upErr } = await up.select('id')
  if (upErr) return { ok: false, status: 500, error: upErr.message }
  if (!updated || updated.length === 0) return { ok: false, status: 409, error: 'This lead already has an agent. Someone else may have just assigned it.' }

  const agentName = str(agent.display_name) || 'the agent'
  const email = str(lead.email)

  // GoHighLevel: a tag and a note. Agents are not GoHighLevel users, so the contact owner is never set.
  try {
    const ghl = await import('@/lib/gohighlevel')
    const contactId = await ghl.findGhlContactId(email)
    if (!contactId) warnings.push('GoHighLevel has no contact for this lead, so the tag and note were skipped.')
    else {
      const tag = await ghl.addGhlTags(contactId, [agentTag(str(agent.slug) || agentName)])
      if (!tag.ok) warnings.push(`The GoHighLevel tag was not added (${tag.error}).`)
      const note = await ghl.addGhlNote(contactId, ghlAssignNote(agentName, by, now))
      if (!note.ok) warnings.push(`The GoHighLevel note was not added (${note.error}).`)
    }
  } catch {
    warnings.push('GoHighLevel could not be reached, so the tag and note were skipped.')
  }

  // The one email that carries the lead's details: to the agent's own private roster address, nobody else.
  const agentEmail = str(agent.email).trim()
  if (!agentEmail) warnings.push(`${agentName} has no email on the roster. Please tell them about this lead yourself.`)
  else {
    try {
      const mail = buildAgentEmail(
        { name: str(lead.name), email, phone: typeof lead.phone === 'string' ? lead.phone : null, package: typeof lead.package === 'string' ? lead.package : null, pagePath: typeof lead.page_path === 'string' ? lead.page_path : null, message: typeof lead.message === 'string' ? lead.message : null, intent: typeof lead.intent === 'string' ? lead.intent : null, utmSource: typeof lead.utm_source === 'string' ? lead.utm_source : null, assignedBy: by },
        agentName,
      )
      const sent = await sendMail(deps, [agentEmail], mail.subject, mail.text)
      if (!sent) warnings.push(`The email to ${agentName} did not go out. Please tell them about this lead yourself.`)
    } catch {
      warnings.push(`The email to ${agentName} did not go out. Please tell them about this lead yourself.`)
    }
  }

  // The activity log: the same decision log the Today page keeps (admin only).
  try {
    const log = parseLog(await getSetting(admin, TODAY_LOG_KEY).catch(() => null))
    const title = plain(`Assigned a ${str(lead.package) || 'trip'} lead to ${agentName} (by ${by})`).slice(0, 120)
    const next = appendLog(log, { id: `hot-lead:${input.leadId}`, kind: 'hot-lead', op: 'approve', mode: 'run', title, at: now.toISOString(), undoable: false })
    await setSetting(admin, TODAY_LOG_KEY, JSON.stringify(next))
    // An assigned lead is being handled, so the plain "new lead needs a reply" card for it is done too.
    const done = parseIdList(await getSetting(admin, TODAY_LEADS_DONE_KEY).catch(() => null))
    await setSetting(admin, TODAY_LEADS_DONE_KEY, JSON.stringify(addToIdList(done, input.leadId)))
  } catch {
    warnings.push('The activity log could not be saved.')
  }

  return { ok: true, message: `Assigned to ${agentName}.`, warnings }
}

// ---- the status buttons on the Leads page -------------------------------------------------------------------

export type StatusResult = { ok: true; message: string } | { ok: false; status: number; error: string }

/** Contacted, booked or lost. Contacted also records when the first contact happened (once). */
export async function setLeadStatus(admin: SupabaseClient, leadId: string, status: unknown, note?: unknown, now: Date = new Date()): Promise<StatusResult> {
  if (!isLeadStatus(status) || status === 'new' || status === 'assigned') return { ok: false, status: 400, error: 'Pick contacted, booked or lost.' }
  const { data, error } = await admin.from('leads').select('id, first_contact_at').eq('id', leadId).maybeSingle()
  if (error) return { ok: false, status: 500, error: error.message }
  if (!data) return { ok: false, status: 404, error: 'That lead is gone.' }
  const patch: Record<string, unknown> = { status }
  if (!(data as Row).first_contact_at && status !== 'lost') patch.first_contact_at = now.toISOString()
  if (typeof note === 'string' && note.trim()) patch.desk_note = plain(note).slice(0, 500)
  const up = await admin.from('leads').update(patch).eq('id', leadId)
  return up.error ? { ok: false, status: 500, error: up.error.message } : { ok: true, message: `Marked ${status}.` }
}
