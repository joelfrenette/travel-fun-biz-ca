// The lead desk: the pure rules. No database, no network, no server imports, so the browser (the Today card, the
// Leads page) and scripts/check-lead-desk.ts can all use them.
//
// The idea: a HOT lead is a person who wants a human now. The desk (Joel, Shelby and Leslie) is told at once and
// decides together who works it. NOTHING in this file or in lib/lead-desk-store.ts ever picks an agent: the
// suggestions only change the ORDER of a list, and no agent is ever selected for the person.
//
// PRIVACY: lead details (name, email, phone) are admin-only. The desk email and the text message carry NO name,
// email or phone, only where it came from and a link into /admin. The one email that carries the details goes to
// the agent the office chose, at that agent's private roster address.

export const LEAD_INTENTS = ['callback', 'quote', 'info'] as const
export type LeadIntent = (typeof LEAD_INTENTS)[number]

export function normalizeIntent(v: unknown): LeadIntent | null {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : ''
  return (LEAD_INTENTS as readonly string[]).includes(s) ? (s as LeadIntent) : null
}

/** The older trip page kit wrote this at the start of the message instead of sending an intent. Still counts as a callback. */
export const CALLBACK_PREFIX = '[Callback requested]'
/** A newsletter signup always has a phone number (the form asks for it, for texts the person agreed to). It is a sign-up, not a request to be called. */
export const NEWSLETTER_PACKAGE = 'Newsletter signup'

export function phoneDigits(p: string | null | undefined): string {
  return (p ?? '').replace(/\D/g, '')
}

/** A phone number someone could really call: 7 to 15 digits. */
export function hasPhone(p: string | null | undefined): boolean {
  const n = phoneDigits(p).length
  return n >= 7 && n <= 15
}

export interface HotInput {
  intent?: unknown
  phone?: string | null
  message?: string | null
  package?: string | null
}

export function isCallbackRequest(i: HotInput): boolean {
  return normalizeIntent(i.intent) === 'callback' || (i.message ?? '').trimStart().startsWith(CALLBACK_PREFIX)
}

/** Hot = a callback request (from a trip page), or any form submission that includes a phone number. A newsletter signup is not hot unless it asks for a callback. */
export function isHotLead(i: HotInput): boolean {
  if (isCallbackRequest(i)) return true
  if ((i.package ?? '').trim() === NEWSLETTER_PACKAGE) return false
  return hasPhone(i.phone)
}

// ---- status and waiting ---------------------------------------------------------------------------------

export const LEAD_STATUSES = ['new', 'assigned', 'contacted', 'booked', 'lost'] as const
export type LeadStatus = (typeof LEAD_STATUSES)[number]
export const isLeadStatus = (v: unknown): v is LeadStatus => typeof v === 'string' && (LEAD_STATUSES as readonly string[]).includes(v)

export const STATUS_LABEL: Record<LeadStatus, string> = { new: 'New', assigned: 'Assigned', contacted: 'Contacted', booked: 'Booked', lost: 'Lost' }

export const WAIT_AMBER_MIN = 5
export const WAIT_RED_MIN = 15
/** The desk gets ONE reminder when a hot lead is still unassigned after this long. */
export const REMINDER_AFTER_MIN = 15
/** The System check: amber past this many minutes unassigned, red past the second. */
export const CHECK_AMBER_MIN = 15
export const CHECK_RED_MIN = 60
/** A hot lead older than this is no longer chased (no reminder). It still shows on the Today card until someone deals with it. */
export const REMINDER_WINDOW_MIN = 24 * 60

export type WaitLight = 'green' | 'amber' | 'red'

export function waitMinutes(createdAt: string | null | undefined, now: number = Date.now()): number {
  const t = Date.parse(createdAt ?? '')
  return Number.isFinite(t) ? Math.max(0, (now - t) / 60_000) : 0
}

/** Red after 15 minutes, amber after 5. */
export function waitLight(minutes: number): WaitLight {
  return minutes > WAIT_RED_MIN ? 'red' : minutes > WAIT_AMBER_MIN ? 'amber' : 'green'
}

/** "just now", "7 min", "2 h 5 min", "3 days". */
export function waitText(minutes: number): string {
  const m = Math.floor(minutes)
  if (m < 1) return 'just now'
  if (m < 60) return `${m} min`
  if (m < 48 * 60) {
    const h = Math.floor(m / 60)
    const r = m % 60
    return r ? `${h} h ${r} min` : `${h} h`
  }
  return `${Math.floor(m / 1440)} days`
}

/** Pure: the Leads page filter "Needs an agent": a real (not test) hot lead that is new and has no agent. */
export function needsAgent(l: { hot?: boolean | null; status?: string | null; assigned_agent_id?: string | null; is_test?: boolean | null }): boolean {
  return l.hot === true && l.is_test !== true && !l.assigned_agent_id && (!l.status || l.status === 'new')
}

/** Pure: should the desk get its reminder now? Once per lead, only while it is unassigned and still new. */
export function reminderDue(i: { createdAt: string; assignedAgentId?: string | null; status?: string | null; isTest?: boolean; alreadyReminded: boolean; now: number }): boolean {
  if (i.isTest || i.alreadyReminded) return false
  if (i.assignedAgentId) return false
  if (i.status && i.status !== 'new') return false
  const w = waitMinutes(i.createdAt, i.now)
  return w >= REMINDER_AFTER_MIN && w <= REMINDER_WINDOW_MIN
}

export interface HotWait {
  /** How many hot leads are waiting for an agent. */
  count: number
  /** Minutes the oldest one has waited. */
  oldestMinutes: number
}

/** Pure: the System check light for the lead desk. Amber past 15 minutes, red past 60. Null light = nothing is waiting. */
export function hotWaitLight(w: HotWait | null | undefined): Light3 | null {
  if (!w || w.count <= 0) return null
  if (w.oldestMinutes > CHECK_RED_MIN) return 'red'
  if (w.oldestMinutes > CHECK_AMBER_MIN) return 'amber'
  return 'green'
}
type Light3 = 'green' | 'amber' | 'red'

/** Pure: the plain sentence for the Conversion stage. Real numbers only. Grade 6 words. Empty when nothing is waiting. */
export function hotWaitSentence(w: HotWait | null | undefined): string {
  if (!w || w.count <= 0) return ''
  const mins = Math.floor(w.oldestMinutes)
  const lead = w.count === 1 ? 'One lead who asked for a call has' : `${w.count} leads who asked for a call have`
  if (mins > CHECK_RED_MIN) return `${lead} waited ${waitText(mins)} with no agent. Please assign one.`
  if (mins > CHECK_AMBER_MIN) return `${lead} waited ${mins} minutes with no agent. Please assign one.`
  return `${w.count === 1 ? 'One lead who asked for a call is' : `${w.count} leads who asked for a call are`} waiting for an agent.`
}

// ---- the agent picker -----------------------------------------------------------------------------------

/** Only what the picker needs. NEVER the private email, phone, address or notes of an agent. */
export interface PickerAgent {
  id: string
  slug: string
  display_name: string
  specialties: string[]
  status: string
  region?: string | null
}

export interface LeadTopic {
  package?: string | null
  pagePath?: string | null
  message?: string | null
}

/** An agent can be offered when their profile is draft, ready or published (the roster has no "archived": every row is a working agent). */
export const ASSIGNABLE_STATUSES = ['draft', 'ready', 'published'] as const
export const isAssignableStatus = (s: unknown): boolean => typeof s === 'string' && (ASSIGNABLE_STATUSES as readonly string[]).includes(s)

const STOP = new Set(['and', 'the', 'for', 'with', 'from', 'trip', 'trips', 'travel', 'vacation', 'vacations', 'package', 'packages', 'custom', 'new', 'all', 'inclusive'])

/** "Cruises" and "cruise" are the same word here. */
function stem(w: string): string {
  return w.length > 4 && w.endsWith('s') ? w.slice(0, -1) : w
}
function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3)
    .map(stem)
}

/** Pure: the words the lead is about, from the trip name, the page it came from and what they typed. */
export function topicWords(t: LeadTopic): Set<string> {
  const path = (t.pagePath ?? '').split(/[?#]/)[0]
  return new Set(words(`${t.package ?? ''} ${path} ${(t.message ?? '').slice(0, 300)}`).filter((w) => !STOP.has(w)))
}

/** Pure: how many of the agent's specialties show up in the lead's topic. 0 = no reason to suggest. */
export function specialtyScore(agent: Pick<PickerAgent, 'specialties'>, topic: Set<string>): number {
  let score = 0
  for (const s of agent.specialties ?? []) {
    const ws = words(s).filter((w) => !STOP.has(w))
    if (ws.length > 0 && ws.some((w) => topic.has(w))) score++
  }
  return score
}

export interface PickerEntry {
  agent: PickerAgent
  suggested: boolean
  score: number
}

/** Pure: the list the desk sees. Agents whose specialties match the lead come first, tagged "suggested", then everyone else
 * by name. Only draft, ready or published agents are listed. Nothing is chosen: this only orders a list. */
export function orderAgents(agents: PickerAgent[], topic: LeadTopic): PickerEntry[] {
  const topicSet = topicWords(topic)
  return agents
    .filter((a) => isAssignableStatus(a.status))
    .map((agent) => {
      const score = specialtyScore(agent, topicSet)
      return { agent, suggested: score > 0, score }
    })
    .sort((a, b) => b.score - a.score || a.agent.display_name.localeCompare(b.agent.display_name, 'en', { sensitivity: 'base' }))
}

/** Pure: the search box. Matches a name, a specialty or a region; keeps the order. An empty search keeps everyone. */
export function filterAgents<T extends { agent: PickerAgent }>(list: T[], query: string): T[] {
  const q = query.trim().toLowerCase()
  if (!q) return list
  return list.filter(({ agent }) => [agent.display_name, agent.region ?? '', ...(agent.specialties ?? [])].join(' ').toLowerCase().includes(q))
}

// ---- lists kept in app_settings ---------------------------------------------------------------------------

export const DESK_EMAILS_KEY = 'lead_desk_alert_emails'
export const DESK_SMS_KEY = 'lead_desk_alert_sms_contact_ids'
export const DESK_STATE_KEY = 'hot_lead_alert_state'
export const DESK_LIST_MAX = 10

/** Pure: one plain address, no header injection characters. */
export function isDeskEmail(email: string): boolean {
  const e = email.trim()
  return !!e && e.length <= 254 && !/[\s,;<>"\r\n]/.test(e) && /^[^@]+@[^@]+\.[^@.]{2,}$/.test(e)
}

function splitList(raw: string | null | undefined): string[] {
  const s = (raw ?? '').trim()
  if (!s) return []
  if (s.startsWith('[')) {
    try {
      const v = JSON.parse(s) as unknown
      if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string')
    } catch {
      // fall through to the plain split
    }
  }
  return s.split(/[\s,;]+/)
}

/** Pure: the desk addresses from the setting (a JSON list, or addresses separated by commas, spaces or new lines). Bad ones are dropped. */
export function parseDeskEmails(raw: string | null | undefined): string[] {
  const out: string[] = []
  for (const part of splitList(raw)) {
    const e = part.trim().toLowerCase()
    if (isDeskEmail(e) && !out.includes(e)) out.push(e)
  }
  return out.slice(0, DESK_LIST_MAX)
}

/** Pure: GoHighLevel contact ids to text. */
export function parseSmsContactIds(raw: string | null | undefined): string[] {
  const out: string[] = []
  for (const part of splitList(raw)) {
    const id = part.trim()
    if (/^[A-Za-z0-9_-]{6,64}$/.test(id) && !out.includes(id)) out.push(id)
  }
  return out.slice(0, DESK_LIST_MAX)
}

// ---- alert state: one alert and one reminder per lead -----------------------------------------------------

export interface AlertEntry {
  /** When the first alert was claimed. */
  a?: string
  /** When the reminder was claimed. */
  r?: string
}
export type AlertState = Record<string, AlertEntry>
export const ALERT_STATE_MAX = 200

export function parseAlertState(raw: string | null | undefined): AlertState {
  try {
    const v = JSON.parse(raw ?? '{}') as unknown
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
    const out: AlertState = {}
    for (const [id, e] of Object.entries(v as Record<string, unknown>)) {
      if (!e || typeof e !== 'object') continue
      const { a, r } = e as { a?: unknown; r?: unknown }
      out[id] = { ...(typeof a === 'string' ? { a } : {}), ...(typeof r === 'string' ? { r } : {}) }
    }
    return out
  } catch {
    return {}
  }
}

/** Pure: claims the alert (kind "a") or the reminder (kind "r") for a lead. Returns null when it was already claimed (so: do nothing). The map stays bounded. */
export function claimAlert(state: AlertState, id: string, kind: 'a' | 'r', now: Date): AlertState | null {
  if (state[id]?.[kind]) return null
  const next: AlertState = { ...state, [id]: { ...state[id], [kind]: now.toISOString() } }
  const ids = Object.keys(next)
  if (ids.length > ALERT_STATE_MAX) {
    const newest = ids.sort((x, y) => Date.parse(next[y].a ?? next[y].r ?? '') - Date.parse(next[x].a ?? next[x].r ?? '')).slice(0, ALERT_STATE_MAX)
    return Object.fromEntries(newest.map((k) => [k, next[k]]))
  }
  return next
}

// ---- the words in the messages ----------------------------------------------------------------------------

export interface HotLeadInfo {
  id: string
  isTest?: boolean
  intent?: string | null
  package?: string | null
  pagePath?: string | null
  utmSource?: string | null
  message?: string | null
}

// Free text from the form can hold an address or a phone number; the desk messages must stay free of both.
function safeField(v: string | null | undefined, max = 120): string {
  const s = (v ?? '')
    .replace(CALLBACK_PREFIX, '')
    .replace(/\[[^\]]*requested\]/gi, '')
    .replace(/\S+@\S+/g, ' ')
    .replace(/\+?\d[\d\s().-]{5,}\d/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
  return s || 'not recorded'
}

export const safeText = safeField

export function whatTheyAsked(i: Pick<HotLeadInfo, 'intent' | 'message'>): string {
  if (isCallbackRequest({ intent: i.intent, message: i.message })) return 'Asked for a call back from a live agent'
  return 'Sent the form with a phone number'
}

/** Pure: the desk email. NO name, email or phone. */
export function buildDeskEmail(info: HotLeadInfo, adminUrl: string, opts: { reminder?: boolean; waitedMinutes?: number } = {}): { subject: string; text: string } {
  const where = safeField(info.package) !== 'not recorded' ? safeField(info.package) : safeField(info.pagePath)
  const subject = opts.reminder ? 'Reminder: a call-back lead still has no agent' : 'Hot lead: someone wants a call'
  const lines = [
    opts.reminder ? `Reminder. This lead has waited ${waitText(opts.waitedMinutes ?? REMINDER_AFTER_MIN)} and still has no agent.` : 'A new lead wants to talk to a person.',
    `Trip or page: ${where}`,
    `What they asked: ${whatTheyAsked(info)}`,
    `Source: ${safeField(info.utmSource)}`,
    '',
    'You three decide who takes it. Nothing is assigned for you.',
    `Open the lead desk: ${adminUrl}`,
  ]
  return { subject, text: lines.join('\n') }
}

/** Pure: the text message. Short, no personal details. */
export function buildDeskSms(info: HotLeadInfo, adminUrl: string, opts: { reminder?: boolean } = {}): string {
  const where = safeField(info.package) !== 'not recorded' ? safeField(info.package, 50) : safeField(info.pagePath, 50)
  return `${opts.reminder ? 'Reminder: hot lead still has no agent' : 'Hot lead wants a call'} (${where}). Assign an agent: ${adminUrl}`.slice(0, 300)
}

export interface AgentLeadMail {
  name: string
  email: string
  phone: string | null
  package: string | null
  pagePath: string | null
  message: string | null
  intent: string | null
  utmSource: string | null
  assignedBy: string
}

/** Pure: the email to the agent the office chose. This is the ONLY message that carries the lead's details. */
export function buildAgentEmail(lead: AgentLeadMail, agentName: string): { subject: string; text: string } {
  const asked = safeAsked(lead.message)
  const lines = [
    `Hi ${firstWord(agentName)},`,
    '',
    `The office assigned you this lead (assigned by ${safeName(lead.assignedBy)}). Please contact them as soon as you can.`,
    '',
    `Name: ${clip(lead.name, 120)}`,
    `Email: ${clip(lead.email, 200)}`,
    `Phone: ${clip(lead.phone ?? 'not given', 60)}`,
    `Trip or page: ${clip(lead.package || lead.pagePath || 'not recorded', 160)}`,
    `What they asked: ${isCallbackRequest({ intent: lead.intent, message: lead.message }) ? 'a call back from a live agent' : 'to be contacted'}`,
    ...(asked ? [`Their message: ${asked}`] : []),
    `Source: ${clip(lead.utmSource ?? 'not recorded', 80)}`,
    '',
    'This is private. Please do not forward it. If you cannot take this lead, tell the office right away so they can pick someone else.',
  ]
  return { subject: 'The office assigned you a lead', text: lines.join('\n') }
}

const clip = (v: string, n: number) => v.replace(/[\r\n]+/g, ' ').trim().slice(0, n)
const firstWord = (n: string) => clip(n, 60).split(/\s+/)[0] || 'there'
function safeName(n: string): string {
  const s = n.replace(/[^\p{L}\p{N} .'-]/gu, '').trim().slice(0, 40)
  return s || 'the office'
}
function safeAsked(message: string | null | undefined): string {
  const s = (message ?? '').replace(CALLBACK_PREFIX, '').replace(/\[Asked about travel specialist:[^\]]*\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 400)
  return s
}
export const cleanAssignedBy = safeName

/** Pure: the GoHighLevel tag for an agent. */
export function agentTag(slug: string): string {
  return `agent-${slug.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60)}`
}

/** Pure: the note added to the GoHighLevel contact. No phone or email in it. */
export function ghlAssignNote(agentName: string, assignedBy: string, when: Date): string {
  return `Assigned to ${clip(agentName, 80)} by ${safeName(assignedBy)} on ${when.toISOString().slice(0, 16).replace('T', ' ')} UTC (chosen by the office, not automatic).`
}
