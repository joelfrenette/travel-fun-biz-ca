import type { SupabaseClient } from '@supabase/supabase-js'
import { groundAngleInPackage, type PackageGrounding } from '@/lib/blog-topics'
import { qualityBlockers, type QualityPost } from '@/lib/blog-quality'
import { isNewsSlug } from '@/lib/news-post'

// "Posts below quality bar: N" on the Posts: Blog Automation card (loop-blog-quality). READ ONLY: it scores the published blog posts with
// the same gates the writer and the weekly refresh use (lib/blog-quality.ts) and writes nothing.

type Row = Record<string, unknown>
const str = (v: unknown) => (typeof v === 'string' ? v : '')
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
const faqList = (v: unknown): { q: string; a: string }[] =>
  Array.isArray(v) ? v.filter((x): x is { q: string; a: string } => !!x && typeof (x as { q?: unknown }).q === 'string' && typeof (x as { a?: unknown }).a === 'string').map((x) => ({ q: x.q, a: x.a })) : []

const firstPackageSlug = (body: string): string | null => /\/packages\/([a-z0-9][a-z0-9-]*)/i.exec(body)?.[1] ?? null

export interface BelowBar {
  /** Published blog posts that fail at least one quality gate. */
  count: number
  /** Published blog posts that were scored. */
  total: number
}

/** Pure: how many of these published post rows fail the quality bar. `packages` are the published trips (for the facts a claim must match). */
export function countBelowBar(rows: Row[], packages: PackageGrounding[], now: Date = new Date()): BelowBar {
  const bySlug = new Map(packages.map((p) => [p.slug, p]))
  let count = 0
  for (const row of rows) {
    const body = str(row.body)
    const base = [str(row.primary_keyword), ...strList(row.secondary_keywords)].filter(Boolean).join(' ')
    const slug = firstPackageSlug(body)
    const pkg = slug ? bySlug.get(slug) ?? null : null
    const post: QualityPost = {
      title: str(row.title),
      body,
      faq: faqList(row.faq),
      primary_keyword: str(row.primary_keyword),
      content_style: str(row.content_style),
      seo_title: str(row.meta_title),
      seo_description: str(row.meta_description),
      og_title: str(row.og_title),
      og_description: str(row.og_description),
      key_takeaways: strList(row.key_takeaways),
    }
    const groundingText = pkg ? `${groundAngleInPackage(base, pkg)} ${base}` : base
    if (qualityBlockers(post, { now, groundingText, tripDates: pkg ? { from: pkg.available_from, to: pkg.available_to } : null }).length > 0) count++
  }
  return { count, total: rows.length }
}

/** Reads the published posts and trips and counts. Throws on a read problem, so the caller can show "could not be read" instead of a false zero. */
export async function postsBelowQualityBar(admin: SupabaseClient, now: Date = new Date()): Promise<BelowBar> {
  const today = now.toISOString().slice(0, 10)
  const { data: posts, error } = await admin.from('posts').select('*').eq('status', 'published').limit(500)
  if (error) throw new Error(error.message)
  const { data: pk, error: pkError } = await admin.from('travel_packages').select('name, slug, destination, short_description, full_description, highlights, available_from, available_to').eq('status', 'published').limit(300)
  if (pkError) throw new Error(pkError.message)
  const live = ((posts ?? []) as Row[]).filter((r) => !isNewsSlug(str(r.slug)) && (!str(r.publish_date) || str(r.publish_date).slice(0, 10) <= today))
  return countBelowBar(live, (pk ?? []) as PackageGrounding[], now)
}
