import type { SupabaseClient } from '@supabase/supabase-js'
import { todayEt } from '@/lib/ai-verify'
import { getSetting, setSetting } from '@/lib/app-settings'
import { pingIndexNow } from '@/lib/indexnow'
import { site } from '@/lib/site'
import { parseArticle } from '@/lib/guide-composer'
import { linkedPackageSlugs } from '@/lib/page-copy-composer'
import { guideKinds, GUIDE_KINDS, type GuideKind } from '@/lib/guides'
import { EST_COST_USD_PER_CALL, type ContentEdit, type ContentType, type EditField } from '@/lib/content-repair'

// The database side of self-healing content (growth loop WP10): the audit log of every automatic edit, the daily
// slots that cap how many pages may be repaired in a day, the spend estimate, and revert. The repair logic itself is
// in lib/content-repair.ts and has no database access.

/** At most this many pages are repaired or healed per day across posts, guides and page copy. */
export const REPAIR_ITEMS_PER_DAY = 6
/** At most this many model calls per page (posts 1). */
export const REPAIR_CALLS_PER_ITEM = 2
/** The most the repair and heal steps can spend in a day: items x calls x the per-call estimate. */
export const DAILY_REPAIR_LINE_USD = REPAIR_ITEMS_PER_DAY * REPAIR_CALLS_PER_ITEM * EST_COST_USD_PER_CALL

const SLOT_PREFIX = 'content_repair_slot'
const SPEND_PREFIX = 'content_repair_spend'

export interface EditRow extends ContentEdit {
  id: string
  reverted_at: string | null
  created_at: string
}

/** Today's date in the site's own time zone (the day the daily cap resets). */
export const repairDay = (now: Date = new Date()) => todayEt(now)

/** The UTC instant at which the site's current calendar day started (for "edits made today"). */
export function startOfSiteDayIso(now: Date = new Date()): string {
  const tz = site.timeZone
  const [y, m, d] = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now).split('-').map(Number)
  const guess = Date.UTC(y, m - 1, d)
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(new Date(guess))
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0)
  return new Date(guess - (Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - guess)).toISOString()
}

// ---------------------------------------------------------------------------------------------------
// The daily slots (an atomic claim per page, like the daily brief's)
// ---------------------------------------------------------------------------------------------------

export interface SlotResult {
  ok: boolean
  /** How many pages have a slot today (including this one when ok). */
  used: number
  reason?: string
}

/** Claims one of today's REPAIR_ITEMS_PER_DAY slots for a page. A page that already has a slot today keeps it (a
 * second look at the same page is free). Each slot is its own app_settings row inserted with a unique key, so two
 * overlapping runs can never both take the last one. Fails closed: if the slots cannot be read, nothing is repaired. */
export async function claimRepairSlot(admin: SupabaseClient, itemKey: string, perDay = REPAIR_ITEMS_PER_DAY, now: Date = new Date()): Promise<SlotResult> {
  const day = repairDay(now)
  const prefix = `${SLOT_PREFIX}:${day}:`
  const { data, error } = await admin.from('app_settings').select('key, value').like('key', `${prefix}%`)
  if (error) return { ok: false, used: 0, reason: `could not read today's repair slots: ${error.message}` }
  const rows = (data ?? []) as { key: string; value: string }[]
  if (rows.some((r) => r.value === itemKey)) return { ok: true, used: rows.length }
  for (let n = 1; n <= perDay; n++) {
    if (rows.some((r) => r.key === `${prefix}${n}`)) continue
    const { error: insertError } = await admin.from('app_settings').insert({ key: `${prefix}${n}`, value: itemKey })
    if (!insertError) return { ok: true, used: rows.length + 1 }
    // 23505 = someone else just took this slot: try the next one.
    if ((insertError as { code?: string }).code !== '23505') return { ok: false, used: rows.length, reason: `could not claim a repair slot: ${insertError.message}` }
  }
  return { ok: false, used: rows.length, reason: `today's cap of ${perDay} repaired pages is used` }
}

/** How many pages have a slot today. Null when it cannot be read. */
export async function repairSlotsUsed(admin: SupabaseClient, now: Date = new Date()): Promise<number | null> {
  const { data, error } = await admin.from('app_settings').select('key').like('key', `${SLOT_PREFIX}:${repairDay(now)}:%`)
  return error ? null : (data ?? []).length
}

export interface RepairSpend {
  calls: number
  usd: number
}

export async function readRepairSpend(admin: SupabaseClient, now: Date = new Date()): Promise<RepairSpend> {
  try {
    const parsed = JSON.parse((await getSetting(admin, `${SPEND_PREFIX}:${repairDay(now)}`)) ?? 'null') as Partial<RepairSpend> | null
    return { calls: Number(parsed?.calls) || 0, usd: Number(parsed?.usd) || 0 }
  } catch {
    return { calls: 0, usd: 0 }
  }
}

/** Adds model calls to today's estimate. Best effort (a display number, not a guard): never throws. */
export async function recordRepairSpend(admin: SupabaseClient, calls: number, now: Date = new Date()): Promise<void> {
  if (calls <= 0) return
  try {
    const before = await readRepairSpend(admin, now)
    const next: RepairSpend = { calls: before.calls + calls, usd: Math.round((before.usd + calls * EST_COST_USD_PER_CALL) * 10000) / 10000 }
    await setSetting(admin, `${SPEND_PREFIX}:${repairDay(now)}`, JSON.stringify(next))
  } catch {
    // a display number must never break a repair
  }
}

// ---------------------------------------------------------------------------------------------------
// The audit log
// ---------------------------------------------------------------------------------------------------

/** True when the content_edits table can be read (migration 0033 applied). No repair runs when it cannot be logged. */
export async function editsLoggable(admin: SupabaseClient): Promise<boolean> {
  try {
    const { error } = await admin.from('content_edits').select('id').limit(1)
    return !error
  } catch {
    return false
  }
}

/** Writes audit rows. The caller applies the edit to the page only if this succeeds ("log, then apply"). */
export async function insertEdits(admin: SupabaseClient, edits: ContentEdit[]): Promise<{ ids: string[]; error?: string }> {
  if (edits.length === 0) return { ids: [] }
  const { data, error } = await admin.from('content_edits').insert(edits).select('id')
  if (error) return { ids: [], error: error.message }
  return { ids: ((data ?? []) as { id: string }[]).map((r) => r.id) }
}

/** Points freshly written audit rows at the saved page, and records whether it went live. */
export async function attachEdits(admin: SupabaseClient, ids: string[], patch: { content_id: string; path: string; published_after: boolean }): Promise<void> {
  if (ids.length === 0) return
  const { error } = await admin.from('content_edits').update(patch).in('id', ids)
  if (error) console.error('[content-edits] could not attach audit rows:', error.message)
}

/** Takes back audit rows whose edit could not be applied after all. */
export async function deleteEdits(admin: SupabaseClient, ids: string[]): Promise<void> {
  if (ids.length === 0) return
  await admin.from('content_edits').delete().in('id', ids)
}

export async function listEdits(admin: SupabaseClient, opts: { type?: ContentType | null; limit?: number; offset?: number; sinceIso?: string } = {}): Promise<{ edits: EditRow[]; error?: string }> {
  let q = admin.from('content_edits').select('*').order('created_at', { ascending: false })
  if (opts.type) q = q.eq('content_type', opts.type)
  if (opts.sinceIso) q = q.gte('created_at', opts.sinceIso)
  const limit = Math.max(1, Math.min(opts.limit ?? 100, 500))
  const offset = Math.max(0, opts.offset ?? 0)
  const { data, error } = await q.range(offset, offset + limit - 1)
  if (error) return { edits: [], error: error.message }
  return { edits: (data ?? []) as EditRow[] }
}

/** Number of edits since `sinceIso` (null when unreadable). */
export async function countEditsSince(admin: SupabaseClient, sinceIso: string): Promise<number | null> {
  const { count, error } = await admin.from('content_edits').select('id', { count: 'exact', head: true }).gte('created_at', sinceIso).is('reverted_at', null)
  return error ? null : (count ?? 0)
}

// ---------------------------------------------------------------------------------------------------
// Revert: put the `before` text back
// ---------------------------------------------------------------------------------------------------

type Row = Record<string, unknown>

const TABLE: Record<ContentType, string> = { post: 'posts', guide: 'guides', page_copy: 'page_copy' }

const asString = (v: unknown) => (typeof v === 'string' ? v : '')

/** What a stored row holds for one audit field, in the same form the audit log stores it. */
export function storedValue(type: ContentType, row: Row, field: EditField): string {
  switch (field) {
    case 'body':
    case 'links':
      return type === 'guide' ? `${asString(row.summary)}\n\n${asString(row.body)}` : type === 'page_copy' ? asString(row.intro) : asString(row.body)
    case 'faq':
      return JSON.stringify(Array.isArray(row.faq) ? row.faq : [])
    case 'key_takeaways':
      return JSON.stringify(Array.isArray(row.key_takeaways) ? row.key_takeaways : [])
    default:
      return asString(row[field])
  }
}

/** The columns to write to put `text` (an audit field value) back into a row. Null when the text cannot be restored. */
export function columnsFor(type: ContentType, field: EditField, text: string): Row | null {
  switch (field) {
    case 'body':
    case 'links': {
      if (type === 'post') return { body: text }
      if (type === 'page_copy') return { intro: text, linked_slugs: linkedPackageSlugs(text) }
      const parsed = parseArticle(text)
      return parsed ? { summary: parsed.summary, body: parsed.body, sections: parsed.sections } : null
    }
    case 'faq':
    case 'key_takeaways':
      try {
        const value = JSON.parse(text)
        return Array.isArray(value) ? { [field]: value } : null
      } catch {
        return null
      }
    case 'title':
      return type === 'post' ? { title: text } : null
    default:
      return { [field]: text }
  }
}

/** The public path of a guide row, from its kind and slug (the kinds' URL prefixes). */
function guideRowPath(kind: string, slug: string): string {
  return GUIDE_KINDS.includes(kind as GuideKind) ? `${guideKinds[kind as GuideKind].urlPrefix}/${slug}` : `/${kind}/${slug}`
}

/** Finds the page an audit row is about: by id, or (for an edit logged before the page was saved) by its path. */
async function findRow(admin: SupabaseClient, type: ContentType, id: string | null, path: string): Promise<Row | null> {
  const table = TABLE[type]
  if (id) {
    const { data } = await admin.from(table).select('*').eq('id', id).maybeSingle()
    if (data) return data as Row
  }
  if (type === 'post') {
    const slug = /^\/blog\/([^/]+)$/.exec(path)?.[1]
    if (!slug) return null
    const { data } = await admin.from('posts').select('*').eq('slug', slug).maybeSingle()
    return (data as Row | null) ?? null
  }
  if (type === 'page_copy') {
    const { data } = await admin.from('page_copy').select('*').eq('path', path).maybeSingle()
    return (data as Row | null) ?? null
  }
  const m = /^\/([^/]+)\/([^/]+)$/.exec(path)
  if (!m) return null
  const kind = GUIDE_KINDS.find((k) => guideKinds[k].urlPrefix === `/${m[1]}`)
  if (!kind) return null
  const { data } = await admin.from('guides').select('*').eq('kind', kind).eq('slug', m[2]).maybeSingle()
  return (data as Row | null) ?? null
}

export interface RevertResult {
  ok: boolean
  error?: string
  /** True when the page has changed since the edit, so a revert needs the admin's explicit OK (force). */
  needsForce?: boolean
}

/** Puts the `before` text of one audit row back on its page and stamps reverted_at. If the field no longer holds the
 * edit's `after` text (a later edit, or a person, changed it), nothing is written unless `force` is true. */
export async function revertEdit(admin: SupabaseClient, id: string, opts: { force?: boolean } = {}): Promise<RevertResult> {
  const { data: found, error } = await admin.from('content_edits').select('*').eq('id', id).maybeSingle()
  if (error) return { ok: false, error: error.message }
  const edit = found as EditRow | null
  if (!edit) return { ok: false, error: 'That edit no longer exists.' }
  if (edit.reverted_at) return { ok: false, error: 'That edit was already reverted.' }

  const row = await findRow(admin, edit.content_type, edit.content_id, edit.path)
  if (!row) return { ok: false, error: 'The page this edit was made on no longer exists, so there is nothing to put back.' }
  if (!opts.force && storedValue(edit.content_type, row, edit.field) !== edit.after) {
    return { ok: false, needsForce: true, error: 'This field has changed since the automatic edit (a later edit or a person changed it). Reverting will replace what is there now.' }
  }
  const columns = columnsFor(edit.content_type, edit.field, edit.before ?? '')
  if (!columns) return { ok: false, error: 'The original text could not be read back, so it was not restored.' }

  const { error: updateError } = await admin.from(TABLE[edit.content_type]).update({ ...columns, updated_at: new Date().toISOString() }).eq('id', row.id as string)
  if (updateError) return { ok: false, error: updateError.message }
  await admin.from('content_edits').update({ reverted_at: new Date().toISOString() }).eq('id', id)

  if (row.status === 'published') {
    const publicPath = edit.content_type === 'guide' ? guideRowPath(asString(row.kind), asString(row.slug)) : edit.path
    await pingIndexNow([publicPath, '/sitemap.xml']).catch(() => undefined)
  }
  return { ok: true }
}
