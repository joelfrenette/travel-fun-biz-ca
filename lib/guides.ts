import type { SupabaseClient } from '@supabase/supabase-js'
import { supabase } from '@/integrations/supabase/client'
import { generateSlug } from '@/lib/utils'
import { GUIDE_SEEDS } from '@/lib/guide-seeds'
import { GUIDE_BACKFILL_KEY, parseBackfillState } from '@/lib/guide-backfill'
import type { TripFact } from '@/lib/guide-facts'
import { groupChildren, inferScope, parentChain, parseScope, type GuideScope } from '@/lib/guide-scope'
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
  /** How wide the page is (migration 0041). Null = not set; the site then infers one from the name (lib/guide-scope.ts). */
  scope: GuideScope | null
  /** 'rejected' = a person turned this draft down in the review queue (migration 0041). */
  review_state: 'rejected' | null
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

/** What a visitor gets: no admin notes, no source. */
export type PublicGuide = Omit<Guide, 'quality_notes' | 'source' | 'review_state'>

// Migration 0041 adds `scope` and `review_state`. Until it is applied, a select that names them fails with a
// "column does not exist" error, which would 404 every guide page. So every read tries the new columns first and,
// only on that one error, retries with the old list. The page then falls back to inferring the scope from the name.
const PUBLIC_COLUMNS_OLD =
  'id, kind, slug, name, parent_slug, summary, body, sections, faq, key_takeaways, hero_image_url, hero_alt, meta_title, meta_description, og_title, og_description, primary_keyword, secondary_keywords, related_package_ids, status, created_at, updated_at'
const PUBLIC_COLUMNS = `${PUBLIC_COLUMNS_OLD}, scope`

/** What an index page or an admin list needs, without the long body. */
export type GuideSummary = Pick<Guide, 'id' | 'kind' | 'slug' | 'name' | 'parent_slug' | 'summary' | 'hero_image_url' | 'hero_alt' | 'status' | 'source' | 'quality_notes' | 'created_at' | 'updated_at'> & {
  scope?: GuideScope | null
  review_state?: 'rejected' | null
}

const SUMMARY_COLUMNS_OLD = 'id, kind, slug, name, parent_slug, summary, hero_image_url, hero_alt, status, source, quality_notes, created_at, updated_at'
const SUMMARY_COLUMNS = `${SUMMARY_COLUMNS_OLD}, scope, review_state`

/** True when a database error is only "the 0041 columns are not there yet". */
export function isMissingScopeColumn(message: string | null | undefined): boolean {
  return !!message && /\b(scope|review_state)\b/i.test(message) && /column|schema cache/i.test(message)
}

type PgReply = { data: unknown; error: { message: string } | null }

/** Runs a read with the new column list, and again with the old one when the new columns are missing. */
async function withScopeFallback(run: (columns: 'new' | 'old') => PromiseLike<PgReply>): Promise<PgReply> {
  const first = await run('new')
  return first.error && isMissingScopeColumn(first.error.message) ? run('old') : first
}

// ---------------------------------------------------------------------------------------------------
// Public reads (anon client: RLS returns published rows only, a draft can never leak through here)
// ---------------------------------------------------------------------------------------------------

export async function getPublishedGuide(kind: GuideKind, slug: string): Promise<PublicGuide | null> {
  const { data, error } = await withScopeFallback((v) =>
    supabase.from('guides').select(v === 'new' ? PUBLIC_COLUMNS : PUBLIC_COLUMNS_OLD).eq('kind', kind).eq('slug', slug).eq('status', 'published').maybeSingle(),
  )
  if (error) {
    console.error('[guides] fetch failed:', error.message)
    return null
  }
  const row = data as unknown as PublicGuide | null
  return row ? { ...row, scope: parseScope(row.scope) } : null
}

/** Published guides, newest first, optionally for one kind. Never throws: a read error is an empty list. */
export async function listPublishedGuides(kind?: GuideKind): Promise<GuideSummary[]> {
  const { data, error } = await withScopeFallback((v) => {
    let query = supabase.from('guides').select(v === 'new' ? 'id, kind, slug, name, parent_slug, summary, hero_image_url, hero_alt, status, source, quality_notes, created_at, updated_at, scope' : SUMMARY_COLUMNS_OLD).eq('status', 'published').order('created_at', { ascending: false })
    if (kind) query = query.eq('kind', kind)
    return query
  })
  if (error) {
    console.error('[guides] list failed:', error.message)
    return []
  }
  return (data ?? []) as unknown as GuideSummary[]
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

/** The stored facts of the published trips a guide lists (for the key-facts table, the route and the length chart).
 * Anon client, so RLS lets only published trips through. Never throws: a read error is an empty list. */
export async function getTripFactsByIds(ids: string[]): Promise<TripFact[]> {
  if (ids.length === 0) return []
  const { data, error } = await supabase
    .from('travel_packages')
    .select('id, slug, name, category, destination, duration_days, available_from, available_to, itinerary')
    .in('id', ids)
    .eq('status', 'published')
  if (error) {
    console.error('[guides] trip facts failed:', error.message)
    return []
  }
  return (data ?? []) as TripFact[]
}

// ---------------------------------------------------------------------------------------------------
// Link graph (growth loop WP7): which published guides to link to from a guide, a blog post, a destination
// page. All reads are the anon client with explicit columns, so only published rows can come back. The
// choosing is in pure functions (no database), so it can be tested offline.
// ---------------------------------------------------------------------------------------------------

/** The few columns a link needs. */
export type GuideLink = Pick<Guide, 'id' | 'kind' | 'slug' | 'name' | 'parent_slug' | 'summary' | 'related_package_ids'> & { scope?: GuideScope | null }

const LINK_COLUMNS_OLD = 'id, kind, slug, name, parent_slug, summary, related_package_ids'
const LINK_COLUMNS = `${LINK_COLUMNS_OLD}, scope`

/** Every published guide as a link row, newest first. Never throws: a read error is an empty list. */
export async function listPublishedGuideLinks(): Promise<GuideLink[]> {
  const { data, error } = await withScopeFallback((v) => supabase.from('guides').select(v === 'new' ? LINK_COLUMNS : LINK_COLUMNS_OLD).eq('status', 'published').order('created_at', { ascending: false }))
  if (error) {
    console.error('[guides] link list failed:', error.message)
    return []
  }
  return ((data ?? []) as unknown as GuideLink[]).filter((g) => isGuideKind(g.kind))
}

/** One line for a card: the first sentence of the summary, cut at 160 characters. */
export function oneLineSummary(summary: string): string {
  const flat = summary.replace(/\s+/g, ' ').trim()
  const first = flat.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? flat
  return first.length > 160 ? `${first.slice(0, 157).trimEnd()}...` : first
}

/** Up to `limit` guides related to `current`, in this order: same parent (siblings under one destination or
 * cruise line, plus the parent itself and a guide whose parent is this one), then the same kind, then any that
 * share a related package. Never includes `current`, never repeats. `candidates` must already be published. */
export function pickRelatedGuides(current: Pick<GuideLink, 'kind' | 'slug' | 'parent_slug' | 'related_package_ids'>, candidates: GuideLink[], limit = 6): GuideLink[] {
  const others = candidates.filter((g) => !(g.kind === current.kind && g.slug === current.slug))
  const sameParent = others.filter(
    (g) =>
      (current.parent_slug && (g.parent_slug === current.parent_slug || (g.kind === 'destinations' && g.slug === current.parent_slug))) ||
      g.parent_slug === current.slug,
  )
  const sameKind = others.filter((g) => g.kind === current.kind)
  const mine = new Set(current.related_package_ids ?? [])
  const sharesPackage = mine.size > 0 ? others.filter((g) => (g.related_package_ids ?? []).some((id) => mine.has(id))) : []
  const seen = new Set<string>()
  const out: GuideLink[] = []
  // Last, pages of other kinds, named properties (hotel, resort, ship, cruise line...) before destinations. A property
  // page that is the only one of its kind has no same-kind or same-parent pages, so without this it would show no
  // related guides and nothing would ever link to the other properties (they all became orphans).
  const crossKind = others
    .filter((g) => g.kind !== current.kind)
    .sort((a, b) => Number(a.kind === 'destinations') - Number(b.kind === 'destinations'))
  for (const g of [...sameParent, ...sameKind, ...sharesPackage, ...crossKind]) {
    if (seen.has(g.id)) continue
    seen.add(g.id)
    out.push(g)
    if (out.length >= limit) break
  }
  return out
}

const normPhrase = (s: string) => ` ${s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `

/** Up to `limit` guides that a blog post is really about. A guide counts when the post's destination (from its
 * linked package) is the guide's own slug or its parent, or when the guide's whole name appears as a phrase in
 * one of the post's tags or in its title. Nothing else counts: no fuzzy match, so with no match the result is
 * empty. Destination matches come first. */
export function pickGuidesForPost(post: { title: string; tags: string[]; destinationSlug: string | null }, candidates: GuideLink[], limit = 3): GuideLink[] {
  const byDestination = post.destinationSlug ? candidates.filter((g) => g.parent_slug === post.destinationSlug || (g.kind === 'destinations' && g.slug === post.destinationSlug)) : []
  // Destination guides first, then the properties under that destination.
  byDestination.sort((a, b) => Number(b.kind === 'destinations') - Number(a.kind === 'destinations'))
  const haystacks = [post.title, ...post.tags].map(normPhrase)
  const byName = candidates.filter((g) => {
    const name = normPhrase(g.name)
    return name.trim().length >= 4 && haystacks.some((h) => h.includes(name))
  })
  const seen = new Set<string>()
  const out: GuideLink[] = []
  for (const g of [...byDestination, ...byName]) {
    if (seen.has(g.id)) continue
    seen.add(g.id)
    out.push(g)
    if (out.length >= limit) break
  }
  return out
}

/** The destination pages to show on the home page: published destination guides, the ones that have trips first (the
 * most trips first), then the rest newest first (the order given). At most `limit`. A page with no trips is still
 * listed when there are not enough with trips, because the guide itself is real content. Pure. */
export function pickTopDestinationGuides(candidates: GuideLink[], limit = 6): GuideLink[] {
  const destinations = candidates.filter((g) => g.kind === 'destinations')
  const withTrips = destinations.filter((g) => (g.related_package_ids ?? []).length > 0).sort((a, b) => (b.related_package_ids ?? []).length - (a.related_package_ids ?? []).length)
  const rest = destinations.filter((g) => (g.related_package_ids ?? []).length === 0)
  return [...withTrips, ...rest].slice(0, Math.max(0, limit))
}

/** Home-page destinations. Never throws. */
export async function listTopDestinationGuides(limit = 6): Promise<GuideSummary[]> {
  try {
    const all = await listPublishedGuides('destinations')
    const links = await listPublishedGuideLinks()
    const order = pickTopDestinationGuides(links, limit).map((g) => g.id)
    return order.map((id) => all.find((g) => g.id === id)).filter((g): g is GuideSummary => !!g)
  } catch {
    return []
  }
}

export interface TrailStep {
  name: string
  /** Site path. */
  path: string
}

/** The breadcrumb of a guide page after "Home": its parents outermost first (a country, then a city, then a port),
 * then the page itself. With no published parent the trail is the kind's index page, then the page. A parent that
 * has no guide of its own but is a destination with trips (`fallbackParent`) links to its /destinations page.
 * Pure, loop-safe (see parentChain). */
export function guideTrail(guide: Pick<GuideLink, 'kind' | 'slug' | 'name' | 'parent_slug'>, nodes: GuideLink[], fallbackParent: { slug: string; name: string } | null = null): TrailStep[] {
  const chain = parentChain(guide, nodes)
  const own: TrailStep = { name: guide.name, path: guidePath(guide.kind, guide.slug) }
  if (chain.length > 0) return [...chain.map((n) => ({ name: n.name, path: guidePath(n.kind as GuideKind, n.slug) })), own]
  if (fallbackParent && guide.parent_slug === fallbackParent.slug) return [{ name: fallbackParent.name, path: `/destinations/${fallbackParent.slug}` }, own]
  return [{ name: guideKinds[guide.kind].plural, path: guideKinds[guide.kind].urlPrefix }, own]
}

/** The published pages that sit directly under this one, grouped by scope ("Cities", "Ports of call", "Hotels"...). */
export function childGroups(guide: Pick<GuideLink, 'kind' | 'slug'>, nodes: GuideLink[]): { label: string; items: GuideLink[] }[] {
  return groupChildren(guide, nodes, (kind) => (isGuideKind(kind) ? guideKinds[kind].plural : kind))
}

/** A blog post as a link: just what is needed to decide whether a guide is about it. */
export interface PostLink {
  id: string
  slug: string
  title: string
  tags: string[]
  related_package_id: string | null
}

/** Up to `limit` blog posts a guide is really about, newest first as given: a post written for one of the guide's own
 * trips, or a post whose title or tags contain the guide's whole name as a phrase. Nothing fuzzy; no match is an empty list. */
export function pickPostsForGuide(guide: Pick<GuideLink, 'name' | 'related_package_ids'>, posts: PostLink[], limit = 3): PostLink[] {
  const mine = new Set(guide.related_package_ids ?? [])
  const name = normPhrase(guide.name)
  const long = name.trim().length >= 4
  const byTrip = mine.size > 0 ? posts.filter((p) => p.related_package_id && mine.has(p.related_package_id)) : []
  const byName = long ? posts.filter((p) => [p.title, ...(p.tags ?? [])].map(normPhrase).some((h) => h.includes(name))) : []
  const seen = new Set<string>()
  const out: PostLink[] = []
  for (const p of [...byTrip, ...byName]) {
    if (seen.has(p.id)) continue
    seen.add(p.id)
    out.push(p)
    if (out.length >= limit) break
  }
  return out
}

/** Published blog posts a guide page can link back to. Never throws. */
export async function listPostsForGuide(guide: Pick<GuideLink, 'name' | 'related_package_ids'>, limit = 3): Promise<PostLink[]> {
  try {
    const { data, error } = await supabase.from('posts').select('id, slug, title, tags, related_package_id').eq('status', 'published').order('publish_date', { ascending: false, nullsFirst: false })
    if (error) return []
    return pickPostsForGuide(guide, (data ?? []) as PostLink[], limit)
  } catch {
    return []
  }
}

/** Up to `limit` guides a TRIP page can link to: pages that list this trip, then the page for the trip's destination,
 * then pages under that destination. Pure. (The trip page itself belongs to another branch; it calls this.) */
export function pickGuidesForPackage(pkg: { id: string; destinationSlug: string | null }, candidates: GuideLink[], limit = 4): GuideLink[] {
  const byTrip = candidates.filter((g) => (g.related_package_ids ?? []).includes(pkg.id))
  const dest = pkg.destinationSlug ? candidates.filter((g) => g.kind === 'destinations' && g.slug === pkg.destinationSlug) : []
  const under = pkg.destinationSlug ? candidates.filter((g) => g.parent_slug === pkg.destinationSlug) : []
  const seen = new Set<string>()
  const out: GuideLink[] = []
  for (const g of [...dest, ...byTrip, ...under]) {
    if (seen.has(g.id)) continue
    seen.add(g.id)
    out.push(g)
    if (out.length >= limit) break
  }
  return out
}

/** Published guides for a trip page. Never throws. */
export async function listGuidesForPackage(pkg: { id: string; destination: string | null }, limit = 4): Promise<GuideLink[]> {
  try {
    return pickGuidesForPackage({ id: pkg.id, destinationSlug: pkg.destination ? generateSlug(pkg.destination) || null : null }, await listPublishedGuideLinks(), limit)
  } catch {
    return []
  }
}

/** Related published guides for a guide page. Never throws. */
export async function listRelatedGuides(current: Pick<GuideLink, 'kind' | 'slug' | 'parent_slug' | 'related_package_ids'>, limit = 6): Promise<GuideLink[]> {
  return pickRelatedGuides(current, await listPublishedGuideLinks(), limit)
}

/** Published guides a blog post is about (see pickGuidesForPost). The destination comes only from the post's
 * linked package (published), never guessed. Never throws. */
export async function listGuidesForPost(post: { title: string; tags: string[]; related_package_id: string | null }, limit = 3): Promise<GuideLink[]> {
  try {
    let destinationSlug: string | null = null
    if (post.related_package_id) {
      const { data } = await supabase.from('travel_packages').select('destination').eq('id', post.related_package_id).eq('status', 'published').maybeSingle()
      const destination = (data as { destination: string | null } | null)?.destination
      destinationSlug = destination ? generateSlug(destination) || null : null
    }
    return pickGuidesForPost({ title: post.title, tags: post.tags ?? [], destinationSlug }, await listPublishedGuideLinks(), limit)
  } catch {
    return []
  }
}

/** Published hotel and resort guides whose parent is this destination, for the destination page. Never throws. */
export async function listPropertyGuidesForDestination(destinationSlug: string): Promise<GuideLink[]> {
  const { data, error } = await withScopeFallback((v) =>
    supabase
      .from('guides')
      .select(v === 'new' ? LINK_COLUMNS : LINK_COLUMNS_OLD)
      .eq('status', 'published')
      .eq('parent_slug', destinationSlug)
      .in('kind', ['hotels', 'resorts'])
      .order('name', { ascending: true }),
  )
  if (error) {
    console.error('[guides] destination property list failed:', error.message)
    return []
  }
  return (data ?? []) as unknown as GuideLink[]
}

// ---------------------------------------------------------------------------------------------------
// Admin reads and writes (service role)
// ---------------------------------------------------------------------------------------------------

export async function listGuidesAdmin(admin: SupabaseClient): Promise<GuideSummary[]> {
  const { data, error } = await withScopeFallback((v) => admin.from('guides').select(v === 'new' ? SUMMARY_COLUMNS : SUMMARY_COLUMNS_OLD).order('created_at', { ascending: false }))
  if (error) throw new Error(`Could not read guides: ${error.message}`)
  return (data ?? []) as unknown as GuideSummary[]
}

export async function getGuideAdmin(admin: SupabaseClient, kind: GuideKind, slug: string): Promise<Guide | null> {
  const { data } = await admin.from('guides').select('*').eq('kind', kind).eq('slug', slug).maybeSingle()
  return (data as Guide | null) ?? null
}

export async function getGuideById(admin: SupabaseClient, id: string): Promise<Guide | null> {
  const { data } = await admin.from('guides').select('*').eq('id', id).maybeSingle()
  return (data as Guide | null) ?? null
}

export type GuideWrite = Omit<Guide, 'id' | 'created_at' | 'updated_at' | 'scope' | 'review_state'> & { scope?: GuideScope | null; review_state?: 'rejected' | null }

/** Insert or replace one guide (kind + slug is unique). Returns the saved row. Before migration 0041 is applied the
 * two new columns are left out of the write, so saving a guide keeps working. */
export async function saveGuide(admin: SupabaseClient, row: GuideWrite): Promise<Guide> {
  const write = async (payload: Record<string, unknown>) =>
    admin.from('guides').upsert({ ...payload, updated_at: new Date().toISOString() }, { onConflict: 'kind,slug' }).select('*').single()
  let { data, error } = await write(row)
  if (error && isMissingScopeColumn(error.message)) {
    const legacy: Record<string, unknown> = { ...row }
    delete legacy.scope
    delete legacy.review_state
    ;({ data, error } = await write(legacy))
  }
  if (error || !data) throw new Error(`Could not save the guide: ${error?.message ?? 'no row returned'}`)
  return data as Guide
}

export async function setGuideStatus(admin: SupabaseClient, id: string, status: 'draft' | 'published'): Promise<{ guide?: GuideSummary; error?: string }> {
  const { data, error } = await withScopeFallback((v) =>
    // Publishing is the admin's decision, so the "Held back: ..." notes from the quality gate are cleared with it.
    admin.from('guides').update(status === 'published' ? { status, quality_notes: null, updated_at: new Date().toISOString() } : { status, updated_at: new Date().toISOString() }).eq('id', id).select(v === 'new' ? SUMMARY_COLUMNS : SUMMARY_COLUMNS_OLD).maybeSingle(),
  )
  if (error) return { error: error.message }
  if (!data) return { error: 'That guide no longer exists.' }
  return { guide: data as unknown as GuideSummary }
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
  /** How wide the page is. Set from the seed list or inferred from the name; null when it cannot be told. */
  scope?: GuideScope | null
  /** True while a one-time backfill (lib/guide-backfill.ts) has this page on its list. Such a page is written before the
   * normal rotation even when its origin is 'package', but it is NOT a priority page: a guessed name is not forced to
   * a draft here, it follows the same gate and publish decision as every other page. */
  backfill?: boolean
  /** True while "Promote this package" has put this guide at the front of the line (30 days). A priority guide is
   * picked before the normal rotation, even when its origin is 'package'. It still goes through the quality gate. */
  priority?: boolean
}

// ---------------------------------------------------------------------------------------------------
// Priority list (growth loop WP15): guides that a promoted package wants written first
// ---------------------------------------------------------------------------------------------------

/** `app_settings.guide_priority`: JSON array of PriorityGuide. */
export const GUIDE_PRIORITY_KEY = 'guide_priority'
/** How long a promoted guide stays at the front of the line. */
export const GUIDE_PRIORITY_DAYS = 30

export interface PriorityGuide {
  kind: GuideKind
  slug: string
  name: string
  parent_slug: string | null
  /** ISO time after which the entry is ignored. */
  until: string
  /** The package this was added for. */
  package_slug: string
}

/** The entries of a stored priority list that are well formed and not yet expired. Anything else is dropped, so a
 * bad value in the setting can never break the guides step. Pure. */
export function parseGuidePriority(raw: string | null | undefined, now: Date = new Date()): PriorityGuide[] {
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const out: PriorityGuide[] = []
  for (const e of parsed as Record<string, unknown>[]) {
    if (!e || typeof e !== 'object') continue
    if (!isGuideKind(e.kind) || typeof e.slug !== 'string' || !e.slug || typeof e.name !== 'string' || !e.name) continue
    if (typeof e.until !== 'string' || !(Date.parse(e.until) > now.getTime())) continue
    out.push({
      kind: e.kind,
      slug: e.slug,
      name: e.name,
      parent_slug: typeof e.parent_slug === 'string' && e.parent_slug ? e.parent_slug : null,
      until: e.until,
      package_slug: typeof e.package_slug === 'string' ? e.package_slug : '',
    })
  }
  return out
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
    if (destination) add({ kind: 'destinations', name: destination, slug: generateSlug(destination), parent_slug: null, origin: 'destination', scope: inferScope('destinations', destination) })
  }
  for (const p of rows) {
    if (!p.name) continue
    const kind = kindFromPackageName(p.name, p.category)
    if (!kind) continue
    const name = cleanPropertyName(p.name)
    if (!name) continue
    const parent = (kind === 'hotels' || kind === 'resorts') && p.destination ? generateSlug(p.destination) : null
    add({ kind, name, slug: generateSlug(name), parent_slug: parent || null, origin: 'package', scope: inferScope(kind, name) })
  }
  // A curated destination is skipped when a real destination already covers it ("cancun" vs "cancun-mexico").
  const realDestinations = [
    ...out.filter((c) => c.kind === 'destinations' && c.origin === 'destination').map((c) => c.slug),
    ...((existing ?? []) as { kind: string; slug: string }[]).filter((g) => g.kind === 'destinations').map((g) => g.slug),
  ]
  for (const seed of GUIDE_SEEDS) {
    const seedSlug = generateSlug(seed.name)
    const seedWords = seedSlug.split('-').join(' ')
    if (seed.kind === 'destinations' && realDestinations.some((r) => r === seedSlug || ` ${r.split('-').join(' ')} `.includes(` ${seedWords} `))) continue
    add({ kind: seed.kind, name: seed.name, slug: seedSlug, parent_slug: seed.parent_slug ?? null, origin: 'seed', scope: seed.scope ?? inferScope(seed.kind, seed.name) })
  }

  // A one-time backfill (WP16): its listed pages are marked so the guides step writes them before the normal rotation.
  // A listed page that is already written is skipped (it is in `existing`); one that is not in the list yet is added.
  // Never throws: a bad or missing value is no backfill.
  try {
    const { data } = await admin.from('app_settings').select('value').eq('key', GUIDE_BACKFILL_KEY).maybeSingle()
    const state = parseBackfillState((data as { value: string | null } | null)?.value)
    if (state && !state.cancelled_at) {
      for (const e of state.entries) {
        const key = `${e.kind}:${e.slug}`
        if (taken.has(key) && !out.some((c) => c.kind === e.kind && c.slug === e.slug)) continue
        const found = out.find((c) => c.kind === e.kind && c.slug === e.slug)
        if (found) found.backfill = true
        else out.push({ kind: e.kind, name: e.name, slug: e.slug, parent_slug: e.parent_slug, origin: e.origin, scope: e.scope, backfill: true })
      }
    }
  } catch {
    // the backfill list is optional
  }

  // Promoted packages (WP15): their guides go to the front. A guide that is already written is not a candidate
  // (it is in `existing`); one that is already in the list is only marked; a new one is added. Never throws.
  try {
    const { data } = await admin.from('app_settings').select('value').eq('key', GUIDE_PRIORITY_KEY).maybeSingle()
    const written = new Set(((existing ?? []) as { kind: string; slug: string }[]).map((g) => `${g.kind}:${g.slug}`))
    for (const p of parseGuidePriority((data as { value: string | null } | null)?.value)) {
      const key = `${p.kind}:${p.slug}`
      if (written.has(key)) continue
      const found = out.find((c) => c.kind === p.kind && c.slug === p.slug)
      if (found) found.priority = true
      else out.push({ kind: p.kind, name: p.name, slug: p.slug, parent_slug: p.parent_slug, origin: p.kind === 'destinations' ? 'destination' : 'package', priority: true })
    }
  } catch {
    // the priority list is optional
  }
  return out
}
