// Pure helpers for the "Posts: Guides" and "Posts: Trips" admin pages (posts menu phase 2). No database, no React,
// no server-only imports, so the browser, the API routes and the offline check all share the same rules.

/** The on/off switches the Automation cards can flip (guide catch-up, trip social posts, news social posts). Only these keys are accepted. */
export const TOGGLE_KEYS = ['guide_catchup_posts', 'trip_social_posts', 'news_social_posts'] as const
export type ToggleKey = (typeof TOGGLE_KEYS)[number]

/** Only the exact text 'true' means on. Unset, 'TRUE', 'on', '1' and everything else mean off. Same rule the pipeline uses. */
export function isExactTrue(raw: string | null | undefined): boolean {
  return raw === 'true'
}

/** Validates a toggle request body. The value must be a real boolean (not "true", not 1), and the key must be on the list. */
export function parseToggleRequest(body: unknown): { ok: true; key: ToggleKey; value: 'true' | 'false' } | { ok: false; error: string } {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const key = (TOGGLE_KEYS as readonly string[]).includes(b.setting as string) ? (b.setting as ToggleKey) : null
  if (!key) return { ok: false, error: `setting must be one of: ${TOGGLE_KEYS.join(', ')}` }
  if (typeof b.enabled !== 'boolean') return { ok: false, error: 'enabled must be true or false' }
  return { ok: true, key, value: b.enabled ? 'true' : 'false' }
}

// ---------------------------------------------------------------------------------------------------
// The "do not recreate" list (app_settings key guide_excluded): a JSON array of 'kind:slug'
// ---------------------------------------------------------------------------------------------------

export const GUIDE_EXCLUDED_KEY = 'guide_excluded'
const EXCLUDE_KEY = /^[a-z0-9-]+:[a-z0-9-]+$/

export function guideExcludeKey(kind: string, slug: string): string {
  return `${kind}:${slug}`
}

/** The stored list as clean strings. Bad JSON or a non-array reads as empty (the same way listGuideCandidates reads it). */
export function parseExcludedList(raw: string | null | undefined): string[] {
  try {
    const v = raw ? JSON.parse(raw) : []
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/** The new stored value with `kind:slug` added once. Keeps every existing entry (even ones this code would not write),
 * and refuses a key that is not 'kind:slug' so nothing odd can end up in the list. */
export function addExcluded(raw: string | null | undefined, kind: string, slug: string): { ok: true; value: string; added: boolean } | { ok: false; error: string } {
  const key = guideExcludeKey(kind, slug)
  if (!EXCLUDE_KEY.test(key)) return { ok: false, error: 'That guide has no usable kind and slug to exclude.' }
  const list = parseExcludedList(raw)
  if (list.includes(key)) return { ok: true, value: JSON.stringify(list), added: false }
  return { ok: true, value: JSON.stringify([...list, key]), added: true }
}

// ---------------------------------------------------------------------------------------------------
// Guides: the guessed-name rule
// ---------------------------------------------------------------------------------------------------

/** A guide whose name was taken from a trip title carries this wording in its quality notes (lib/guide-run.ts GUESSED_PROPERTY_NOTE). */
export function hasGuessedNameNote(note: string | null | undefined): boolean {
  return !!note && /taken from a trip title/.test(note)
}

export const GUESSED_PUBLISH_MESSAGE = 'This page names a business that was guessed from a trip title, so it cannot be published from the admin. Check the name is a real property first; until then it stays a draft.'

/** Why a guide may not be published from the admin, or null when it may. Unpublishing is never blocked. */
export function guidePublishBlock(g: { status: string; quality_notes: string | null | undefined }): string | null {
  if (g.status === 'published') return null
  return hasGuessedNameNote(g.quality_notes) ? GUESSED_PUBLISH_MESSAGE : null
}

/** The "special" filter on the Guides list. */
export const GUIDE_FLAGS = ['', 'safe', 'held', 'guessed'] as const
export type GuideFlag = (typeof GUIDE_FLAGS)[number]

export function parseGuideFlag(raw: string | null | undefined): GuideFlag {
  return (GUIDE_FLAGS as readonly string[]).includes(raw ?? '') ? ((raw ?? '') as GuideFlag) : ''
}

const MODE_HOLD = 'held for review (guides_publish_mode=draft)'

export function isSafePageText(note: string | null | undefined): boolean {
  return typeof note === 'string' && note.trim().startsWith('safe-page:')
}

/** Held = a draft with a quality note that is not just the "site is in review mode" note. */
export function isHeldGuide(g: { status: string; quality_notes: string | null | undefined }): boolean {
  const n = (g.quality_notes ?? '').trim()
  return g.status === 'draft' && n !== '' && n !== MODE_HOLD && !isSafePageText(n)
}

export function matchesGuideFlag(g: { status: string; quality_notes: string | null | undefined }, flag: GuideFlag): boolean {
  if (!flag) return true
  if (flag === 'safe') return g.status === 'published' && isSafePageText(g.quality_notes)
  if (flag === 'held') return isHeldGuide(g)
  return hasGuessedNameNote(g.quality_notes)
}

export interface GuideTotals {
  total: number
  live: number
  drafts: number
  review: number
  rejected: number
  held: number
  safe: number
}

/** Header counts over EVERY guide (not the filtered list). `review` and `rejected` follow lib/guide-list.ts. */
export function guideTotals(rows: { status: string; source: string; review_state: string | null | undefined; quality_notes: string | null | undefined }[]): GuideTotals {
  const t: GuideTotals = { total: rows.length, live: 0, drafts: 0, review: 0, rejected: 0, held: 0, safe: 0 }
  for (const r of rows) {
    if (r.status === 'published') {
      t.live++
      if (isSafePageText(r.quality_notes)) t.safe++
      continue
    }
    t.drafts++
    if (r.review_state === 'rejected') t.rejected++
    else if (r.source === 'ai') t.review++
    if (isHeldGuide(r)) t.held++
  }
  return t
}

// ---------------------------------------------------------------------------------------------------
// Trips: filters the Trips page adds (search, status and category already exist on the page)
// ---------------------------------------------------------------------------------------------------

export interface TripFilterInput {
  supplier: string
  country: string
  /** YYYY-MM-DD; keeps trips that start on or after it. */
  from: string
  /** YYYY-MM-DD; keeps trips that start on or before it. */
  to: string
}

export const EMPTY_TRIP_FILTER: TripFilterInput = { supplier: '', country: '', from: '', to: '' }

interface TripLike {
  supplier?: string | null
  country?: string | null
  available_from?: string | null
}

const same = (a: string | null | undefined, b: string) => (a ?? '').trim().toLowerCase() === b.trim().toLowerCase()

/** Keeps trips matching the supplier, country and start-date filters. A date filter drops trips with no start date, so
 * "starts after" never silently includes a trip with no date. Blank filters keep everything. Pure. */
export function filterTripsExtra<T extends TripLike>(rows: T[], f: TripFilterInput): T[] {
  return rows.filter((r) => {
    if (f.supplier && !same(r.supplier, f.supplier)) return false
    if (f.country && !same(r.country, f.country)) return false
    if (f.from && (!r.available_from || r.available_from.slice(0, 10) < f.from)) return false
    if (f.to && (!r.available_from || r.available_from.slice(0, 10) > f.to)) return false
    return true
  })
}

/** The distinct non-blank values of a field, A to Z, with one spelling per case-insensitive match. */
export function distinctTripValues<T extends TripLike>(rows: T[], field: 'supplier' | 'country'): string[] {
  const seen = new Map<string, string>()
  for (const r of rows) {
    const v = (r[field] ?? '').trim()
    if (v && !seen.has(v.toLowerCase())) seen.set(v.toLowerCase(), v)
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b))
}

export interface TripTotals {
  total: number
  published: number
  drafts: number
  archived: number
  past: number
}

/** Header counts for the Trips page. `past` counts trips whose end date has passed (the shared rule is isPastTrip; the
 * page passes that in so this file stays free of imports). */
export function tripTotals(rows: { status: string }[], isPast: (r: { status: string }) => boolean = () => false): TripTotals {
  const t: TripTotals = { total: rows.length, published: 0, drafts: 0, archived: 0, past: 0 }
  for (const r of rows) {
    if (r.status === 'published') t.published++
    else if (r.status === 'archived') t.archived++
    else t.drafts++
    if (isPast(r)) t.past++
  }
  return t
}
