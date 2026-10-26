import type { SupabaseClient } from '@supabase/supabase-js'
import { getSetting, setSetting } from '@/lib/app-settings'
import { isDryRunActive } from '@/lib/dry-run'
import { parseReviewKey, reviewKey, type ReviewType } from '@/lib/ai-heal-review'

// The "Model-written additions for a live page: review" queue.
//
// Joel's rule: the daily live-page heal (lib/content-heal-run.ts) keeps its cheap, code-only fixes automatic, but anything the MODEL wrote
// for an already-published post, guide or page copy (a FAQ, key takeaways, a meta title or description, and the share text derived from
// them) is NOT applied. It is held here as a proposal and shown on a Today card (kind live-additions, lib/today-cards.ts):
//   Yes = apply the held fields to the live page through the same log-first path the heal uses (so Undo in Content edits works);
//   No  = discard them, and do not propose for that page again for 30 days.
//
// The queue is one small JSON value in app_settings (no table, no migration), same shape of idea as lib/ai-heal-review.ts. Everything
// here is pure or takes the database client and its collaborators as arguments, so scripts/check-live-additions-review.ts runs it offline.

export const LIVE_ADDITIONS_KEY = 'live_additions_review'
/** At most this many proposals wait for a person. When the queue is full the heal skips the model call. */
export const LIVE_OPEN_CAP = 20
/** Decided items kept so an Undo can reopen one. */
export const LIVE_KEEP_DECIDED = 20
/** A page whose proposal was rejected is not proposed again for this long. */
export const LIVE_REJECT_DAYS = 30
export const LIVE_REJECT_PREFIX = 'live_additions_rejected'

export type AdditionField = 'faq' | 'key_takeaways' | 'meta_title' | 'meta_description' | 'og_title' | 'og_description'
export const ADDITION_FIELDS: AdditionField[] = ['faq', 'key_takeaways', 'meta_title', 'meta_description', 'og_title', 'og_description']
export type AdditionStatus = 'open' | 'approved' | 'rejected' | 'gone'

/** One model-written field. `before` and `after` are the audit-log text of the field (JSON for faq and key takeaways). */
export interface AdditionChange {
  field: AdditionField
  before: string
  after: string
}

export interface AdditionItem {
  /** `post-<id>`, `guide-<id>` or `copy-<id>`. */
  key: string
  type: ReviewType
  id: string
  path: string
  title: string
  changes: AdditionChange[]
  /** One plain sentence: what the model wrote. */
  what: string
  at: string
  status: AdditionStatus
  decidedAt?: string
  /** The content_edits rows written when a person said Yes (the Undo handles). */
  editIds: string[]
  /** Why the item went away (page changed, unpublished ...) or why the last Yes failed. */
  note?: string
}

export interface AdditionQueue {
  items: AdditionItem[]
}

export const additionKey = (type: ReviewType, id: string): string => reviewKey(type, id)

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 3)}...` : s)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const isField = (f: unknown): f is AdditionField => typeof f === 'string' && (ADDITION_FIELDS as string[]).includes(f)

/** Reads the stored queue. Anything missing or damaged is an empty queue. Pure. */
export function parseQueue(raw: string | null | undefined): AdditionQueue {
  try {
    const v = JSON.parse(raw ?? 'null') as { items?: unknown } | null
    if (!v || !Array.isArray(v.items)) return { items: [] }
    const items: AdditionItem[] = []
    for (const x of v.items as Partial<AdditionItem>[]) {
      if (!x || typeof x !== 'object' || typeof x.key !== 'string') continue
      const p = parseReviewKey(x.key)
      if (!p) continue
      const status: AdditionStatus = x.status === 'approved' || x.status === 'rejected' || x.status === 'gone' ? x.status : 'open'
      const changes: AdditionChange[] = Array.isArray(x.changes)
        ? x.changes.filter((c): c is AdditionChange => !!c && isField((c as AdditionChange).field) && typeof (c as AdditionChange).before === 'string' && typeof (c as AdditionChange).after === 'string').map((c) => ({ field: c.field, before: c.before, after: c.after }))
        : []
      items.push({
        key: x.key,
        type: p.type,
        id: p.id,
        path: str(x.path),
        title: str(x.title) || str(x.path) || x.key,
        changes,
        what: str(x.what),
        at: str(x.at),
        status,
        ...(typeof x.decidedAt === 'string' ? { decidedAt: x.decidedAt } : {}),
        editIds: Array.isArray(x.editIds) ? x.editIds.filter((e): e is string => typeof e === 'string') : [],
        ...(typeof x.note === 'string' && x.note ? { note: x.note } : {}),
      })
    }
    return { items }
  } catch {
    return { items: [] }
  }
}

export const openItems = (q: AdditionQueue): AdditionItem[] => q.items.filter((i) => i.status === 'open')
export const openCount = (q: AdditionQueue): number => openItems(q).length
export const isFull = (q: AdditionQueue, cap: number = LIVE_OPEN_CAP): boolean => openCount(q) >= cap
export const findItem = (q: AdditionQueue, key: string): AdditionItem | undefined => q.items.find((i) => i.key === key)

/** Keeps every open item and only the newest LIVE_KEEP_DECIDED decided ones. Pure. */
export function trim(q: AdditionQueue): AdditionQueue {
  const decided = q.items.filter((i) => i.status !== 'open').sort((a, b) => Date.parse(b.decidedAt ?? b.at) - Date.parse(a.decidedAt ?? a.at)).slice(0, LIVE_KEEP_DECIDED)
  const keep = new Set(decided.map((i) => i.key))
  return { items: q.items.filter((i) => i.status === 'open' || keep.has(i.key)) }
}

/** Adds an item. A page that already has an OPEN item is not added twice; a full queue refuses. Pure. */
export function addItem(q: AdditionQueue, item: AdditionItem, cap: number = LIVE_OPEN_CAP): { queue: AdditionQueue; added: boolean; reason: string } {
  const existing = findItem(q, item.key)
  if (existing && existing.status === 'open') return { queue: q, added: false, reason: 'already waiting for review' }
  if (isFull(q, cap)) return { queue: q, added: false, reason: `${cap} additions are already waiting for review` }
  const rest = q.items.filter((i) => i.key !== item.key)
  return { queue: trim({ items: [...rest, { ...item, status: 'open' }] }), added: true, reason: '' }
}

/** Replaces one item. Pure. */
export function setItem(q: AdditionQueue, key: string, patch: Partial<AdditionItem>): AdditionQueue {
  return trim({ items: q.items.map((i) => (i.key === key ? { ...i, ...patch } : i)) })
}

export async function readQueue(admin: SupabaseClient): Promise<AdditionQueue> {
  return parseQueue(await getSetting(admin, LIVE_ADDITIONS_KEY).catch(() => null))
}

export async function writeQueue(admin: SupabaseClient, q: AdditionQueue): Promise<{ error?: string }> {
  try {
    return await setSetting(admin, LIVE_ADDITIONS_KEY, JSON.stringify(q))
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'could not save the review queue' }
  }
}

// ---------------------------------------------------------------------------------------------------
// Whether the heal may ask the model about a page
// ---------------------------------------------------------------------------------------------------

export const rejectMarkerKey = (key: string): string => `${LIVE_REJECT_PREFIX}:${key}`

/** True while a rejection stamp (an ISO time) is younger than LIVE_REJECT_DAYS. Pure. */
export function rejectedRecently(stamp: string | null | undefined, now: number = Date.now()): boolean {
  const t = Date.parse(stamp ?? '')
  return Number.isFinite(t) && now - t < LIVE_REJECT_DAYS * 86_400_000
}

export interface ProposeVerdict {
  /** False when the heal must not generate for this page. */
  ok: boolean
  /** 'open' = the page has an undecided item (skip the whole page), 'rejected' = declined in the last 30 days, 'full' = the queue is full. */
  why: 'ok' | 'open' | 'rejected' | 'full'
}

/** The decision before any model call. An open item on the page wins (no second proposal until a person decides), then a recent rejection,
 * then a full queue. Pure. */
export function proposeVerdict(q: AdditionQueue, key: string, rejectStamp: string | null | undefined, now: number = Date.now(), cap: number = LIVE_OPEN_CAP): ProposeVerdict {
  if (findItem(q, key)?.status === 'open') return { ok: false, why: 'open' }
  if (rejectedRecently(rejectStamp, now)) return { ok: false, why: 'rejected' }
  if (isFull(q, cap)) return { ok: false, why: 'full' }
  return { ok: true, why: 'ok' }
}

export async function readRejectStamp(admin: SupabaseClient, key: string): Promise<string | null> {
  return getSetting(admin, rejectMarkerKey(key)).catch(() => null)
}

// ---------------------------------------------------------------------------------------------------
// Words for the card
// ---------------------------------------------------------------------------------------------------

const FIELD_WORDS: Record<AdditionField, string> = {
  faq: 'a FAQ',
  key_takeaways: 'key takeaways',
  meta_title: 'a search title',
  meta_description: 'a search description',
  og_title: 'a share title',
  og_description: 'a share description',
}

/** A field's stored text as plain lines a person can read. Pure. */
export function readable(field: AdditionField, text: string): string {
  if (field === 'faq' || field === 'key_takeaways') {
    try {
      const v = JSON.parse(text) as unknown
      if (Array.isArray(v)) {
        if (v.length === 0) return '(none)'
        if (field === 'faq') return v.map((p) => `Q: ${str((p as { q?: unknown }).q)} A: ${str((p as { a?: unknown }).a)}`).join(' | ')
        return v.map((t) => `- ${str(t)}`).join(' ')
      }
    } catch {
      // fall through to the raw text
    }
  }
  return text.trim() ? text : '(empty)'
}

/** The one-sentence "what" and the Before and After text of a set of changes. Pure. */
export function describeChanges(changes: AdditionChange[]): { what: string; before: string; after: string } {
  if (changes.length === 0) return { what: 'The AI wrote some extra text for this page.', before: '', after: '' }
  const words = changes.map((c) => FIELD_WORDS[c.field])
  const list = words.length === 1 ? words[0] : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`
  return {
    what: `The AI wrote ${list} for this live page (${changes.length} field${changes.length === 1 ? '' : 's'}).`,
    before: clip(changes.map((c) => `${c.field.replace(/_/g, ' ')}: ${readable(c.field, c.before)}`).join('\n'), 600),
    after: clip(changes.map((c) => `${c.field.replace(/_/g, ' ')}: ${readable(c.field, c.after)}`).join('\n'), 600),
  }
}

// ---------------------------------------------------------------------------------------------------
// Queueing
// ---------------------------------------------------------------------------------------------------

export interface ProposalInfo {
  type: ReviewType
  id: string
  path: string
  title: string
  changes: AdditionChange[]
}

/** Records one held proposal. Returns whether it was queued. A dry run writes nothing. Never throws. */
export async function enqueueAdditions(admin: SupabaseClient, info: ProposalInfo, now: Date = new Date()): Promise<{ queued: boolean; reason: string }> {
  try {
    if (isDryRunActive()) return { queued: false, reason: 'dry run' }
    if (info.changes.length === 0) return { queued: false, reason: 'nothing to review' }
    const q = await readQueue(admin)
    const item: AdditionItem = {
      key: additionKey(info.type, info.id),
      type: info.type,
      id: info.id,
      path: info.path,
      title: info.title,
      changes: info.changes,
      what: describeChanges(info.changes).what,
      at: now.toISOString(),
      status: 'open',
      editIds: [],
    }
    const r = addItem(q, item)
    if (!r.added) return { queued: false, reason: r.reason }
    const w = await writeQueue(admin, r.queue)
    return w.error ? { queued: false, reason: w.error } : { queued: true, reason: '' }
  } catch (e) {
    return { queued: false, reason: e instanceof Error ? e.message : 'unknown error' }
  }
}

// ---------------------------------------------------------------------------------------------------
// Decisions. The real apply and revert are passed in so the offline check can fake them.
// ---------------------------------------------------------------------------------------------------

export type DecisionResult = { ok: true; message: string; noop?: boolean } | { ok: false; status: number; error: string }

export type ApplyOutcome = { ok: true; editIds: string[] } | { ok: false; gone: true; reason: string } | { ok: false; gone?: false; error: string }

export interface AdditionsDeps {
  /** Re-reads the live row, checks it is still published and the target fields still equal `before`, then applies (log first). */
  apply: (item: AdditionItem) => Promise<ApplyOutcome>
  /** revertEdit. */
  revert: (editId: string) => Promise<{ ok: boolean; error?: string; needsForce?: boolean }>
}

/** Yes: apply the held fields to the live page. A page that changed meanwhile closes the item as gone and says why. */
export async function approveAdditions(admin: SupabaseClient, key: string, deps: Pick<AdditionsDeps, 'apply'>, now: Date = new Date()): Promise<DecisionResult> {
  const q = await readQueue(admin)
  const item = findItem(q, key)
  if (!item) return { ok: true, noop: true, message: 'That item is no longer in the review list.' }
  if (item.status !== 'open') return { ok: true, noop: true, message: `That item was already ${item.status}.` }
  const r = await deps.apply(item)
  if (r.ok) {
    await writeQueue(admin, setItem(q, key, { status: 'approved', decidedAt: now.toISOString(), editIds: r.editIds, note: undefined }))
    return { ok: true, message: 'Added to the live page.' }
  }
  if (r.gone) {
    await writeQueue(admin, setItem(q, key, { status: 'gone', decidedAt: now.toISOString(), note: clip(r.reason, 300) }))
    return { ok: true, noop: true, message: `Nothing was added: ${r.reason}` }
  }
  const why = clip(r.error || 'The page could not be updated.', 300)
  await writeQueue(admin, setItem(q, key, { note: why }))
  return { ok: false, status: 409, error: `Could not add it, the live page is unchanged: ${why}` }
}

/** No: discard the held fields and remember the rejection for LIVE_REJECT_DAYS. */
export async function rejectAdditions(admin: SupabaseClient, key: string, now: Date = new Date()): Promise<DecisionResult> {
  const q = await readQueue(admin)
  const item = findItem(q, key)
  if (!item) return { ok: true, noop: true, message: 'That item is no longer in the review list.' }
  if (item.status !== 'open') return { ok: true, noop: true, message: `That item was already ${item.status}.` }
  const marker = await setSetting(admin, rejectMarkerKey(key), now.toISOString())
  if (marker.error) return { ok: false, status: 500, error: `Could not save the decision: ${marker.error}` }
  await writeQueue(admin, setItem(q, key, { status: 'rejected', decidedAt: now.toISOString() }))
  return { ok: true, message: `Discarded. This page is not proposed again for ${LIVE_REJECT_DAYS} days.` }
}

/** Today's Undo of a Yes: every audit row is reverted (newest first) and the item waits for review again. */
export async function undoApproval(admin: SupabaseClient, key: string, deps: Pick<AdditionsDeps, 'revert'>): Promise<DecisionResult> {
  const q = await readQueue(admin)
  const item = findItem(q, key)
  if (!item || item.status !== 'approved') return { ok: false, status: 409, error: 'That item was not added from this list, so there is nothing to take back.' }
  const problems: string[] = []
  for (const id of [...item.editIds].reverse()) {
    const r = await deps.revert(id)
    if (!r.ok && !/already (been )?reverted/i.test(r.error ?? '')) problems.push(r.needsForce ? 'the text was changed by someone since, so it was left alone' : r.error || 'could not put the old text back')
  }
  if (problems.length) return { ok: false, status: 409, error: `The old text was not fully put back: ${[...new Set(problems)].join('; ')}. Use Content edits to finish.` }
  await writeQueue(admin, setItem(q, key, { status: 'open', decidedAt: undefined, editIds: [] }))
  return { ok: true, message: 'Taken back. The additions are waiting for review again.' }
}

/** Marks open items whose page is gone (unpublished, deleted) so the card goes away and the cap is not clogged. */
export async function closeGone(admin: SupabaseClient, keys: string[], why = 'the page is no longer published', now: Date = new Date()): Promise<void> {
  if (keys.length === 0) return
  const q = await readQueue(admin)
  let next = q
  for (const k of keys) if (findItem(next, k)?.status === 'open') next = setItem(next, k, { status: 'gone', decidedAt: now.toISOString(), note: why })
  if (next !== q) await writeQueue(admin, next)
}
