import { CHECKLIST_URL } from '@/lib/plain-steps'

// Daily follow-ups, pure part: the short to-do list that is built fresh each day from the daily brief and the suggestion tasks
// (growth tips, the best SEO fixes, leads waiting for a reply, the social routine, link building, past-trip recaps, setup steps
// still open, and the weekly jobs). No database and no network here, so scripts/check-admin-v2.ts tests every rule offline.
// lib/followups-run.ts reads the sources and keeps the ticks in app_settings.
//
// The ticks live in ONE app_settings value (followups_done): { "2026-10-24": [ids done or pushed to later today], "*": [ids done for good] }.
// Day buckets older than 14 days are dropped and every bucket is capped, so the value can never grow without limit.

export type FollowGroup = 'lead' | 'digest' | 'seo' | 'social' | 'weekly' | 'links' | 'recap' | 'setup'

export interface FollowItem {
  /** `${group}:${key}`. Stable for the same task, so a tick survives a reload. */
  id: string
  group: FollowGroup
  title: string
  /** One plain sentence on why it matters. */
  why: string
  /** A rough time, in minutes. */
  minutes: number
  /** Where "Open" goes: a site path, or a full address for an outside site. */
  href: string
  /** Higher comes first. About how much the task helps traffic and leads. */
  impact: number
  /** True when a tick means "never show this again" (setup steps, a lead's step). False = this day only. */
  persist: boolean
  /** A small extra line (how old a lead is). */
  note?: string
}

export const FOLLOWUP_CAP = 8
export const FOLLOWUPS_DONE_KEY = 'followups_done'
export const FOLLOWUPS_LIST_KEY = 'followups_list'
export const PERSIST_BUCKET = '*'
export const DAYS_KEPT = 14
export const DAY_BUCKET_MAX = 60
export const PERSIST_MAX = 300
/** A built list is reused for this long before the sources are read again. */
export const LIST_TTL_MS = 10 * 60_000
export const TZ = 'America/Toronto'

const ID_PATTERN = /^(lead|digest|seo|social|weekly|links|recap|setup):[A-Za-z0-9._:-]{1,120}$/
export const isFollowId = (v: unknown): v is string => typeof v === 'string' && ID_PATTERN.test(v)

// ---------------------------------------------------------------------------------------------------
// Dates (site time zone)
// ---------------------------------------------------------------------------------------------------

/** The calendar day in the site's time zone, as YYYY-MM-DD. */
export function siteDay(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}

export function siteWeekday(now: Date): 'Monday' | 'Tuesday' | 'Wednesday' | 'Thursday' | 'Friday' | 'Saturday' | 'Sunday' {
  return new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'long' }).format(now) as ReturnType<typeof siteWeekday>
}

/** Whole calendar days between two instants, counted in site days (so 11 pm and 1 am the next night are 1 day apart). */
export function daysBetween(fromIso: string, now: Date): number | null {
  const t = Date.parse(fromIso)
  if (!Number.isFinite(t)) return null
  const a = Date.parse(`${siteDay(new Date(t))}T00:00:00Z`)
  const b = Date.parse(`${siteDay(now)}T00:00:00Z`)
  return Math.max(0, Math.round((b - a) / 86_400_000))
}

// ---------------------------------------------------------------------------------------------------
// The ticks
// ---------------------------------------------------------------------------------------------------

export type DoneState = Record<string, string[]>
export const LATER_PREFIX = 'later:'

/** Reads the stored ticks. Junk is ignored; old days and long lists are cut. Pure. */
export function parseDone(raw: string | null | undefined): DoneState {
  if (!raw) return {}
  try {
    const v = JSON.parse(raw) as unknown
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
    const out: DoneState = {}
    for (const [k, list] of Object.entries(v as Record<string, unknown>)) {
      if (k !== PERSIST_BUCKET && !/^\d{4}-\d{2}-\d{2}$/.test(k)) continue
      if (!Array.isArray(list)) continue
      const ids = [...new Set(list.filter((x): x is string => typeof x === 'string' && x.length <= 140))]
      out[k] = ids.slice(-(k === PERSIST_BUCKET ? PERSIST_MAX : DAY_BUCKET_MAX))
    }
    return boundDone(out)
  } catch {
    return {}
  }
}

/** Keeps the newest DAYS_KEPT day buckets and the permanent bucket. Pure. */
export function boundDone(state: DoneState): DoneState {
  const days = Object.keys(state).filter((k) => k !== PERSIST_BUCKET).sort().slice(-DAYS_KEPT)
  const out: DoneState = {}
  for (const d of days) out[d] = state[d].slice(-DAY_BUCKET_MAX)
  if (state[PERSIST_BUCKET]) out[PERSIST_BUCKET] = state[PERSIST_BUCKET].slice(-PERSIST_MAX)
  return out
}

export function serializeDone(state: DoneState): string {
  return JSON.stringify(boundDone(state))
}

export type Mark = 'open' | 'done' | 'later'

/** What a candidate's tick says today. A permanent tick wins; otherwise today's bucket decides. Pure. */
export function markOf(state: DoneState, day: string, id: string): Mark {
  if ((state[PERSIST_BUCKET] ?? []).includes(id)) return 'done'
  const today = state[day] ?? []
  if (today.includes(id)) return 'done'
  if (today.includes(`${LATER_PREFIX}${id}`)) return 'later'
  return 'open'
}

const without = (list: string[] | undefined, ...ids: string[]) => (list ?? []).filter((x) => !ids.includes(x))

/** Applies one tick and returns the new state. Pure; the caller saves it.
 * done   = ticked (for good when the item is persistent, for today otherwise)
 * later  = pushed to tomorrow (it comes back by itself, because the list is built fresh each day)
 * reopen = takes either tick back */
export function applyMark(state: DoneState, day: string, item: Pick<FollowItem, 'id' | 'persist'>, op: 'done' | 'later' | 'reopen'): DoneState {
  const next: DoneState = { ...state }
  const id = item.id
  next[PERSIST_BUCKET] = without(next[PERSIST_BUCKET], id)
  next[day] = without(next[day], id, `${LATER_PREFIX}${id}`)
  if (op === 'done') {
    // A persistent task is also ticked on today's list, so it stays visible as done today and is gone from tomorrow on.
    if (item.persist) next[PERSIST_BUCKET] = [...next[PERSIST_BUCKET], id]
    next[day] = [...next[day], id]
  } else if (op === 'later') {
    next[day] = [...next[day], `${LATER_PREFIX}${id}`]
  }
  if (next[PERSIST_BUCKET].length === 0) delete next[PERSIST_BUCKET]
  return boundDone(next)
}

// ---------------------------------------------------------------------------------------------------
// The candidates
// ---------------------------------------------------------------------------------------------------

/** Things you do once and then never again. Code-defined; a tick is kept for good, so a finished step stops appearing. */
export interface SetupFollow {
  key: string
  title: string
  why: string
  minutes: number
  href: string
}

export const SETUP_FOLLOWUPS: readonly SetupFollow[] = [
  { key: 'bio-link', title: 'Put the link page in your social bios', why: 'One page that lists your trips and the contact form turns profile visits into enquiries.', minutes: 10, href: '/links' },
  { key: 'search-console-indexing', title: 'Ask Google to index your newest pages', why: 'In Search Console paste a page address and press Request indexing. New pages show up sooner.', minutes: 15, href: 'https://search.google.com/search-console' },
  { key: 'business-listings', title: 'Claim your free business listings', why: 'Listings such as Google Business Profile and Bing Places bring local visitors and real links.', minutes: 20, href: '/admin/links-building' },
  { key: 'social-connected', title: 'Connect Facebook and LinkedIn for posting', why: 'Posts only go out to accounts that are connected.', minutes: 10, href: '/admin/autopilot' },
  { key: 'reviews-requested', title: 'Ask three happy travellers for a review', why: 'Real reviews build trust and help your pages rank.', minutes: 15, href: '/admin/testimonials' },
  { key: 'email-workflow', title: 'Switch on the welcome email workflow', why: 'A short email series turns new signups into enquiries.', minutes: 15, href: CHECKLIST_URL },
]

/** How many setup steps may sit in the list at once, so they never crowd out the work that earns leads. */
export const SETUP_AT_ONCE = 2

export function setupCandidates(done: DoneState, day: string): FollowItem[] {
  // Steps finished on an earlier day are gone for good; one finished today stays on today's list, ticked.
  const today = new Set(done[day] ?? [])
  const gone = new Set((done[PERSIST_BUCKET] ?? []).filter((id) => !today.has(id)))
  return SETUP_FOLLOWUPS.filter((s) => !gone.has(`setup:${s.key}`))
    .slice(0, SETUP_AT_ONCE)
    .map((s, i) => ({ id: `setup:${s.key}`, group: 'setup' as const, title: s.title, why: s.why, minutes: s.minutes, href: s.href, impact: 30 - i, persist: true }))
}

export interface LeadFact {
  id: string
  name: string
  email: string
  phone: string
  createdAt: string
}

export type LeadStep = 'd0' | 'd2' | 'd5'

/** Day 0 or 1: call or text. Day 2 to 4: email. Day 5 to 14: one last nudge. After that the moment has gone. Pure. */
export function leadStep(ageDays: number): LeadStep | null {
  if (ageDays < 0) return null
  if (ageDays <= 1) return 'd0'
  if (ageDays <= 4) return 'd2'
  if (ageDays <= 14) return 'd5'
  return null
}

const AGE_TEXT = (d: number) => (d === 0 ? 'Came in today' : d === 1 ? 'Came in yesterday' : `Came in ${d} days ago`)
export const LEAD_MAX = 3

/** Leads that still wait for a reply, newest first, one step each. `replied` are ids already answered (Today's "I replied"). Pure. */
export function leadCandidates(leads: LeadFact[], replied: readonly string[], now: Date): FollowItem[] {
  const skip = new Set(replied)
  const rows: { lead: LeadFact; age: number; step: LeadStep }[] = []
  for (const lead of leads) {
    if (!lead.id || skip.has(lead.id)) continue
    const age = daysBetween(lead.createdAt, now)
    if (age === null) continue
    const step = leadStep(age)
    if (step) rows.push({ lead, age, step })
  }
  rows.sort((a, b) => a.age - b.age || (a.lead.id < b.lead.id ? -1 : 1))
  return rows.slice(0, LEAD_MAX).map(({ lead, age, step }, i) => {
    const who = lead.name.trim() || lead.email.trim() || 'a new lead'
    const base = step === 'd0' ? 100 : step === 'd2' ? 92 : 80
    const title = step === 'd0' ? `${lead.phone.trim() ? 'Call or text' : 'Email'} ${who}` : step === 'd2' ? `Email ${who}` : `Send ${who} one last friendly nudge`
    const why = step === 'd0' ? 'A quick reply in the first day is what wins the booking.' : step === 'd2' ? 'They may have missed the first try. A short email keeps the door open.' : 'This is the last follow-up. After it, leave them be.'
    return { id: `lead:${lead.id}:${step}`, group: 'lead' as const, title, why, minutes: step === 'd0' ? 10 : 5, href: '/admin/leads', impact: base - i * 0.01, persist: true, note: AGE_TEXT(age) }
  })
}

export interface SeoFixFact {
  id: string
  title: string
  why: string
  hint: string
  impact: number
  effort: number
  href: string
}

export const SEO_MAX = 3

export function seoCandidates(fixes: readonly SeoFixFact[] | null): FollowItem[] {
  return (fixes ?? []).slice(0, SEO_MAX).map((f) => ({
    id: `seo:${f.id.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 100)}`,
    group: 'seo' as const,
    title: f.title,
    why: f.hint || f.why,
    // The playbook's effort: 1 = minutes, 2 = an afternoon, 3 = days.
    minutes: f.effort >= 3 ? 40 : f.effort === 2 ? 20 : 10,
    href: f.href,
    impact: 70 + Math.min(10, f.impact),
    persist: false,
  }))
}

export const DIGEST_MAX = 3

/** The growth digest's "what to do today" lines. Each is tied to a real number by the digest itself. */
export function digestCandidates(actions: readonly string[] | null): FollowItem[] {
  return (actions ?? []).slice(0, DIGEST_MAX).map((text, i) => ({
    id: `digest:${slug(text)}`,
    group: 'digest' as const,
    title: text,
    why: 'It comes from this week\'s growth numbers.',
    minutes: 10,
    href: '/admin/autopilot',
    impact: 85 - i * 2,
    persist: false,
  }))
}

export interface LinkTaskFact {
  id: string
  title: string
  how: string
  effort: 'low' | 'medium' | 'high'
}

export const LINK_TASK_MAX = 2
const EFFORT_MIN: Record<LinkTaskFact['effort'], number> = { low: 10, medium: 20, high: 40 }

/** The next two link-building tasks still to do (the caller passes them best first). */
export function linkCandidates(tasks: readonly LinkTaskFact[] | null): FollowItem[] {
  return (tasks ?? []).slice(0, LINK_TASK_MAX).map((t, i) => ({
    id: `links:${slug(t.id)}`,
    group: 'links' as const,
    title: t.title,
    why: 'A real link from another site is one of the strongest signals for search.',
    minutes: EFFORT_MIN[t.effort] ?? 20,
    href: '/admin/links-building',
    impact: 50 - i * 2,
    persist: false,
  }))
}

export interface RecapFact {
  id: string
  name: string
  href: string
}

export const RECAP_MAX = 2

export function recapCandidates(trips: readonly RecapFact[] | null): FollowItem[] {
  return (trips ?? []).slice(0, RECAP_MAX).map((t, i) => ({
    id: `recap:${slug(t.id)}`,
    group: 'recap' as const,
    title: `Write the recap for ${t.name}`,
    why: 'A recap page shows real travellers had a good time. It also earns fresh search traffic.',
    minutes: 5,
    href: t.href,
    impact: 45 - i,
    persist: false,
  }))
}

export function socialCandidate(): FollowItem {
  return {
    id: 'social:routine',
    group: 'social',
    title: 'Do the 15 minute social routine',
    why: 'Reply to comments, answer questions and comment on 5 posts. It builds trust and sends people to the site.',
    minutes: 15,
    href: '/admin/distribution',
    impact: 65,
    persist: false,
  }
}

/** The jobs that belong to one weekday: Mondays Search Console, Fridays the grid. */
export function weeklyCandidates(now: Date): FollowItem[] {
  const day = siteWeekday(now)
  if (day === 'Monday') return [{ id: 'weekly:mon-search-console', group: 'weekly', title: 'Review Search Console', why: 'See which searches grew this week and which pages are close to page one.', minutes: 10, href: '/admin/rankings', impact: 75, persist: false }]
  if (day === 'Friday') return [{ id: 'weekly:fri-grid', group: 'weekly', title: 'Check the grid and tell Claude what you liked', why: 'Your taste teaches the site which posts to make more of.', minutes: 10, href: '/admin/distribution', impact: 60, persist: false }]
  return []
}

export function slug(text: string): string {
  const s = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
  // A short stable hash keeps two long lines that start the same from sharing an id.
  let h = 0
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0
  return `${s || 'item'}-${(h >>> 0).toString(36)}`
}

export interface FollowSources {
  now: Date
  digestActions: readonly string[] | null
  seoFixes: readonly SeoFixFact[] | null
  leads: readonly LeadFact[] | null
  /** Lead ids already answered (Today's "I replied"). */
  repliedLeadIds: readonly string[]
  linkTasks: readonly LinkTaskFact[] | null
  recaps: readonly RecapFact[] | null
  done: DoneState
}

/** Every task that could be on today's list, before the cap. Pure. */
export function allCandidates(s: FollowSources): FollowItem[] {
  return [
    ...leadCandidates([...(s.leads ?? [])], s.repliedLeadIds, s.now),
    ...digestCandidates(s.digestActions),
    ...seoCandidates(s.seoFixes),
    socialCandidate(),
    ...weeklyCandidates(s.now),
    ...linkCandidates(s.linkTasks),
    ...recapCandidates(s.recaps),
    ...setupCandidates(s.done, siteDay(s.now)),
  ]
}

export interface ShownItem extends FollowItem {
  mark: Mark
}

export interface Selection {
  day: string
  items: ShownItem[]
  openCount: number
  laterCount: number
  doneCount: number
  /** True when nothing is left open: show "All done for today". */
  allDone: boolean
}

/** Orders the candidates by impact, drops what is finished for good, keeps the top FOLLOWUP_CAP and marks each. Pure.
 * Items ticked or pushed to later today still count towards the cap: the day's list is eight tasks, not eight open tasks. */
export function selectFollowups(candidates: readonly FollowItem[], done: DoneState, now: Date, cap: number = FOLLOWUP_CAP): Selection {
  const day = siteDay(now)
  // Finished for good on an earlier day: gone. Finished today: still shown, ticked.
  const todays = new Set(done[day] ?? [])
  const permanent = new Set((done[PERSIST_BUCKET] ?? []).filter((id) => !todays.has(id)))
  const seen = new Set<string>()
  const list = candidates
    .filter((c) => {
      if (seen.has(c.id)) return false
      seen.add(c.id)
      return !(c.persist && permanent.has(c.id))
    })
    .sort((a, b) => b.impact - a.impact || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, cap)
  const items: ShownItem[] = list.map((c) => ({ ...c, mark: markOf(done, day, c.id) }))
  const openCount = items.filter((i) => i.mark === 'open').length
  return {
    day,
    items,
    openCount,
    laterCount: items.filter((i) => i.mark === 'later').length,
    doneCount: items.filter((i) => i.mark === 'done').length,
    allDone: openCount === 0,
  }
}

// ---------------------------------------------------------------------------------------------------
// The stored list (so the menu badge and the brief need no new reads)
// ---------------------------------------------------------------------------------------------------

export interface StoredList {
  v: 1
  day: string
  at: string
  items: FollowItem[]
}

export function serializeList(day: string, at: Date, items: readonly FollowItem[]): string {
  return JSON.stringify({ v: 1, day, at: at.toISOString(), items: items.slice(0, 40) } satisfies StoredList)
}

export function parseList(raw: string | null | undefined): StoredList | null {
  if (!raw) return null
  try {
    const p = JSON.parse(raw) as Partial<StoredList>
    if (!p || p.v !== 1 || typeof p.day !== 'string' || typeof p.at !== 'string' || !Array.isArray(p.items)) return null
    const items = p.items.filter((i): i is FollowItem => !!i && isFollowId((i as FollowItem).id) && typeof i.title === 'string' && typeof i.href === 'string' && typeof i.impact === 'number')
    return { v: 1, day: p.day, at: p.at, items }
  } catch {
    return null
  }
}

/** True when a stored list was built today and recently enough to reuse. Pure. */
export function listIsFresh(list: StoredList | null, now: Date, ttlMs: number = LIST_TTL_MS): boolean {
  if (!list || list.day !== siteDay(now)) return false
  const age = now.getTime() - Date.parse(list.at)
  return Number.isFinite(age) && age >= -60_000 && age < ttlMs
}

/** The open count for the menu badge from a stored list and the ticks, or null when the list is not from today. Pure. */
export function openCountFrom(list: StoredList | null, done: DoneState, now: Date): { open: number; total: number } | null {
  if (!list || list.day !== siteDay(now)) return null
  const sel = selectFollowups(list.items, done, now)
  return { open: sel.openCount, total: sel.items.length }
}

// ---------------------------------------------------------------------------------------------------
// The words in the 7 am brief
// ---------------------------------------------------------------------------------------------------

export interface BriefFollowItem {
  title: string
  why: string
  minutes: number
  /** A full web address: one tap from the email. */
  url: string
}

/** The brief's follow-up lines: only what is still open, each with a full link. Pure. */
export function briefFollowups(sel: Selection, siteUrl: string): BriefFollowItem[] {
  return sel.items
    .filter((i) => i.mark === 'open')
    .map((i) => ({ title: i.title, why: i.why, minutes: i.minutes, url: /^https?:/.test(i.href) ? i.href : `${siteUrl}${i.href}` }))
}
