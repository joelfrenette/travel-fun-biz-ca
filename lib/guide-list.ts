import { SCOPE_LABEL, parseScope, scopeOf, GUIDE_SCOPES, type GuideScope } from '@/lib/guide-scope'

// The admin "Pages" list at /admin/guides (growth loop WP16, part 3): one table of every guide, with search, sort,
// filters and pages, all decided here in plain code so the server route and the offline check use the same rules.
// No database and no browser APIs in this file.

export const LIST_SORTS = ['name', 'kind', 'scope', 'status', 'updated', 'words', 'score', 'inbound', 'clicks'] as const
export type ListSort = (typeof LIST_SORTS)[number]
export const LIST_STATUSES = ['all', 'published', 'draft', 'review', 'rejected'] as const
export type ListStatus = (typeof LIST_STATUSES)[number]
export const PAGE_SIZES = [25, 50, 100] as const
/** The note lib/guide-run.ts saves on a page whose checks were clean but that waits because the site is in review mode. */
export const MODE_HOLD_NOTE = 'held for review (guides_publish_mode=draft)'

/** One line of the table. */
export interface GuideListRow {
  id: string
  kind: string
  slug: string
  name: string
  parent_slug: string | null
  /** The stored scope. */
  scope: GuideScope | null
  status: 'draft' | 'published'
  source: 'ai' | 'manual'
  review_state: 'rejected' | null
  quality_notes: string | null
  updated_at: string
  words: number
  /** The stored SEO score (the daily heal writes it), or null when the page has not been scored yet. */
  score: number | null
  inbound: number
  /** Search Console clicks, trailing 28 days, from the latest performance snapshot; null when none was recorded. */
  clicks: number | null
  /** Public path, for the View link. */
  path: string
  primary_keyword: string | null
}

export interface ListQuery {
  q: string
  sort: ListSort
  dir: 'asc' | 'desc'
  kind: string
  scope: GuideScope | 'none' | ''
  status: ListStatus
  /** Only live pages that nothing links to (inbound is 0). A page whose links could not be counted (inbound -1) is not listed. */
  orphans: boolean
  page: number
  pageSize: number
}

export const DEFAULT_QUERY: ListQuery = { q: '', sort: 'updated', dir: 'desc', kind: '', scope: '', status: 'all', orphans: false, page: 1, pageSize: 50 }

type Params = { get(name: string): string | null }

/** A query from URL parameters. Anything unknown or out of range falls back to the default, so a hand-typed URL can never break the list. */
export function parseListQuery(params: Params, validKinds: readonly string[]): ListQuery {
  const get = (k: string) => params.get(k) ?? ''
  const sort = LIST_SORTS.find((s) => s === get('sort')) ?? DEFAULT_QUERY.sort
  const status = LIST_STATUSES.find((s) => s === get('status')) ?? DEFAULT_QUERY.status
  const kind = validKinds.includes(get('kind')) ? get('kind') : ''
  const rawScope = get('scope')
  const scope: ListQuery['scope'] = rawScope === 'none' ? 'none' : parseScope(rawScope) ?? ''
  const pageSize = PAGE_SIZES.find((n) => n === Number(get('pageSize'))) ?? DEFAULT_QUERY.pageSize
  const page = Math.max(1, Math.min(10_000, Math.floor(Number(get('page'))) || 1))
  return { q: get('q').trim().slice(0, 80), sort, dir: get('dir') === 'asc' ? 'asc' : get('dir') === 'desc' ? 'desc' : defaultDir(sort), kind, scope, status, orphans: get('orphans') === '1', page, pageSize }
}

/** Names and dates read best A to Z / newest first; numbers read best biggest first. */
export function defaultDir(sort: ListSort): 'asc' | 'desc' {
  return sort === 'name' || sort === 'kind' || sort === 'scope' || sort === 'status' ? 'asc' : 'desc'
}

/** Word count of a page's opening and sections. */
export function wordCountOf(summary: string, body: string): number {
  return `${summary} ${body}`.replace(/[#*_>`[\]()-]+/g, ' ').trim().split(/\s+/).filter(Boolean).length
}

/** A draft written by the AI that nobody has turned down yet: the review queue. */
export function inReviewQueue(row: Pick<GuideListRow, 'status' | 'source' | 'review_state'>): boolean {
  return row.status === 'draft' && row.source === 'ai' && row.review_state !== 'rejected'
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

function searchText(row: GuideListRow, kindLabel: (kind: string) => string): string {
  const s = scopeOf(row)
  return norm([row.name, row.slug, row.parent_slug ?? '', row.kind, kindLabel(row.kind), s ? SCOPE_LABEL[s] : '', row.primary_keyword ?? ''].join(' '))
}

function matchesFilters(row: GuideListRow, q: ListQuery, kindLabel: (kind: string) => string): boolean {
  if (q.kind && row.kind !== q.kind) return false
  if (q.scope === 'none' ? scopeOf(row) !== null : q.scope && scopeOf(row) !== q.scope) return false
  if (q.orphans && !(row.status === 'published' && row.inbound === 0)) return false
  if (q.status === 'published' && row.status !== 'published') return false
  if (q.status === 'draft' && row.status !== 'draft') return false
  if (q.status === 'review' && !inReviewQueue(row)) return false
  if (q.status === 'rejected' && !(row.status === 'draft' && row.review_state === 'rejected')) return false
  if (q.q) {
    const hay = searchText(row, kindLabel)
    if (!norm(q.q).split(' ').filter(Boolean).every((t) => hay.includes(t))) return false
  }
  return true
}

/** The value a column sorts by. Strings sort case-insensitively. A null (not scored, no clicks) sorts last in both directions. */
function sortValue(row: GuideListRow, sort: ListSort): string | number | null {
  switch (sort) {
    case 'name': return row.name.toLowerCase()
    case 'kind': return row.kind
    case 'scope': return scopeOf(row) ?? null
    case 'status': return row.status === 'published' ? 'published' : inReviewQueue(row) ? 'review' : 'draft'
    case 'updated': return Date.parse(row.updated_at) || 0
    case 'words': return row.words
    case 'score': return row.score
    case 'inbound': return row.inbound
    case 'clicks': return row.clicks
  }
}

export interface ListResult {
  rows: GuideListRow[]
  total: number
  page: number
  pages: number
  /** Counts for the filter chips, before the status filter (so the chips do not change as you click them). */
  statusCounts: Record<ListStatus, number>
}

/** Filters, searches, sorts and pages the rows. Pure. Ties always break on name so the order is stable. */
export function queryGuideRows(rows: GuideListRow[], query: ListQuery, kindLabel: (kind: string) => string = (k) => k): ListResult {
  const withoutStatus = rows.filter((r) => matchesFilters(r, { ...query, status: 'all' }, kindLabel))
  const statusCounts: Record<ListStatus, number> = {
    all: withoutStatus.length,
    published: withoutStatus.filter((r) => r.status === 'published').length,
    draft: withoutStatus.filter((r) => r.status === 'draft').length,
    review: withoutStatus.filter(inReviewQueue).length,
    rejected: withoutStatus.filter((r) => r.status === 'draft' && r.review_state === 'rejected').length,
  }
  const filtered = withoutStatus.filter((r) => matchesFilters(r, { ...query, q: '', kind: '', scope: '' }, kindLabel))
  const dir = query.dir === 'asc' ? 1 : -1
  const sorted = [...filtered].sort((a, b) => {
    const va = sortValue(a, query.sort)
    const vb = sortValue(b, query.sort)
    if (va === null && vb !== null) return 1
    if (vb === null && va !== null) return -1
    if (va !== null && vb !== null && va !== vb) return (va < vb ? -1 : 1) * dir
    return a.name.localeCompare(b.name)
  })
  const pages = Math.max(1, Math.ceil(sorted.length / query.pageSize))
  const page = Math.min(query.page, pages)
  return { rows: sorted.slice((page - 1) * query.pageSize, page * query.pageSize), total: sorted.length, page, pages, statusCounts }
}

/** Which of the chosen ids a bulk "Publish" may touch: drafts that the checks did not hold back (no quality notes) and
 * nobody rejected. Everything else is returned under `skipped` with the reason, so a held-back page is never published
 * in bulk. Pure. */
export function bulkPublishable(rows: Pick<GuideListRow, 'id' | 'name' | 'status' | 'quality_notes' | 'review_state'>[]): { ok: string[]; skipped: { id: string; name: string; reason: string }[] } {
  const ok: string[] = []
  const skipped: { id: string; name: string; reason: string }[] = []
  for (const r of rows) {
    if (r.status !== 'draft') skipped.push({ id: r.id, name: r.name, reason: 'already live' })
    else if (r.review_state === 'rejected') skipped.push({ id: r.id, name: r.name, reason: 'was rejected' })
    // The one note that means "the checks were clean, the site was only in review mode" does not hold a page back.
    else if (r.quality_notes && r.quality_notes.trim() && r.quality_notes.trim() !== MODE_HOLD_NOTE) skipped.push({ id: r.id, name: r.name, reason: `held back: ${r.quality_notes.slice(0, 80)}` })
    else ok.push(r.id)
  }
  return { ok, skipped }
}

export { GUIDE_SCOPES }
