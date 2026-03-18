import { supabase } from '@/integrations/supabase/client'
import { samplePackages } from '@/content/packages'
import type { TravelPackage } from '@/types/travel'

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
  gallery_urls: string[]
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
  created_at: string
  updated_at: string
}

/**
 * Convert database package to frontend TravelPackage format
 */
export function dbPackageToTravelPackage(pkg: DbPackage): TravelPackage {
  return {
    id: pkg.id,
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

/**
 * Get all packages (including drafts) for admin
 */
export async function getAllPackagesAdmin(): Promise<DbPackage[]> {
  const { data, error } = await supabase
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
  const { data, error } = await supabase
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
export async function createPackage(pkg: Partial<DbPackage>): Promise<DbPackage | null> {
  const { data, error } = await supabase
    .from('travel_packages')
    .insert(pkg)
    .select()
    .single()

  if (error) {
    console.error('Failed to create package:', error)
    return null
  }

  return data
}

/**
 * Update a package
 */
export async function updatePackage(id: string, updates: Partial<DbPackage>): Promise<DbPackage | null> {
  const { data, error } = await supabase
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
  const { error } = await supabase
    .from('travel_packages')
    .delete()
    .eq('id', id)

  if (error) {
    console.error('Failed to delete package:', error)
    return false
  }

  return true
}

/**
 * Generate a URL-friendly slug from a name
 */
export function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}
