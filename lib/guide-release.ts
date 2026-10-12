import type { SupabaseClient } from '@supabase/supabase-js'
import { getSettingStrict } from '@/lib/app-settings'
import { numbersIn, proseOf, SUPERLATIVE_PATTERNS } from '@/lib/guide-composer'
import { loadGuidePostSource, type GuidePostSource } from '@/lib/guide-post-source'

// Growth loop WP18-E: social posts for guides about a NAMED place (a hotel, resort, ship, river cruise or yacht) used to
// be enrolled as `held` for good, so nothing about them ever posted unless Joel clicked Approve. Now they are enrolled as
// held (lib/guide-distribution.ts), and the existing posting pass releases each one by itself after
// `guide_social_release_hours` (default 24, 0 = never, the old manual way) when its caption passes the caption checks:
// no superlative, no number outside the guide's own facts, no long dash. A caption that fails stays held with the reasons,
// shows in Needs attention, and is looked at again on every pass (so fixing the guide releases it). Nothing here sends
// anything: it only moves a ledger row from `held` to `queued`, and the normal send code does the rest, within the
// same per-day guide limit.
//
// This file does not import lib/distribution.ts or lib/guide-distribution.ts (distribution.ts calls it), so there is
// no import cycle.

export const GUIDE_SOCIAL_RELEASE_KEY = 'guide_social_release_hours'
export const DEFAULT_GUIDE_RELEASE_HOURS = 24
export const MAX_GUIDE_RELEASE_HOURS = 720
/** At most this many guide posts are released (or already queued or sent) per UTC day, the same limit as enrolment. */
export const GUIDE_RELEASES_PER_DAY = 1

/** Marks a held row that the release step may let go of. A row held by hand (prepare mode, a pause) never has it. */
export const AUTO_HOLD_PREFIX = 'Auto-hold:'
/** Replaces the note when the caption did not pass. Rows with either prefix are looked at on every pass. */
export const CAPTION_FAILED_PREFIX = 'Caption check failed:'

export function autoHoldNote(hours: number): string {
  return `${AUTO_HOLD_PREFIX} a named place waits ${hours} hour${hours === 1 ? '' : 's'}, then posts by itself if its caption passes the checks.`
}

/** The setting value as a number of hours: unset or unreadable text means the default (24), 0 means never, and the
 * rest is a whole number up to 720. Pure. */
export function parseReleaseHours(raw: string | null | undefined): number {
  if (raw === null || raw === undefined || raw.trim() === '') return DEFAULT_GUIDE_RELEASE_HOURS
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return DEFAULT_GUIDE_RELEASE_HOURS
  return Math.min(MAX_GUIDE_RELEASE_HOURS, Math.floor(n))
}

/** Hours to wait, or null when the setting could not be read (callers then do nothing and keep the old manual hold). */
export async function readReleaseHours(admin: SupabaseClient): Promise<number | null> {
  const { value, error } = await getSettingStrict(admin, GUIDE_SOCIAL_RELEASE_KEY)
  return error ? null : parseReleaseHours(value)
}

const EM_DASH = String.fromCharCode(8212)
const EN_DASH = String.fromCharCode(8211)

/** The caption checks for the text a guide post would carry (its title and description): a superlative or
 * reputation word, a number that is not in the guide's own takeaways and FAQ, a long dash, or nothing to say. Pure. */
export function guideCaptionProblems(src: Pick<GuidePostSource, 'title' | 'meta_description' | 'grounding'>): string[] {
  const problems: string[] = []
  const text = [src.title, src.meta_description ?? ''].join('. ')
  const prose = proseOf(text)
  for (const [pattern, label] of SUPERLATIVE_PATTERNS) if (pattern.test(prose)) problems.push(`superlative or rating claim (${label})`)
  const allowed = new Set(numbersIn(src.grounding ?? ''))
  const stray = [...new Set(numbersIn(prose).filter((n) => !allowed.has(n)))]
  if (stray.length) problems.push(`number not in the guide's facts: ${stray.slice(0, 5).join(', ')}`)
  if (text.includes(EM_DASH) || text.includes(EN_DASH)) problems.push('contains a long dash')
  if (!(src.meta_description ?? '').trim()) problems.push('no description to post with')
  return problems
}

export interface ReleaseResult {
  released: number
  stillHeld: number
  note: string
}

const startOfUtcDay = (now: Date) => `${now.toISOString().slice(0, 10)}T00:00:00.000Z`

/** Releases held guide rows that have waited long enough and whose caption passes. `mode` is the distribution mode (only
 * 'auto' releases anything). Never throws. */
export async function releaseHeldGuides(admin: SupabaseClient, opts: { mode: string; now?: Date }): Promise<ReleaseResult> {
  const none = (note: string): ReleaseResult => ({ released: 0, stillHeld: 0, note })
  try {
    if (opts.mode !== 'auto') return none('guide posts are released only in auto mode')
    const hours = await readReleaseHours(admin)
    if (hours === null) return none('could not read how long guide posts wait')
    if (hours === 0) return none('guide posts are held until you approve them (wait time is 0)')
    const now = opts.now ?? new Date()
    const cutoff = new Date(now.getTime() - hours * 3_600_000).toISOString()

    const { data, error } = await admin
      .from('post_distribution')
      .select('slug, title, path, created_at, last_error')
      .eq('content_type', 'post')
      .eq('stage', 'held')
      .not('path', 'is', null)
      .like('slug', 'guide-%')
      .lte('created_at', cutoff)
      .order('created_at', { ascending: true })
      .limit(10)
    if (error) return none(`could not read the held guide posts (${error.message})`)
    const rows = ((data ?? []) as { slug: string; title: string; path: string; last_error: string | null }[]).filter((r) => r.last_error?.startsWith(AUTO_HOLD_PREFIX) || r.last_error?.startsWith(CAPTION_FAILED_PREFIX))
    if (!rows.length) return none('no held guide posts are due')

    // The daily limit counts guide posts already queued or sent today (released or enrolled straight to queued).
    const { count, error: countError } = await admin
      .from('post_distribution')
      .select('slug', { count: 'exact', head: true })
      .like('slug', 'guide-%')
      .not('path', 'is', null)
      .in('stage', ['queued', 'done'])
      .gte('updated_at', startOfUtcDay(now))
    if (countError) return none('could not check the daily guide limit, so nothing was released')
    let room = Math.max(0, GUIDE_RELEASES_PER_DAY - (count ?? 0))

    let released = 0
    let stillHeld = 0
    for (const row of rows) {
      let src: GuidePostSource | null
      try {
        src = await loadGuidePostSource(admin, row.path)
      } catch {
        continue
      }
      if (!src) continue
      const problems = guideCaptionProblems(src)
      if (problems.length === 0) {
        if (room <= 0) continue
        const { data: moved, error: moveError } = await admin
          .from('post_distribution')
          .update({ stage: 'queued', last_error: null, updated_at: now.toISOString() })
          .eq('content_type', 'post')
          .eq('slug', row.slug)
          .eq('stage', 'held')
          .select('slug')
        if (!moveError && moved?.length) {
          released++
          room--
        }
        continue
      }
      stillHeld++
      const note = `${CAPTION_FAILED_PREFIX} ${problems.join('; ')}`.slice(0, 300)
      if (row.last_error !== note) {
        await admin.from('post_distribution').update({ last_error: note, updated_at: now.toISOString() }).eq('content_type', 'post').eq('slug', row.slug).eq('stage', 'held')
      }
    }
    return { released, stillHeld, note: `${released} guide post${released === 1 ? '' : 's'} released, ${stillHeld} held for a caption problem` }
  } catch (e) {
    return none(`guide release failed: ${e instanceof Error ? e.message : 'unknown error'}`)
  }
}

/** When an admin approves a held guide row by hand, the automatic-hold note is cleared (it is no longer true). */
export async function clearAutoHoldNote(admin: SupabaseClient, slug: string): Promise<void> {
  for (const prefix of [AUTO_HOLD_PREFIX, CAPTION_FAILED_PREFIX]) {
    await admin.from('post_distribution').update({ last_error: null }).eq('content_type', 'post').eq('slug', slug).like('last_error', `${prefix}%`)
  }
}
