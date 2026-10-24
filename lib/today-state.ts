// The small pure rules behind the Today queue: ordering, snoozes, the decision log. No database, no network, so
// scripts/check-today-queue.ts can test every rule offline. The server code (lib/today-queue.ts, the API route)
// only reads and writes these values through app_settings.

import { GROUP_RANK, TODAY_KINDS, type TodayCard, type TodayKindId } from '@/lib/today-cards'

export const TODAY_SNOOZE_KEY = 'today_snoozed'
export const TODAY_LOG_KEY = 'today_log'
export const TODAY_LEADS_DONE_KEY = 'today_leads_done'

/** The decision log keeps only the last 50 decisions. */
export const LOG_MAX = 50
export const SNOOZE_MAX = 400
export const LEADS_DONE_MAX = 300
export const MAX_SNOOZE_DAYS = 60
/** A second identical tap on the same card inside this window is the same decision, not a new one. */
export const DUPLICATE_WINDOW_MS = 10 * 60_000
const DAY_MS = 86_400_000

/** Admin copy never carries a long dash. Anything that came from the database is cleaned before it is shown. */
const EM_DASH = String.fromCharCode(0x2014)
const EN_DASH = String.fromCharCode(0x2013)
export function plain(text: string): string {
  let out = ''
  for (const ch of text.split(EM_DASH).join(' - ').split(EN_DASH).join(' - ')) {
    const c = ch.charCodeAt(0)
    // keep tab (9), newline (10) and carriage return (13); drop the other control characters
    if (c < 32 && c !== 9 && c !== 10 && c !== 13) continue
    if (c === 127) continue
    out += ch
  }
  return out.replace(/ {2,}/g, ' ').trim()
}

// ---------------------------------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------------------------------

/** Most urgent first: the group (urgent, then approvals, then prompts), then the kind's own place in the line, then
 * the card's sort key (usually oldest first), then the id so the order never flickers. */
export function orderCards(cards: TodayCard[]): TodayCard[] {
  return [...cards].sort((a, b) => {
    const da = TODAY_KINDS[a.kind]
    const db = TODAY_KINDS[b.kind]
    return GROUP_RANK[da.group] - GROUP_RANK[db.group] || da.order - db.order || a.sortKey - b.sortKey || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  })
}

// ---------------------------------------------------------------------------------------------------
// Snoozes: { cardId: "ISO time it comes back" } in app_settings.today_snoozed
// ---------------------------------------------------------------------------------------------------

export type SnoozeMap = Record<string, string>

/** Reads the stored snoozes. Expired ones are dropped, nonsense is ignored, and the map never grows past SNOOZE_MAX. */
export function parseSnoozed(raw: string | null | undefined, now: number = Date.now()): SnoozeMap {
  let value: unknown
  try {
    value = JSON.parse(raw ?? '{}')
  } catch {
    return {}
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const live: [string, string, number][] = []
  for (const [id, until] of Object.entries(value as Record<string, unknown>)) {
    const t = typeof until === 'string' ? Date.parse(until) : NaN
    if (Number.isFinite(t) && t > now) live.push([id, until as string, t])
  }
  live.sort((a, b) => b[2] - a[2])
  return Object.fromEntries(live.slice(0, SNOOZE_MAX).map(([id, until]) => [id, until]))
}

export function isSnoozed(map: SnoozeMap, id: string, now: number = Date.now()): boolean {
  const t = Date.parse(map[id] ?? '')
  return Number.isFinite(t) && t > now
}

export function addSnooze(map: SnoozeMap, id: string, days: number, now: number = Date.now()): SnoozeMap {
  const d = Math.min(Math.max(Math.round(days) || 1, 1), MAX_SNOOZE_DAYS)
  return { ...map, [id]: new Date(now + d * DAY_MS).toISOString() }
}

export function removeSnooze(map: SnoozeMap, id: string): SnoozeMap {
  const { [id]: _gone, ...rest } = map
  return rest
}

/** Hides snoozed cards. Un-hides by itself once the time has passed. */
export function visibleCards(cards: TodayCard[], map: SnoozeMap, now: number = Date.now()): TodayCard[] {
  return cards.filter((c) => !isSnoozed(map, c.id, now))
}

// ---------------------------------------------------------------------------------------------------
// The decision log: the last 50 decisions, newest last. Undo reads it.
// ---------------------------------------------------------------------------------------------------

export type TodayOp = 'approve' | 'reject' | 'snooze'
export const TODAY_OPS: readonly string[] = ['approve', 'reject', 'snooze', 'undo']

export interface LogEntry {
  /** A running number: the newest entry has the biggest. */
  n: number
  id: string
  kind: TodayKindId
  op: TodayOp
  /** What the button did: run = the real action; open/keep/later only hid the card. */
  mode: 'run' | 'open' | 'keep' | 'later'
  title: string
  at: string
  /** Can Undo put this back? */
  undoable: boolean
  /** What the undo needs to know (the state before the action). Small, plain values only. */
  prev?: Record<string, string | number | null>
  undone?: true
}

const isOp = (v: unknown): v is TodayOp => v === 'approve' || v === 'reject' || v === 'snooze'

export function parseLog(raw: string | null | undefined): LogEntry[] {
  let value: unknown
  try {
    value = JSON.parse(raw ?? '[]')
  } catch {
    return []
  }
  if (!Array.isArray(value)) return []
  const out: LogEntry[] = []
  for (const v of value as Record<string, unknown>[]) {
    if (!v || typeof v !== 'object') continue
    if (typeof v.n !== 'number' || typeof v.id !== 'string' || typeof v.kind !== 'string' || !(v.kind in TODAY_KINDS) || !isOp(v.op) || typeof v.at !== 'string') continue
    const mode = v.mode === 'run' || v.mode === 'open' || v.mode === 'keep' || v.mode === 'later' ? v.mode : 'run'
    const prev = v.prev && typeof v.prev === 'object' && !Array.isArray(v.prev) ? (v.prev as Record<string, string | number | null>) : undefined
    out.push({ n: v.n, id: v.id, kind: v.kind as TodayKindId, op: v.op, mode, title: typeof v.title === 'string' ? v.title : '', at: v.at, undoable: v.undoable === true, ...(prev ? { prev } : {}), ...(v.undone === true ? { undone: true as const } : {}) })
  }
  return out.slice(-LOG_MAX)
}

/** Adds an entry and keeps only the last LOG_MAX. The entry gets the next running number. */
export function appendLog(log: LogEntry[], entry: Omit<LogEntry, 'n'>): LogEntry[] {
  const n = log.reduce((m, e) => Math.max(m, e.n), 0) + 1
  return [...log, { ...entry, n }].slice(-LOG_MAX)
}

/** The most recent decision that has not been undone. */
export function lastOpenEntry(log: LogEntry[]): LogEntry | null {
  for (let i = log.length - 1; i >= 0; i--) if (!log[i].undone) return log[i]
  return null
}

export type UndoVerdict = { kind: 'none' } | { kind: 'cannot'; entry: LogEntry } | { kind: 'ok'; entry: LogEntry }

/** What Undo would do right now: nothing to undo, a last step that cannot be taken back, or a step it can reverse. */
export function undoVerdict(log: LogEntry[]): UndoVerdict {
  const entry = lastOpenEntry(log)
  if (!entry) return { kind: 'none' }
  return entry.undoable ? { kind: 'ok', entry } : { kind: 'cannot', entry }
}

export function markUndone(log: LogEntry[], n: number): LogEntry[] {
  return log.map((e) => (e.n === n ? { ...e, undone: true as const } : e))
}

/** True when this exact decision on this card was already taken a moment ago and not undone: the second tap does nothing. */
export function isDuplicate(log: LogEntry[], id: string, op: TodayOp, now: number = Date.now()): boolean {
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i]
    if (e.id !== id || e.undone) continue
    return e.op === op && now - Date.parse(e.at) < DUPLICATE_WINDOW_MS
  }
  return false
}

// ---------------------------------------------------------------------------------------------------
// A short bounded list of ids (the leads already answered)
// ---------------------------------------------------------------------------------------------------

export function parseIdList(raw: string | null | undefined): string[] {
  try {
    const v = JSON.parse(raw ?? '[]')
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(-LEADS_DONE_MAX) : []
  } catch {
    return []
  }
}

export function addToIdList(list: string[], id: string): string[] {
  return list.includes(id) ? list : [...list, id].slice(-LEADS_DONE_MAX)
}

export const removeFromIdList = (list: string[], id: string): string[] => list.filter((x) => x !== id)
