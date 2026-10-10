import type { SupabaseClient } from '@supabase/supabase-js'
import { supabase } from '@/integrations/supabase/client'
import { generateSlug } from '@/lib/utils'
import { GUIDE_SEEDS } from '@/lib/guide-seeds'
import { dbPackageToTravelPackage, type DbPackage } from '@/lib/packages'
import type { TravelPackage } from '@/types/travel'

// Guide pages (growth loop WP4): destinations, hotels, resorts, cruise lines, ships, river cruises and
// yachts. This file holds the types, the public reads (anon client, RLS only lets published rows through),
// the admin reads and writes (service role) and the candidate list (what could be written next). Writing a
// guide is lib/guide-composer.ts (the AI and the quality gate) and lib/guide-run.ts (caps and the pipeline).

export const GUIDE_KINDS = ['destinations', 'hotels', 'resorts', 'cruise-lines', 'ships', 'river-cruises', 'yachts'] as const
export type GuideKind = (typeof GUIDE_KINDS)[number]

export interface GuideKindInfo {
  /** Singular noun, e.g. "Hotel". */
  label: string
  /** Plural, for index pages and the admin, e.g. "Hotels". */
  plural: string
  /** Public URL prefix. A guide lives at `${urlPrefix}/${slug}`. Destinations keep the existing prefix. */
  urlPrefix: string
  /** schema.org type for the page's main entity. */
  schemaType: 'TouristDestination' | 'Hotel' | 'Resort' | 'Organization' | 'TouristTrip'
  /** The "guide" words after the name in the H1, e.g. "Travel Guide". */
  guideLabel: string
  /** A generic phrase to search stock photos for, used when the name itself would pull a photo of something else. */
  stockPhotoQuery: string
}

export const guideKinds: Record<GuideKind, GuideKindInfo> = {
  destinations: { label: 'Destination', plural: 'Destinations', urlPrefix: '/destinations', schemaType: 'TouristDestination', guideLabel: 'Travel Guide', stockPhotoQuery: '' },
  hotels: { label: 'Hotel', plural: 'Hotels', urlPrefix: '/hotels', schemaType: 'Hotel', guideLabel: 'Hotel Guide', stockPhotoQuery: 'hotel lobby resort pool' },
  resorts: { label: 'Resort', plural: 'Resorts', urlPrefix: '/resorts', schemaType: 'Resort', guideLabel: 'Resort Guide', stockPhotoQuery: 'tropical resort beach' },
  'cruise-lines': { label: 'Cruise line', plural: 'Cruise lines', urlPrefix: '/cruise-lines', schemaType: 'Organization', guideLabel: 'Cruise Line Guide', stockPhotoQuery: 'cruise ship ocean sunset' },
  ships: { label: 'Ship', plural: 'Ships', urlPrefix: '/ships', schemaType: 'TouristTrip', guideLabel: 'Ship Guide', stockPhotoQuery: 'cruise ship sea' },
  'river-cruises': { label: 'River cruise', plural: 'River cruises', urlPrefix: '/river-cruises', schemaType: 'TouristTrip', guideLabel: 'River Cruise Guide', stockPhotoQuery: 'river cruise ship europe' },
  yachts: { label: 'Yacht', plural: 'Yachts', urlPrefix: '/yachts', schemaType: 'TouristTrip', guideLabel: 'Yacht Cruise Guide', stockPhotoQuery: 'sailing yacht sea' },
}

export function isGuideKind(value: unknown): value is GuideKind {
  return typeof value === 'string' && (GUIDE_KINDS as readonly string[]).includes(value)
}

/** The public path of a guide. */
export function guidePath(kind: GuideKind, slug: string): string {
  return `${guideKinds[kind].urlPrefix}/${slug}`
}

export interface GuideSection {
  heading: string
  body: string
}

export interface GuideFaq {
  q: string
  a: string
}

export interface Guide {
  id: string
  kind: GuideKind
  slug: string
  name: string
  parent_slug: string | null
  summary: string
  body: string
  sections: GuideSection[]
  faq: GuideFaq[]
  key_takeaways: string[]
  hero_image_url: string | null
  hero_alt: string | null
  meta_title: string | null
  meta_description: string | null
  og_title: string | null
  og_description: string | null
  primary_keyword: string | null
  secondary_keywords: string[]
  related_package_ids: string[]
  status: 'draft' | 'published'
  source: 'ai' | 'manual'
  quality_notes: string | null
  created_at: string
  updated_at: string
}

/** What an index page or an admin list needs, without the long body. */
export type GuideSummary = Pick<Guide, 'id' | 'kind' | 'slug' | 'name' | 'parent_slug' | 'summary' | 'hero_image_url' | 'hero_alt' | 'status' | 'source' | 'quality_notes' | 'created_at' | 'updated_at'>

const SUMMARY_COLUMNS = 'id, kind, slug, name, parent_slug, summary, hero_image_url, hero_alt, status, source, quality_notes, created_at, updated_at'

// ---------------------------------------------------------------------------------------------------
// Public reads (anon client: RLS returns published rows only, a draft can never leak through here)
// ---------------------------------------------------------------------------------------------------

export async function getPublishedGuide(kind: GuideKind, slug: string): Promise<Guide | null> {
  const { data, error } = await supabase.from('guides').select('*').eq('kind', kind).eq('slug', slug).eq('status', 'published').maybeSingle()
  if (error) {
    console.error('[guides] fetch failed:', error.message)
    return null
  }
  return (data as Guide | null) ?? null
}

/** Published guides, newest first, optionally for one kind. Never throws: a read error is an empty list. */
export async function listPublishedGuides(kind?: GuideKind): Promise<GuideSummary[]> {
  let query = supabase.from('guides').select(SUMMARY_COLUMNS).eq('status', 'published').order('created_at', { ascending: false })
  if (kind) query = query.eq('kind', kind)
  const { data, error } = await query
  if (error) {
    console.error('[guides] list failed:', error.message)
    return []
  }
  return (data ?? []) as GuideSummary[]
}

/** Every published guide's address and last update, for the sitemap. */
export async function getPublishedGuidePaths(): Promise<{ kind: GuideKind; slug: string; updated_at: string }[]> {
  const { data, error } = await supabase.from('guides').select('kind, slug, updated_at').eq('status', 'published')
  if (error) {
    console.error('[guides] sitemap read failed:', error.message)
    return []
  }
  return ((data ?? []) as { kind: GuideKind; slug: string; updated_at: string }[]).filter((g) => isGuideKind(g.kind))
}

/** The real published packages a guide points at, as cards. A package unpublished since is silently left out. */
export async function getPublishedPackagesByIds(ids: string[]): Promise<TravelPackage[]> {
  if (ids.length === 0) return []
  const { data, error } = await supabase.from('travel_packages').select('*').in('id', ids).eq('status', 'published')
  if (error) {
    console.error('[guides] related packages failed:', error.message)
    return []
  }
  return ((data ?? []) as DbPackage[]).map(dbPackageToTravelPackage)
}

// ---------------------------------------------------------------------------------------------------
// Admin reads and writes (service role)
// ---------------------------------------------------------------------------------------------------

export async function listGuidesAdmin(admin: SupabaseClient): Promise<GuideSummary[]> {
  const { data, error } = await admin.from('guides').select(SUMMARY_COLUMNS).order('created_at', { ascending: false })
  if (error) throw new Error(`Could not read guides: ${error.message}`)
  return (data ?? []) as GuideSummary[]
}

export async function getGuideAdmin(admin: SupabaseClient, kind: GuideKind, slug: string): Promise<Guide | null> {
  const { data } = await admin.from('guides').select('*').eq('kind', kind).eq('slug', slug).maybeSingle()
  return (data as Guide | null) ?? null
}

export type GuideWrite = Omit<Guide, 'id' | 'created_at' | 'updated_at'>

/** Insert or replace one guide (kind + slug is unique). Returns the saved row. */
export async function saveGuide(admin: SupabaseClient, row: GuideWrite): Promise<Guide> {
  const { data, error } = await admin
    .from('guides')
    .upsert({ ...row, updated_at: new Date().toISOString() }, { onConflict: 'kind,slug' })
    .select('*')
    .single()
  if (error || !data) throw new Error(`Could not save the guide: ${error?.message ?? 'no row returned'}`)
  return data as Guide
}

export async function setGuideStatus(admin: SupabaseClient, id: string, status: 'draft' | 'published'): Promise<{ guide?: GuideSummary; error?: string }> {
  const { data, error } = await admin.from('guides').update({ status, updated_at: new Date().toISOString() }).eq('id', id).select(SUMMARY_COLUMNS).maybeSingle()
  if (error) return { error: error.message }
  if (!data) return { error: 'That guide no longer exists.' }
  return { guide: data as GuideSummary }
}

export async function deleteGuide(admin: SupabaseClient, id: string): Promise<{ error?: string }> {
  const { error } = await admin.from('guides').delete().eq('id', id)
  return error ? { error: error.message } : {}
}

/** How many guides were created since `sinceIso`, or null when the count could not be read. Callers that
 * guard spending MUST treat null as "do not write" (fail closed), same discipline as postsWrittenToday. */
export async function guidesCreatedSince(admin: SupabaseClient, sinceIso: string): Promise<number | null> {
  const { count, error } = await admin.from('guides').select('id', { count: 'exact', head: true }).gte('created_at', sinceIso)
  return error ? null : (count ?? 0)
}

// ---------------------------------------------------------------------------------------------------
// Candidates: what could be written next
// ---------------------------------------------------------------------------------------------------

export interface GuideCandidate {
  kind: GuideKind
  name: string
  slug: string
  /** A resort's destination slug. Null when unknown. */
  parent_slug: string | null
  /** destination = a published package goes there; package = a package name looks like this property; seed = curated name. */
  origin: 'destination' | 'package' | 'seed'
}

/** Which kind of property a package's name looks like, or null when it looks like an ordinary trip. Only the
 * name words and category decide; nothing is guessed beyond that. */
export function kindFromPackageName(name: string, category: string | null): GuideKind | null {
  const n = name.toLowerCase()
  const cat = (category ?? '').toLowerCase()
  if (/\byachts?\b|\bgulets?\b/.test(n)) return 'yachts'
  if (/\bresort\b/.test(n)) return 'resorts'
  if (/\bhotel\b|\binn\b|\blodge\b/.test(n)) return 'hotels'
  if (/\briver\b/.test(n) && (/\bcruises?\b|\bwaterways\b/.test(n) || cat.includes('cruise'))) return 'river-cruises'
  if (/\bship\b|\bm\/s\b|\bms\b|\bmv\b/.test(n)) return 'ships'
  if (/\bcruises\b|\bcruise line\b/.test(n) && !/\b(river|with|trip|getaway|singles|group|party)\b/.test(n)) return 'cruise-lines'
  return null
}

/** The property name inside a package title ("Sandals Royal Resort: 7 nights" -> "Sandals Royal Resort"), or
 * null when what is left would be a trip title rather than a name (digits, too long). */
export function cleanPropertyName(raw: string): string | null {
  const first = raw.split(/\s[-|:]\s|:\s|\s\|\s|\swith\s|\son\s/i)[0]?.trim() ?? ''
  if (first.length < 3 || first.length > 60) return null
  if (/\d/.test(first)) return null
  if (first.split(/\s+/).length > 6) return null
  return first
}

/** Everything that could be written next and is not a guide yet: every destination of a published package,
 * every package name that looks like a hotel/resort/ship/cruise line (by name words and category), and the
 * curated names in lib/guide-seeds.ts. Real data first (destinations, then package names), seeds last. */
export async function listGuideCandidates(admin: SupabaseClient): Promise<GuideCandidate[]> {
  const [{ data: pkgs, error: pkgError }, { data: existing, error: guideError }] = await Promise.all([
    admin.from('travel_packages').select('name, destination, category').eq('status', 'published'),
    admin.from('guides').select('kind, slug'),
  ])
  if (pkgError) throw new Error(`Could not read packages: ${pkgError.message}`)
  if (guideError) throw new Error(`Could not read guides: ${guideError.message}`)

  const taken = new Set(((existing ?? []) as { kind: string; slug: string }[]).map((g) => `${g.kind}:${g.slug}`))
  const out: GuideCandidate[] = []
  const add = (c: GuideCandidate) => {
    if (!c.slug) return
    const key = `${c.kind}:${c.slug}`
    if (taken.has(key)) return
    taken.add(key)
    out.push(c)
  }

  const rows = (pkgs ?? []) as { name: string | null; destination: string | null; category: string | null }[]
  for (const p of rows) {
    const destination = p.destination?.trim()
    if (destination) add({ kind: 'destinations', name: destination, slug: generateSlug(destination), parent_slug: null, origin: 'destination' })
  }
  for (const p of rows) {
    if (!p.name) continue
    const kind = kindFromPackageName(p.name, p.category)
    if (!kind) continue
    const name = cleanPropertyName(p.name)
    if (!name) continue
    const parent = (kind === 'hotels' || kind === 'resorts') && p.destination ? generateSlug(p.destination) : null
    add({ kind, name, slug: generateSlug(name), parent_slug: parent || null, origin: 'package' })
  }
  for (const seed of GUIDE_SEEDS) add({ kind: seed.kind, name: seed.name, slug: generateSlug(seed.name), parent_slug: null, origin: 'seed' })
  return out
}
