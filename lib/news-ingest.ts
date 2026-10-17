import type { SupabaseClient } from '@supabase/supabase-js'
import {
  FEED_FAIL_LIMIT,
  fetchDue,
  fetchFeed,
  itemLinkOk,
  looksLikeInjection,
  parseFeed,
  readFeedState,
  realFetchDeps,
  writeFeedState,
  type FetchDeps,
} from '@/lib/news-feed'
import { classifyItem, isBreaking, isRepeatOf } from '@/lib/news-relevance'
import { NEWS_MAX_AGE_DAYS, SUMMARY_MAX_CHARS, enabledSources, maxAgeMs, type NewsCategory, type NewsSource, type NewsTier } from '@/lib/news-sources'

// Growth loop WP20: step one of the news pipeline. Read the allowlisted feeds (each at most once in 30 minutes), keep
// only the items that change a traveller's plans, drop repeats, store what is left in news_items, and expire what has
// gone stale. No model is called here and nothing is published.

export type NewsStatus = 'new' | 'queued' | 'published' | 'rejected' | 'expired'

export interface NewsItemRow {
  id: string
  source_key: string
  guid: string
  url: string
  title: string
  summary_raw: string
  published_at: string | null
  fetched_at: string
  category: NewsCategory
  tier: NewsTier
  status: NewsStatus
  reject_reason: string | null
  post_slug: string | null
  decided_at: string | null
  created_at: string
}

/** Per source, per read: the most new items stored (a feed that suddenly lists everything cannot flood the table). */
export const MAX_NEW_PER_SOURCE = 10
const DAY_MS = 86_400_000

export interface IngestResult {
  /** Sources actually fetched this pass. */
  fetched: string[]
  /** Sources not due yet (read within the last 30 minutes). */
  waiting: string[]
  stored: number
  rejected: number
  duplicates: number
  notRelevant: number
  tooOld: number
  offSite: number
  failed: { key: string; error: string }[]
  /** Feeds not started because the step's time was nearly up (they are read on the next pass). */
  skippedForTime: string[]
  /** The table could not be read or written (migration 0047 not applied, or a database error). */
  tableProblem?: string
}

export const emptyIngest = (): IngestResult => ({ fetched: [], waiting: [], stored: 0, rejected: 0, duplicates: 0, notRelevant: 0, tooOld: 0, offSite: 0, failed: [], skippedForTime: [] })

/** True when news_items can be read. */
export async function newsTableReady(admin: SupabaseClient): Promise<{ ok: boolean; error?: string }> {
  try {
    const { error } = await admin.from('news_items').select('id').limit(1)
    return error ? { ok: false, error: error.message } : { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'unknown error' }
  }
}

/** Stores one item, ignoring a repeat (the unique key on source and guid). Returns whether a new row went in. */
async function storeItem(admin: SupabaseClient, row: Record<string, unknown>): Promise<'stored' | 'duplicate' | 'error'> {
  const { error } = await admin.from('news_items').insert(row)
  if (!error) return 'stored'
  return (error as { code?: string }).code === '23505' ? 'duplicate' : 'error'
}

export interface IngestDeps {
  fetchDeps?: FetchDeps
  now?: Date
  sources?: NewsSource[]
  /** Absolute time (Date.now() scale). Further feeds are not started when less than FEED_START_MARGIN_MS is left. */
  deadlineMs?: number
}

/** A feed read can take up to about 20 seconds (robots.txt, then the feed), so none is started with less than this left. */
export const FEED_START_MARGIN_MS = 25_000

/** Reads every due, enabled source. Never throws. */
export async function ingestFeeds(admin: SupabaseClient, deps: IngestDeps = {}): Promise<IngestResult> {
  const result = emptyIngest()
  const fetchDeps = deps.fetchDeps ?? realFetchDeps()
  const now = deps.now ?? new Date(fetchDeps.now())
  const nowMs = now.getTime()
  // Official feeds first (tier 1), so a deadline that cuts the pass short never costs the storm and advisory notices.
  const sources = [...(deps.sources ?? enabledSources())].sort((a, b) => a.tier - b.tier)
  try {
    const recentSince = new Date(nowMs - NEWS_MAX_AGE_DAYS * DAY_MS).toISOString()
    const recent = await admin.from('news_items').select('title, summary_raw, category').gte('created_at', recentSince).limit(1000)
    if (recent.error) return { ...result, tableProblem: recent.error.message }
    const known = ((recent.data ?? []) as { title: string; summary_raw: string | null; category: string | null }[]).map((r) => ({ title: r.title, summary: r.summary_raw ?? '', category: r.category ?? '' }))

    for (const source of sources) {
      if (deps.deadlineMs !== undefined && deps.deadlineMs - Date.now() < FEED_START_MARGIN_MS) {
        result.skippedForTime.push(source.key)
        continue
      }
      const state = await readFeedState(admin, source.key)
      if (!fetchDue(state, nowMs)) {
        result.waiting.push(source.key)
        continue
      }
      // The attempt is recorded BEFORE the request, so a crash or a slow feed can never cause a retry storm.
      if (!(await writeFeedState(admin, source.key, { ...state, lastFetchAt: now.toISOString() }))) {
        result.failed.push({ key: source.key, error: 'could not save the fetch time, so the feed was not read' })
        continue
      }
      result.fetched.push(source.key)
      const outcome = await fetchFeed(source, state, fetchDeps)
      const next = { ...state, lastFetchAt: now.toISOString() }
      if (outcome.robots) {
        next.robotsAt = outcome.robots.at
        next.robotsAllowed = outcome.robots.allowed
      }
      if (outcome.kind === 'error') {
        await writeFeedState(admin, source.key, { ...next, fails: state.fails + 1, lastError: outcome.error.slice(0, 200) })
        result.failed.push({ key: source.key, error: outcome.error })
        continue
      }
      if (outcome.kind === 'not-modified') {
        await writeFeedState(admin, source.key, { ...next, fails: 0, lastError: undefined, lastOkAt: now.toISOString() })
        continue
      }
      const parsed = parseFeed(outcome.text, { now: nowMs })
      if (parsed.error) {
        await writeFeedState(admin, source.key, { ...next, fails: state.fails + 1, lastError: parsed.error.slice(0, 200) })
        result.failed.push({ key: source.key, error: parsed.error })
        continue
      }
      // The etag is saved only AFTER the items are stored (below): a failed store must not make the next pass answer "not modified".
      await writeFeedState(admin, source.key, { ...next, fails: 0, lastError: undefined, lastOkAt: now.toISOString() })

      // Which of these guids are already stored for this source?
      const guids = parsed.items.map((i) => i.guid)
      const seen = new Set<string>()
      if (guids.length) {
        const { data, error } = await admin.from('news_items').select('guid').eq('source_key', source.key).in('guid', guids)
        if (error) return { ...result, tableProblem: error.message }
        for (const r of (data ?? []) as { guid: string }[]) seen.add(r.guid)
      }

      let storedHere = 0
      for (const item of parsed.items) {
        if (storedHere >= MAX_NEW_PER_SOURCE) break
        if (seen.has(item.guid)) {
          result.duplicates++
          continue
        }
        if (!itemLinkOk(source, item)) {
          result.offSite++
          continue
        }
        const when = item.publishedAt ? Date.parse(item.publishedAt) : nowMs
        if (nowMs - when > NEWS_MAX_AGE_DAYS * DAY_MS) {
          result.tooOld++
          continue
        }
        const base = {
          source_key: source.key,
          guid: item.guid.slice(0, 400),
          url: item.url,
          title: item.title,
          summary_raw: item.summary.slice(0, SUMMARY_MAX_CHARS),
          published_at: item.publishedAt,
          fetched_at: now.toISOString(),
          tier: source.tier,
        }
        // Text that talks to a model is not news. It is stored as rejected so a person can see it happened, and never used.
        if (looksLikeInjection(`${item.title} ${item.summary}`)) {
          const r = await storeItem(admin, { ...base, category: source.defaultCategory, status: 'rejected', reject_reason: 'the feed text contained instruction-like wording, so it was not used' })
          if (r === 'stored') result.rejected++
          else if (r === 'duplicate') result.duplicates++
          continue
        }
        const verdict = classifyItem(source, item)
        if (!verdict.relevant) {
          result.notRelevant++
          continue
        }
        // A storm or a breaking official notice is only news for 36 hours; everything else for 7 days.
        if (nowMs - when > maxAgeMs(verdict.category, verdict.breaking)) {
          result.tooOld++
          continue
        }
        // A repeat of a stored item is dropped. For a storm the figures count: the same storm with a new warning, a higher
        // category or different winds is an UPDATE and is kept (the older brief is marked superseded when the update goes live).
        if (isRepeatOf({ title: item.title, summary: item.summary, category: verdict.category }, known)) {
          result.duplicates++
          continue
        }
        const r = await storeItem(admin, { ...base, category: verdict.category, status: 'new' })
        if (r === 'stored') {
          result.stored++
          storedHere++
          known.push({ title: item.title, summary: item.summary, category: verdict.category })
        } else if (r === 'duplicate') result.duplicates++
        else return { ...result, tableProblem: 'could not save a news item' }
      }
      // Everything stored: only now is the feed's etag remembered (a pass that failed half way reads the feed again).
      if (outcome.etag || outcome.lastModified) await writeFeedState(admin, source.key, { ...next, fails: 0, lastError: undefined, lastOkAt: now.toISOString(), etag: outcome.etag, lastModified: outcome.lastModified })
    }
  } catch (e) {
    result.tableProblem = e instanceof Error ? e.message : 'unexpected error while reading the feeds'
  }
  return result
}

/** Marks items older than NEWS_MAX_AGE_DAYS that are still 'new' or 'queued' as expired. A queued item's draft post is left
 * exactly as it is (never deleted). Returns how many were expired, or null when the table could not be read. */
export async function expireOldItems(admin: SupabaseClient, now: Date = new Date()): Promise<number | null> {
  const { data, error } = await admin.from('news_items').select('id, published_at, fetched_at, category, tier, title, summary_raw').in('status', ['new', 'queued']).limit(500)
  if (error) return null
  const stale = ((data ?? []) as { id: string; published_at: string | null; fetched_at: string; category?: string | null; tier?: number | null; title?: string | null; summary_raw?: string | null }[]).filter((r) => {
    const t = Date.parse(r.published_at ?? r.fetched_at)
    const limit = maxAgeMs(r.category ?? '', isBreaking(r.tier ?? 2, r.title ?? '', r.summary_raw ?? ''))
    return Number.isFinite(t) && now.getTime() - t > limit
  })
  if (stale.length === 0) return 0
  const { error: upErr } = await admin.from('news_items').update({ status: 'expired', reject_reason: 'too old to be news any more (36 hours for storms and breaking notices, 7 days for the rest) before it was written about' }).in('id', stale.map((r) => r.id))
  return upErr ? null : stale.length
}

/** Sources whose last FEED_FAIL_LIMIT fetches in a row all failed (for Needs attention). */
export async function failingSources(admin: SupabaseClient, sources: NewsSource[] = enabledSources()): Promise<{ key: string; name: string; fails: number; lastError: string }[]> {
  const out: { key: string; name: string; fails: number; lastError: string }[] = []
  for (const s of sources) {
    const st = await readFeedState(admin, s.key)
    if (st.fails >= FEED_FAIL_LIMIT) out.push({ key: s.key, name: s.name.replace(/^the /i, ''), fails: st.fails, lastError: st.lastError ?? 'unknown error' })
  }
  return out
}
