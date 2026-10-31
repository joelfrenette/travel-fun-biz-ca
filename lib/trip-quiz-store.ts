import type { SupabaseClient } from '@supabase/supabase-js'
import { supabase as anonClient } from '@/integrations/supabase/client'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { getSetting, setSetting } from '@/lib/app-settings'
import { bumpQuizCount, parseQuizCounts, parseTripQuizMode, TRIP_QUIZ_COUNTS_KEY, TRIP_QUIZ_MODE_KEY, type QuizCounts, type QuizEvent, type QuizTripInput, type TripQuizMode } from '@/lib/trip-quiz'

// The database side of "Find your trip in 60 seconds". No migration: two app_settings keys
//   trip_quiz_mode     "on" turns it on; missing or anything else is off
//   trip_quiz_funnel   {"<UTC day>": {"started": n, "q1": n, ... "result": n, "email": n}}, shown on System health

/** Fails closed: any problem reading the switch means off. */
export async function getTripQuizMode(admin?: SupabaseClient): Promise<TripQuizMode> {
  try {
    return parseTripQuizMode(await getSetting(admin ?? getSupabaseAdmin(), TRIP_QUIZ_MODE_KEY))
  } catch {
    return 'off'
  }
}

export async function setTripQuizMode(admin: SupabaseClient, mode: TripQuizMode): Promise<{ error?: string }> {
  return setSetting(admin, TRIP_QUIZ_MODE_KEY, mode)
}

export async function readQuizCounts(admin: SupabaseClient): Promise<QuizCounts> {
  try {
    return parseQuizCounts(await getSetting(admin, TRIP_QUIZ_COUNTS_KEY))
  } catch {
    return {}
  }
}

/** One more of this funnel event today. Server side only, best effort: a lost count never touches the visitor. */
export async function recordQuizEvent(event: QuizEvent, admin?: SupabaseClient, now: Date = new Date()): Promise<void> {
  try {
    const db = admin ?? getSupabaseAdmin()
    await setSetting(db, TRIP_QUIZ_COUNTS_KEY, bumpQuizCount(await getSetting(db, TRIP_QUIZ_COUNTS_KEY), event, now))
  } catch {
    // a lost count is only a slightly low number
  }
}

const TRIP_COLUMNS = 'id, slug, name, status, destination, country, category, tags, keywords, duration, duration_days, available_from, available_to, departure_dates, recap_mode'

/** Published trips for matching, through the anon client so RLS keeps drafts private (same as lib/packages.ts). A failed read gives []. */
export async function listQuizTrips(): Promise<(QuizTripInput & { id: string })[]> {
  try {
    const { data, error } = await anonClient.from('travel_packages').select(TRIP_COLUMNS).eq('status', 'published')
    if (error) return []
    return (data ?? []) as unknown as (QuizTripInput & { id: string })[]
  } catch {
    return []
  }
}
