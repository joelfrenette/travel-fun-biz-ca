// Migration 0049: the kind of thing an affiliate link is. Pure (no imports), shared by the admin form,
// the admin validation and the "Plan the extras for your trip" block on trip pages.
export const LINK_CATEGORIES = ['tours', 'transport', 'stays', 'luggage', 'connectivity', 'insurance', 'other'] as const
export type LinkCategory = (typeof LINK_CATEGORIES)[number]

export const isLinkCategory = (v: unknown): v is LinkCategory => typeof v === 'string' && (LINK_CATEGORIES as readonly string[]).includes(v)

/** Admin-facing names for the dropdown and the list. */
export const LINK_CATEGORY_LABELS: Record<LinkCategory, string> = {
  tours: 'Tours and activities',
  transport: 'Transport',
  stays: 'Stays',
  luggage: 'Luggage and gear',
  connectivity: 'Connectivity (VPN, eSIM)',
  insurance: 'Insurance and protection',
  other: 'Other',
}
