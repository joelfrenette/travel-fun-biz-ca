import type { SupabaseClient } from '@supabase/supabase-js'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { setSetting } from '@/lib/app-settings'
import { parseTripKit, parsePriceConfirmed, tripKitKey, tripPriceConfirmedKey, type TripKit, type PriceConfirmed } from '@/lib/trip-kit-facts'

// Reads (and, for the admin, writes) the two per-trip records of the Trip Page Kit. Both live in app_settings, so no migration:
//   trip_kit:<id>               the structured route, inclusions and sources the page renders (written by the fill engine)
//   trip_price_confirmed:<id>   the agent-confirmed price (written ONLY by an admin click, never by the engine)

export interface TripKitRecords {
  kit: TripKit | null
  price: PriceConfirmed | null
}

/** Server read for the public trip page. Fails open: any problem means no kit and no price (the page still renders). */
export async function loadTripKit(packageId: string, admin?: SupabaseClient): Promise<TripKitRecords> {
  try {
    const db = admin ?? getSupabaseAdmin()
    const { data, error } = await db.from('app_settings').select('key, value').in('key', [tripKitKey(packageId), tripPriceConfirmedKey(packageId)])
    if (error) return { kit: null, price: null }
    const map = new Map((data ?? []).map((r: { key: string; value: string }) => [r.key, r.value]))
    return { kit: parseTripKit(map.get(tripKitKey(packageId))), price: parsePriceConfirmed(map.get(tripPriceConfirmedKey(packageId))) }
  } catch {
    return { kit: null, price: null }
  }
}

/** Admin only: record that an agent confirmed a price. All three parts are required. */
export async function confirmTripPrice(admin: SupabaseClient, packageId: string, input: { by: string; text: string }, now: Date = new Date()): Promise<{ ok: true; record: PriceConfirmed } | { ok: false; error: string }> {
  const by = input.by.replace(/\s+/g, ' ').trim().slice(0, 80)
  const text = input.text.replace(/\s+/g, ' ').trim().slice(0, 120)
  if (!by) return { ok: false, error: 'Say who confirmed the price.' }
  if (!/\d/.test(text)) return { ok: false, error: 'Write the price the agent confirmed, for example "From $1,999 per person".' }
  const record: PriceConfirmed = { by, at: now.toISOString(), text }
  const r = await setSetting(admin, tripPriceConfirmedKey(packageId), JSON.stringify(record))
  return r.error ? { ok: false, error: r.error } : { ok: true, record }
}

export async function clearTripPrice(admin: SupabaseClient, packageId: string): Promise<boolean> {
  const { error } = await admin.from('app_settings').delete().eq('key', tripPriceConfirmedKey(packageId))
  return !error
}
