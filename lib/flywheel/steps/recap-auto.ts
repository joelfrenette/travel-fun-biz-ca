import type { SupabaseClient } from '@supabase/supabase-js'
import { getSetting, setSetting } from '@/lib/app-settings'
import { composeRecap, NOTES_MIN_WORDS, notesWordCount, RECAP_NOTES_MIN, usableNotes, type ComposedRecap, type RecapNote, type RecapTrip } from '@/lib/recap-composer'
import type { Quote } from '@/lib/recap-studio'
import { hasRecap, isPastTrip, todayYmd } from '@/lib/past-trip'
import { approvedQuotesFrom, listSubmissions, readStudio } from '@/lib/recap-store'
import { isVetoed, logDecision, writeSetting } from '@/lib/flywheel/ctx'
import type { FlywheelContext, FlywheelResult, FlywheelStep } from '@/lib/flywheel/types'

// WP10: Recap and testimonial auto-draft after a trip ends (policy recap_auto). See docs/factory/AUTOPILOT-AUDIT.md (WP10).
//
// Once a PUBLISHED trip is in the past and its journal notes are enough, this writes the recap ONCE as a PRIVATE draft (the same
// `recap_draft:<id>` setting the trip's "Convert to Past Trip" card already shows) and turns each APPROVED, consented quote into a DRAFT
// testimonial row. It publishes nothing and messages nobody: a person still taps "Replace the live recap" (clean draft) or reads the held
// reasons (draft the gate stopped), and publishes a testimonial from /admin/testimonials. It never calls writeRecap (that one publishes
// a clean recap by itself), so there is no path from this file to a public page.
//
// Bounds: the policy cap (2 a day, one decision per trip), ONE model call per pass, only trips that ended in the last 365 days, only
// trips with at least RECAP_NOTES_MIN notes and NOTES_MIN_WORDS words (below that the gate would hold the recap anyway, so no credit is
// spent), each trip tried once (marker) and never again after an Undo, a person's veto, an existing draft or a live recap.

export const RECAP_AUTO_MAX_AGE_DAYS = 365
/** The pass needs this long left before it starts a model call (the call may take 60 s). */
export const RECAP_AUTO_MIN_CALL_MS = 70_000
/** At most this many trips are looked at per pass, newest ending first. */
export const RECAP_AUTO_LOOKAHEAD = 30
export const recapDraftSettingKey = (packageId: string): string => `recap_draft:${packageId}` // same key as lib/recap-run.ts recapDraftKey
export const recapAutoDoneKey = (packageId: string): string => `recap_auto_done:${packageId}`

interface TripRow {
  id: string
  slug: string
  name: string
  destination: string
  country: string | null
  category: string | null
  duration: string | null
  available_from: string | null
  available_to: string | null
  short_description: string | null
  full_description: string | null
  highlights: string[] | null
  recap_mode: string | null
  recap_summary: string | null
  journal_entries: RecapNote[] | null
}

const TRIP_COLUMNS = 'id, slug, name, destination, country, category, duration, available_from, available_to, short_description, full_description, highlights, recap_mode, recap_summary, journal_entries'

export interface RecapAutoDeps {
  compose?: (trip: RecapTrip, notes: RecapNote[]) => Promise<ComposedRecap>
}

const daysAgoYmd = (now: Date, days: number): string => new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10)
const normText = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim()

async function loadTrips(admin: SupabaseClient, now: Date): Promise<{ trips: TripRow[]; error?: string }> {
  const { data, error } = await admin.from('travel_packages').select(TRIP_COLUMNS).eq('status', 'published') // published trips only, never a draft trip
  if (error) return { trips: [], error: error.message }
  const today = todayYmd(now)
  const oldest = daysAgoYmd(now, RECAP_AUTO_MAX_AGE_DAYS)
  const trips = ((data ?? []) as TripRow[])
    .filter((t) => isPastTrip(t, today) && (!t.available_to || t.available_to >= oldest))
    .sort((a, b) => (b.available_to ?? '').localeCompare(a.available_to ?? ''))
    .slice(0, RECAP_AUTO_LOOKAHEAD)
  return { trips }
}

async function existingTestimonialTexts(admin: SupabaseClient, packageId: string): Promise<Set<string> | null> {
  const { data, error } = await admin.from('testimonials').select('text').eq('package_id', packageId)
  if (error) return null
  return new Set(((data ?? []) as { text: string }[]).map((r) => normText(r.text ?? '')))
}

/** Draft testimonials for approved quotes not already in the table (any status, so a deleted-then-regenerated loop cannot start from a
 * published one). Returns the new row ids. Throws on a database error so the trip is reported, not hidden. */
async function draftTestimonials(admin: SupabaseClient, trip: TripRow, quotes: Quote[]): Promise<string[]> {
  if (quotes.length === 0) return []
  const have = await existingTestimonialTexts(admin, trip.id)
  if (have === null) throw new Error('testimonials could not be read')
  const ids: string[] = []
  for (const q of quotes) {
    const text = q.text.trim()
    if (text.length < 12 || !q.name.trim() || have.has(normText(text))) continue
    // rating: the table needs a number and the traveller gave none, so it takes the table's own default (5). This is a DRAFT; the admin
    // sets the real rating (or drops the row) before publishing it.
    const { data, error } = await admin
      .from('testimonials')
      .insert({ author: q.name.trim(), location: null, trip_name: trip.name, package_id: trip.id, rating: 5, text, image_url: null, source: null, status: 'draft', featured: false, sort_order: 0 })
      .select('id')
      .single()
    if (error || !data) throw new Error(error?.message ?? 'a draft testimonial could not be saved')
    have.add(normText(text))
    ids.push((data as { id: string }).id)
  }
  return ids
}

/** The ref of one decision: trip id | draft time (or '-') | testimonial ids. No names, no text. */
const makeRef = (packageId: string, draftAt: string | null, testimonialIds: string[]): string => `${packageId}|${draftAt ?? '-'}|${testimonialIds.join(',')}`
export function parseRef(ref: string): { packageId: string; draftAt: string | null; testimonialIds: string[] } | null {
  const [packageId, at, ids] = ref.split('|')
  if (!packageId) return null
  return { packageId, draftAt: at && at !== '-' ? at : null, testimonialIds: ids ? ids.split(',').filter(Boolean) : [] }
}

/** The step body, with the model call injectable so scripts/check-recap-auto.ts runs it offline. */
export async function runRecapAuto(ctx: FlywheelContext, deps: RecapAutoDeps = {}): Promise<FlywheelResult> {
  if (ctx.dryRun) return { ran: false, reason: 'dry run' }
  if (ctx.room <= 0) return { ran: false, reason: 'the daily cap is used up' }
  const compose = deps.compose ?? composeRecap
  const { admin } = ctx

  const loaded = await loadTrips(admin, ctx.now)
  if (loaded.error) {
    if (/recap_mode|recap_summary|journal_entries|column|schema cache/i.test(loaded.error)) return { ran: false, reason: 'the recap columns are missing (migration 0037 is not applied)' }
    throw new Error(`could not read the trips: ${loaded.error}`)
  }

  let acted = 0
  let aiCalls = 0
  const notes: string[] = []
  const errors: string[] = []

  for (const trip of loaded.trips) {
    if (acted >= ctx.room) break
    if (ctx.remainingMs() < 5_000) break
    try {
      if (await isVetoed(admin, 'recap_auto', trip.slug)) continue

      // ---- 1. the private recap draft --------------------------------------------------------------------------------------
      let draftAt: string | null = null
      let draftState: 'clean' | 'held' | null = null
      const needsRecap = !hasRecap(trip)
      if (needsRecap && aiCalls < 1 && ctx.remainingMs() >= RECAP_AUTO_MIN_CALL_MS) {
        const done = await getSetting(admin, recapAutoDoneKey(trip.id))
        const existing = await getSetting(admin, recapDraftSettingKey(trip.id))
        const tripNotes = usableNotes(trip.journal_entries)
        const enough = tripNotes.length >= RECAP_NOTES_MIN && notesWordCount(tripNotes) >= NOTES_MIN_WORDS
        if (!done && !existing && enough) {
          aiCalls++
          const composed = await compose(trip, tripNotes)
          if (!composed.ok) {
            errors.push(`${trip.slug}: ${composed.error}`)
          } else {
            draftAt = ctx.now.toISOString()
            const draft = { summary: composed.recap.summary, highlights: composed.recap.highlights, blockers: composed.blockers, at: draftAt, ...(composed.blockers.length === 0 ? { readyToReplace: true } : {}) }
            const saved = await setSetting(admin, recapDraftSettingKey(trip.id), JSON.stringify(draft))
            if (saved.error) throw new Error(`the draft could not be saved: ${saved.error}`)
            await writeSetting(admin, recapAutoDoneKey(trip.id), draftAt)
            draftState = composed.blockers.length === 0 ? 'clean' : 'held'
          }
        }
      }

      // ---- 2. draft testimonials from APPROVED, consented quotes only ------------------------------------------------------------
      const studio = await readStudio(admin, trip.id)
      const subs = await listSubmissions(admin, trip.id)
      const quotes = approvedQuotesFrom(studio.quotes, subs)
      const testimonialIds = await draftTestimonials(admin, trip, quotes)

      if (!draftAt && testimonialIds.length === 0) continue
      const parts: string[] = []
      if (draftState === 'clean') parts.push('wrote a private recap draft that passed the checks (waiting for your click)')
      if (draftState === 'held') parts.push('wrote a private recap draft that the checks held back (reasons shown on the trip)')
      if (testimonialIds.length) parts.push(`saved ${testimonialIds.length} draft testimonial${testimonialIds.length === 1 ? '' : 's'} from approved quotes`)
      const action = `${parts.join(' and ')}. Nothing was published or sent.`
      await logDecision(admin, 'recap_auto', trip.slug, action, 'the trip has ended; drafts only, you publish', { kind: 'fw:recap_auto', ref: makeRef(trip.id, draftAt, testimonialIds) }, ctx.now)
      acted++
      notes.push(`${trip.slug}: ${parts.join(', ')}`)
    } catch (e) {
      errors.push(`${trip.slug}: ${e instanceof Error ? e.message : 'failed'}`)
    }
  }

  if (acted === 0 && errors.length > 0) throw new Error(errors.slice(0, 3).join('; '))
  if (acted === 0) return { ran: false, reason: 'no ended trip needs a recap or testimonial draft' }
  const tail = errors.length ? ` (${errors.length} trip${errors.length === 1 ? '' : 's'} failed: ${errors[0]})` : ''
  return { ran: true, acted, note: `${notes.join('; ')}${tail}` }
}

/** Undo for one decision: removes the recap draft this step wrote (only if it is still that draft) and the draft testimonials it saved
 * (only rows still in draft). A recap or testimonial a person published since is left alone. The "done" marker stays, so it is not rewritten. */
export async function undoRecapAuto(admin: SupabaseClient, ref: string): Promise<{ ok: boolean; message: string }> {
  const r = parseRef(ref)
  if (!r) return { ok: false, message: 'This decision has no usable reference.' }
  const removed: string[] = []
  const kept: string[] = []
  if (r.draftAt) {
    const raw = await getSetting(admin, recapDraftSettingKey(r.packageId))
    let at: string | null = null
    try {
      at = raw ? ((JSON.parse(raw) as { at?: string }).at ?? null) : null
    } catch {
      at = null
    }
    if (raw && at === r.draftAt) {
      const { error } = await admin.from('app_settings').delete().eq('key', recapDraftSettingKey(r.packageId))
      if (error) kept.push('the recap draft (it could not be removed)')
      else removed.push('the recap draft')
    } else {
      kept.push('the recap draft (it was changed, published or already removed)')
    }
  }
  let gone = 0
  for (const id of r.testimonialIds) {
    const { data } = await admin.from('testimonials').select('id, status').eq('id', id).maybeSingle()
    if (data && (data as { status: string }).status === 'draft') {
      const { error } = await admin.from('testimonials').delete().eq('id', id)
      if (!error) gone++
    }
  }
  if (r.testimonialIds.length) (gone === r.testimonialIds.length ? removed : kept).push(`${gone} of ${r.testimonialIds.length} draft testimonials`)
  if (removed.length === 0 && kept.length > 0) return { ok: false, message: `Nothing was removed: ${kept.join(', ')}.` }
  return { ok: true, message: `Removed ${removed.join(' and ') || 'nothing'}.${kept.length ? ` Left alone: ${kept.join(', ')}.` : ''}` }
}

export const recapAutoStep: FlywheelStep = {
  id: 'recap_auto',
  policy: 'recap_auto',
  label: 'Recap and testimonial auto-draft',
  order: 100,
  floorMs: 60_000,
  maxMs: 120_000,
  run: (ctx) => runRecapAuto(ctx),
  undo: undoRecapAuto,
}
