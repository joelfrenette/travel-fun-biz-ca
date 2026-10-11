import type { SupabaseClient } from '@supabase/supabase-js'

// ONE definition of "this trip is a past trip" (growth loop WP14). The trip page, the destination page, the
// share image, content drift and the supplier-page watch all ask here, so a trip never disagrees with itself.
//
// The rule behind it, in Joel's words: we do NOT unpublish past trips. A page promoted for months keeps its
// URL, title and body; it changes its call to action and gains a recap. So nothing in this file (or in the code
// that uses it) ever suggests unpublishing a past trip. No imports from the app: pure, testable offline.

export type RecapMode = 'auto' | 'recap' | 'live'
export const RECAP_MODES: RecapMode[] = ['auto', 'recap', 'live']

export interface PastTripInput {
  available_to: string | null
  recap_mode?: string | null
}

export const todayYmd = (now: Date = new Date()): string => now.toISOString().slice(0, 10)

/** Anything unknown (a missing column before migration 0037, a typo) behaves as 'auto'. */
export function normaliseRecapMode(value: unknown): RecapMode {
  return value === 'recap' || value === 'live' ? value : 'auto'
}

/**
 * auto: the last date has passed. recap: forced on, whatever the dates say. live: forced off, so a trip that is
 * run again, or whose dates were left behind, keeps its bookable layout.
 */
export function isPastTrip(pkg: PastTripInput, today: string = todayYmd()): boolean {
  const mode = normaliseRecapMode(pkg.recap_mode)
  if (mode === 'recap') return true
  if (mode === 'live') return false
  return !!pkg.available_to && pkg.available_to < today
}

export const hasRecap = (pkg: { recap_summary?: string | null }): boolean => !!pkg.recap_summary && pkg.recap_summary.trim().length > 0

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

function monthYear(ymd: string | null | undefined): { month: string; year: string } | null {
  const m = /^(\d{4})-(\d{2})/.exec(ymd ?? '')
  if (!m) return null
  const idx = Number(m[2]) - 1
  return idx >= 0 && idx < 12 ? { month: MONTHS[idx], year: m[1] } : null
}

/** "May 2026", "May to June 2026" or "December 2026 to January 2027": for the line "This trip happened ...".
 * Null when the trip has no usable date (the line is then left out, never guessed). */
export function happenedLabel(from: string | null | undefined, to: string | null | undefined): string | null {
  const a = monthYear(from) ?? monthYear(to)
  const b = monthYear(to) ?? a
  if (!a || !b) return null
  if (a.month === b.month && a.year === b.year) return `${a.month} ${a.year}`
  if (a.year === b.year) return `${a.month} to ${b.month} ${a.year}`
  return `${a.month} ${a.year} to ${b.month} ${b.year}`
}

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

/** The GoHighLevel tag used when a trip has none of its own: alert:<category slug>. */
export function defaultAlertTag(category: string | null | undefined): string {
  return `alert:${slugify(category ?? '') || 'trips'}`
}

const ALERT_TAG_RE = /^[a-z0-9][a-z0-9:_-]{0,59}$/

/** A tag an admin typed, made safe, or null when it cannot be used. */
export function cleanAlertTag(raw: string | null | undefined): string | null {
  const t = (raw ?? '').trim().toLowerCase().replace(/\s+/g, '-')
  return ALERT_TAG_RE.test(t) ? t : null
}

/** The tag that is really used for a trip: its own, else the default for its category. */
export function effectiveAlertTag(pkg: { alert_tag?: string | null; category?: string | null }): string {
  return cleanAlertTag(pkg.alert_tag) ?? defaultAlertTag(pkg.category)
}

export interface PastTripNeedingRecap {
  id: string
  slug: string
  name: string
  available_to: string | null
  recap_mode: RecapMode
}

/**
 * Published past trips with no recap yet (and not forced back to live). Feeds the "needs a recap" item in
 * Needs attention and the brief line. Returns [] when the recap columns do not exist yet (migration 0037 not
 * applied), because then nothing can be done about it from the admin either.
 */
export async function pastTripsNeedingRecap(admin: SupabaseClient, today: string = todayYmd()): Promise<PastTripNeedingRecap[]> {
  const { data, error } = await admin.from('travel_packages').select('id, slug, name, available_to, recap_mode, recap_summary').eq('status', 'published')
  if (error) {
    if (/recap_mode|recap_summary|column|schema cache/i.test(error.message)) return []
    throw new Error(error.message)
  }
  return ((data ?? []) as { id: string; slug: string; name: string; available_to: string | null; recap_mode: string | null; recap_summary: string | null }[])
    .filter((p) => isPastTrip(p, today) && !hasRecap(p))
    .map((p) => ({ id: p.id, slug: p.slug, name: p.name, available_to: p.available_to, recap_mode: normaliseRecapMode(p.recap_mode) }))
}

/** Of these slugs, the ones that are past trips right now (published or not). Used to keep supplier-page
 * findings off trips that already happened. Unknown columns count as 'auto'. */
export async function pastTripSlugs(admin: SupabaseClient, slugs: string[], today: string = todayYmd()): Promise<Set<string>> {
  if (slugs.length === 0) return new Set()
  let res = await admin.from('travel_packages').select('slug, available_to, recap_mode').in('slug', slugs)
  if (res.error) res = (await admin.from('travel_packages').select('slug, available_to').in('slug', slugs)) as typeof res
  return new Set(((res.data ?? []) as { slug: string; available_to: string | null; recap_mode?: string | null }[]).filter((p) => isPastTrip(p, today)).map((p) => p.slug))
}
