import { supabase } from '@/integrations/supabase/client'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { samplePackages } from '@/content/packages'
import type { TravelPackage } from '@/types/travel'

// A dated traveler update on a trip ("where we went, what happened") - roadmap use case
// 6aed9806. Admin-entered only; never AI-generated, since it's a first-person account of a real
// day, not marketing copy.
export interface JournalEntry {
  date: string // YYYY-MM-DD
  title: string
  body: string
}

export interface DbPackage {
  id: string
  name: string
  slug: string
  destination: string
  country: string | null
  region: string | null
  category: string
  tags: string[]
  price_display: string
  price_value: number | null
  currency: string
  price_includes: string | null
  duration: string
  duration_days: number | null
  available_from: string | null
  available_to: string | null
  departure_dates: string[] | null
  short_description: string | null
  full_description: string | null
  highlights: string[] | null
  itinerary: any | null
  image_url: string | null
  image_url_square: string | null
  image_url_portrait: string | null
  image_url_banner: string | null
  image_source: 'upload' | 'pexels' | 'ai_generated' | null
  gallery_urls: string[]
  journal_entries: JournalEntry[]
  video_url: string | null
  rating: number | null
  review_count: number
  max_people: number | null
  min_people: number
  booking_url: string | null
  more_info_url: string | null
  call_to_action: string
  affiliate_code: string | null
  supplier: string | null
  ai_summary: string | null
  ai_faqs: any | null
  meta_title: string | null
  meta_description: string | null
  og_image_url: string | null
  status: 'draft' | 'published' | 'archived'
  featured: boolean
  sort_order: number
  not_included: string | null
  keywords: string[]
  created_at: string
  updated_at: string
}

/**
 * Convert database package to frontend TravelPackage format
 */
export function dbPackageToTravelPackage(pkg: DbPackage): TravelPackage {
  return {
    id: pkg.id,
    slug: pkg.slug,
    name: pkg.name,
    destination: pkg.destination,
    duration: pkg.duration,
    price: pkg.price_display,
    priceValue: pkg.price_value ?? undefined,
    description: pkg.short_description || pkg.full_description || '',
    image: pkg.image_url || `/placeholder.svg?height=400&width=600&query=${encodeURIComponent(pkg.name)}`,
    category: pkg.category,
    rating: pkg.rating ?? undefined,
    maxPeople: pkg.max_people?.toString() || '',
  }
}

/**
 * Returns published packages from Supabase, falls back to sample data if empty
 */
export async function getPackages(): Promise<TravelPackage[]> {
  try {
    const { data, error } = await supabase
      .from('travel_packages')
      .select('*')
      .eq('status', 'published')
      .order('featured', { ascending: false })
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: false })

    if (error) {
      console.error('Failed to fetch packages from Supabase:', error)
      return samplePackages
    }

    if (!data || data.length === 0) {
      return samplePackages
    }

    return data.map(dbPackageToTravelPackage)
  } catch (error) {
    console.error('Failed to fetch packages:', error)
    return samplePackages
  }
}

export interface BrowsePackage extends TravelPackage {
  country: string | null
  durationDays: number | null
  availableFrom: string | null
}

function dbPackageToBrowsePackage(pkg: DbPackage): BrowsePackage {
  return {
    ...dbPackageToTravelPackage(pkg),
    country: pkg.country,
    durationDays: pkg.duration_days,
    availableFrom: pkg.available_from,
  }
}

/** Published packages with the extra fields the /packages browse/filter page needs
 * (country, duration, start date) on top of what the homepage grid uses. */
export async function getPackagesForBrowse(): Promise<BrowsePackage[]> {
  const { data, error } = await supabase
    .from('travel_packages')
    .select('*')
    .eq('status', 'published')
    .order('featured', { ascending: false })
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: false })
  if (error) {
    console.error('Failed to fetch packages for browse:', error)
    return []
  }
  return (data || []).map(dbPackageToBrowsePackage)
}

/** A published package by slug, through the anon client so RLS keeps drafts private. */
/** The next upcoming published trip in the same category (for a recap page's "Join the next
 * trip" button) - a trip whose start date hasn't happened yet, closest one first, excluding
 * itself. Null when there's no such trip yet. */
export async function getNextUpcomingPackageInCategory(category: string, excludeId: string): Promise<DbPackage | null> {
  const today = new Date().toISOString().slice(0, 10)
  const { data, error } = await supabase
    .from('travel_packages')
    .select('*')
    .eq('status', 'published')
    .eq('category', category)
    .neq('id', excludeId)
    .gte('available_from', today)
    .order('available_from', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (error) {
    console.error('Failed to fetch next upcoming package:', error)
    return null
  }
  return data
}

/** Upcoming published trips to show on a blog post, so reading leads to enquiring instead of
 * dead-ending. The post's own related_package_id (if set) is featured first; the rest fill in
 * from whatever's soonest to depart. Never invents a package - an empty list means show nothing. */
export async function getRelatedPackages(relatedPackageId: string | null, limit = 3): Promise<TravelPackage[]> {
  const results: DbPackage[] = []

  if (relatedPackageId) {
    const { data } = await supabase.from('travel_packages').select('*').eq('id', relatedPackageId).eq('status', 'published').maybeSingle()
    if (data) results.push(data)
  }

  if (results.length < limit) {
    const { data, error } = await supabase
      .from('travel_packages')
      .select('*')
      .eq('status', 'published')
      .neq('id', relatedPackageId ?? '')
      .order('available_from', { ascending: true, nullsFirst: false })
      .limit(limit)
    if (error) {
      console.error('Failed to fetch related packages:', error)
    } else {
      for (const p of data ?? []) {
        if (results.length >= limit) break
        results.push(p)
      }
    }
  }

  return results.slice(0, limit).map(dbPackageToTravelPackage)
}

export async function getPublishedPackageBySlug(slug: string): Promise<DbPackage | null> {
  const { data, error } = await supabase
    .from('travel_packages')
    .select('*')
    .eq('slug', slug)
    .eq('status', 'published')
    .maybeSingle()
  if (error) {
    console.error('Failed to fetch package by slug:', error)
    return null
  }
  return data
}

/** Published slugs with their last update, for the sitemap. */
export async function getPublishedPackageSlugs(): Promise<{ slug: string; updated_at: string }[]> {
  const { data, error } = await supabase
    .from('travel_packages')
    .select('slug, updated_at')
    .eq('status', 'published')
  if (error) {
    console.error('Failed to fetch package slugs:', error)
    return []
  }
  return data || []
}

/**
 * Get all packages (including drafts) for admin
 */
export async function getAllPackagesAdmin(): Promise<DbPackage[]> {
  const { data, error } = await getSupabaseAdmin()
    .from('travel_packages')
    .select('*')
    .order('created_at', { ascending: false })

  if (error) {
    console.error('Failed to fetch packages for admin:', error)
    return []
  }

  return data || []
}

/**
 * Get a single package by ID
 */
export async function getPackageById(id: string): Promise<DbPackage | null> {
  const { data, error } = await getSupabaseAdmin()
    .from('travel_packages')
    .select('*')
    .eq('id', id)
    .single()

  if (error) {
    console.error('Failed to fetch package:', error)
    return null
  }

  return data
}

/**
 * Create a new package
 */
export async function createPackage(
  pkg: Partial<DbPackage>,
): Promise<{ pkg: DbPackage | null; error: { code?: string; message: string } | null }> {
  const { data, error } = await getSupabaseAdmin()
    .from('travel_packages')
    .insert(pkg)
    .select()
    .single()

  if (error) {
    console.error('Failed to create package:', error)
    return { pkg: null, error: { code: error.code, message: error.message } }
  }

  return { pkg: data, error: null }
}

/**
 * Update a package
 */
export async function updatePackage(id: string, updates: Partial<DbPackage>): Promise<DbPackage | null> {
  const { data, error } = await getSupabaseAdmin()
    .from('travel_packages')
    .update(updates)
    .eq('id', id)
    .select()
    .single()

  if (error) {
    console.error('Failed to update package:', error)
    return null
  }

  return data
}

/**
 * Delete a package
 */
export async function deletePackage(id: string): Promise<boolean> {
  const { error } = await getSupabaseAdmin()
    .from('travel_packages')
    .delete()
    .eq('id', id)

  if (error) {
    console.error('Failed to delete package:', error)
    return false
  }

  return true
}
