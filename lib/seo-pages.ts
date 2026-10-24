import type { SupabaseClient } from '@supabase/supabase-js'
import { stems } from '@/lib/keyword-score'
import { guidePath, isGuideKind, isSafePageNote } from '@/lib/guides'

// The pages of OUR site as the SEO engines see them (lib/gsc-mining.ts, lib/cannibalization.ts, lib/hub-spoke.ts): a path, a kind, the
// words that say what the page is about, and its text. One loader, one matching rule, so the engines can never disagree about what
// "this page covers that search" means. The matching and ranking helpers here are pure.

export type SeoPageType = 'blog' | 'guide' | 'package' | 'destination'

export interface SeoPage {
  path: string
  type: SeoPageType
  title: string
  h1: string
  keywords: string[]
  /** The text of the page (markdown) for posts and guides, the description for trips. Empty when not loaded. */
  body: string
  /** True for the kinds an engine may edit by itself: published posts and guides. Trips and destination pages are only reported. */
  editable: boolean
  /** A safe (thin, noindex) guide page: never a link target and never counts as covering a search. */
  thin: boolean
}

/** Which page wins a tie: a guide, a trip or a destination page over a blog post. */
export const TYPE_PRIORITY: Record<SeoPageType, number> = { guide: 3, destination: 3, package: 3, blog: 1 }

/** A query is "covered" by a page when at least this share of its meaningful words appear in the page's title, heading, keywords or address. */
export const MATCH_THRESHOLD = 0.6

export function pageTypeOfPath(path: string): SeoPageType | null {
  const p = path.replace(/\/+$/, '') || '/'
  if (/^\/blog\/[^/]+$/.test(p)) return 'blog'
  if (/^\/packages\/[^/]+$/.test(p)) return 'package'
  if (/^\/destinations\/[^/]+$/.test(p)) return 'destination'
  if (/^\/(hotels|resorts|cruise-lines|ships|river-cruises|yachts)\/[^/]+$/.test(p)) return 'guide'
  return null
}

/** The meaningful word stems a page stands for: title, main heading, keywords and the words of its address. Pure. */
export function pageStems(page: Pick<SeoPage, 'title' | 'h1' | 'keywords' | 'path'>): Set<string> {
  const slug = page.path.split('/').pop() ?? ''
  return stems(`${page.title} ${page.h1} ${page.keywords.join(' ')} ${slug.replace(/-/g, ' ')}`)
}

/** How much of the search the page covers, 0 to 1: the share of the search's meaningful words found in the page's own words. Pure. */
export function matchScore(query: string, page: Pick<SeoPage, 'title' | 'h1' | 'keywords' | 'path'>): number {
  const q = stems(query)
  if (q.size === 0) return 0
  const have = pageStems(page)
  let hit = 0
  for (const w of q) if (have.has(w)) hit++
  return hit / q.size
}

export interface PageMatch {
  page: SeoPage
  score: number
}

/** The page that covers a search best (ties go to a guide, trip or destination over a post), or null when none reaches `min`. Pure. */
export function bestPageFor(query: string, pages: readonly SeoPage[], min: number = MATCH_THRESHOLD): PageMatch | null {
  let best: PageMatch | null = null
  for (const page of pages) {
    if (page.thin) continue
    const score = matchScore(query, page)
    if (score < min) continue
    if (!best || score > best.score || (score === best.score && TYPE_PRIORITY[page.type] > TYPE_PRIORITY[best.page.type])) best = { page, score }
  }
  return best
}

type Row = Record<string, unknown>
const str = (v: unknown) => (typeof v === 'string' ? v : '')
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

/** Every published post, guide and trip as an SeoPage. Null when any read failed (an unreadable table is never reported as "no pages"). */
export async function loadSeoPages(admin: SupabaseClient, opts: { withBodies?: boolean } = {}): Promise<SeoPage[] | null> {
  try {
    const [p, g, t] = await Promise.all([
      admin.from('posts').select('slug, title, primary_keyword, secondary_keywords, tags, body').eq('status', 'published').limit(1000),
      admin.from('guides').select('kind, slug, name, summary, body, quality_notes').eq('status', 'published').limit(1000),
      admin.from('travel_packages').select('slug, name, destination, keywords, full_description').eq('status', 'published').limit(500),
    ])
    if (p.error || g.error || t.error) return null
    const pages: SeoPage[] = []
    for (const r of (p.data ?? []) as Row[]) {
      const slug = str(r.slug)
      if (!slug) continue
      pages.push({
        path: `/blog/${slug}`,
        type: 'blog',
        title: str(r.title),
        h1: str(r.title),
        keywords: [str(r.primary_keyword), ...strList(r.secondary_keywords), ...strList(r.tags)].filter(Boolean),
        body: opts.withBodies ? str(r.body) : '',
        editable: true,
        thin: false,
      })
    }
    for (const r of (g.data ?? []) as Row[]) {
      const kind = str(r.kind)
      const slug = str(r.slug)
      if (!slug || !isGuideKind(kind)) continue
      const thin = isSafePageNote(typeof r.quality_notes === 'string' ? r.quality_notes : null)
      pages.push({
        path: guidePath(kind, slug),
        type: kind === 'destinations' ? 'destination' : 'guide',
        title: str(r.name),
        h1: str(r.name),
        keywords: [],
        body: opts.withBodies ? `${str(r.summary)}\n\n${str(r.body)}` : '',
        editable: true,
        thin,
      })
    }
    const seen = new Set(pages.map((x) => x.path))
    for (const r of (t.data ?? []) as Row[]) {
      const slug = str(r.slug)
      if (!slug) continue
      pages.push({
        path: `/packages/${slug}`,
        type: 'package',
        title: str(r.name),
        h1: str(r.name),
        keywords: [str(r.destination), ...strList(r.keywords)].filter(Boolean),
        body: opts.withBodies ? str(r.full_description) : '',
        editable: false,
        thin: false,
      })
      // A destination page exists for every destination of a published trip, unless a destination guide already is that page.
      const dest = str(r.destination)
      if (dest) {
        const dslug = dest.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
        const path = `/destinations/${dslug}`
        if (dslug && !seen.has(path)) {
          seen.add(path)
          pages.push({ path, type: 'destination', title: dest, h1: dest, keywords: [], body: '', editable: false, thin: false })
        }
      }
    }
    return pages
  } catch {
    return null
  }
}
