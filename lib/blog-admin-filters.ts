// Pure filter / sort / paging / URL helpers for the admin Posts list. No database, no React.
// Nothing here invents data: a post with no linked trip simply has blank supplier / city / country,
// and a filter on those fields excludes it.

export const POST_TYPES = ['blog', 'news', 'trip', 'guide', 'recap'] as const
export type PostType = (typeof POST_TYPES)[number]
export const TYPE_LABEL: Record<PostType, string> = { blog: 'Blog post', news: 'News', trip: 'Trip-linked', guide: 'Guide-linked', recap: 'Trip recap' }

export const SORTS = ['date', 'name', 'type', 'supplier', 'city', 'country'] as const
export type PostSort = (typeof SORTS)[number]
export const PAGE_SIZE = 50

/** The fields of a post the list needs. */
export interface AdminPostInput {
  id: string
  title: string
  slug: string
  status: 'draft' | 'published'
  publish_date: string | null
  created_at: string
  tags: string[]
  related_package_id: string | null
  primary_keyword?: string | null
  secondary_keywords?: string[] | null
}

/** Server-joined facts about a post (all optional, blank when unknown). */
export interface AdminPostMeta {
  supplier?: string | null
  city?: string | null
  country?: string | null
  /** news_items.source_key for a news post. */
  newsSourceKey?: string | null
  newsSourceName?: string | null
}

export interface AdminPostRow extends AdminPostInput {
  type: PostType
  date: string
  supplier: string
  city: string
  country: string
  source: string
  keywords: string[]
}

/** Type from the slug prefix, tags and linked trip. Order matters: news and guide and recap win over a trip link. */
export function derivePostType(p: Pick<AdminPostInput, 'slug' | 'tags' | 'related_package_id'>): PostType {
  const tags = (p.tags ?? []).map((t) => String(t).toLowerCase())
  const slug = (p.slug ?? '').toLowerCase()
  if (slug.startsWith('news-') || tags.includes('travel-news')) return 'news'
  if (slug.startsWith('guide-') || tags.includes('guide')) return 'guide'
  if (slug.startsWith('recap-') || tags.includes('recap') || tags.includes('trip-recap')) return 'recap'
  if (p.related_package_id) return 'trip'
  return 'blog'
}

export function buildRow(p: AdminPostInput, meta: AdminPostMeta | undefined): AdminPostRow {
  const m = meta ?? {}
  return {
    ...p,
    tags: p.tags ?? [],
    type: derivePostType(p),
    date: (p.publish_date || p.created_at || '').slice(0, 10),
    supplier: (m.supplier ?? '').trim(),
    city: (m.city ?? '').trim(),
    country: (m.country ?? '').trim(),
    source: (m.newsSourceName ?? m.newsSourceKey ?? '').trim(),
    keywords: [p.primary_keyword ?? '', ...(p.secondary_keywords ?? [])].filter(Boolean),
  }
}

export interface PostQuery {
  q: string
  status: 'all' | 'published' | 'draft'
  type: '' | PostType
  supplier: string
  city: string
  country: string
  from: string
  to: string
  sort: PostSort
  dir: 'asc' | 'desc'
  page: number
}

export const DEFAULT_POST_QUERY: PostQuery = { q: '', status: 'all', type: '', supplier: '', city: '', country: '', from: '', to: '', sort: 'date', dir: 'desc', page: 1 }

const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s)

type Params = { get(name: string): string | null }

/** URL query -> PostQuery. Anything invalid falls back to the default, so a hand-edited URL never breaks the page. */
export function parsePostQuery(params: Params): PostQuery {
  const d = DEFAULT_POST_QUERY
  const status = params.get('status')
  const type = params.get('type') ?? ''
  const sort = params.get('sort') ?? ''
  const dir = params.get('dir')
  const from = params.get('from') ?? ''
  const to = params.get('to') ?? ''
  const page = Math.floor(Number(params.get('page')))
  return {
    q: (params.get('q') ?? '').slice(0, 200),
    status: status === 'published' || status === 'draft' ? status : d.status,
    type: (POST_TYPES as readonly string[]).includes(type) ? (type as PostType) : '',
    supplier: (params.get('supplier') ?? '').slice(0, 120),
    city: (params.get('city') ?? '').slice(0, 120),
    country: (params.get('country') ?? '').slice(0, 120),
    from: isDate(from) ? from : '',
    to: isDate(to) ? to : '',
    sort: (SORTS as readonly string[]).includes(sort) ? (sort as PostSort) : d.sort,
    dir: dir === 'asc' || dir === 'desc' ? dir : d.dir,
    page: Number.isFinite(page) && page >= 1 ? page : 1,
  }
}

/** PostQuery -> query string pieces, omitting defaults so the URL stays short. */
export function serializePostQuery(q: PostQuery): URLSearchParams {
  const d = DEFAULT_POST_QUERY
  const out = new URLSearchParams()
  if (q.q) out.set('q', q.q)
  if (q.status !== d.status) out.set('status', q.status)
  if (q.type) out.set('type', q.type)
  if (q.supplier) out.set('supplier', q.supplier)
  if (q.city) out.set('city', q.city)
  if (q.country) out.set('country', q.country)
  if (q.from) out.set('from', q.from)
  if (q.to) out.set('to', q.to)
  if (q.sort !== d.sort) out.set('sort', q.sort)
  if (q.dir !== d.dir) out.set('dir', q.dir)
  if (q.page > 1) out.set('page', String(q.page))
  return out
}

const eqi = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

export function filterPosts(rows: AdminPostRow[], q: PostQuery): AdminPostRow[] {
  const needle = q.q.trim().toLowerCase()
  return rows.filter((r) => {
    if (q.status !== 'all' && r.status !== q.status) return false
    if (q.type && r.type !== q.type) return false
    if (q.supplier && !eqi(r.supplier, q.supplier)) return false
    if (q.city && !eqi(r.city, q.city)) return false
    if (q.country && !eqi(r.country, q.country)) return false
    if (q.from && (!r.date || r.date < q.from)) return false
    if (q.to && (!r.date || r.date > q.to)) return false
    if (needle) {
      const hay = [r.title, r.slug, ...r.keywords].join(' ').toLowerCase()
      if (!hay.includes(needle)) return false
    }
    return true
  })
}

/** Stable sort; blank values always sort last whichever way the list is ordered. */
export function sortPosts(rows: AdminPostRow[], sort: PostSort, dir: 'asc' | 'desc'): AdminPostRow[] {
  const key = (r: AdminPostRow): string => {
    switch (sort) {
      case 'name': return r.title.toLowerCase()
      case 'type': return r.type
      case 'supplier': return r.supplier.toLowerCase()
      case 'city': return r.city.toLowerCase()
      case 'country': return r.country.toLowerCase()
      default: return r.date
    }
  }
  const sign = dir === 'asc' ? 1 : -1
  return rows
    .map((r, i) => ({ r, i, k: key(r) }))
    .sort((a, b) => {
      if (!a.k && !b.k) return a.i - b.i
      if (!a.k) return 1
      if (!b.k) return -1
      const c = a.k < b.k ? -1 : a.k > b.k ? 1 : 0
      return c !== 0 ? c * sign : a.i - b.i
    })
    .map((x) => x.r)
}

export function paginate<T>(rows: T[], page: number, size: number = PAGE_SIZE): { items: T[]; page: number; pages: number; total: number } {
  const pages = Math.max(1, Math.ceil(rows.length / size))
  const p = Math.min(Math.max(1, page), pages)
  return { items: rows.slice((p - 1) * size, p * size), page: p, pages, total: rows.length }
}

/** Distinct non-blank values of a field, sorted, for the filter dropdowns. */
export function distinctValues(rows: AdminPostRow[], field: 'supplier' | 'city' | 'country'): string[] {
  const seen = new Map<string, string>()
  for (const r of rows) {
    const v = r[field]
    if (v && !seen.has(v.toLowerCase())) seen.set(v.toLowerCase(), v)
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b))
}

// ---------------------------------------------------------------------------------------------------
// Bulk actions
// ---------------------------------------------------------------------------------------------------

export const BULK_ACTIONS = ['publish', 'unpublish', 'delete'] as const
export type BulkAction = (typeof BULK_ACTIONS)[number]
export const BULK_MAX_IDS = 200

/** Validates a bulk request body. Ids are de-duplicated and must look like uuids. */
export function parseBulkRequest(body: unknown): { ok: true; action: BulkAction; ids: string[] } | { ok: false; error: string } {
  const b = (body ?? {}) as { action?: unknown; ids?: unknown }
  if (typeof b.action !== 'string' || !(BULK_ACTIONS as readonly string[]).includes(b.action)) return { ok: false, error: 'action must be publish, unpublish or delete' }
  if (!Array.isArray(b.ids) || b.ids.length === 0) return { ok: false, error: 'ids must be a non-empty list' }
  const ids = [...new Set(b.ids.filter((x): x is string => typeof x === 'string' && /^[0-9a-f-]{8,64}$/i.test(x)))]
  if (ids.length !== new Set(b.ids).size) return { ok: false, error: 'ids contained an invalid value' }
  if (ids.length > BULK_MAX_IDS) return { ok: false, error: `at most ${BULK_MAX_IDS} posts per request` }
  return { ok: true, action: b.action as BulkAction, ids }
}

/** The post patch for publish / unpublish. A post published with no date gets today's date so it is not hidden by a null date. */
export function statusPatch(action: 'publish' | 'unpublish', current: { publish_date: string | null }, todayIso: string): { status: 'published' | 'draft'; publish_date?: string } {
  if (action === 'unpublish') return { status: 'draft' }
  return current.publish_date ? { status: 'published' } : { status: 'published', publish_date: todayIso.slice(0, 10) }
}
