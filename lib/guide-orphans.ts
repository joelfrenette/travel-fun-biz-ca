import type { SupabaseClient } from '@supabase/supabase-js'
import { getSetting, setSetting } from '@/lib/app-settings'
import { internalLinkPathsOf } from '@/lib/seo-score'
import { resolveParent } from '@/lib/guide-scope'
import { guidePath, pickGuidesForPost, pickRelatedGuides, pickTopDestinationGuides, isGuideKind, type GuideKind, type GuideLink } from '@/lib/guides'
import { generateSlug } from '@/lib/utils'

// Orphan-page audit (growth loop WP16, part 4). An orphan is a published guide page that no other page of the site
// links to. Links that count:
//   - a markdown link to it in another guide's text, a blog post's text or a trip's description
//   - the page above it (its parent) lists it under "More guides", and a child page's breadcrumb links up to its parent
//   - a blog post it is about shows it in "Guides for this story" (the same matching the post page uses)
//   - another guide shows it in "Related guides" (the same pick the page makes, six at most)
//   - the home page's top-destinations block
// Links that do NOT count, because every page gets them whatever it says: the header, the footer, the kind's index
// page and the sitemap. Pure code first (so it can be tested with plain objects), then one loader.

export interface AuditGuide {
  id: string
  kind: GuideKind
  slug: string
  name: string
  parent_slug: string | null
  related_package_ids: string[]
  summary: string
  body: string
}

export interface AuditPost {
  slug: string
  title: string
  tags: string[]
  related_package_id: string | null
  body: string
}

export interface AuditTrip {
  id: string
  slug: string
  destination: string | null
  full_description: string | null
}

const keyOf = (g: { kind: string; slug: string }) => `${g.kind}:${g.slug}`

/** For each guide (key `kind:slug`), the distinct pages that link to it. A guide with an empty list is an orphan. Pure. */
export function inboundSources(guides: AuditGuide[], posts: AuditPost[], trips: AuditTrip[]): Map<string, string[]> {
  const sources = new Map<string, Set<string>>()
  for (const g of guides) sources.set(keyOf(g), new Set())
  const byPath = new Map(guides.map((g) => [guidePath(g.kind, g.slug), g]))
  const add = (target: { kind: string; slug: string }, source: string) => {
    const set = sources.get(keyOf(target))
    if (set && source !== `guide:${keyOf(target)}`) set.add(source)
  }

  // 1. Explicit markdown links in guides, posts and trips.
  for (const g of guides) {
    for (const path of internalLinkPathsOf(`${g.summary}\n${g.body}`)) {
      const hit = byPath.get(path)
      if (hit) add(hit, `guide:${keyOf(g)}`)
    }
  }
  for (const p of posts) {
    for (const path of internalLinkPathsOf(p.body)) {
      const hit = byPath.get(path)
      if (hit) add(hit, `post:${p.slug}`)
    }
  }
  for (const t of trips) {
    for (const path of internalLinkPathsOf(t.full_description ?? '')) {
      const hit = byPath.get(path)
      if (hit) add(hit, `trip:${t.slug}`)
    }
  }

  // 2. Parent and child: the parent page lists its children, and a child's breadcrumb links up to its parent.
  const nodes = guides.map((g) => ({ kind: g.kind, slug: g.slug, name: g.name, parent_slug: g.parent_slug }))
  for (const g of guides) {
    const parent = resolveParent(g, nodes)
    if (!parent) continue
    add(g, `parent:${keyOf(parent)}`)
    add(parent, `child:${keyOf(g)}`)
  }

  // 3. The pages a blog post shows as "about this story", and the related-guides block of every guide.
  const links: GuideLink[] = guides.map((g) => ({ id: g.id, kind: g.kind, slug: g.slug, name: g.name, parent_slug: g.parent_slug, summary: g.summary, related_package_ids: g.related_package_ids }))
  const destByPackageId = new Map(trips.map((t) => [t.id, t.destination ? generateSlug(t.destination) || null : null]))
  for (const p of posts) {
    const destinationSlug = p.related_package_id ? destByPackageId.get(p.related_package_id) ?? null : null
    for (const hit of pickGuidesForPost({ title: p.title, tags: p.tags, destinationSlug }, links, 3)) add(hit, `story:${p.slug}`)
  }
  for (const g of links) {
    for (const hit of pickRelatedGuides(g, links, 6)) add(hit, `related:${keyOf(g)}`)
  }

  // 4. The home page's top-destinations block.
  for (const hit of pickTopDestinationGuides(links, 6)) add(hit, 'home')

  return new Map([...sources.entries()].map(([k, v]) => [k, [...v]]))
}

export interface Orphan {
  kind: GuideKind
  slug: string
  name: string
  path: string
}

/** The guides nothing links to. Pure. */
export function findOrphans(guides: AuditGuide[], posts: AuditPost[], trips: AuditTrip[]): Orphan[] {
  const inbound = inboundSources(guides, posts, trips)
  return guides
    .filter((g) => (inbound.get(keyOf(g)) ?? []).length === 0)
    .map((g) => ({ kind: g.kind, slug: g.slug, name: g.name, path: guidePath(g.kind, g.slug) }))
    .sort((a, b) => a.path.localeCompare(b.path))
}

/** How many pages link to each guide, keyed `kind:slug`, for the admin list. Pure. */
export function inboundCounts(guides: AuditGuide[], posts: AuditPost[], trips: AuditTrip[]): Map<string, number> {
  return new Map([...inboundSources(guides, posts, trips)].map(([k, v]) => [k, v.length]))
}

// ---------------------------------------------------------------------------------------------------
// Loading (service role). The audit reads every published guide, post and trip, so Needs attention uses a stored
// result that is at most 6 hours old instead of recomputing on every open.
// ---------------------------------------------------------------------------------------------------

export const ORPHAN_AUDIT_KEY = 'guide_orphan_audit'
const AUDIT_MAX_AGE_MS = 6 * 60 * 60 * 1000

export interface AuditInputs {
  guides: AuditGuide[]
  posts: AuditPost[]
  trips: AuditTrip[]
}

/** Reads what the audit needs. Returns null when any read failed, so an unreadable table is never reported as "no links". */
export async function loadAuditInputs(admin: SupabaseClient): Promise<AuditInputs | null> {
  const [g, extras] = await Promise.all([
    admin.from('guides').select('id, kind, slug, name, parent_slug, related_package_ids, summary, body').eq('status', 'published'),
    loadPostsAndTrips(admin),
  ])
  if (g.error || !extras) return null
  return { guides: toAuditGuides((g.data ?? []) as AuditGuide[]), ...extras }
}

/** Published guide rows (any shape that has the audit fields) as audit guides. */
export function toAuditGuides(rows: AuditGuide[]): AuditGuide[] {
  return rows
    .filter((x) => isGuideKind(x.kind))
    .map((x) => ({ id: x.id, kind: x.kind, slug: x.slug, name: x.name, parent_slug: x.parent_slug ?? null, related_package_ids: x.related_package_ids ?? [], summary: x.summary ?? '', body: x.body ?? '' }))
}

/** The published posts and trips the audit counts links from. Null when either read failed. */
export async function loadPostsAndTrips(admin: SupabaseClient): Promise<{ posts: AuditPost[]; trips: AuditTrip[] } | null> {
  const [p, t] = await Promise.all([
    admin.from('posts').select('slug, title, tags, related_package_id, body').eq('status', 'published'),
    admin.from('travel_packages').select('id, slug, destination, full_description').eq('status', 'published'),
  ])
  if (p.error || t.error) return null
  return {
    posts: ((p.data ?? []) as AuditPost[]).map((x) => ({ ...x, tags: x.tags ?? [], body: x.body ?? '' })),
    trips: (t.data ?? []) as AuditTrip[],
  }
}

export interface OrphanAudit {
  at: string
  checked: number
  orphans: Orphan[]
}

/** The audit result, from the stored copy when it is fresh, else recomputed and stored. Null when it cannot be read. Never throws. */
export async function readOrphanAudit(admin: SupabaseClient, now: Date = new Date()): Promise<OrphanAudit | null> {
  try {
    const stored = await getSetting(admin, ORPHAN_AUDIT_KEY)
    if (stored) {
      const parsed = JSON.parse(stored) as OrphanAudit
      if (parsed && typeof parsed.at === 'string' && Array.isArray(parsed.orphans) && now.getTime() - Date.parse(parsed.at) < AUDIT_MAX_AGE_MS) return parsed
    }
  } catch {
    // recompute
  }
  try {
    const inputs = await loadAuditInputs(admin)
    if (!inputs) return null
    const audit: OrphanAudit = { at: now.toISOString(), checked: inputs.guides.length, orphans: findOrphans(inputs.guides, inputs.posts, inputs.trips) }
    await setSetting(admin, ORPHAN_AUDIT_KEY, JSON.stringify(audit))
    return audit
  } catch {
    return null
  }
}
