import type { SupabaseClient } from '@supabase/supabase-js'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { cardHref, usesGoLink } from '@/lib/affiliate-go'
import type { LinkCategory } from '@/lib/link-categories'

// "Plan the extras for your trip" on upcoming trip pages. Nothing here invents text: a card shows only the link's
// stored title, merchant and note. No claims about coverage, price, benefits or what is included, no urgency.
// Tours are not offered here (they belong to the "Fun things to do" block). No AI call is made.

/** Category priority: the first category listed wins a slot first. Tours, other and uncategorised never appear. */
export const TRIP_EXTRA_CATEGORIES: LinkCategory[] = ['insurance', 'transport', 'luggage', 'connectivity', 'stays']
export const MAX_TRIP_EXTRAS = 4

export interface TripExtraLink {
  id: string
  slug: string | null
  status: string
  url: string
  merchant: string | null
  title: string | null
  sort_order: number
  note: string | null
  category: string | null
}

export interface TripExtra {
  id: string
  category: LinkCategory
  title: string
  merchant: string
  /** The link's stored note, or null. Never generated. */
  note: string | null
  /** Always the /go/<slug> short link. */
  href: string
}

/** Pure: up to 4 cards, at most one per category (the lowest sort_order), categories in priority order. Only active
 * links with a real /go short link; draft, hidden, tours, other and uncategorised are never picked. */
export function pickTripExtras(links: TripExtraLink[]): TripExtra[] {
  const out: TripExtra[] = []
  for (const category of TRIP_EXTRA_CATEGORIES) {
    if (out.length >= MAX_TRIP_EXTRAS) break
    const best = links
      .filter((l) => l.status === 'active' && l.category === category && usesGoLink({ url: l.url, slug: l.slug }))
      .filter((l) => ((l.title ?? '').trim() || (l.merchant ?? '').trim()))
      .sort((a, b) => a.sort_order - b.sort_order || String(a.slug).localeCompare(String(b.slug)))[0]
    if (!best) continue
    const merchant = (best.merchant ?? '').trim() || (best.title ?? '').trim()
    out.push({
      id: best.id,
      category,
      title: (best.title ?? '').trim() || merchant,
      merchant,
      note: best.note?.trim() || null,
      href: cardHref({ url: best.url, slug: best.slug }),
    })
  }
  return out
}

const COLUMNS = 'id, slug, status, url, merchant, title, sort_order, note, category'

/** Server read. A past trip, a read failure, or migration 0049 not applied yet (no category column) is an empty list,
 * never an error page. */
export async function loadTripExtras(isPastTrip: boolean, admin?: SupabaseClient): Promise<TripExtra[]> {
  if (isPastTrip) return []
  try {
    const db = admin ?? getSupabaseAdmin()
    const res = await db.from('affiliate_links').select(COLUMNS).eq('status', 'active').order('sort_order')
    if (res.error) return []
    return pickTripExtras((res.data ?? []) as unknown as TripExtraLink[])
  } catch {
    return []
  }
}
