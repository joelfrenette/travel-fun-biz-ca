import type { SupabaseClient } from '@supabase/supabase-js'
import { getSettingStrict, setSetting } from '@/lib/app-settings'
import { getGoogleAccessToken } from '@/lib/google-auth'
import { isSearchConsoleConfigured, searchConsoleSiteUrl } from '@/lib/search-console'
import { fetchSitemap, normUrl, pool, realFetch, type FetchLike } from '@/lib/site-crawl'
import { SITE_URL } from '@/lib/site'

// Google URL Inspection feedback (hub WP2): a small daily batch of "is this page really in Google, and if not, why?". The question goes to
// Google's URL Inspection API with the SAME service account the rest of Search Console uses (lib/search-console.ts, lib/google-auth.ts).
//
//  - MEASURE ONLY. The index ratio is computed and shown; it never blocks, slows or pauses publishing (that is hub WP3, switch off by default).
//  - Oldest-checked first, at most INSPECT_MAX_PER_DAY pages a day (Google allows far more; we stay small on purpose).
//  - Honest about what it cannot read: a missing permission, a quota answer or a network fault is stored as such and shown, never as "fine".
//  - State is one app_settings value (INSPECT_STATE_KEY). No migration, no new table.
//  - A page that was NOT indexed on the first check and is STILL not indexed on a check at least 7 days later is "stuck": it becomes a
//    Needs attention item (informational, never emailed) with Google's exact reason. We have no publish date for every page on the site,
//    so the 7 days count from the first inspection that found it not indexed (a lower bound on its real age).

export const INSPECT_STATE_KEY = 'seo_inspection_state'
export const INSPECT_MAX_PER_DAY = 20
/** A not-indexed page is reported once it was still not indexed on a check this long after the first one that found it not indexed. */
export const STUCK_AFTER_MS = 7 * 86_400_000
/** The ratio is only shown once this many pages have a clear answer (a ratio from three pages means nothing). */
export const MIN_RATIO_SAMPLE = 10
export const INSPECT_CALL_TIMEOUT_MS = 8_000
export const INSPECT_BUDGET_MS = 14_000
const INSPECT_CONCURRENCY = 3
const SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly'
const INSPECT_URL = 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect'
const MAX_ENTRIES = 1500

export type InspectVerdict = 'indexed' | 'not_indexed' | 'unknown'
export type ReadStatus = 'ok' | 'no_permission' | 'quota' | 'error' | 'not_configured' | 'no_sitemap'

export interface InspectEntry {
  /** The page path, for example /blog/rhine-cruise-tips. */
  path: string
  /** When Google was last asked about it (ISO). */
  checkedAt: string
  verdict: InspectVerdict
  /** Google's own words (coverage state), plus the fetch or canonical detail when it explains the answer. */
  reason: string
  /** The first check of the current not-indexed streak (ISO). Cleared when the page is indexed. */
  since?: string
}

export interface InspectState {
  v: 1
  lastRun: string | null
  /** The UTC day the counter below belongs to. */
  day: string
  usedToday: number
  /** What the last run could and could not read. */
  read: { status: ReadStatus; note: string; at: string } | null
  entries: Record<string, InspectEntry>
}

export const emptyInspectState = (): InspectState => ({ v: 1, lastRun: null, day: '', usedToday: 0, read: null, entries: {} })

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10)

/** The stored state, or an empty one for a missing or damaged value. Pure. */
export function parseInspectState(raw: string | null | undefined): InspectState {
  if (!raw) return emptyInspectState()
  try {
    const p = JSON.parse(raw) as Partial<InspectState>
    if (!p || p.v !== 1 || typeof p.entries !== 'object' || !p.entries) return emptyInspectState()
    const entries: Record<string, InspectEntry> = {}
    for (const [k, e] of Object.entries(p.entries as Record<string, Partial<InspectEntry>>)) {
      if (!e || typeof e.path !== 'string' || typeof e.checkedAt !== 'string' || !Number.isFinite(Date.parse(e.checkedAt))) continue
      if (e.verdict !== 'indexed' && e.verdict !== 'not_indexed' && e.verdict !== 'unknown') continue
      entries[k] = { path: e.path, checkedAt: e.checkedAt, verdict: e.verdict, reason: typeof e.reason === 'string' ? e.reason : '', ...(typeof e.since === 'string' ? { since: e.since } : {}) }
    }
    const read = p.read && typeof p.read === 'object' && typeof (p.read as { status?: unknown }).status === 'string' ? (p.read as InspectState['read']) : null
    return { v: 1, lastRun: typeof p.lastRun === 'string' ? p.lastRun : null, day: typeof p.day === 'string' ? p.day : '', usedToday: typeof p.usedToday === 'number' && p.usedToday >= 0 ? p.usedToday : 0, read, entries }
  } catch {
    return emptyInspectState()
  }
}

// ---------------------------------------------------------------------------------------------------
// Reading Google's answer
// ---------------------------------------------------------------------------------------------------

export interface InspectApiResponse {
  inspectionResult?: {
    indexStatusResult?: {
      verdict?: string
      coverageState?: string
      robotsTxtState?: string
      indexingState?: string
      pageFetchState?: string
      googleCanonical?: string
      userCanonical?: string
      lastCrawlTime?: string
    }
  }
}

/** Turns one URL Inspection answer into an indexed / not indexed verdict and Google's reason in plain words. Pure.
 * Anything it cannot read clearly is `unknown` (never counted as indexed). */
export function classifyInspection(resp: InspectApiResponse | null | undefined, pageUrl?: string): { verdict: InspectVerdict; reason: string } {
  const r = resp?.inspectionResult?.indexStatusResult
  if (!r) return { verdict: 'unknown', reason: 'Google gave no index answer for this page' }
  const coverage = (r.coverageState ?? '').trim()
  const details: string[] = []
  if (r.pageFetchState && r.pageFetchState !== 'SUCCESSFUL' && r.pageFetchState !== 'PAGE_FETCH_STATE_UNSPECIFIED') details.push(`page fetch: ${r.pageFetchState.toLowerCase().replace(/_/g, ' ')}`)
  if (r.robotsTxtState === 'DISALLOWED') details.push('blocked by robots.txt')
  if (r.indexingState && r.indexingState !== 'INDEXING_ALLOWED' && r.indexingState !== 'INDEXING_STATE_UNSPECIFIED') details.push(`indexing: ${r.indexingState.toLowerCase().replace(/_/g, ' ')}`)
  if (r.googleCanonical && pageUrl) {
    const g = normUrl(r.googleCanonical)
    const p = normUrl(pageUrl)
    if (g && p && g !== p) details.push(`Google chose a different canonical: ${r.googleCanonical}`)
  }
  const reason = [coverage || (r.verdict ? `verdict ${r.verdict}` : 'no coverage state'), ...details].join('; ')
  const notIndexedWords = /not indexed|excluded|discovered|crawled|blocked|noindex|duplicate|redirect|soft 404|not found|server error|alternate page/i.test(coverage)
  const indexedWords = /(^|\b)(submitted and )?indexed\b/i.test(coverage) && !/not indexed/i.test(coverage)
  if (r.verdict === 'PASS' || (indexedWords && !notIndexedWords)) return { verdict: 'indexed', reason }
  if (r.verdict === 'FAIL' || r.verdict === 'NEUTRAL' || notIndexedWords) return { verdict: 'not_indexed', reason }
  return { verdict: 'unknown', reason }
}

// ---------------------------------------------------------------------------------------------------
// Which pages, and what to remember
// ---------------------------------------------------------------------------------------------------

/** The next pages to ask about: never-asked first (in path order), then the longest ago, at most `n`. Pure. */
export function pickBatch(paths: readonly string[], entries: Readonly<Record<string, InspectEntry>>, n: number): string[] {
  if (n <= 0) return []
  const unique = [...new Set(paths)]
  return unique
    .map((p) => ({ p, at: entries[p] ? Date.parse(entries[p].checkedAt) : -1 }))
    .sort((a, b) => a.at - b.at || a.p.localeCompare(b.p))
    .slice(0, n)
    .map((x) => x.p)
}

export interface InspectOutcome {
  path: string
  verdict: InspectVerdict
  reason: string
}

/** Folds this run's answers into the state (the since-date, the daily counter, the read status) and forgets pages no longer in the sitemap. Pure. */
export function applyInspections(state: InspectState, outcomes: readonly InspectOutcome[], sitemapPaths: readonly string[] | null, read: { status: ReadStatus; note: string }, now: number): InspectState {
  const nowIso = new Date(now).toISOString()
  const day = utcDay(now)
  const entries: Record<string, InspectEntry> = { ...state.entries }
  for (const o of outcomes) {
    const prev = entries[o.path]
    const since = o.verdict === 'not_indexed' ? (prev?.verdict === 'not_indexed' && prev.since ? prev.since : nowIso) : undefined
    entries[o.path] = { path: o.path, checkedAt: nowIso, verdict: o.verdict, reason: o.reason.slice(0, 240), ...(since ? { since } : {}) }
  }
  if (sitemapPaths && sitemapPaths.length) {
    const keep = new Set(sitemapPaths)
    for (const k of Object.keys(entries)) if (!keep.has(k)) delete entries[k]
  }
  const trimmed = Object.keys(entries).length > MAX_ENTRIES ? Object.fromEntries(Object.entries(entries).sort((a, b) => Date.parse(b[1].checkedAt) - Date.parse(a[1].checkedAt)).slice(0, MAX_ENTRIES)) : entries
  return { v: 1, lastRun: nowIso, day, usedToday: (state.day === day ? state.usedToday : 0) + outcomes.length, read: { ...read, at: nowIso }, entries: trimmed }
}

export interface IndexRatio {
  indexed: number
  notIndexed: number
  unknown: number
  /** Sitemap pages never asked about. */
  notChecked: number
  /** indexed / (indexed + notIndexed), 0 to 1; null while fewer than MIN_RATIO_SAMPLE pages have a clear answer. Never a reason to block anything. */
  ratio: number | null
}

/** Indexed pages divided by pages with a clear answer, among the pages the sitemap lists now. Pure. */
export function indexRatio(state: InspectState, sitemapPaths: readonly string[]): IndexRatio {
  let indexed = 0
  let notIndexed = 0
  let unknown = 0
  let notChecked = 0
  for (const p of new Set(sitemapPaths)) {
    const e = state.entries[p]
    if (!e) notChecked++
    else if (e.verdict === 'indexed') indexed++
    else if (e.verdict === 'not_indexed') notIndexed++
    else unknown++
  }
  const known = indexed + notIndexed
  return { indexed, notIndexed, unknown, notChecked, ratio: known >= MIN_RATIO_SAMPLE ? Math.round((indexed / known) * 1000) / 1000 : null }
}

export interface StuckPage {
  path: string
  reason: string
  since: string
}

/** Pages still not indexed on a check made at least 7 days after the first check that found them not indexed. Oldest streak first. Pure. */
export function stuckNotIndexed(state: InspectState, _now: number = Date.now()): StuckPage[] {
  void _now
  return Object.values(state.entries)
    .filter((e) => e.verdict === 'not_indexed' && e.since && Date.parse(e.checkedAt) - Date.parse(e.since) >= STUCK_AFTER_MS)
    .sort((a, b) => Date.parse(a.since as string) - Date.parse(b.since as string))
    .map((e) => ({ path: e.path, reason: e.reason || 'Google gave no reason', since: e.since as string }))
}

/** One plain sentence about the state, for the cron note and the SEO page. Pure. */
export function describeInspection(state: InspectState, sitemapPaths: readonly string[]): string {
  const r = indexRatio(state, sitemapPaths)
  const read = state.read
  if (read && read.status !== 'ok') return `Google URL inspection could not be read (${read.note})`
  const asked = r.indexed + r.notIndexed + r.unknown
  if (asked === 0) return 'Google URL inspection: no page has been checked yet'
  const pct = r.ratio === null ? `too few clear answers for a ratio yet (${r.indexed + r.notIndexed} of ${MIN_RATIO_SAMPLE} needed)` : `${Math.round(r.ratio * 100)} percent of the clear answers are indexed`
  return `Google URL inspection: ${r.indexed} indexed, ${r.notIndexed} not indexed${r.unknown ? `, ${r.unknown} unclear` : ''}, ${r.notChecked} not asked about yet; ${pct}`
}

// ---------------------------------------------------------------------------------------------------
// The call and the runner
// ---------------------------------------------------------------------------------------------------

export type InspectCall = (pageUrl: string, timeoutMs: number) => Promise<{ ok: true; body: InspectApiResponse } | { ok: false; status: number; message: string }>

/** The real call: one POST, one page. Never throws (a network fault is status 0). */
export function realInspectCall(getToken: () => Promise<string> = () => getGoogleAccessToken(SCOPE)): InspectCall {
  return async (pageUrl, timeoutMs) => {
    try {
      const token = await getToken()
      const res = await fetch(INSPECT_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ inspectionUrl: pageUrl, siteUrl: searchConsoleSiteUrl(), languageCode: 'en-CA' }),
        cache: 'no-store',
        signal: AbortSignal.timeout(timeoutMs),
      })
      const body = (await res.json().catch(() => ({}))) as InspectApiResponse & { error?: { message?: string } }
      if (!res.ok) return { ok: false, status: res.status, message: body.error?.message ?? `HTTP ${res.status}` }
      return { ok: true, body }
    } catch (e) {
      return { ok: false, status: 0, message: e instanceof Error ? e.message : 'network error' }
    }
  }
}

export interface InspectRunOptions {
  deadlineMs: number
  /** The call to make; the real one by default (the offline check passes a fake). */
  call?: InspectCall
  fetchFn?: FetchLike
  siteUrl?: string
  now?: number
  maxPerDay?: number
  /** The sitemap's addresses, when the caller already has them (otherwise ONE sitemap read is made). */
  sitemapUrls?: readonly string[]
}

function pathOfUrl(u: string): string | null {
  try {
    const p = new URL(u).pathname
    return p.length > 1 ? p.replace(/\/+$/, '') : '/'
  } catch {
    return null
  }
}

/** The daily batch. Returns a one-line note. Never throws; "could not read" is a stored, shown state, not an error. */
export async function runUrlInspection(admin: SupabaseClient, opts: InspectRunOptions): Promise<{ ok: boolean; note: string }> {
  const now = opts.now ?? Date.now()
  if (!opts.call && !isSearchConsoleConfigured()) return { ok: true, note: 'URL inspection is off until the Google service account is set up' }
  const siteUrl = (opts.siteUrl ?? SITE_URL).replace(/\/$/, '')
  try {
    const stored = await getSettingStrict(admin, INSPECT_STATE_KEY)
    // Fail closed: if the state cannot be read, the daily count and the history are unknown, so nothing is asked.
    if (stored.error) return { ok: true, note: `URL inspection skipped (could not read its state: ${stored.error})` }
    const state = parseInspectState(stored.value)

    let urls: readonly string[]
    if (opts.sitemapUrls) urls = opts.sitemapUrls
    else {
      const sm = await fetchSitemap(siteUrl, opts.fetchFn ?? realFetch)
      if (sm.error) {
        const next = applyInspections(state, [], null, { status: 'no_sitemap', note: `the sitemap could not be read: ${sm.error}` }, now)
        await setSetting(admin, INSPECT_STATE_KEY, JSON.stringify(next))
        return { ok: true, note: `URL inspection skipped (the sitemap could not be read: ${sm.error})` }
      }
      urls = sm.urls
    }
    const byPath = new Map<string, string>()
    for (const u of urls) {
      const p = pathOfUrl(u)
      if (p) byPath.set(p, u)
    }
    const paths = [...byPath.keys()]
    const cap = opts.maxPerDay ?? INSPECT_MAX_PER_DAY
    const usedToday = state.day === utcDay(now) ? state.usedToday : 0
    const room = Math.max(0, cap - usedToday)
    const batch = pickBatch(paths, state.entries, room)
    if (batch.length === 0) {
      const next = { ...state, lastRun: new Date(now).toISOString() }
      await setSetting(admin, INSPECT_STATE_KEY, JSON.stringify(next))
      return { ok: true, note: `${room === 0 ? `URL inspection: today's ${cap} are used. ` : ''}${describeInspection(next, paths)}` }
    }

    const call = opts.call ?? realInspectCall()
    const outcomes: InspectOutcome[] = []
    // A 403 or 429 means every later call would get the same answer, so the run stops starting new calls; other faults are noted and the rest continue.
    const flags: { stop: { status: ReadStatus; note: string } | null; hard: boolean } = { stop: null, hard: false }
    await pool(batch, INSPECT_CONCURRENCY, async (p) => {
      const pageUrl = byPath.get(p) as string
      // Each call is also cut off at the run's deadline, so a slow answer cannot push the cron past its 60 seconds.
      const res = await call(pageUrl, Math.max(1_500, Math.min(INSPECT_CALL_TIMEOUT_MS, opts.deadlineMs - Date.now())))
      if (res.ok) {
        const c = classifyInspection(res.body, pageUrl)
        outcomes.push({ path: p, verdict: c.verdict, reason: c.reason })
        return
      }
      if (res.status === 403) {
        flags.stop = { status: 'no_permission', note: 'Google refused the question (403): the service account is probably not a user on the Search Console property, or SEARCH_CONSOLE_SITE_URL does not match the property' }
        flags.hard = true
      } else if (res.status === 429) {
        flags.stop = { status: 'quota', note: 'Google said the daily or per-minute limit was reached (429), will continue tomorrow' }
        flags.hard = true
      } else if (!flags.stop) flags.stop = { status: 'error', note: `Google could not answer (${res.status || 'network'}: ${res.message.slice(0, 120)})` }
    }, () => Date.now() > opts.deadlineMs || flags.hard)

    const stopped = flags.stop
    const read = stopped && outcomes.length === 0 ? stopped : { status: 'ok' as ReadStatus, note: stopped ? `partly read: ${stopped.note}` : 'read' }
    const next = applyInspections(state, outcomes, paths, read, now)
    const saved = await setSetting(admin, INSPECT_STATE_KEY, JSON.stringify(next))
    const stuck = stuckNotIndexed(next).length
    const line = outcomes.length ? describeInspection(next, paths) : `Google URL inspection could not be read (${(stopped ?? { note: 'no answer' }).note})`
    return { ok: !saved.error, note: `${line}${stuck ? `; ${stuck} page${stuck === 1 ? '' : 's'} still not indexed after 7 days` : ''}${saved.error ? ` (could not save: ${saved.error})` : ''}` }
  } catch (e) {
    return { ok: true, note: `URL inspection could not run (${e instanceof Error ? e.message : 'unknown error'})` }
  }
}

/** The stored state for the Needs attention list and the SEO page; null when it cannot be read. */
export async function readInspectionState(admin: SupabaseClient): Promise<InspectState | null> {
  try {
    const stored = await getSettingStrict(admin, INSPECT_STATE_KEY)
    if (stored.error) return null
    return parseInspectState(stored.value)
  } catch {
    return null
  }
}
