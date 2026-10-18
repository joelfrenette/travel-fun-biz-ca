import type { SupabaseClient } from '@supabase/supabase-js'
import { isValidSlug, isRealLink, slugify } from '@/lib/affiliate-go'
import { cleanHttpsUrl, GUIDE_SLUG_PATTERN, MAX_NOTE_LENGTH } from '@/lib/affiliate-partners'
import { isGuideKind, type GuideKind } from '@/lib/guides'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Factory Phase 11: the admin CRUD that Phase 6 (affiliate-go.ts, migration 0007) shipped
// without — that phase deliberately left affiliate_links empty since no admin screen could
// write to it yet. This is that screen's server-side logic: validating a card before it's
// written, and folding raw click rows into per-link counts (matches Nomad's own
// getAffiliateClickCounts shape — total/last7/last30 — computed in JS rather than SQL so it's
// covered by a plain assertion instead of a database round trip).
export type AffiliateLinkStatus = 'draft' | 'active' | 'hidden'
const STATUSES: AffiliateLinkStatus[] = ['draft', 'active', 'hidden']

export interface AffiliateLinkInput {
  slug: string
  url: string
  merchant: string | null
  title: string | null
  status: AffiliateLinkStatus
  sort_order: number
  // WP21: pin the card to one guide page, with a partner, a photo and a short admin-written note.
  partner_id: string | null
  guide_kind: GuideKind | null
  guide_slug: string | null
  image_url: string | null
  note: string | null
}

export type AffiliateLinkValidation = { ok: true; value: AffiliateLinkInput } | { ok: false; error: string }

/** Validates and normalizes a raw admin-form submission. Never throws — a bad input is always a
 * `{ ok: false, error }`, ready to return straight from the route as a 400. The slug is not
 * de-duplicated here (that needs the current set of taken slugs, which only the route has). */
export function normalizeAffiliateLinkInput(raw: {
  slug?: unknown
  url?: unknown
  merchant?: unknown
  title?: unknown
  status?: unknown
  sort_order?: unknown
  partner_id?: unknown
  guide_kind?: unknown
  guide_slug?: unknown
  image_url?: unknown
  note?: unknown
}, opts?: { previousUrl?: string | null }): AffiliateLinkValidation {
  const url = String(raw.url ?? '').trim()
  if (!url) return { ok: false, error: 'A URL is required.' }
  if (!isRealLink(url)) return { ok: false, error: 'That does not look like a real, working http(s) link.' }

  const rawSlug = String(raw.slug ?? '').trim().toLowerCase()
  const merchant = String(raw.merchant ?? '').trim() || null
  const title = String(raw.title ?? '').trim() || null
  const slug = rawSlug || slugify(title || merchant || url)
  if (!isValidSlug(slug)) {
    return { ok: false, error: 'Slug must be lowercase letters, digits and dashes, 2-41 characters.' }
  }

  const status = STATUSES.includes(raw.status as AffiliateLinkStatus) ? (raw.status as AffiliateLinkStatus) : 'draft'
  const sortNum = Number(raw.sort_order)
  const sort_order = Number.isFinite(sortNum) ? Math.trunc(sortNum) : 0

  // The merchant URL stays as before (isRealLink). The new link must still be https only, with no
  // javascript:/data: scheme and no user name or password in it.
  if (/^\s*(javascript|data|vbscript):/i.test(url)) return { ok: false, error: 'That link type is not allowed.' }
  if (/^https?:\/\/[^/?#]*@/i.test(url)) return { ok: false, error: 'The link must not contain a user name or password.' }
  // https only for a new link or a changed URL; an unchanged legacy http URL stays editable (status, sort order...).
  const unchangedLegacy = opts?.previousUrl != null && opts.previousUrl.trim() === url
  if (!unchangedLegacy && !/^https:\/\//i.test(url)) return { ok: false, error: 'The link must start with https://' }

  const partnerRaw = String(raw.partner_id ?? '').trim()
  if (partnerRaw && !UUID.test(partnerRaw)) return { ok: false, error: 'Pick a partner from the list.' }
  const partner_id = partnerRaw || null

  const kindRaw = String(raw.guide_kind ?? '').trim()
  const slugRaw = String(raw.guide_slug ?? '').trim().toLowerCase()
  let guide_kind: GuideKind | null = null
  let guide_slug: string | null = null
  if (kindRaw || slugRaw) {
    if (!isGuideKind(kindRaw) || !GUIDE_SLUG_PATTERN.test(slugRaw)) return { ok: false, error: 'Pick the page this link belongs to from the list (or leave it empty).' }
    guide_kind = kindRaw
    guide_slug = slugRaw
  }

  const imageRaw = String(raw.image_url ?? '').trim()
  let image_url: string | null = null
  if (imageRaw) {
    image_url = cleanHttpsUrl(imageRaw)
    if (!image_url) return { ok: false, error: 'The photo link must be a plain https:// web address with no user name or password.' }
  }

  const note = String(raw.note ?? '').replace(/\s+/g, ' ').trim()
  if (note.length > MAX_NOTE_LENGTH) return { ok: false, error: `The note is too long (${MAX_NOTE_LENGTH} characters at most).` }

  return { ok: true, value: { slug, url, merchant, title, status, sort_order, partner_id, guide_kind, guide_slug, image_url, note: note || null } }
}

/** The columns migration 0048 added to affiliate_links. */
export const NEW_LINK_KEYS = ['partner_id', 'guide_kind', 'guide_slug', 'image_url', 'note'] as const

/** True when a database error only means "migration 0048 is not applied" (missing column or table). */
export const isMissingMigration = (message: string | null | undefined): boolean =>
  !!message && /(partner_id|guide_kind|guide_slug|image_url|\bnote\b|guide_key|affiliate_partners)/i.test(message) && /column|schema cache|does not exist|relation|could not find/i.test(message)

/** True when the form actually set one of the new fields. */
export const setsNewFields = (v: AffiliateLinkInput): boolean => NEW_LINK_KEYS.some((k) => v[k] != null)

/** The input without the 0048 columns, for a database that does not have them yet. */
export function withoutNewFields(v: AffiliateLinkInput): Omit<AffiliateLinkInput, (typeof NEW_LINK_KEYS)[number]> {
  const { partner_id: _a, guide_kind: _b, guide_slug: _c, image_url: _d, note: _e, ...old } = v
  void [_a, _b, _c, _d, _e]
  return old
}

export const MIGRATION_0048_MESSAGE = 'Run migration 0048 first (supabase/migrations/0048_things_to_do.sql in the Supabase SQL editor), then save again.'

export const LINK_COLUMNS_OLD = 'id, slug, status, url, merchant, title, sort_order, created_at, updated_at'
export const LINK_COLUMNS = `${LINK_COLUMNS_OLD}, partner_id, guide_kind, guide_slug, image_url, note`

export type SaveLinkResult = { ok: true; data: Record<string, unknown> } | { ok: false; status: number; error: string }

/** Inserts (no id) or updates (id) one card. Before migration 0048 a write that sets none of the new fields still
 * works (retried without them); one that sets a new field is refused with a clear 409 instead of dropping it. */
export async function saveLink(admin: SupabaseClient, value: AffiliateLinkInput, id?: string): Promise<SaveLinkResult> {
  const attempt = async (payload: Record<string, unknown>, columns: string) => {
    const q = id ? admin.from('affiliate_links').update({ ...payload, updated_at: new Date().toISOString() }).eq('id', id) : admin.from('affiliate_links').insert(payload)
    return q.select(columns).single()
  }
  const first = await attempt(value as unknown as Record<string, unknown>, LINK_COLUMNS)
  if (!first.error) return { ok: true, data: first.data as unknown as Record<string, unknown> }
  if (!isMissingMigration(first.error.message)) return { ok: false, status: 500, error: first.error.message }
  if (setsNewFields(value)) return { ok: false, status: 409, error: MIGRATION_0048_MESSAGE }
  const second = await attempt(withoutNewFields(value) as unknown as Record<string, unknown>, LINK_COLUMNS_OLD)
  if (second.error) return { ok: false, status: 500, error: second.error.message }
  return { ok: true, data: second.data as unknown as Record<string, unknown> }
}

export interface AffiliateClickCounts {
  total: number
  last7: number
  last30: number
}

const ZERO_COUNTS: AffiliateClickCounts = { total: 0, last7: 0, last30: 0 }

/** Folds raw `affiliate_clicks` rows into per-link total/last-7-day/last-30-day counts. Pure, so
 * it's covered by a real assertion instead of a database round trip. */
export function summarizeClicksByLink(
  clicks: { link_id: string | null; created_at: string }[],
  now: number = Date.now(),
): Record<string, AffiliateClickCounts> {
  const cutoff7 = now - 7 * 24 * 60 * 60 * 1000
  const cutoff30 = now - 30 * 24 * 60 * 60 * 1000
  const out: Record<string, AffiliateClickCounts> = {}
  for (const c of clicks) {
    if (!c.link_id) continue
    const bucket = out[c.link_id] ?? (out[c.link_id] = { total: 0, last7: 0, last30: 0 })
    bucket.total += 1
    const at = new Date(c.created_at).getTime()
    if (at >= cutoff30) bucket.last30 += 1
    if (at >= cutoff7) bucket.last7 += 1
  }
  return out
}

export const clicksFor = (counts: Record<string, AffiliateClickCounts>, linkId: string): AffiliateClickCounts =>
  counts[linkId] ?? ZERO_COUNTS
