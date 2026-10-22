import {
  derivePostType, buildRow, parsePostQuery, serializePostQuery, filterPosts, sortPosts, paginate, distinctValues,
  parseBulkRequest, statusPatch, DEFAULT_POST_QUERY, BULK_MAX_IDS, type AdminPostInput, type AdminPostRow, type AdminPostMeta,
} from '../lib/blog-admin-filters'
import { applySourceToggle, sourceHealth, filterSortItems, countByStatus, DEFAULT_ITEM_QUERY, type NewsItemView } from '../lib/news-admin'
import { nextWriteDay, describeAutoblogPlan, parseLastRun } from '../lib/autoblog-summary'
import { friendlySourceName } from '../lib/blog-admin-meta'

let failed = 0
function check(name: string, ok: boolean) {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
}

const base = (o: Partial<AdminPostInput> & { id: string }): AdminPostInput => ({
  title: o.id, slug: o.id, status: 'draft', publish_date: null, created_at: '2026-01-01T00:00:00Z', tags: [], related_package_id: null, ...o,
})
const posts: AdminPostInput[] = [
  base({ id: 'aaaaaaaa-1', title: 'Rhine river cruise guide', slug: 'rhine-cruise', status: 'published', publish_date: '2026-03-10', related_package_id: 'p1', primary_keyword: 'rhine cruise' }),
  base({ id: 'aaaaaaaa-2', title: 'Hurricane Zeta update', slug: 'news-hurricane-zeta-abc123', status: 'draft', created_at: '2026-10-01T00:00:00Z', tags: ['travel-news'] }),
  base({ id: 'aaaaaaaa-3', title: 'Santorini hotel guide', slug: 'guide-hotel-santorini', status: 'published', publish_date: '2026-05-01' }),
  base({ id: 'aaaaaaaa-4', title: 'Alps recap', slug: 'alps-recap', status: 'published', publish_date: '2026-07-01', tags: ['Recap'] }),
  base({ id: 'aaaaaaaa-5', title: 'Plain tips', slug: 'plain-tips', status: 'published', publish_date: '2026-02-01', secondary_keywords: ['packing list'] }),
]
const meta: Record<string, AdminPostMeta> = {
  'aaaaaaaa-1': { supplier: 'Viking', city: 'Basel', country: 'Switzerland' },
  'aaaaaaaa-2': { newsSourceName: 'US National Hurricane Center' },
}
const rows: AdminPostRow[] = posts.map((p) => buildRow(p, meta[p.id]))
const q = (o: Partial<typeof DEFAULT_POST_QUERY>) => ({ ...DEFAULT_POST_QUERY, ...o })

// type derivation
check('type: news slug', derivePostType(posts[1]) === 'news')
check('type: guide slug', derivePostType(posts[2]) === 'guide')
check('type: recap tag (case-insensitive)', derivePostType(posts[3]) === 'recap')
check('type: linked trip', derivePostType(posts[0]) === 'trip')
check('type: plain blog', derivePostType(posts[4]) === 'blog')
check('type: news beats trip link', derivePostType({ slug: 'news-x', tags: [], related_package_id: 'p' }) === 'news')

// filters
check('search: title', filterPosts(rows, q({ q: 'rhine' })).length === 1)
check('search: slug', filterPosts(rows, q({ q: 'hurricane-zeta' })).length === 1)
check('search: secondary keyword', filterPosts(rows, q({ q: 'packing' })).map((r) => r.id).join() === 'aaaaaaaa-5')
check('search: case-insensitive', filterPosts(rows, q({ q: 'SANTORINI' })).length === 1)
check('status: published', filterPosts(rows, q({ status: 'published' })).length === 4)
check('status: draft', filterPosts(rows, q({ status: 'draft' })).length === 1)
check('type filter: news', filterPosts(rows, q({ type: 'news' })).length === 1)
check('supplier filter excludes unknown', filterPosts(rows, q({ supplier: 'viking' })).map((r) => r.id).join() === 'aaaaaaaa-1')
check('city/country filter excludes blanks', filterPosts(rows, q({ country: 'Switzerland' })).length === 1 && filterPosts(rows, q({ city: 'Nowhere' })).length === 0)
check('blank fields stay blank (never invented)', rows[2].supplier === '' && rows[2].city === '' && rows[2].country === '')
check('date range from', filterPosts(rows, q({ from: '2026-05-01' })).length === 3)
check('date range to', filterPosts(rows, q({ to: '2026-03-10' })).length === 2)
check('date range uses created_at when no publish date', rows[1].date === '2026-10-01')
check('news Source shown by friendly name, blank otherwise', rows[1].source === 'US National Hurricane Center' && rows[0].source === '')
check('friendlySourceName strips "the" and falls back to the key', friendlySourceName('us-state-dept') === 'US Department of State' && friendlySourceName('gone-source') === 'gone-source')

// sorting
check('sort date desc', sortPosts(rows, 'date', 'desc')[0].id === 'aaaaaaaa-2')
check('sort date asc', sortPosts(rows, 'date', 'asc')[0].id === 'aaaaaaaa-5')
check('sort name asc', sortPosts(rows, 'name', 'asc')[0].title === 'Alps recap')
check('sort supplier: blanks last both ways', sortPosts(rows, 'supplier', 'asc')[0].id === 'aaaaaaaa-1' && sortPosts(rows, 'supplier', 'desc')[0].id === 'aaaaaaaa-1')
check('sort is stable and does not mutate input', sortPosts(rows, 'city', 'asc').length === 5 && rows[0].id === 'aaaaaaaa-1')

// paging
const many = Array.from({ length: 120 }, (_, i) => i)
check('paginate: 50 per page, 3 pages', paginate(many, 1).pages === 3 && paginate(many, 1).items.length === 50 && paginate(many, 3).items.length === 20)
check('paginate: out of range page is clamped', paginate(many, 99).page === 3 && paginate(many, -4).page === 1)
check('paginate: empty list has one page', paginate([], 1).pages === 1)
check('distinct values sorted, no blanks', distinctValues(rows, 'country').join() === 'Switzerland')

// URL round trip
const full = q({ q: 'rhine', status: 'published', type: 'trip', supplier: 'Viking', city: 'Basel', country: 'Switzerland', from: '2026-01-01', to: '2026-12-31', sort: 'name', dir: 'asc', page: 2 })
const back = parsePostQuery(serializePostQuery(full))
check('url round trip', JSON.stringify(back) === JSON.stringify(full))
check('defaults serialize to an empty query string', serializePostQuery(DEFAULT_POST_QUERY).toString() === '')
check('bad url values fall back to defaults', JSON.stringify(parsePostQuery(new URLSearchParams('status=zzz&type=x&sort=drop&dir=up&from=notadate&page=-3'))) === JSON.stringify(DEFAULT_POST_QUERY))

// bulk request validation
const ok = parseBulkRequest({ action: 'unpublish', ids: ['abcdef12-3456', 'abcdef12-3456', 'abcdef12-9999'] })
check('bulk: valid request, duplicates removed', ok.ok && ok.ids.length === 2 && ok.action === 'unpublish')
check('bulk: unknown action rejected', !parseBulkRequest({ action: 'nuke', ids: ['abcdef12-3456'] }).ok)
check('bulk: empty ids rejected', !parseBulkRequest({ action: 'delete', ids: [] }).ok)
check('bulk: bad id rejected', !parseBulkRequest({ action: 'delete', ids: ['abcdef12-3456', "x'; drop"] }).ok)
check('bulk: too many ids rejected', !parseBulkRequest({ action: 'delete', ids: Array.from({ length: BULK_MAX_IDS + 1 }, (_, i) => `abcdef12-${String(i).padStart(4, '0')}`) }).ok)
check('bulk: non-object rejected', !parseBulkRequest(null).ok)
check('unpublish only sets draft (keeps date)', JSON.stringify(statusPatch('unpublish', { publish_date: '2026-03-10' }, '2026-10-21T00:00:00Z')) === '{"status":"draft"}')
check('publish keeps an existing date', JSON.stringify(statusPatch('publish', { publish_date: '2026-03-10' }, '2026-10-21T00:00:00Z')) === '{"status":"published"}')
check('publish fills a missing date with today', statusPatch('publish', { publish_date: null }, '2026-10-21T08:00:00Z').publish_date === '2026-10-21')

// news source toggle (news_sources_off)
check('toggle off adds a key', applySourceToggle('', 'skift', true) === 'skift')
check('toggle off keeps others, sorted, de-duplicated', applySourceToggle('us-state-dept, skift', 'cruise-hive', true) === 'cruise-hive,skift,us-state-dept' && applySourceToggle('skift', 'skift', true) === 'skift')
check('toggle on removes only that key', applySourceToggle('skift,cruise-hive', 'skift', false) === 'cruise-hive')
check('toggle on the last key leaves an empty setting', applySourceToggle('skift', 'skift', false) === '')
check('toggle handles null/unset', applySourceToggle(null, 'skift', true) === 'skift')
check('toggle keeps keys of sources no longer in code', applySourceToggle('old-feed', 'skift', true) === 'old-feed,skift')
check('toggle rejects an invalid key', applySourceToggle('', 'bad key!', true) === null && applySourceToggle('', '', true) === null)

// source health
check('health: off wins', sourceHealth(true, { fails: 5, lastError: 'HTTP 403' }) === 'off')
check('health: 403 is blocked', sourceHealth(false, { fails: 1, lastError: 'HTTP 403 Forbidden' }) === 'blocked')
check('health: robots refusal is blocked', sourceHealth(false, { fails: 1, lastError: 'robots.txt does not allow it' }) === 'blocked')
check('health: 3 fails is failing', sourceHealth(false, { fails: 3, lastError: 'timeout' }) === 'failing')
check('health: 1 fail is a warning', sourceHealth(false, { fails: 1, lastError: 'timeout' }) === 'warning')
check('health: ok and never-read', sourceHealth(false, { fails: 0, lastOkAt: '2026-10-01' }) === 'ok' && sourceHealth(false, { fails: 0 }) === 'waiting')

// news items table
const items: NewsItemView[] = [
  { id: '1', source_key: 'skift', title: 'Airline strike', url: 'https://x', status: 'new', category: 'industry', published_at: '2026-10-20T00:00:00Z', fetched_at: '2026-10-20T01:00:00Z', reject_reason: null, post_slug: null },
  { id: '2', source_key: 'nhc-atlantic', title: 'Storm Zeta', url: 'https://x', status: 'queued', category: 'storm', published_at: null, fetched_at: '2026-10-19T01:00:00Z', reject_reason: null, post_slug: 'news-storm-zeta-1' },
  { id: '3', source_key: 'skift', title: 'Old news', url: 'https://x', status: 'rejected', category: 'industry', published_at: '2026-10-01T00:00:00Z', fetched_at: '2026-10-01T01:00:00Z', reject_reason: 'covered by an earlier post', post_slug: null },
]
const iq = { ...DEFAULT_ITEM_QUERY }
check('items: counts per status', JSON.stringify(countByStatus(items)) === '{"new":1,"queued":1,"published":0,"rejected":1,"expired":0}')
check('items: default sort newest first (published else fetched)', filterSortItems(items, iq).map((i) => i.id).join() === '1,2,3')
check('items: filter by status', filterSortItems(items, { ...iq, status: 'queued' }).length === 1)
check('items: filter by source', filterSortItems(items, { ...iq, source: 'skift' }).length === 2)
check('items: search title and reason', filterSortItems(items, { ...iq, q: 'earlier post' }).length === 1 && filterSortItems(items, { ...iq, q: 'zeta' }).length === 1)
check('items: sort by title asc', filterSortItems(items, { ...iq, sort: 'title', dir: 'asc' })[0].title === 'Airline strike')

// autoblog status card
check('autoblog: 3/week on Tuesday -> Wednesday', nextWriteDay(3, 2)?.name === 'Wednesday' && nextWriteDay(3, 2)?.daysAhead === 1)
check('autoblog: today counts when it is a write day', nextWriteDay(3, 1)?.daysAhead === 0)
check('autoblog: 0/week has no next day', nextWriteDay(0, 2) === null)
check('autoblog: off says nothing is written', /off/i.test(describeAutoblogPlan({ mode: 'off', paused: false, postsPerWeek: 3, todayWeekday: 1, approvedTopics: 0 })))
check('autoblog: kill switch beats mode', /kill switch/i.test(describeAutoblogPlan({ mode: 'publish', paused: true, postsPerWeek: 3, todayWeekday: 1, approvedTopics: 0 })))
check('autoblog: draft plan names the topic count', /draft/.test(describeAutoblogPlan({ mode: 'draft', paused: false, postsPerWeek: 3, todayWeekday: 2, approvedTopics: 2 })) && /2 approved topics/.test(describeAutoblogPlan({ mode: 'draft', paused: false, postsPerWeek: 3, todayWeekday: 2, approvedTopics: 2 })))
check('autoblog: copy has no em dash', !/—/.test(describeAutoblogPlan({ mode: 'publish', paused: false, postsPerWeek: 5, todayWeekday: 6, approvedTopics: 0 })))
check('autoblog: last run parse tolerant', parseLastRun('{"at":"2026-10-20T10:00:00Z","ok":false,"note":"x"}')?.ok === false && parseLastRun('junk') === null && parseLastRun(null) === null)

process.exit(failed === 0 ? 0 : 1)
