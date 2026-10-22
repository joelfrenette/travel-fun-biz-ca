import type { SupabaseClient } from '@supabase/supabase-js'
import type { AdminPostMeta } from '@/lib/blog-admin-filters'
import { sourceByKey } from '@/lib/news-sources'

/** Friendly feed name for a news_items.source_key ("the US Department of State" -> "US Department of State").
 * An unknown key (a source since removed from the allowlist) is shown as the raw key, never guessed at. */
export function friendlySourceName(key: string): string {
  const s = sourceByKey(key)
  return s ? s.name.replace(/^the /i, '') : key
}

interface PostLite {
  id: string
  slug: string
  related_package_id: string | null
}

/** Supplier, city, country (from the linked trip) and the news feed behind a news post. Read only.
 * Anything that cannot be read is simply left out (blank in the list); `problems` says why. */
export async function loadPostMeta(admin: SupabaseClient, posts: PostLite[]): Promise<{ meta: Record<string, AdminPostMeta>; problems: string[] }> {
  const meta: Record<string, AdminPostMeta> = {}
  const problems: string[] = []

  const pkgIds = [...new Set(posts.map((p) => p.related_package_id).filter((x): x is string => !!x))]
  const pkgById = new Map<string, { supplier: string | null; destination: string | null; country: string | null }>()
  for (let i = 0; i < pkgIds.length; i += 100) {
    const { data, error } = await admin.from('travel_packages').select('id, supplier, destination, country').in('id', pkgIds.slice(i, i + 100))
    if (error) {
      problems.push(`trips: ${error.message}`)
      break
    }
    for (const r of (data ?? []) as { id: string; supplier: string | null; destination: string | null; country: string | null }[]) pkgById.set(r.id, r)
  }

  const slugs = posts.map((p) => p.slug).filter(Boolean)
  const sourceBySlug = new Map<string, string>()
  for (let i = 0; i < slugs.length; i += 100) {
    const { data, error } = await admin.from('news_items').select('post_slug, source_key').in('post_slug', slugs.slice(i, i + 100))
    if (error) {
      // Before migration 0047 the table does not exist: not a problem worth a banner, the Source column is just blank.
      if (!/news_items|schema cache|does not exist/i.test(error.message)) problems.push(`news sources: ${error.message}`)
      break
    }
    for (const r of (data ?? []) as { post_slug: string | null; source_key: string }[]) if (r.post_slug && !sourceBySlug.has(r.post_slug)) sourceBySlug.set(r.post_slug, r.source_key)
  }

  for (const p of posts) {
    const pkg = p.related_package_id ? pkgById.get(p.related_package_id) : undefined
    const src = sourceBySlug.get(p.slug)
    meta[p.id] = {
      supplier: pkg?.supplier ?? null,
      // travel_packages has no separate city column: its `destination` is the place the trip is about, shown as City.
      city: pkg?.destination ?? null,
      country: pkg?.country ?? null,
      newsSourceKey: src ?? null,
      newsSourceName: src ? friendlySourceName(src) : null,
    }
  }
  return { meta, problems }
}
