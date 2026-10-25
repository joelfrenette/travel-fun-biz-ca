import type { SupabaseClient } from '@supabase/supabase-js'
import { getSetting, setSetting } from '@/lib/app-settings'
import { isDryRunActive } from '@/lib/dry-run'

// The "Auto-heal improved this: review" queue.
//
// Joel's rule: the AUTOMATIC AI auto-heal (the ai_heal flywheel step) never publishes a held draft by itself. It repairs the text, leaves
// the draft HELD, and records the item here. A Today card (kind heal-review, lib/today-cards.ts) then asks a person:
//   swipe right = publish it through the normal publish route (so that route's own gate still decides; if it refuses, the reason is kept
//                 on the card and the draft stays held);
//   swipe left  = keep it held and put the old text back with revertEdit (the same Undo the Content edits screen uses).
//
// The queue is one small JSON value in app_settings (no new table, no migration): at most REVIEW_OPEN_CAP open items; decided items are
// kept briefly (REVIEW_KEEP_DECIDED) so a Today Undo of an approval can reopen one. Everything in here is pure or takes the database client
// and its collaborators as arguments, so scripts/check-ai-heal-review.ts runs it offline.

export const AI_HEAL_REVIEW_KEY = 'ai_heal_review'
/** At most this many items wait for a person. When the queue is full the scheduled auto-heal stops repairing more. */
export const REVIEW_OPEN_CAP = 20
/** Decided items kept so an Undo can reopen them. */
export const REVIEW_KEEP_DECIDED = 20
/** The quality note a held row carries while it waits for review. It is a "mode hold" note: the daily heal loop leaves such a row alone. */
export const REVIEW_HOLD_NOTE = 'Improved by auto-heal; waiting for a person to review before it is published'

export type ReviewType = 'post' | 'guide' | 'page_copy'
export type ReviewStatus = 'open' | 'approved' | 'rejected' | 'gone'

export interface ReviewSummary {
  /** One plain sentence: which parts were rewritten. */
  what: string
  before: string
  after: string
}

export interface ReviewItem {
  /** `post-<id>`, `guide-<id>` or `copy-<id>`. The part after the dash is the row id. */
  key: string
  type: ReviewType
  id: string
  path: string
  title: string
  /** content_edits rows the repair wrote (the Undo handles). */
  editIds: string[]
  summary: ReviewSummary
  /** The quality note the row had before it was marked as waiting for review (guides and page copy), put back on reject. */
  originalNotes: string | null
  at: string
  status: ReviewStatus
  decidedAt?: string
  /** Why the normal publish route refused the last Publish, so the card can show it. */
  refusal?: string
}

export interface ReviewQueue {
  items: ReviewItem[]
}

const TYPE_PREFIX: Record<ReviewType, string> = { post: 'post', guide: 'guide', page_copy: 'copy' }
const PREFIX_TYPE: Record<string, ReviewType> = { post: 'post', guide: 'guide', copy: 'page_copy' }

export const reviewKey = (type: ReviewType, id: string): string => `${TYPE_PREFIX[type]}-${id}`

/** The key shape the Today card id must have (checked on the server before anything runs). */
export const REVIEW_KEY_PATTERN = /^(post|guide|copy)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function parseReviewKey(key: string): { type: ReviewType; id: string } | null {
  if (!REVIEW_KEY_PATTERN.test(key)) return null
  const dash = key.indexOf('-')
  return { type: PREFIX_TYPE[key.slice(0, dash)], id: key.slice(dash + 1) }
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 3)}...` : s)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** Reads the stored queue. Anything missing or damaged is an empty queue. Pure. */
export function parseQueue(raw: string | null | undefined): ReviewQueue {
  try {
    const v = JSON.parse(raw ?? 'null') as { items?: unknown } | null
    if (!v || !Array.isArray(v.items)) return { items: [] }
    const items: ReviewItem[] = []
    for (const x of v.items as Partial<ReviewItem>[]) {
      if (!x || typeof x !== 'object' || typeof x.key !== 'string' || !parseReviewKey(x.key)) continue
      const p = parseReviewKey(x.key)!
      const status: ReviewStatus = x.status === 'approved' || x.status === 'rejected' || x.status === 'gone' ? x.status : 'open'
      const s = (x.summary ?? {}) as Partial<ReviewSummary>
      items.push({
        key: x.key,
        type: p.type,
        id: p.id,
        path: str(x.path),
        title: str(x.title) || str(x.path) || x.key,
        editIds: Array.isArray(x.editIds) ? x.editIds.filter((e): e is string => typeof e === 'string') : [],
        summary: { what: str(s.what), before: str(s.before), after: str(s.after) },
        originalNotes: typeof x.originalNotes === 'string' ? x.originalNotes : null,
        at: str(x.at),
        status,
        ...(typeof x.decidedAt === 'string' ? { decidedAt: x.decidedAt } : {}),
        ...(typeof x.refusal === 'string' && x.refusal ? { refusal: x.refusal } : {}),
      })
    }
    return { items }
  } catch {
    return { items: [] }
  }
}

export const openItems = (q: ReviewQueue): ReviewItem[] => q.items.filter((i) => i.status === 'open')
export const openCount = (q: ReviewQueue): number => openItems(q).length
export const isFull = (q: ReviewQueue, cap: number = REVIEW_OPEN_CAP): boolean => openCount(q) >= cap
export const findItem = (q: ReviewQueue, key: string): ReviewItem | undefined => q.items.find((i) => i.key === key)

/** Adds an item. A page that already has an OPEN item is not added twice; a full queue refuses. Decided items for the same page are replaced. Pure. */
export function addItem(q: ReviewQueue, item: ReviewItem, cap: number = REVIEW_OPEN_CAP): { queue: ReviewQueue; added: boolean; reason: string } {
  const existing = findItem(q, item.key)
  if (existing && existing.status === 'open') return { queue: q, added: false, reason: 'already waiting for review' }
  if (isFull(q, cap)) return { queue: q, added: false, reason: `${cap} items are already waiting for review` }
  const rest = q.items.filter((i) => i.key !== item.key)
  return { queue: trim({ items: [...rest, { ...item, status: 'open' }] }), added: true, reason: '' }
}

/** Keeps every open item and only the newest REVIEW_KEEP_DECIDED decided ones. Pure. */
export function trim(q: ReviewQueue): ReviewQueue {
  const decided = q.items.filter((i) => i.status !== 'open').sort((a, b) => Date.parse(b.decidedAt ?? b.at) - Date.parse(a.decidedAt ?? a.at)).slice(0, REVIEW_KEEP_DECIDED)
  const keep = new Set(decided.map((i) => i.key))
  return { items: q.items.filter((i) => i.status === 'open' || keep.has(i.key)) }
}

/** Replaces one item. Pure. */
export function setItem(q: ReviewQueue, key: string, patch: Partial<ReviewItem>): ReviewQueue {
  return trim({ items: q.items.map((i) => (i.key === key ? { ...i, ...patch } : i)) })
}

export async function readQueue(admin: SupabaseClient): Promise<ReviewQueue> {
  return parseQueue(await getSetting(admin, AI_HEAL_REVIEW_KEY).catch(() => null))
}

export async function writeQueue(admin: SupabaseClient, q: ReviewQueue): Promise<{ error?: string }> {
  try {
    return await setSetting(admin, AI_HEAL_REVIEW_KEY, JSON.stringify(q))
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'could not save the review queue' }
  }
}

interface EditLike {
  field: string
  before: string | null
  after: string | null
}

/** One summary from the audit rows of a repair. Pure. */
export function summarize(edits: EditLike[]): ReviewSummary {
  if (edits.length === 0) return { what: 'The text was improved.', before: '', after: '' }
  const fields = [...new Set(edits.map((e) => e.field.replace(/_/g, ' ')))]
  const first = edits[0]
  return {
    what: `Rewrote ${fields.slice(0, 5).join(', ')}${fields.length > 5 ? ` and ${fields.length - 5} more` : ''} (${edits.length} change${edits.length === 1 ? '' : 's'}).`,
    before: clip(str(first.before), 240),
    after: clip(str(first.after), 240),
  }
}

/** Reads the audit rows and summarises them. Never throws; an unreadable log gives the plain fallback sentence. */
export async function summarizeEdits(admin: SupabaseClient, ids: string[]): Promise<ReviewSummary> {
  if (ids.length === 0) return summarize([])
  try {
    const { data, error } = await admin.from('content_edits').select('field, before, after').in('id', ids)
    if (error) return summarize([])
    return summarize((data ?? []) as EditLike[])
  } catch {
    return summarize([])
  }
}

export interface ImprovedInfo {
  type: ReviewType
  id: string
  path: string
  title: string
  editIds: string[]
  originalNotes: string | null
}

/** Records one healed-but-unpublished item. Returns whether it was queued. A dry run writes nothing. Never throws. */
export async function enqueueReview(admin: SupabaseClient, info: ImprovedInfo, now: Date = new Date()): Promise<{ queued: boolean; reason: string }> {
  try {
    if (isDryRunActive()) return { queued: false, reason: 'dry run' }
    const q = await readQueue(admin)
    const item: ReviewItem = {
      key: reviewKey(info.type, info.id),
      type: info.type,
      id: info.id,
      path: info.path,
      title: info.title,
      editIds: info.editIds,
      summary: await summarizeEdits(admin, info.editIds),
      originalNotes: info.originalNotes,
      at: now.toISOString(),
      status: 'open',
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
// Decisions. The real publish and revert are passed in so the offline check can fake them.
// ---------------------------------------------------------------------------------------------------

export type DecisionResult = { ok: true; message: string; noop?: boolean } | { ok: false; status: number; error: string }

export interface ReviewDeps {
  /** The normal publish path for the page (the admin route's own PATCH, gate included). */
  publish: (item: ReviewItem, status?: 'published' | 'draft') => Promise<{ ok: boolean; status: number; error?: string }>
  /** revertEdit. */
  revert: (editId: string) => Promise<{ ok: boolean; error?: string; needsForce?: boolean }>
  /** Puts the row's quality note to `notes` (null clears it) when it still holds the review marker. */
  setNotes: (item: ReviewItem, notes: string | null) => Promise<void>
}

/** Publish: the normal route decides. A refusal keeps the item open (the draft stays held) and stores the reason for the card. */
export async function approveReview(admin: SupabaseClient, key: string, deps: ReviewDeps, now: Date = new Date()): Promise<DecisionResult> {
  const q = await readQueue(admin)
  const item = findItem(q, key)
  if (!item) return { ok: true, noop: true, message: 'That item is no longer in the review list.' }
  if (item.status !== 'open') return { ok: true, noop: true, message: `That item was already ${item.status}.` }
  const r = await deps.publish(item)
  if (!r.ok) {
    const why = clip(r.error || 'The publish route refused it.', 300)
    await writeQueue(admin, setItem(q, key, { refusal: why }))
    return { ok: false, status: r.status === 401 ? 401 : 409, error: `The publish check refused it, so it stays held: ${why}` }
  }
  await deps.setNotes(item, null).catch(() => undefined)
  await writeQueue(admin, setItem(q, key, { status: 'approved', decidedAt: now.toISOString(), refusal: undefined }))
  return { ok: true, message: 'Published.' }
}

/** Keep held: every audit row of the repair is reverted with revertEdit (newest first). A page a person changed since is left alone and said so. */
export async function rejectReview(admin: SupabaseClient, key: string, deps: ReviewDeps, now: Date = new Date()): Promise<DecisionResult> {
  const q = await readQueue(admin)
  const item = findItem(q, key)
  if (!item) return { ok: true, noop: true, message: 'That item is no longer in the review list.' }
  if (item.status !== 'open') return { ok: true, noop: true, message: `That item was already ${item.status}.` }
  const problems: string[] = []
  for (const id of [...item.editIds].reverse()) {
    const r = await deps.revert(id)
    if (!r.ok && !/already (been )?reverted/i.test(r.error ?? '')) problems.push(r.needsForce ? 'the text was changed by someone since, so it was left alone' : r.error || 'could not put the old text back')
  }
  if (problems.length) {
    // Nothing is marked decided: the card stays so the person can try again or open the Content edits screen.
    return { ok: false, status: 409, error: `Kept held, but the old text was not fully put back: ${[...new Set(problems)].join('; ')}. Use Content edits to finish.` }
  }
  await deps.setNotes(item, item.originalNotes).catch(() => undefined)
  await writeQueue(admin, setItem(q, key, { status: 'rejected', decidedAt: now.toISOString() }))
  return { ok: true, message: 'Kept held. The old text is back.' }
}

/** Today's Undo of a Publish: the item waits for review again (the caller has already put the page back to a draft). */
export async function reopenReview(admin: SupabaseClient, key: string, deps: Pick<ReviewDeps, 'setNotes'>): Promise<boolean> {
  const q = await readQueue(admin)
  const item = findItem(q, key)
  if (!item || item.status !== 'approved') return false
  await deps.setNotes(item, REVIEW_HOLD_NOTE).catch(() => undefined)
  await writeQueue(admin, setItem(q, key, { status: 'open', decidedAt: undefined }))
  return true
}

/** Marks items whose page changed under them (published elsewhere, deleted, or every edit already reverted) so the card goes away. */
export async function closeGone(admin: SupabaseClient, keys: string[], now: Date = new Date()): Promise<void> {
  if (keys.length === 0) return
  const q = await readQueue(admin)
  let next = q
  for (const k of keys) if (findItem(next, k)?.status === 'open') next = setItem(next, k, { status: 'gone', decidedAt: now.toISOString() })
  if (next !== q) await writeQueue(admin, next)
}
