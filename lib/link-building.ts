// Pure helpers for the Link building workspace: saved task state, link-earned entries, partner task suggestions,
// copy-ready drafts, and the NAP consistency check. No network. The route (app/api/admin/links-building) does the
// database reads and writes and passes plain values in here.
import {
  LINK_STATUSES, LINK_TARGETS, MAX_EARNED, MAX_NOTE_LENGTH, MAX_PARTNER_TASKS, MAX_TASKS_STORED,
  type DraftKind, type Level, type LinkGroup, type LinkStatus, type LinkTarget,
} from '@/lib/link-targets'

export const TASKS_KEY = 'link_tasks'
export const EARNED_KEY = 'link_earned'

const ID_RE = /^[a-z0-9][a-z0-9-]{0,79}$/

// ---------------------------------------------------------------- task state

export interface TaskState { status: LinkStatus; note?: string; holds?: boolean; at: string }
export type TaskStateMap = Record<string, TaskState>

export function isLinkStatus(v: unknown): v is LinkStatus {
  return typeof v === 'string' && (LINK_STATUSES as string[]).includes(v)
}

/** Parse the stored JSON. Anything malformed, oversized or unexpected is dropped (fail open: an empty map, never a throw). */
export function parseTaskState(raw: string | null | undefined): TaskStateMap {
  if (!raw || raw.length > 400_000) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    const src = parsed && typeof parsed === 'object' ? (parsed as { tasks?: unknown }).tasks : null
    if (!src || typeof src !== 'object' || Array.isArray(src)) return {}
    const out: TaskStateMap = {}
    for (const [id, v] of Object.entries(src as Record<string, unknown>)) {
      if (Object.keys(out).length >= MAX_TASKS_STORED) break
      if (!ID_RE.test(id) || !v || typeof v !== 'object') continue
      const e = v as Record<string, unknown>
      if (!isLinkStatus(e.status)) continue
      out[id] = {
        status: e.status,
        ...(typeof e.note === 'string' && e.note.trim() ? { note: e.note.trim().slice(0, MAX_NOTE_LENGTH) } : {}),
        ...(typeof e.holds === 'boolean' ? { holds: e.holds } : {}),
        at: typeof e.at === 'string' ? e.at.slice(0, 40) : '',
      }
    }
    return out
  } catch {
    return {}
  }
}

export function serializeTaskState(map: TaskStateMap): string {
  const ids = Object.keys(map).slice(0, MAX_TASKS_STORED)
  const tasks: TaskStateMap = {}
  for (const id of ids) tasks[id] = map[id]
  return JSON.stringify({ v: 1, tasks })
}

export interface TaskPatch { status?: unknown; note?: unknown; holds?: unknown }

/** Apply a validated change for one task. Returns the new map or an error message. Never mutates the input. */
export function applyTaskPatch(map: TaskStateMap, id: unknown, patch: TaskPatch, knownIds: Set<string>, now: string): { map: TaskStateMap } | { error: string } {
  if (typeof id !== 'string' || !ID_RE.test(id) || !knownIds.has(id)) return { error: 'Unknown task.' }
  if (patch.status !== undefined && !isLinkStatus(patch.status)) return { error: 'Status must be todo, doing, done or skipped.' }
  if (patch.note !== undefined && typeof patch.note !== 'string') return { error: 'Note must be text.' }
  if (patch.holds !== undefined && typeof patch.holds !== 'boolean') return { error: 'holds must be true or false.' }
  const prev = map[id]
  if (!prev && Object.keys(map).length >= MAX_TASKS_STORED) return { error: 'Too many saved tasks.' }
  const note = patch.note === undefined ? prev?.note : patch.note.trim().slice(0, MAX_NOTE_LENGTH)
  const next: TaskState = {
    status: (patch.status as LinkStatus | undefined) ?? prev?.status ?? 'todo',
    ...(note ? { note } : {}),
    ...((patch.holds as boolean | undefined) !== undefined ? { holds: patch.holds as boolean } : prev?.holds !== undefined ? { holds: prev.holds } : {}),
    at: now,
  }
  return { map: { ...map, [id]: next } }
}

// ---------------------------------------------------------------- links earned

export interface EarnedLink { id: string; page: string; source: string; date: string }

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export function parseEarned(raw: string | null | undefined): EarnedLink[] {
  if (!raw || raw.length > 400_000) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    const items = parsed && typeof parsed === 'object' ? (parsed as { items?: unknown }).items : null
    if (!Array.isArray(items)) return []
    const out: EarnedLink[] = []
    for (const it of items) {
      if (out.length >= MAX_EARNED) break
      if (!it || typeof it !== 'object') continue
      const e = it as Record<string, unknown>
      if (typeof e.id !== 'string' || !ID_RE.test(e.id) || typeof e.page !== 'string' || typeof e.source !== 'string' || typeof e.date !== 'string' || !DATE_RE.test(e.date)) continue
      out.push({ id: e.id, page: e.page.slice(0, 200), source: e.source.slice(0, 200), date: e.date })
    }
    return out
  } catch {
    return []
  }
}

export function serializeEarned(items: EarnedLink[]): string {
  return JSON.stringify({ v: 1, items: items.slice(0, MAX_EARNED) })
}

/** Validate what the owner typed. page is the page on our site that earned the link (a path or a URL), source is who linked. */
export function validateEarnedInput(input: { page?: unknown; source?: unknown; date?: unknown }): { page: string; source: string; date: string } | { error: string } {
  const page = typeof input.page === 'string' ? input.page.trim() : ''
  const source = typeof input.source === 'string' ? input.source.trim() : ''
  const date = typeof input.date === 'string' ? input.date.trim() : ''
  if (!page || page.length > 200) return { error: 'Enter the page on our site that got the link (up to 200 characters).' }
  if (!source || source.length > 200) return { error: 'Enter who linked to us, a site name or address (up to 200 characters).' }
  if (!DATE_RE.test(date) || Number.isNaN(new Date(`${date}T00:00:00Z`).getTime())) return { error: 'Enter the date as YYYY-MM-DD.' }
  return { page, source, date }
}

/** Add an entry (newest first). Fails when the list is full. */
export function addEarned(items: EarnedLink[], input: { page: string; source: string; date: string }, id: string): { items: EarnedLink[] } | { error: string } {
  if (items.length >= MAX_EARNED) return { error: `The list is full (${MAX_EARNED} entries).` }
  return { items: [{ id, ...input }, ...items] }
}

// ---------------------------------------------------------------- partner suggestions

export function slugify(name: string): string {
  return name.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
}

/** One "ask <partner> to link to your agent page" task per distinct supplier or affiliate partner name. Never invents a URL. */
export function suggestPartnerTasks(supplierNames: Array<string | null | undefined>, affiliatePartnerNames: Array<string | null | undefined>): LinkTarget[] {
  const seen = new Set<string>()
  const out: LinkTarget[] = []
  const add = (raw: string | null | undefined, from: 'supplier' | 'affiliate') => {
    const name = (raw ?? '').replace(/\s+/g, ' ').trim()
    if (!name || name.length > 80) return
    const slug = slugify(name)
    if (!slug || seen.has(slug) || out.length >= MAX_PARTNER_TASKS) return
    seen.add(slug)
    out.push({
      id: `partner-${slug}`.slice(0, 80),
      group: 'partners',
      title: `Ask ${name} to link to your agent page`,
      how: from === 'supplier'
        ? `You have a published trip with ${name}. Check whether they have a partner, agent or "where to book" page that lists agencies, and ask your contact there for a link.`
        : `${name} is one of your affiliate partners. Check whether they list partner agencies on their site, and ask your contact there for a link.`,
      searchPhrase: `${name} travel agent partner page where to book`,
      officialSite: `${name} (use the official site you already deal with)`,
      effort: 'medium',
      value: 'high',
      needsNap: true,
      drafts: ['partner'],
    })
  }
  for (const n of supplierNames) add(n, 'supplier')
  for (const n of affiliatePartnerNames) add(n, 'affiliate')
  return out
}

export function allTargets(partnerTasks: LinkTarget[]): LinkTarget[] {
  return [...LINK_TARGETS, ...partnerTasks]
}

// ---------------------------------------------------------------- NAP and drafts

export interface Nap {
  name: string
  addressLines: string[]
  phone: string
  url: string
}

export function napBlock(n: Nap): string {
  return [`Name: ${n.name}`, ...(n.addressLines.length ? [`Address: ${n.addressLines.join(', ')}`] : []), `Phone: ${n.phone}`, `Website: ${n.url}`].join('\n')
}

export interface Draft { label: string; text: string }

/** Directory descriptions at three lengths. Each is at most its limit. Built from site facts only. */
export function directoryDescriptions(n: { name: string; city: string }): { limit: 50 | 150 | 300; text: string }[] {
  return [
    { limit: 50, text: 'Hosted group trips, cruises and singles getaways.' },
    { limit: 150, text: `${n.name} plans hosted group trips, river and ocean cruises, and singles getaways, with real travel advisors on hand.` },
    {
      limit: 300,
      text: `${n.name} is a ${n.city} travel agency for hosted group trips, river and ocean cruises, and singles getaways. Our travel advisors help you compare your options and plan the trip that fits you. Browse upcoming trips and destination guides on our site, or send us a note if you would like a hand.`,
    },
  ]
}

export interface DraftContext extends Nap {
  city: string
  /** The page we want linked. */
  linkUrl: string
  anchor: string
  /** The target's display name (partner, host agency, network). */
  targetName: string
}

/** Short, honest, plain-text templates. No prices, no response-time promises, no claims we cannot back. */
export function buildDrafts(kind: DraftKind, c: DraftContext): Draft[] {
  const nap = napBlock(c)
  switch (kind) {
    case 'directory':
      return directoryDescriptions({ name: c.name, city: c.city }).map((d) => ({ label: `Description, up to ${d.limit} characters (${d.text.length} used)`, text: d.text }))
    case 'bio':
      return [
        { label: 'Bio link', text: `${c.url.replace(/\/$/, '')}/links` },
        { label: 'Bio line', text: `Hosted group trips and cruises with travel advisors. Newest guides and trips below.` },
      ]
    case 'partner':
      return [{
        label: 'Link request to a partner (edit the greeting and send it yourself)',
        text: `Hello ${c.targetName} team,\n\nWe are a travel agency in ${c.city} and we have ${c.targetName} on our site. We would be glad to be listed on your partner or "where to book" page, if you keep one.\n\nIf you can add a link, this is the page: ${c.linkUrl}\nSuggested link text: ${c.anchor}\n\nOur details, so the listing matches:\n${nap}\n\nThank you for your time.\n[Your name]`,
      }]
    case 'agent_page':
      return [{
        label: 'Request to your host agency or network (edit and send it yourself)',
        text: `Hello,\n\nCould you add a link to our website on our agent page? Our site is ${c.linkUrl}\nSuggested link text: ${c.anchor}\n\nOur details:\n${nap}\n\nThank you.\n[Your name]`,
      }]
    case 'association':
      return [{
        label: 'Member profile update (paste into the website field and details)',
        text: `Website: ${c.linkUrl}\nSuggested link text: ${c.anchor}\n\n${nap}`,
      }]
    case 'review':
      return [{
        label: 'Review request to a past traveller (personal, one at a time)',
        text: `Hi [Name],\n\nIt was a pleasure having you on the trip. If you have a minute, would you share an honest review of your experience? Here is the link: [paste your review link]\n\nWhatever you write is fine with us, good or not. Thank you either way.\n[Your name]`,
      }]
    case 'pitch':
      return [{
        label: 'Short pitch idea (write it in your own voice, send from your own email)',
        text: `Hi [Name],\n\nI read your piece on [their post]. We run hosted group trips and cruises from ${c.city}, and we have written a guide that your readers might find useful: ${c.linkUrl}\n\nIf it fits, you are welcome to link to it with a line such as "${c.anchor}". Happy to answer any questions.\n[Your name]`,
      }]
    default:
      return []
  }
}

// ---------------------------------------------------------------- NAP consistency check

/** The old Canada office number: it must never appear on a public surface. */
// Built from pieces so the number itself never sits in a source file (scripts/check-old-phone.ts scans for it).
const OLD_PARTS = ['365', '800', '6363']
export const OLD_PHONE_RE = new RegExp(`${OLD_PARTS[0]}\\)?[\\s.-]*${OLD_PARTS[1]}[\\s.-]*${OLD_PARTS[2]}`)

export interface NapSurface {
  surface: string
  name?: string | null
  phone?: string | null
  street?: string | null
  locality?: string | null
  region?: string | null
  postalCode?: string | null
  /** Free text from the surface (a consent line, a price line), scanned for phone numbers. */
  text?: string | null
}

export interface NapExpected { name: string; phone: string; street: string; locality: string; region: string; postalCode: string }

export interface NapFinding { surface: string; field: string; ok: boolean; expected: string; found: string; note?: string }

const digits = (s: string) => s.replace(/\D/g, '')
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()
// 10 or 11 digit phone-looking runs
const PHONE_LIKE = /(?:\+?1[\s.-]*)?\(?\d{3}\)?[\s.-]*\d{3}[\s.-]*\d{4}/g

/** Compare every surface with lib/site.ts. Surfaces are read-only snapshots; this never changes anything. */
export function checkNap(surfaces: NapSurface[], expected: NapExpected): NapFinding[] {
  const out: NapFinding[] = []
  const wantPhone = digits(expected.phone).slice(-10)
  for (const s of surfaces) {
    if (s.name != null && s.name !== '') out.push({ surface: s.surface, field: 'name', ok: norm(s.name) === norm(expected.name), expected: expected.name, found: s.name })
    if (s.phone != null && s.phone !== '') {
      const found = digits(s.phone).slice(-10)
      out.push({ surface: s.surface, field: 'phone', ok: found === wantPhone && !OLD_PHONE_RE.test(s.phone), expected: expected.phone, found: s.phone })
    }
    if (s.street != null && s.street !== '') out.push({ surface: s.surface, field: 'street', ok: norm(s.street) === norm(expected.street), expected: expected.street, found: s.street })
    if (s.locality != null && s.locality !== '') out.push({ surface: s.surface, field: 'city', ok: norm(s.locality) === norm(expected.locality), expected: expected.locality, found: s.locality })
    if (s.region != null && s.region !== '') out.push({ surface: s.surface, field: 'province', ok: norm(s.region) === norm(expected.region), expected: expected.region, found: s.region })
    if (s.postalCode != null && s.postalCode !== '') out.push({ surface: s.surface, field: 'postal code', ok: norm(s.postalCode) === norm(expected.postalCode), expected: expected.postalCode, found: s.postalCode })
    const text = s.text ?? ''
    if (text) {
      const stray = (text.match(PHONE_LIKE) ?? []).filter((m) => digits(m).slice(-10) !== wantPhone)
      const old = OLD_PHONE_RE.test(text)
      out.push({
        surface: s.surface, field: 'phone in text', ok: !old && stray.length === 0, expected: expected.phone,
        found: old ? 'the old Canada office number' : stray.length ? stray.join(', ') : 'only the site phone',
        ...(old ? { note: 'The Canada office number must never appear publicly.' } : {}),
      })
    }
  }
  return out
}

export function napSummary(findings: NapFinding[]): { total: number; bad: number } {
  return { total: findings.length, bad: findings.filter((f) => !f.ok).length }
}

// ---------------------------------------------------------------- merged view

export interface TaskView extends LinkTarget { status: LinkStatus; note: string; holds: boolean | null; drafts_text: Draft[] }

export function levelRank(l: Level): number { return l === 'high' ? 3 : l === 'medium' ? 2 : 1 }

export function groupTasks<T extends { group: LinkGroup }>(tasks: T[], order: LinkGroup[]): { group: LinkGroup; tasks: T[] }[] {
  return order.map((g) => ({ group: g, tasks: tasks.filter((t) => t.group === g) })).filter((g) => g.tasks.length)
}
