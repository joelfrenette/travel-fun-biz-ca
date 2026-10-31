import type { SupabaseClient } from '@supabase/supabase-js'
import { getSettingStrict, setSetting } from '@/lib/app-settings'
import {
  FEED_FAIL_LIMIT,
  MAX_ADVISORY_ENTRIES,
  fetchDue,
  fetchFeed,
  itemLinkOk,
  looksLikeInjection,
  cleanFeedText,
  shapeFeedItem,
  parseAdvisoryJson,
  parseFeed,
  readFeedState,
  realFetchDeps,
  writeFeedState,
  type FetchDeps,
  type RawFeedItem,
} from '@/lib/news-feed'
import { classifyItem, coveredByEarlierStormPost, isBreaking, isNhcSource, isRepeatOf, nhcProductRank } from '@/lib/news-relevance'
import { getAdvisoryMode } from '@/lib/country-advisory-store'
import { dualWriteCanada, dualWriteUk, emptyAdvisoryNote, type AdvisoryIngestNote } from '@/lib/country-advisory-ingest'
import { UK_ADVISORY_SOURCE_KEY } from '@/lib/country-advisory'
import { NEWS_MAX_AGE_DAYS, parseSourcesOff, SUMMARY_MAX_CHARS, TITLE_MAX_CHARS, enabledSources, maxAgeMs, sourceByKey, type NewsCategory, type NewsSource, type NewsTier } from '@/lib/news-sources'

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

export const STORM_COVERED_REASON = 'covered by an earlier post'
export const NO_LONGER_QUALIFIES_REASON = 'no longer qualifies'

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
  /** Storm bulletins stored as rejected because an earlier post about the same storm is less than 12 hours away. */
  covered: number
  notRelevant: number
  tooOld: number
  offSite: number
  failed: { key: string; error: string }[]
  /** Feeds not started because the step's time was nearly up (they are read on the next pass). */
  skippedForTime: string[]
  /** The table could not be read or written (migration 0047 not applied, or a database error). */
  tableProblem?: string
  /** Travel advisories dual write (lib/country-advisory-ingest.ts). Present only when app_settings.country_advisories_mode is log or on. */
  advisories?: AdvisoryIngestNote
}

export const emptyIngest = (): IngestResult => ({ fetched: [], waiting: [], stored: 0, rejected: 0, duplicates: 0, covered: 0, notRelevant: 0, tooOld: 0, offSite: 0, failed: [], skippedForTime: [] })

// ---------------------------------------------------------------------------------------------------
// Canadian advisory snapshot: what changed since the last read
// ---------------------------------------------------------------------------------------------------

export const GAC_STATE_KEY = 'news_gac_state'
/** The most advisory items one read may create, however many countries changed (the rest wait for the next read). */
export const MAX_GAC_PER_RUN = 5

export interface GacState {
  v: 1
  at: string
  /** country id -> short hash of its advisory text and date. Only countries in the latest snapshot are kept. */
  countries: Record<string, string>
  /** country id -> the advisory LEVEL text (eng.advisory-text, e.g. "Avoid all travel"). Added later than `countries`, so a saved
   * state from before may not have it (or may lack some countries); it is filled in on the next read. */
  levels?: Record<string, string>
}

export type AdvisorySelection = { ok: true; items: RawFeedItem[]; baseline: boolean; held: number; next: GacState } | { ok: false; error: string }

/** The level text the Government of Canada uses when nothing special is going on. Not news by itself. */
const NORMAL_LEVEL = /\bnormal\s+(?:security\s+)?precautions\b/i
export const isElevatedLevel = (level: string | undefined): boolean => !!level && !NORMAL_LEVEL.test(level)
const sameLevel = (a: string, b: string): boolean => a.trim().replace(/\s+/g, ' ').toLowerCase() === b.trim().replace(/\s+/g, ' ').toLowerCase()

/** Pure. Compares the snapshot with the saved state. No saved state = a BASELINE: everything (hashes and levels) is remembered,
 * nothing is created. Otherwise a country already in the state whose hash differs is a candidate, and it becomes an item only when
 *   (a) its advisory LEVEL text changed versus the stored level (the item is then titled "Canada changes its advisory for X: old to new"), or
 *   (b) its level is elevated (anything but normal security precautions) and its text or date changed.
 * "Exercise normal security precautions" with the same level is not news. A saved state without levels is upgraded in place: the levels
 * are stored, and a country with no stored level yet can only become an item through (b). A country new to the list is just remembered.
 * At most MAX_GAC_PER_RUN items are returned, newest date first; the others keep their OLD hash and level so a later read picks them up.
 * A snapshot far smaller than the saved state is refused (a truncated file must not wipe the state and cause a flood later). */
export function selectChangedAdvisories(snapshot: RawFeedItem[], prev: GacState | null, now: Date): AdvisorySelection {
  const current: Record<string, string> = {}
  const currentLevels: Record<string, string> = {}
  for (const i of snapshot) {
    if (!i.stateKey || !i.stateHash) continue
    current[i.stateKey] = i.stateHash
    if (i.stateLevel) currentLevels[i.stateKey] = i.stateLevel.slice(0, 160)
  }
  const keys = Object.keys(current)
  if (keys.length === 0 || keys.length > MAX_ADVISORY_ENTRIES) return { ok: false, error: 'the advisory snapshot had no usable countries' }
  const stamp = (countries: Record<string, string>, levels: Record<string, string>): GacState => ({ v: 1, at: now.toISOString(), countries, levels })
  if (!prev) return { ok: true, items: [], baseline: true, held: 0, next: stamp(current, currentLevels) }
  const prevCount = Object.keys(prev.countries).length
  if (prevCount >= 20 && keys.length < prevCount * 0.5) return { ok: false, error: 'the advisory snapshot is much smaller than the last one, so it was not used' }
  const has = (o: Record<string, string> | undefined, k: string) => !!o && Object.prototype.hasOwnProperty.call(o, k)
  const levelChange = (i: RawFeedItem): { from: string; to: string } | null => {
    const from = has(prev.levels, i.stateKey as string) ? (prev.levels as Record<string, string>)[i.stateKey as string] : ''
    return from && i.stateLevel && !sameLevel(from, i.stateLevel) ? { from, to: i.stateLevel } : null
  }
  const newsworthy = snapshot
    .filter((i) => i.stateKey && i.stateHash && has(prev.countries, i.stateKey) && prev.countries[i.stateKey] !== i.stateHash)
    .map((i) => ({ i, lc: levelChange(i) }))
    .filter((x) => x.lc !== null || isElevatedLevel(x.i.stateLevel))
    .sort((a, b) => (Date.parse(b.i.publishedAt ?? '') || 0) - (Date.parse(a.i.publishedAt ?? '') || 0))
  const emit = newsworthy.slice(0, MAX_GAC_PER_RUN)
  const items = emit.map(({ i, lc }) => (lc && i.stateName ? { ...i, title: cleanFeedText(`Canada changes its advisory for ${i.stateName}: ${lc.from} to ${lc.to}`, TITLE_MAX_CHARS) } : i))
  const next = { ...current }
  const nextLevels = { ...currentLevels }
  // Held back (over the cap): keep the OLD hash and the OLD level, so the same change is found again on a later read.
  for (const { i } of newsworthy.slice(MAX_GAC_PER_RUN)) {
    const k = i.stateKey as string
    next[k] = prev.countries[k]
    if (has(prev.levels, k)) nextLevels[k] = (prev.levels as Record<string, string>)[k]
    else delete nextLevels[k]
  }
  return { ok: true, items, baseline: false, held: newsworthy.length - emit.length, next: stamp(next, nextLevels) }
}

/** The saved state: null = none yet or unusable text (a baseline, which creates nothing); error = the database could not be read. */
export async function readGacState(admin: SupabaseClient): Promise<{ state: GacState | null; error?: string }> {
  const r = await getSettingStrict(admin, GAC_STATE_KEY)
  if (r.error) return { state: null, error: r.error }
  if (!r.value) return { state: null }
  try {
    const p = JSON.parse(r.value) as Partial<GacState> | null
    if (!p || p.v !== 1 || typeof p.countries !== 'object' || p.countries === null || Array.isArray(p.countries)) return { state: null }
    const countries: Record<string, string> = {}
    for (const [k, v] of Object.entries(p.countries)) if (typeof v === 'string' && v.length <= 40) countries[k.slice(0, 40)] = v
    // The levels are optional (a state saved before they existed has none): read what is there, ignore anything malformed.
    const lv = (p as { levels?: unknown }).levels
    if (typeof lv !== 'object' || lv === null || Array.isArray(lv)) return { state: { v: 1, at: typeof p.at === 'string' ? p.at : '', countries } }
    const levels: Record<string, string> = {}
    for (const [k, v] of Object.entries(lv)) if (typeof v === 'string' && v.length > 0 && v.length <= 160) levels[k.slice(0, 40)] = v
    return { state: { v: 1, at: typeof p.at === 'string' ? p.at : '', countries, levels } }
  } catch {
    return { state: null }
  }
}

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

/** Setting that turns feeds off WITHOUT a deploy: a comma list of source keys (for example "us-state-dept,cruise-industry-news").
 * Used when a site blocks our servers (HTTP 403): we do not work around a block, we switch that feed off. Empty or unset =
 * every source that is enabled in lib/news-sources.ts is read. */
export const NEWS_SOURCES_OFF_KEY = 'news_sources_off'

export { parseSourcesOff }

/** The enabled sources minus the ones switched off in settings. An unreadable setting turns nothing off (the per-source
 * failure counter and the 30-minute limit still apply), so a settings glitch never silences the official feeds. */
export async function activeSources(admin: SupabaseClient): Promise<NewsSource[]> {
  try {
    const r = await getSettingStrict(admin, NEWS_SOURCES_OFF_KEY)
    const off = r.error ? new Set<string>() : parseSourcesOff(r.value)
    return enabledSources().filter((s) => !off.has(s.key))
  } catch {
    return enabledSources()
  }
}

/** Reads every due, enabled source. Never throws. */
export async function ingestFeeds(admin: SupabaseClient, deps: IngestDeps = {}): Promise<IngestResult> {
  const result = emptyIngest()
  const fetchDeps = deps.fetchDeps ?? realFetchDeps()
  const now = deps.now ?? new Date(fetchDeps.now())
  const nowMs = now.getTime()
  // Official feeds first (tier 1), so a deadline that cuts the pass short never costs the storm and advisory notices.
  const sources = [...(deps.sources ?? (await activeSources(admin)))].sort((a, b) => a.tier - b.tier)
  // Travel advisories: with the mode off (the default, and anything unreadable) nothing below is touched and the result has no `advisories`.
  const advisoryMode = await getAdvisoryMode(admin)
  const adv = advisoryMode === 'off' ? null : emptyAdvisoryNote(advisoryMode)
  if (adv) result.advisories = adv
  try {
    const recentSince = new Date(nowMs - NEWS_MAX_AGE_DAYS * DAY_MS).toISOString()
    const recent = await admin.from('news_items').select('title, summary_raw, category, source_key, status, published_at, fetched_at, reject_reason').gte('created_at', recentSince).limit(1000)
    if (recent.error) return { ...result, tableProblem: recent.error.message }
    // Bulletins stored as "covered by an earlier post" never made a post, so they must not make a later bulletin look like a repeat.
    const known = ((recent.data ?? []) as { title: string; summary_raw: string | null; category: string | null; source_key?: string | null; status?: string | null; published_at?: string | null; fetched_at?: string | null; reject_reason?: string | null }[])
      .filter((r) => r.reject_reason !== STORM_COVERED_REASON)
      .map((r) => ({
      title: r.title,
      summary: r.summary_raw ?? '',
      category: r.category ?? '',
      sourceKey: r.source_key ?? '',
      status: r.status ?? '',
      whenMs: Date.parse(r.published_at ?? r.fetched_at ?? '') || 0,
    }))

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
      const isJson = source.kind === 'json'
      const parsed = isJson ? parseAdvisoryJson(outcome.text, { now: nowMs }) : parseFeed(outcome.text, { now: nowMs })
      if (parsed.error) {
        await writeFeedState(admin, source.key, { ...next, fails: state.fails + 1, lastError: parsed.error.slice(0, 200) })
        result.failed.push({ key: source.key, error: parsed.error })
        continue
      }
      // A snapshot of every country: only what CHANGED since the saved state becomes an item. The new state is saved BEFORE the
      // items are stored, so a crash can never make the next read treat the same countries as changed again. Anything unreadable fails closed.
      let readItems = parsed.items
      if (isJson) {
        const saved = await readGacState(admin)
        const fail = async (error: string) => {
          await writeFeedState(admin, source.key, { ...next, fails: state.fails + 1, lastError: error.slice(0, 200) })
          result.failed.push({ key: source.key, error })
        }
        if (saved.error) {
          await fail(`could not read the saved advisory state (${saved.error.slice(0, 80)}), so nothing was created`)
          continue
        }
        const sel = selectChangedAdvisories(parsed.items, saved.state, now)
        if (!sel.ok) {
          await fail(sel.error)
          continue
        }
        const wrote = await setSetting(admin, GAC_STATE_KEY, JSON.stringify(sel.next))
        if (wrote.error) {
          await fail('could not save the advisory state, so nothing was created')
          continue
        }
        readItems = sel.items
        // Also record the changed countries on their advisory pages (log or on mode only; never throws, never changes the posts).
        if (adv) await dualWriteCanada(admin, adv, sel.items, parsed.items, saved.state?.levels, now)
      }
      // The etag is saved only AFTER the items are stored (below): a failed store must not make the next pass answer "not modified".
      await writeFeedState(admin, source.key, { ...next, fails: 0, lastError: undefined, lastOkAt: now.toISOString() })

      // Which of these guids are already stored for this source?
      const guids = readItems.map((i) => i.guid)
      const seen = new Set<string>()
      if (guids.length) {
        const { data, error } = await admin.from('news_items').select('guid').eq('source_key', source.key).in('guid', guids)
        if (error) return { ...result, tableProblem: error.message }
        for (const r of (data ?? []) as { guid: string }[]) seen.add(r.guid)
      }

      // Hurricane centre feeds: the plain-language Public Advisory is looked at before the "Summary for" item of the same storm.
      if (isNhcSource(source.key)) readItems = [...readItems].sort((a, b) => nhcProductRank(a.title) - nhcProductRank(b.title))

      let storedHere = 0
      for (const rawItem of readItems) {
        // The UK feed titles each entry with the bare country name; the stored title says what the item is.
        const item = shapeFeedItem(source.key, rawItem)
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
        const classified = classifyItem(source, item)
        // Canadian advisories are always category 'advisory' (a keyword in the advisory text must not re-file them).
        const verdict = isJson ? { ...classified, category: source.defaultCategory } : classified
        if (!verdict.relevant) {
          result.notRelevant++
          continue
        }
        // A storm or a breaking official notice is only news for 36 hours; everything else for 7 days.
        if (nowMs - when > maxAgeMs(verdict.category, verdict.breaking)) {
          result.tooOld++
          continue
        }
        // UK travel advice: also record the update on the country's advisory page (log or on mode only). The post logic below is unchanged.
        if (adv && source.key === UK_ADVISORY_SOURCE_KEY) await dualWriteUk(admin, adv, item, now)
        // One post per storm per 12 hours: a later bulletin inside that window is stored as rejected ("covered by an earlier post",
        // no decided_at, so it does not count as a write attempt) so its guid is remembered and it is not re-judged every run.
        // Past 12 hours a new bulletin is a candidate again and follows the normal update logic below and in lib/news-run.ts.
        if (verdict.category === 'storm' && coveredByEarlierStormPost({ sourceKey: source.key, title: item.title, whenMs: when }, known)) {
          const r = await storeItem(admin, { ...base, category: verdict.category, status: 'rejected', reject_reason: STORM_COVERED_REASON })
          if (r === 'stored') result.covered++
          else if (r === 'duplicate') result.duplicates++
          else return { ...result, tableProblem: 'could not save a news item' }
          continue
        }
        // A repeat of a stored item is dropped. For a storm the figures count: the same storm with a new warning, a higher
        // category or different winds is an UPDATE and is kept (the older brief is marked superseded when the update goes live).
        // Canadian advisories are NOT compared by title words: many countries share the same advisory wording, and the guid
        // (country + hash of text and date) above already drops the exact repeat.
        // The UK titles share one long prefix, so word overlap would make "Papua New Guinea" look like "Guinea": for that source a
        // repeat is the same title (the same country) from the same source.
        const shaped = item !== rawItem
        const isRepeat = shaped ? known.some((k) => k.sourceKey === source.key && k.title.trim().toLowerCase() === item.title.trim().toLowerCase()) : !isJson && isRepeatOf({ title: item.title, summary: item.summary, category: verdict.category }, known)
        if (isRepeat) {
          result.duplicates++
          continue
        }
        const r = await storeItem(admin, { ...base, category: verdict.category, status: 'new' })
        if (r === 'stored') {
          result.stored++
          storedHere++
          known.push({ title: item.title, summary: item.summary, category: verdict.category, sourceKey: source.key, status: 'new', whenMs: when })
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

/** Runs the CURRENT relevance rules over items still waiting ('new' or 'queued'). One that no longer qualifies (for example a
 * hurricane centre forecast discussion stored before that product was dropped) is marked 'expired' with the reason
 * "no longer qualifies". Nothing is deleted and a queued item's draft post is left exactly as it is. Items of a source that is
 * gone are left to the allowlist checks in lib/news-run.ts. Returns how many were expired, or null when the table could not be read. */
export async function reevaluateItems(admin: SupabaseClient): Promise<number | null> {
  const { data, error } = await admin.from('news_items').select('id, source_key, title, summary_raw').in('status', ['new', 'queued']).limit(500)
  if (error) return null
  const out = ((data ?? []) as { id: string; source_key: string; title: string | null; summary_raw: string | null }[]).filter((r) => {
    const source = sourceByKey(r.source_key)
    return source ? !classifyItem(source, { title: r.title ?? '', summary: r.summary_raw ?? '' }).relevant : false
  })
  if (out.length === 0) return 0
  const { error: upErr } = await admin.from('news_items').update({ status: 'expired', reject_reason: NO_LONGER_QUALIFIES_REASON }).in('id', out.map((r) => r.id))
  return upErr ? null : out.length
}

/** Sources whose last FEED_FAIL_LIMIT fetches in a row all failed (for Needs attention). */
export async function failingSources(admin: SupabaseClient, sources?: NewsSource[]): Promise<{ key: string; name: string; fails: number; lastError: string }[]> {
  const out: { key: string; name: string; fails: number; lastError: string }[] = []
  // A feed switched off in settings is not "failing": it is off on purpose, so it raises no Needs attention item.
  for (const s of sources ?? (await activeSources(admin))) {
    const st = await readFeedState(admin, s.key)
    if (st.fails >= FEED_FAIL_LIMIT) out.push({ key: s.key, name: s.name.replace(/^the /i, ''), fails: st.fails, lastError: st.lastError ?? 'unknown error' })
  }
  return out
}
