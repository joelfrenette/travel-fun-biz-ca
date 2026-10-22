import type { SupabaseClient } from '@supabase/supabase-js'
import { getSetting, setSetting } from '@/lib/app-settings'
import { isAutomationPaused } from '@/lib/automation-kill-switch'
import { AUTO_HOLD_PREFIX, CAPTION_FAILED_PREFIX, guideCaptionProblems } from '@/lib/guide-release'
import { loadGuidePostSource, packageDistributionSlug, packageSlugFromPath } from '@/lib/guide-post-source'
import { isPastTrip } from '@/lib/past-trip'
import { enrolPackagePost, PACKAGE_ENROLMENTS_PER_DAY, PROMOTION_GAP_DAYS } from '@/lib/promotion'

// Automatic social posts for published trips. Off unless app_settings.trip_social_posts is exactly 'true'.
// Nothing new is sent here: this only decides WHICH trip gets one ledger row (the same row, captions, hook rotation,
// UTM tags and send code as "Promote this package"; enrolPackagePost does the 30-day and per-day checks), and later lets
// that row go after TRIP_HOLD_HOURS. It runs inside the existing posting pass (lib/distribution.ts), no new cron.
//
// Rules, all of them fail closed:
//  - a trip with no price or no dates is never enrolled and never released (nothing is invented to fill the gap);
//  - one post per trip per PROMOTION_GAP_DAYS (30), one trip enrolment per UTC day (shared with manual promotion),
//    and at most TRIP_ENROLMENTS_PER_WEEK across a rolling 7 days;
//  - the row waits TRIP_HOLD_HOURS ("Auto-hold" note) and is released by itself only in auto mode when the trip is
//    still live, still has price and dates, and the caption text passes the same checks as guide posts;
//  - prepare mode enrols the row held with no note, so only a human approval releases it.
// The only phone number on the site is site.phone; no caption path here reads or adds a phone number.

export const TRIP_SOCIAL_KEY = 'trip_social_posts'
export const TRIP_HOLD_HOURS = 24
export const TRIP_ENROLMENTS_PER_WEEK = 2
/** At most this many trip posts are released (or already queued or sent) per UTC day. */
export const TRIP_RELEASES_PER_DAY = 1

export const TRIP_HOLD_NOTE = `${AUTO_HOLD_PREFIX} this trip post waits ${TRIP_HOLD_HOURS} hours, then posts by itself if the trip still has a price and dates and its caption passes the checks.`

/** Only the exact text 'true' turns it on. Anything else, including unset, is off. */
export function parseTripSocial(raw: string | null | undefined): boolean {
  return raw === 'true'
}

export async function getTripSocialEnabled(admin: SupabaseClient): Promise<boolean> {
  return parseTripSocial(await getSetting(admin, TRIP_SOCIAL_KEY))
}

export async function setTripSocialEnabled(admin: SupabaseClient, on: boolean): Promise<{ error?: string }> {
  return setSetting(admin, TRIP_SOCIAL_KEY, on ? 'true' : 'false')
}

/** The stored trip fields the checks read. */
export interface TripSocialPackage {
  id?: string
  slug: string
  name: string
  status: string
  price_display?: string | null
  price_value?: number | null
  available_from?: string | null
  available_to?: string | null
  departure_dates?: string[] | null
  recap_mode?: string | null
  created_at?: string | null
  short_description?: string | null
  meta_description?: string | null
}

/** True when the trip states a real price: a positive number, or text that holds a digit ("From $2,499"). "Price on
 * request" alone does not count. */
export function hasTripPrice(pkg: Pick<TripSocialPackage, 'price_display' | 'price_value'>): boolean {
  if (typeof pkg.price_value === 'number' && Number.isFinite(pkg.price_value) && pkg.price_value > 0) return true
  return typeof pkg.price_display === 'string' && /\d/.test(pkg.price_display)
}

export function hasTripDates(pkg: Pick<TripSocialPackage, 'available_from' | 'available_to' | 'departure_dates'>): boolean {
  if (pkg.available_from || pkg.available_to) return true
  return (pkg.departure_dates ?? []).some((d) => typeof d === 'string' && d.trim().length > 0)
}

/** Why this trip may not be posted, in plain words. Empty means it may. Pure. */
export function tripBlockers(pkg: TripSocialPackage, today?: string): string[] {
  const out: string[] = []
  if (pkg.status !== 'published') out.push('the trip is not published')
  if (isPastTrip({ available_to: pkg.available_to ?? null, recap_mode: pkg.recap_mode ?? null }, today)) out.push('the trip has already happened')
  if (!hasTripPrice(pkg)) out.push('the trip has no price')
  if (!hasTripDates(pkg)) out.push('the trip has no dates')
  return out
}

export interface TripLedgerRow {
  slug: string
  stage: string
  created_at: string
}

/** The trip to enrol next, or null. Pure. Eligible: no blockers, and no ledger row yet, or a finished (done) row older than
 * the 30-day gap. A trip that never had a post comes before one that did; then the older ledger row, then the older trip,
 * then slug, so the pick is stable. */
export function pickTripToPost(trips: readonly TripSocialPackage[], ledger: readonly TripLedgerRow[], now: Date = new Date()): TripSocialPackage | null {
  const bySlug = new Map(ledger.map((r) => [r.slug, r]))
  const today = now.toISOString().slice(0, 10)
  const gapMs = PROMOTION_GAP_DAYS * 86_400_000
  const eligible = trips.filter((t) => {
    if (tripBlockers(t, today).length) return false
    const row = bySlug.get(packageDistributionSlug(t.slug))
    if (!row) return true
    return row.stage === 'done' && now.getTime() - Date.parse(row.created_at) >= gapMs
  })
  if (!eligible.length) return null
  const lastPosted = (t: TripSocialPackage) => {
    const row = bySlug.get(packageDistributionSlug(t.slug))
    return row ? Date.parse(row.created_at) : -1
  }
  const made = (t: TripSocialPackage) => {
    const n = t.created_at ? Date.parse(t.created_at) : NaN
    return Number.isNaN(n) ? Number.MAX_SAFE_INTEGER : n
  }
  return [...eligible].sort((a, b) => lastPosted(a) - lastPosted(b) || made(a) - made(b) || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))[0]
}

/** True when a held row is one this file may release by itself: it carries the Auto-hold note (or a failed-check note from an
 * earlier pass) and has waited the full hold. A row held by hand (manual promotion, prepare mode) never has the note. Pure. */
export function isReleasableTripRow(row: { last_error: string | null; created_at: string }, now: Date = new Date()): boolean {
  const noted = !!row.last_error && (row.last_error.startsWith(AUTO_HOLD_PREFIX) || row.last_error.startsWith(CAPTION_FAILED_PREFIX))
  return noted && now.getTime() - Date.parse(row.created_at) >= TRIP_HOLD_HOURS * 3_600_000
}

/** One enrolment try, called from the posting pass. Does nothing (returns '') when the setting is not 'true', posting is off or
 * paused, a cap is used or unreadable, or no trip qualifies. Never throws. Returns a short note for the run log. */
export async function runTripSocialEnrol(admin: SupabaseClient, mode: string, now: Date = new Date()): Promise<string> {
  try {
    if (!(await getTripSocialEnabled(admin))) return ''
    if (mode !== 'prepare' && mode !== 'auto') return ''
    if (await isAutomationPaused(admin)) return ''

    const weekAgo = new Date(now.getTime() - 7 * 86_400_000).toISOString()
    const { count, error: countError } = await admin.from('post_distribution').select('slug', { count: 'exact', head: true }).like('slug', 'package-%').not('path', 'is', null).gte('created_at', weekAgo)
    if (countError || count === null || count >= TRIP_ENROLMENTS_PER_WEEK) return ''

    const { data: ledger, error: ledgerError } = await admin.from('post_distribution').select('slug, stage, created_at').like('slug', 'package-%').not('path', 'is', null)
    if (ledgerError) return ''
    const { data: trips, error: tripsError } = await admin.from('travel_packages').select('*').eq('status', 'published')
    if (tripsError) return ''
    const pick = pickTripToPost((trips ?? []) as TripSocialPackage[], (ledger ?? []) as TripLedgerRow[], now)
    if (!pick) return ''

    // enrolPackagePost holds the per-trip 30-day rule and the per-day limit; the hold note makes the row wait in auto mode.
    const result = await enrolPackagePost(admin, { slug: pick.slug, name: pick.name, status: pick.status, available_to: pick.available_to ?? null, recap_mode: pick.recap_mode ?? null }, now, TRIP_HOLD_NOTE)
    return result.state === 'held' || result.state === 'queued' ? `trip post enrolled ${result.slug}` : ''
  } catch (e) {
    console.error('[trip-social] enrol failed:', e instanceof Error ? e.message : e)
    return ''
  }
}

/** Why a held trip row may not go yet (blockers plus caption problems), or [] when it may. Pure apart from its inputs. */
export function tripReleaseProblems(trip: TripSocialPackage | null, src: Parameters<typeof guideCaptionProblems>[0] | null, today?: string): string[] {
  if (!trip || !src) return ['the trip is no longer live']
  return [...tripBlockers(trip, today), ...guideCaptionProblems(src)]
}

export interface TripReleaseResult {
  released: number
  stillHeld: number
  note: string
}

/** Releases held trip rows that waited TRIP_HOLD_HOURS and still pass every check, in auto mode only, at most
 * TRIP_RELEASES_PER_DAY per UTC day. Moves held to queued; the normal send code does the rest. Never throws. */
export async function releaseHeldTrips(admin: SupabaseClient, opts: { mode: string; now?: Date }): Promise<TripReleaseResult> {
  const none = (note: string): TripReleaseResult => ({ released: 0, stillHeld: 0, note })
  try {
    if (opts.mode !== 'auto') return none('')
    if (!(await getTripSocialEnabled(admin))) return none('')
    const now = opts.now ?? new Date()
    const { data, error } = await admin
      .from('post_distribution')
      .select('slug, path, created_at, last_error')
      .eq('content_type', 'post')
      .eq('stage', 'held')
      .not('path', 'is', null)
      .like('slug', 'package-%')
      .order('created_at', { ascending: true })
      .limit(10)
    if (error) return none('')
    const rows = ((data ?? []) as { slug: string; path: string; created_at: string; last_error: string | null }[]).filter((r) => isReleasableTripRow(r, now))
    if (!rows.length) return none('')

    const dayStart = `${now.toISOString().slice(0, 10)}T00:00:00.000Z`
    const { count, error: countError } = await admin.from('post_distribution').select('slug', { count: 'exact', head: true }).like('slug', 'package-%').not('path', 'is', null).in('stage', ['queued', 'done']).gte('updated_at', dayStart)
    if (countError) return none('')
    let room = Math.max(0, Math.min(TRIP_RELEASES_PER_DAY, PACKAGE_ENROLMENTS_PER_DAY) - (count ?? 0))

    let released = 0
    let stillHeld = 0
    for (const row of rows) {
      const tripSlug = packageSlugFromPath(row.path)
      if (!tripSlug) continue
      let trip: TripSocialPackage | null = null
      let src: Awaited<ReturnType<typeof loadGuidePostSource>> = null
      try {
        const { data: t, error: tErr } = await admin.from('travel_packages').select('*').eq('slug', tripSlug).maybeSingle()
        if (tErr) continue
        trip = (t as TripSocialPackage | null) ?? null
        src = await loadGuidePostSource(admin, row.path)
      } catch {
        continue
      }
      const problems = tripReleaseProblems(trip, src, now.toISOString().slice(0, 10))
      if (problems.length === 0) {
        if (room <= 0) continue
        const { data: moved, error: moveError } = await admin.from('post_distribution').update({ stage: 'queued', last_error: null, updated_at: now.toISOString() }).eq('content_type', 'post').eq('slug', row.slug).eq('stage', 'held').select('slug')
        if (!moveError && moved?.length) {
          released++
          room--
        }
        continue
      }
      stillHeld++
      const note = `${CAPTION_FAILED_PREFIX} ${problems.join('; ')}`.slice(0, 300)
      if (row.last_error !== note) await admin.from('post_distribution').update({ last_error: note, updated_at: now.toISOString() }).eq('content_type', 'post').eq('slug', row.slug).eq('stage', 'held')
    }
    return { released, stillHeld, note: `${released} trip post${released === 1 ? '' : 's'} released, ${stillHeld} held for a check` }
  } catch (e) {
    return none(`trip release failed: ${e instanceof Error ? e.message : 'unknown error'}`)
  }
}
