import type { SupabaseClient } from '@supabase/supabase-js'
import { GUIDE_KINDS, guideKinds, guidePath, type GuideKind } from '@/lib/guides'

// What the social-posting pass needs to know about a guide row in post_distribution (migration 0030: a row
// whose `path` is set refers to a guide page, not a blog post). Kept in its own file with no import of
// lib/distribution.ts, so distribution.ts can use it without a circular import. Enrolment is in
// lib/guide-distribution.ts.

/** The ledger slug of a guide: `guide-<kind>-<slug>`. Also the UTM campaign of every link posted for it. */
export function guideDistributionSlug(kind: GuideKind, slug: string): string {
  return `guide-${kind}-${slug}`
}

/** The public path stored in the ledger row. Same as the page's real address. */
export function guideDistributionPath(kind: GuideKind, slug: string): string {
  return guidePath(kind, slug)
}

/** Which guide a ledger path points at, or null when it is not the address of a guide (so a bad path can
 * never turn into a link to somewhere else). */
export function guideFromPath(path: string): { kind: GuideKind; slug: string } | null {
  for (const kind of GUIDE_KINDS) {
    const prefix = `${guideKinds[kind].urlPrefix}/`
    if (!path.startsWith(prefix)) continue
    const slug = path.slice(prefix.length)
    if (!slug || slug.includes('/') || slug.includes('?') || slug.includes('#')) return null
    return { kind, slug }
  }
  return null
}

/** The fields runDistributionLocked reads from a blog post, taken from a guide instead. */
export interface GuidePostSource {
  title: string
  cover_image_url: string | null
  meta_description: string | null
  /** Takeaways and FAQ as plain text, so numbers in them count as real when captions are checked. */
  grounding: string | undefined
}

/** The published guide at `path`, shaped like the post fields the posting pass reads. Returns null when the
 * path is not a guide address, or the guide is gone or no longer published (the caller then sends nothing).
 * Throws on a database error, so a read failure is retried like any other failure and not mistaken for
 * "unpublished". */
export async function loadGuidePostSource(admin: SupabaseClient, path: string): Promise<GuidePostSource | null> {
  const ref = guideFromPath(path)
  if (!ref) return null
  const { data, error } = await admin
    .from('guides')
    .select('name, summary, hero_image_url, og_title, meta_description, faq, key_takeaways, status')
    .eq('kind', ref.kind)
    .eq('slug', ref.slug)
    .maybeSingle()
  if (error) throw new Error(`guides: ${error.message}`)
  if (!data || data.status !== 'published') return null
  const faq = Array.isArray(data.faq) ? (data.faq as Array<{ q?: unknown; a?: unknown }>).map((f) => `${typeof f.q === 'string' ? f.q : ''} ${typeof f.a === 'string' ? f.a : ''}`.trim()) : []
  const takeaways = Array.isArray(data.key_takeaways) ? (data.key_takeaways as unknown[]).filter((t): t is string => typeof t === 'string') : []
  const grounding = [...takeaways.map((t) => `- ${t}`), ...faq.map((f) => `- ${f}`)].join('\n').slice(0, 1500)
  const name = typeof data.name === 'string' ? data.name : ''
  const ogTitle = typeof data.og_title === 'string' ? data.og_title.trim() : ''
  const description = (typeof data.meta_description === 'string' && data.meta_description.trim()) || (typeof data.summary === 'string' ? data.summary : '')
  return {
    title: ogTitle || name,
    cover_image_url: typeof data.hero_image_url === 'string' && data.hero_image_url ? data.hero_image_url : null,
    meta_description: description || null,
    grounding: grounding || undefined,
  }
}
