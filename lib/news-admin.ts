import { parseSourcesOff, FEED_FAIL_LIMIT } from '@/lib/news-sources'

// Pure helpers for the /admin/news screen. No database, no network.

/** The new value of the news_sources_off setting after switching one source off or on. Keeps every other key that was
 * already off (including keys of sources no longer in the allowlist), de-duplicated and sorted so the stored text is stable.
 * Only a valid key (lower-case letters, digits, dashes) is accepted; anything else returns null and the setting is not written. */
export function applySourceToggle(current: string | null | undefined, key: string, off: boolean): string | null {
  const k = String(key ?? '').trim().toLowerCase()
  if (!/^[a-z0-9-]{2,40}$/.test(k)) return null
  const set = parseSourcesOff(current)
  if (off) set.add(k)
  else set.delete(k)
  return [...set].sort().join(',')
}

export type SourceHealth = 'off' | 'blocked' | 'failing' | 'warning' | 'ok' | 'waiting'

export interface SourceStateLite {
  fails: number
  lastError?: string
  lastOkAt?: string
  lastFetchAt?: string
  robotsAllowed?: boolean
}

/** How a source should look in the table. A 403, a robots.txt refusal or "blocked" wording is shown as blocked (we do not work
 * around a block: the fix is the OFF switch). Three failures in a row is failing; one or two is a warning. */
export function sourceHealth(off: boolean, st: SourceStateLite): SourceHealth {
  if (off) return 'off'
  const err = st.lastError ?? ''
  if (st.fails > 0 && (/\b403\b|forbidden|blocked|robots/i.test(err) || st.robotsAllowed === false)) return 'blocked'
  if (st.fails >= FEED_FAIL_LIMIT) return 'failing'
  if (st.fails > 0) return 'warning'
  if (st.lastOkAt) return 'ok'
  return 'waiting'
}

export const HEALTH_LABEL: Record<SourceHealth, string> = {
  off: 'Off',
  blocked: 'Blocked by the site',
  failing: 'Failing',
  warning: 'Last read failed',
  ok: 'Working',
  waiting: 'Not read yet',
}

export const SOURCE_TYPE_LABEL = { feed: 'RSS / Atom feed', json: 'JSON snapshot (plain-code template)' } as const
export const sourceTypeLabel = (kind: 'feed' | 'json' | undefined): string => SOURCE_TYPE_LABEL[kind === 'json' ? 'json' : 'feed']

// ---------------------------------------------------------------------------------------------------
// Items table
// ---------------------------------------------------------------------------------------------------

export const NEWS_STATUSES = ['new', 'queued', 'published', 'rejected', 'expired'] as const
export type NewsItemStatus = (typeof NEWS_STATUSES)[number]

export interface NewsItemView {
  id: string
  source_key: string
  title: string
  url: string
  status: string
  category: string
  published_at: string | null
  fetched_at: string
  reject_reason: string | null
  post_slug: string | null
}

export function countByStatus(items: { status: string }[]): Record<string, number> {
  const out: Record<string, number> = { new: 0, queued: 0, published: 0, rejected: 0, expired: 0 }
  for (const i of items) out[i.status] = (out[i.status] ?? 0) + 1
  return out
}

export const ITEM_SORTS = ['when', 'title', 'source', 'status'] as const
export type ItemSort = (typeof ITEM_SORTS)[number]

export interface ItemQuery {
  q: string
  status: string
  source: string
  sort: ItemSort
  dir: 'asc' | 'desc'
}

export const DEFAULT_ITEM_QUERY: ItemQuery = { q: '', status: '', source: '', sort: 'when', dir: 'desc' }

const whenOf = (i: NewsItemView) => i.published_at || i.fetched_at || ''

export function filterSortItems(items: NewsItemView[], q: ItemQuery, sourceName: (key: string) => string = (k) => k): NewsItemView[] {
  const needle = q.q.trim().toLowerCase()
  const kept = items.filter((i) => {
    if (q.status && i.status !== q.status) return false
    if (q.source && i.source_key !== q.source) return false
    if (needle && !`${i.title} ${i.reject_reason ?? ''} ${i.post_slug ?? ''}`.toLowerCase().includes(needle)) return false
    return true
  })
  const key = (i: NewsItemView): string => {
    switch (q.sort) {
      case 'title': return i.title.toLowerCase()
      case 'source': return sourceName(i.source_key).toLowerCase()
      case 'status': return i.status
      default: return whenOf(i)
    }
  }
  const sign = q.dir === 'asc' ? 1 : -1
  return kept
    .map((i, idx) => ({ i, idx, k: key(i) }))
    .sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0) * sign || a.idx - b.idx)
    .map((x) => x.i)
}
