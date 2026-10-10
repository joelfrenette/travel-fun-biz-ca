import type { SupabaseClient } from '@supabase/supabase-js'
import { generateSlug } from '@/lib/utils'

// Not imported from lib/guides.ts on purpose: the admin pages (client components) import this file, and they
// should not pull the guide writer's data layer into the browser bundle. A guide's URL prefix is its kind.
const GUIDE_KIND_PATHS = ['destinations', 'hotels', 'resorts', 'cruise-lines', 'ships', 'river-cruises', 'yachts']

// Every page of this site that can rank in Google and can be a keyword's target: the home page, every
// travel package, every destination page (one per distinct destination of a published package) and every
// published blog post. One list, used by the Keyword Research dropdown, the Search Rankings page and the
// automatic keyword-to-page connection, so they can never disagree about what pages exist.
export type PageType = 'home' | 'package' | 'destination' | 'blog' | 'guide'

export interface SitePage {
  path: string
  title: string
  type: PageType
  /** Only for packages: a draft or hidden trip is listed (it can be a target) but labelled. */
  status?: string
}

export const PAGE_TYPE_LABEL: Record<PageType, string> = { home: 'Home page', package: 'Packages', destination: 'Destinations', blog: 'Blog posts', guide: 'Guides' }

export function pageTypeOf(path: string): PageType | null {
  const p = path.replace(/\/+$/, '') || '/'
  if (p === '/') return 'home'
  if (/^\/packages\/[^/]+$/.test(p)) return 'package'
  if (/^\/destinations\/[^/]+$/.test(p)) return 'destination'
  if (/^\/blog\/[^/]+$/.test(p)) return 'blog'
  // Hotel, resort, cruise line, ship, river cruise and yacht guides (destination guides live under /destinations/).
  if (/^\/(hotels|resorts|cruise-lines|ships|river-cruises|yachts)\/[^/]+$/.test(p)) return 'guide'
  return null
}

/** Every package, destination and published blog post, plus the home page. Never throws: a table that
 * cannot be read just contributes no pages. */
export async function listSitePages(admin: SupabaseClient): Promise<SitePage[]> {
  const pages: SitePage[] = [{ path: '/', title: 'Home page', type: 'home' }]

  const { data: packages } = await admin.from('travel_packages').select('name, slug, destination, status').order('name')
  const rows = (packages ?? []) as { name: string | null; slug: string | null; destination: string | null; status: string | null }[]
  for (const p of rows) {
    if (p.slug) pages.push({ path: `/packages/${p.slug}`, title: p.name || p.slug, type: 'package', status: p.status ?? undefined })
  }

  // One destination page per distinct destination of a PUBLISHED package (same rule as the site itself).
  const seen = new Set<string>()
  for (const p of rows.filter((r) => r.status === 'published')) {
    const slug = p.destination ? generateSlug(p.destination) : ''
    if (slug && !seen.has(slug)) {
      seen.add(slug)
      pages.push({ path: `/destinations/${slug}`, title: p.destination as string, type: 'destination' })
    }
  }

  // Published guides: a destination guide is a destination page (also when no package goes there yet), every
  // other kind is a guide page.
  const { data: guides } = await admin.from('guides').select('kind, slug, name').eq('status', 'published').order('name')
  for (const g of (guides ?? []) as { kind: string; slug: string | null; name: string | null }[]) {
    if (!g.slug || !GUIDE_KIND_PATHS.includes(g.kind)) continue
    const path = `/${g.kind}/${g.slug}`
    if (pages.some((p) => p.path === path)) continue
    pages.push({ path, title: g.name || g.slug, type: g.kind === 'destinations' ? 'destination' : 'guide' })
  }

  const { data: posts } = await admin.from('posts').select('title, slug').eq('status', 'published').order('created_at', { ascending: false })
  for (const p of (posts ?? []) as { title: string | null; slug: string | null }[]) {
    if (p.slug) pages.push({ path: `/blog/${p.slug}`, title: p.title || p.slug, type: 'blog' })
  }
  return pages
}

const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'in', 'on', 'to', 'for', 'from', 'with', 'by', 'at', 'is', 'are', 'how', 'what', 'best', 'trip', 'trips', 'travel', 'tour', 'tours', 'vacation', 'vacations', 'near', 'me', 'cheap'])
const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/[\s-]+/).filter((w) => w.length > 2 && !STOP.has(w))

/** The best page for a keyword that does not rank yet: the one whose title or address shares the most
 * meaningful words with it. A destination or package beats a blog post on a tie (the page to sell the
 * trip). Returns null unless at least one meaningful word matches, so nothing is ever guessed blindly. */
export function suggestPage(keyword: string, pages: SitePage[]): SitePage | null {
  const kw = new Set(words(keyword))
  if (!kw.size) return null
  const rank: Record<PageType, number> = { package: 3, destination: 3, guide: 2, home: 0, blog: 1 }
  let best: { page: SitePage; score: number } | null = null
  for (const page of pages) {
    if (page.type === 'home') continue
    const hay = new Set(words(`${page.title} ${page.path}`))
    let overlap = 0
    for (const w of kw) if (hay.has(w)) overlap++
    if (!overlap) continue
    const score = overlap * 10 + rank[page.type]
    if (!best || score > best.score) best = { page, score }
  }
  return best?.page ?? null
}
