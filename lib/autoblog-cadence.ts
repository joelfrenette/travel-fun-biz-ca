import type { SupabaseClient } from '@supabase/supabase-js'
import { getSetting, setSetting } from '@/lib/app-settings'
import { site } from '@/lib/site'

// Phase 2 (PR #3) shipped autoblog with a flat "at most one post per day" cap and explicitly
// deferred a configurable cadence dial as a real follow-up, not scope creep — Nomad's own
// Autopilot feature has a "posts per week" dial (0-7) that spreads writes across specific
// weekdays instead of a bare daily cap. This ports that dial, trimmed to just the schedule gate
// (no Nomad's separate "social posts per day" dial — that belongs to the distribution phase, not
// here).
export const AUTOBLOG_POSTS_PER_WEEK_KEY = 'autoblog_posts_per_week'
export const DEFAULT_POSTS_PER_WEEK = 3
const MIN_PER_WEEK = 0
const MAX_PER_WEEK = 7

/** Which weekdays (0 = Sunday .. 6 = Saturday) a given posts-per-week count writes on, spread out
 * rather than clumped — e.g. 3/week is Mon/Wed/Fri, not Mon/Tue/Wed. 0 never writes; 7 writes
 * every day. */
export const PUBLISH_DAYS: Record<number, number[]> = {
  0: [],
  1: [3],
  2: [1, 4],
  3: [1, 3, 5],
  4: [1, 2, 4, 5],
  5: [1, 2, 3, 4, 5],
  6: [0, 1, 2, 3, 4, 5],
  7: [0, 1, 2, 3, 4, 5, 6],
}

/** Clamps to the valid 0-7 range, falling back to the default for anything that isn't a clean
 * integer in range (an unset or corrupted setting must never silently become "0 = never" or
 * "7 = every day" by accident). null/undefined/empty are treated as absent, not as "0" —
 * `Number(null)` is 0, a value that would otherwise pass every check below as a real, deliberate
 * "never publish" setting. */
export function clampPostsPerWeek(raw: unknown): number {
  if (raw === null || raw === undefined || raw === '') return DEFAULT_POSTS_PER_WEEK
  const n = Number(raw)
  if (!Number.isInteger(n) || n < MIN_PER_WEEK || n > MAX_PER_WEEK) return DEFAULT_POSTS_PER_WEEK
  return n
}

export async function getAutoblogPostsPerWeek(admin: SupabaseClient): Promise<number> {
  return clampPostsPerWeek(await getSetting(admin, AUTOBLOG_POSTS_PER_WEEK_KEY))
}

export async function setAutoblogPostsPerWeek(admin: SupabaseClient, perWeek: number): Promise<{ error?: string }> {
  if (!Number.isInteger(perWeek) || perWeek < MIN_PER_WEEK || perWeek > MAX_PER_WEEK) {
    return { error: `posts per week must be an integer from ${MIN_PER_WEEK} to ${MAX_PER_WEEK}` }
  }
  return setSetting(admin, AUTOBLOG_POSTS_PER_WEEK_KEY, String(perWeek))
}

/** True when today (given a weekday 0-6) is one of the days a given posts-per-week count writes
 * on. Falls back to true for an out-of-table value so a future dial value never silently means
 * "never writes" by omission. */
export function isPublishDayDue(postsPerWeek: number, weekday: number): boolean {
  const days = PUBLISH_DAYS[postsPerWeek]
  return days ? days.includes(weekday) : true
}

/** Today's weekday (0 = Sunday) in the site's own time zone — the same zone lib/ai-verify.ts's
 * todayEt uses for dating AI content, so "today" means the same day everywhere in this codebase. */
export function currentWeekday(now: Date = new Date(), timeZone: string = site.timeZone): number {
  const label = now.toLocaleDateString('en-US', { timeZone, weekday: 'short' })
  const index = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(label)
  return index === -1 ? now.getDay() : index
}
