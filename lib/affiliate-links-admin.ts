import { isValidSlug, isRealLink, slugify } from '@/lib/affiliate-go'

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
}): AffiliateLinkValidation {
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

  return { ok: true, value: { slug, url, merchant, title, status, sort_order } }
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
