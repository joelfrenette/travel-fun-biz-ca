import { isValidSlug, slugify } from '@/lib/affiliate-go'

// WP21: affiliate partners for the "Fun things to do in <place>" block. Pure functions only (no
// database, no network), so every rule below is covered by scripts/check-things-to-do.ts.
//
// A partner stores a SEARCH TEMPLATE: an https link with two optional placeholders,
//   {query}       the place name (the guide's name), URL-encoded when filled in
//   {partner_id}  our ID with that partner, URL-encoded when filled in
// The template is read on the server only. A visitor never sends a URL: /go/p/<partner>/<kind>/<slug>
// looks the template up by partner slug, fills it, and redirects only if the filled link still points
// at the template's own host. Nothing here knows any real partner's link format; those come from the
// partner's own dashboard, pasted by an admin.

export type PartnerStatus = 'draft' | 'active' | 'hidden'
const STATUSES: PartnerStatus[] = ['draft', 'active', 'hidden']

/** Shown near the block when a partner has no wording of its own. */
export const DEFAULT_DISCLOSURE = 'We may earn a commission if you book through our links, at no extra cost to you.'

/** Plain-English help under the template field in the admin. */
export const TEMPLATE_HELP = 'Paste the search link from your partner dashboard; use {query} where the place name goes and {partner_id} where your ID goes'

/** The only two placeholders a template may contain. */
export const ALLOWED_PLACEHOLDERS = ['{query}', '{partner_id}'] as const

export const MAX_TEMPLATE_LENGTH = 1000
export const MAX_QUERY_LENGTH = 120
export const MAX_NOTE_LENGTH = 200

export interface PartnerRow {
  id: string
  slug: string
  name: string
  logo_url: string | null
  partner_id: string | null
  search_template: string | null
  disclosure: string | null
  status: PartnerStatus
  sort_order: number
}

const HAS_CONTROL = /[\u0000- \u007f\\]/

/** A real host name: letters, digits and dashes in dot-separated labels, a letters-only last label, and not an IP address. */
export function isRealHost(host: string): boolean {
  if (!host || host.length > 253) return false
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return false
  const labels = host.split('.')
  if (labels.length < 2) return false
  if (!labels.every((l) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i.test(l))) return false
  return /^[a-z]{2,24}$/i.test(labels[labels.length - 1])
}

/** One https link with a real host, no credentials, no whitespace. Returns the normalized href, or null. */
export function cleanHttpsUrl(raw: unknown): string | null {
  const t = String(raw ?? '').trim()
  if (!t || t.length > 2000 || HAS_CONTROL.test(t)) return null
  if (!/^https:\/\//i.test(t)) return null
  try {
    const u = new URL(t)
    if (u.protocol !== 'https:') return null
    if (u.username || u.password) return null
    if (!isRealHost(u.hostname)) return null
    return u.href
  } catch {
    return null
  }
}

const PLACEHOLDER_STAND_IN = 'x'

export type TemplateCheck = { ok: true; template: string; host: string; usesPartnerId: boolean } | { ok: false; error: string }

/** Is this a safe search template? https only, a real host that contains no placeholder, no credentials,
 * only the two allowed placeholders, and {query} present. Never throws. */
export function validateSearchTemplate(raw: unknown): TemplateCheck {
  const t = String(raw ?? '').trim()
  if (!t) return { ok: false, error: 'A search link is required.' }
  if (t.length > MAX_TEMPLATE_LENGTH) return { ok: false, error: `The search link is too long (the limit is ${MAX_TEMPLATE_LENGTH} characters).` }
  if (HAS_CONTROL.test(t)) return { ok: false, error: 'The search link must not contain spaces, line breaks or backslashes.' }
  if (!/^https:\/\//i.test(t)) return { ok: false, error: 'The search link must start with https://' }

  // Every { or } must belong to one of the two allowed placeholders.
  const stripped = t.split('{query}').join('').split('{partner_id}').join('')
  if (/[{}]/.test(stripped)) return { ok: false, error: 'Only {query} and {partner_id} are allowed in curly brackets.' }
  if (!t.includes('{query}')) return { ok: false, error: 'The search link needs {query} where the place name goes.' }

  // Placeholders may not sit in the host part: the host must be fixed text so it can be pinned.
  const authority = t.slice('https://'.length).split(/[/?#]/)[0]
  if (/[{}]/.test(authority)) return { ok: false, error: 'The web address part (before the first /) cannot contain a placeholder.' }
  if (authority.includes('@')) return { ok: false, error: 'The search link must not contain a user name or password.' }

  const probe = t.split('{query}').join(PLACEHOLDER_STAND_IN).split('{partner_id}').join(PLACEHOLDER_STAND_IN)
  let u: URL
  try {
    u = new URL(probe)
  } catch {
    return { ok: false, error: 'That does not look like a working web link.' }
  }
  if (u.protocol !== 'https:') return { ok: false, error: 'The search link must start with https://' }
  if (u.username || u.password) return { ok: false, error: 'The search link must not contain a user name or password.' }
  if (!isRealHost(u.hostname)) return { ok: false, error: 'The web address in the search link does not look like a real website.' }
  return { ok: true, template: t, host: u.host, usesPartnerId: t.includes('{partner_id}') }
}

export type FillResult = { ok: true; url: string } | { ok: false; error: string }

/** Fills a stored template for one place. The values are URL-encoded; the filled link is re-checked and must
 * still be https, credential-free and on exactly the template's host, or nothing is returned. */
export function fillSearchTemplate(template: string, query: string, partnerId: string | null | undefined): FillResult {
  const check = validateSearchTemplate(template)
  if (!check.ok) return { ok: false, error: check.error }
  const q = String(query ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY_LENGTH)
  if (!q) return { ok: false, error: 'No place name to search for.' }
  const pid = String(partnerId ?? '').trim()
  if (check.usesPartnerId && !pid) return { ok: false, error: 'This partner needs a partner ID.' }
  const filled = check.template.split('{query}').join(encodeURIComponent(q)).split('{partner_id}').join(encodeURIComponent(pid))
  let u: URL
  try {
    u = new URL(filled)
  } catch {
    return { ok: false, error: 'The filled link is not a working web link.' }
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.host !== check.host) return { ok: false, error: 'The filled link does not stay on the partner website.' }
  return { ok: true, url: u.href }
}

// ---------- admin input ----------

export interface PartnerInput {
  slug: string
  name: string
  logo_url: string | null
  partner_id: string | null
  search_template: string | null
  disclosure: string | null
  status: PartnerStatus
  sort_order: number
}

export type PartnerValidation = { ok: true; value: PartnerInput } | { ok: false; error: string }

/** Validates and normalizes one partner submitted from the admin. Never throws. */
export function normalizePartnerInput(raw: Record<string, unknown>): PartnerValidation {
  const name = String(raw.name ?? '').trim()
  if (!name) return { ok: false, error: 'A partner name is required.' }
  if (name.length > 80) return { ok: false, error: 'The partner name is too long (80 characters at most).' }

  const rawSlug = String(raw.slug ?? '').trim().toLowerCase()
  const slug = rawSlug || slugify(name)
  if (!isValidSlug(slug)) return { ok: false, error: 'Slug must be lowercase letters, digits and dashes, 2-41 characters.' }

  const logoRaw = String(raw.logo_url ?? '').trim()
  let logo_url: string | null = null
  if (logoRaw) {
    logo_url = cleanHttpsUrl(logoRaw)
    if (!logo_url) return { ok: false, error: 'The logo link must be a plain https:// web address with no user name or password.' }
  }

  const partnerIdRaw = String(raw.partner_id ?? '').trim()
  if (partnerIdRaw && (partnerIdRaw.length > 100 || HAS_CONTROL.test(partnerIdRaw))) return { ok: false, error: 'The partner ID must be one short piece of text with no spaces.' }
  const partner_id = partnerIdRaw || null

  const templateRaw = String(raw.search_template ?? '').trim()
  let search_template: string | null = null
  if (templateRaw) {
    const check = validateSearchTemplate(templateRaw)
    if (!check.ok) return { ok: false, error: check.error }
    if (check.usesPartnerId && !partner_id) return { ok: false, error: 'The search link uses {partner_id}, so fill in the partner ID too.' }
    search_template = check.template
  }

  const disclosureRaw = String(raw.disclosure ?? '').trim()
  if (disclosureRaw.length > 300) return { ok: false, error: 'The commission wording is too long (300 characters at most).' }
  const disclosure = disclosureRaw || null

  const status = STATUSES.includes(raw.status as PartnerStatus) ? (raw.status as PartnerStatus) : 'draft'
  // An active partner without a search link is allowed (curated cards only), so that is not an error.
  const sortNum = Number(raw.sort_order)
  const sort_order = Number.isFinite(sortNum) ? Math.trunc(sortNum) : 0

  return { ok: true, value: { slug, name, logo_url, partner_id, search_template, disclosure, status, sort_order } }
}

/** A partner's slug is part of every /go/p link already on pages and in emails, so it is fixed after creation. */
export function lockedPartnerSlug(currentSlug: string, requested: unknown): { ok: true; slug: string } | { ok: false; error: string } {
  const asked = String(requested ?? '').trim().toLowerCase()
  if (asked && asked !== currentSlug) return { ok: false, error: 'The short name of a partner cannot be changed after it is created, because existing page links use it. Leave it as it is, or create a new partner.' }
  return { ok: true, slug: currentSlug }
}

/** True when a database error only means the partners table is not there yet (migration 0048 not applied). */
export const isMissingPartnersTable = (message: string | null | undefined): boolean =>
  !!message && /affiliate_partners/i.test(message) && /does not exist|schema cache|could not find|relation/i.test(message)

export const PARTNERS_MIGRATION_MESSAGE = 'Run migration 0048 first (supabase/migrations/0048_things_to_do.sql in the Supabase SQL editor), then save again.'

// ---------- click counts ----------

export interface ClickCounts {
  total: number
  last7: number
  last30: number
}

export interface PartnerClickRow {
  partner_id: string | null
  guide_key: string | null
  created_at: string
}

const EMPTY: ClickCounts = { total: 0, last7: 0, last30: 0 }

/** Partner search clicks folded into per-partner and per-page total / last 7 / last 30 day counts. Pure. */
export function summarizePartnerClicks(rows: PartnerClickRow[], now: number = Date.now()): { byPartner: Record<string, ClickCounts>; byPage: Record<string, ClickCounts>; all: ClickCounts } {
  const c7 = now - 7 * 86_400_000
  const c30 = now - 30 * 86_400_000
  const byPartner: Record<string, ClickCounts> = {}
  const byPage: Record<string, ClickCounts> = {}
  const all: ClickCounts = { total: 0, last7: 0, last30: 0 }
  const bump = (b: ClickCounts, at: number) => {
    b.total += 1
    if (at >= c30) b.last30 += 1
    if (at >= c7) b.last7 += 1
  }
  for (const r of rows) {
    if (!r.partner_id) continue
    const at = new Date(r.created_at).getTime()
    bump(all, at)
    bump(byPartner[r.partner_id] ?? (byPartner[r.partner_id] = { total: 0, last7: 0, last30: 0 }), at)
    if (r.guide_key) bump(byPage[r.guide_key] ?? (byPage[r.guide_key] = { total: 0, last7: 0, last30: 0 }), at)
  }
  return { byPartner, byPage, all }
}

export const countsFor = (m: Record<string, ClickCounts>, key: string): ClickCounts => m[key] ?? EMPTY

/** "destinations/croatia": how a page is named in the click ledger. */
export const guideKey = (kind: string, slug: string) => `${kind}/${slug}`

/** The loose rule for a guide slug in the /go/p URL (guide slugs can be longer than a short link slug). */
export const GUIDE_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,119}$/

/** Site-relative automatic search link for one partner on one page: "/go/p/<partner>/<kind>/<slug>". */
export const partnerGoPath = (partnerSlug: string, kind: string, slug: string) =>
  `/go/p/${encodeURIComponent(partnerSlug)}/${encodeURIComponent(kind)}/${encodeURIComponent(slug)}`
