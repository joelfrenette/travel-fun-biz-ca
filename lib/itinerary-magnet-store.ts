import type { SupabaseClient } from '@supabase/supabase-js'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { getSetting, setSetting } from '@/lib/app-settings'
import { bumpItineraryCount, ITINERARY_COUNTS_KEY, ITINERARY_MODE_KEY, parseItineraryCounts, parseItineraryMode, type ItineraryCounts, type ItineraryMode } from '@/lib/itinerary-magnet'

// The database side of "Send me the itinerary and dates". No migration for the switch or the counter: two app_settings keys
//   itinerary_magnet_mode   "on" turns it on; missing or anything else is off
//   itinerary_requests      {"<trip slug>": {"count": n, "last": "<ISO time>"}}, shown on System health

/** Fails closed: any problem reading the switch means off. */
export async function getItineraryMagnetMode(admin?: SupabaseClient): Promise<ItineraryMode> {
  try {
    return parseItineraryMode(await getSetting(admin ?? getSupabaseAdmin(), ITINERARY_MODE_KEY))
  } catch {
    return 'off'
  }
}

export async function setItineraryMagnetMode(admin: SupabaseClient, mode: ItineraryMode): Promise<{ error?: string }> {
  return setSetting(admin, ITINERARY_MODE_KEY, mode)
}

export async function readItineraryCounts(admin: SupabaseClient): Promise<ItineraryCounts> {
  try {
    return parseItineraryCounts(await getSetting(admin, ITINERARY_COUNTS_KEY))
  } catch {
    return {}
  }
}

/** One more request for this trip. Best effort: a lost count never touches the visitor. */
export async function recordItineraryRequest(slug: string, admin?: SupabaseClient, now: Date = new Date()): Promise<void> {
  const db = admin ?? getSupabaseAdmin()
  await setSetting(db, ITINERARY_COUNTS_KEY, bumpItineraryCount(await getSetting(db, ITINERARY_COUNTS_KEY), slug, now))
}

/** Replaces the lead's message (the original text plus the email result line). Best effort. */
export async function writeLeadMessage(leadId: string, message: string, admin?: SupabaseClient): Promise<void> {
  await (admin ?? getSupabaseAdmin()).from('leads').update({ message }).eq('id', leadId)
}
