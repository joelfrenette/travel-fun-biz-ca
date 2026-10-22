import type { SupabaseClient } from '@supabase/supabase-js'
import { getSettingStrict, setSetting } from '@/lib/app-settings'
import { SITE_URL } from '@/lib/site'

// Bing coverage: how many of our pages Bing says it crawled and has in its index. One read-only call a day, inside the existing
// daily cron (app/api/cron/gsc-snapshot), only when BING_WEBMASTER_API_KEY is set. The small result is kept in app_settings
// (bing_coverage_snapshot) and shown on the Search Rankings page as "Bing: crawled, indexed (as reported)".
//
// Endpoint: GetCrawlStats of the Bing Webmaster API (https://ssl.bing.com/webmaster/api.svc/json/GetCrawlStats?apikey=...&siteUrl=...).
// Microsoft publishes it as a .NET method returning a list of daily rows (Date as "/Date(ms)/", CrawledPages, CrawlErrors, InIndex,
// InLinks, ...). It was NOT confirmed against a live account in this build, so every field is read defensively: if Bing answers with
// nothing we can read, the result is the honest status "unknown" with the reason, never a guessed number.

const API = 'https://ssl.bing.com/webmaster/api.svc/json'
export const BING_COVERAGE_KEY = 'bing_coverage_snapshot'
const TIMEOUT_MS = 8000

export interface BingCoverage {
  /** ok = numbers read; unknown = Bing was asked but gave nothing usable (see note); not_configured = no key. */
  status: 'ok' | 'unknown' | 'not_configured'
  /** When this was fetched (ISO). */
  at: string
  /** Pages Bing crawled on the latest day it reported. */
  crawledLatest: number | null
  /** Pages crawled over the 7 days up to that day. */
  crawled7d: number | null
  /** Pages Bing reports in its index, as of the latest day. */
  indexed: number | null
  crawlErrors: number | null
  /** The day those numbers are for (YYYY-MM-DD). */
  asOf: string | null
  note: string
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' && v.trim() === '' ? NaN : Number(v)
  return Number.isFinite(n) && n >= 0 ? n : null
}

/** "/Date(1700000000000)/" (or "/Date(1700000000000+0000)/") to ms, or null. Pure. */
export function parseBingDate(v: unknown): number | null {
  if (typeof v !== 'string') return null
  const m = /\/Date\((-?\d+)/.exec(v)
  if (m) return Number(m[1])
  const t = Date.parse(v)
  return Number.isFinite(t) ? t : null
}

/** The summary from a GetCrawlStats body, or null when the body has no rows we can read. Pure. */
export function parseCrawlStats(body: unknown): Omit<BingCoverage, 'status' | 'at' | 'note'> | null {
  const raw = (body as { d?: unknown } | null)?.d ?? body
  if (!Array.isArray(raw)) return null
  const rows = raw
    .map((r) => {
      const e = (r ?? {}) as Record<string, unknown>
      return { t: parseBingDate(e.Date), crawled: num(e.CrawledPages), errors: num(e.CrawlErrors), indexed: num(e.InIndex) }
    })
    .filter((r) => r.t !== null && (r.crawled !== null || r.indexed !== null || r.errors !== null)) as { t: number; crawled: number | null; errors: number | null; indexed: number | null }[]
  if (rows.length === 0) return null
  rows.sort((a, b) => a.t - b.t)
  const last = rows[rows.length - 1]
  const week = rows.filter((r) => last.t - r.t < 7 * 86_400_000 && r.crawled !== null)
  const latestIndexed = [...rows].reverse().find((r) => r.indexed !== null)
  return {
    crawledLatest: last.crawled,
    crawled7d: week.length ? week.reduce((n, r) => n + (r.crawled ?? 0), 0) : null,
    indexed: latestIndexed ? latestIndexed.indexed : null,
    crawlErrors: last.errors,
    asOf: new Date(last.t).toISOString().slice(0, 10),
  }
}

/** One read-only call. Never throws; every failure is status 'unknown' with a plain reason. `fetchImpl` is for tests. */
export async function fetchBingCoverage(opts: { apiKey?: string; siteUrl?: string; fetchImpl?: typeof fetch; now?: Date } = {}): Promise<BingCoverage> {
  const at = (opts.now ?? new Date()).toISOString()
  const empty = { crawledLatest: null, crawled7d: null, indexed: null, crawlErrors: null, asOf: null }
  const apiKey = opts.apiKey ?? process.env.BING_WEBMASTER_API_KEY
  if (!apiKey) return { status: 'not_configured', at, ...empty, note: 'BING_WEBMASTER_API_KEY is not set' }
  try {
    const url = new URL(`${API}/GetCrawlStats`)
    url.searchParams.set('apikey', apiKey)
    url.searchParams.set('siteUrl', opts.siteUrl ?? SITE_URL)
    const res = await (opts.fetchImpl ?? fetch)(url.toString(), { headers: { Accept: 'application/json' }, cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS) })
    const body = await res.json().catch(() => null)
    if (!res.ok) {
      const why = (body as { Message?: string; ErrorCode?: number | string } | null)?.Message ?? (body as { ErrorCode?: number | string } | null)?.ErrorCode ?? res.status
      return { status: 'unknown', at, ...empty, note: `Bing answered with an error (${String(why).slice(0, 160)})` }
    }
    const parsed = parseCrawlStats(body)
    if (!parsed) return { status: 'unknown', at, ...empty, note: 'Bing answered, but with no crawl or index numbers this site could read' }
    return { status: 'ok', at, ...parsed, note: 'as reported by Bing Webmaster Tools' }
  } catch (e) {
    return { status: 'unknown', at, ...empty, note: e instanceof Error && e.name === 'TimeoutError' ? `Bing did not answer within ${TIMEOUT_MS / 1000} seconds` : 'Bing could not be reached' }
  }
}

/** The daily step: fetch and store. '' when no key is set (nothing is called, nothing is written). Never throws. */
export async function runBingCoverage(admin: SupabaseClient, opts: { fetchImpl?: typeof fetch; now?: Date } = {}): Promise<string> {
  if (!process.env.BING_WEBMASTER_API_KEY) return ''
  try {
    const result = await fetchBingCoverage(opts)
    const saved = await setSetting(admin, BING_COVERAGE_KEY, JSON.stringify(result))
    if (saved.error) return `Bing coverage fetched but not saved (${saved.error})`
    return result.status === 'ok' ? `Bing: ${result.crawled7d ?? '?'} pages crawled in 7 days, ${result.indexed ?? '?'} indexed` : `Bing coverage unknown (${result.note})`
  } catch {
    return 'Bing coverage step failed'
  }
}

/** What is stored. `error` is set when the setting could not be read (shown as "could not be read", never as zero). Never throws. */
export async function readBingCoverage(admin: SupabaseClient): Promise<{ coverage: BingCoverage | null; error?: string }> {
  try {
    const r = await getSettingStrict(admin, BING_COVERAGE_KEY)
    if (r.error) return { coverage: null, error: r.error }
    if (!r.value) return { coverage: null }
    const parsed = JSON.parse(r.value) as Partial<BingCoverage>
    if (!parsed || typeof parsed !== 'object' || typeof parsed.status !== 'string') return { coverage: null, error: 'the stored Bing summary is not readable' }
    return {
      coverage: {
        status: parsed.status as BingCoverage['status'],
        at: typeof parsed.at === 'string' ? parsed.at : '',
        crawledLatest: num(parsed.crawledLatest),
        crawled7d: num(parsed.crawled7d),
        indexed: num(parsed.indexed),
        crawlErrors: num(parsed.crawlErrors),
        asOf: typeof parsed.asOf === 'string' ? parsed.asOf : null,
        note: typeof parsed.note === 'string' ? parsed.note : '',
      },
    }
  } catch {
    return { coverage: null, error: 'the stored Bing summary is not readable' }
  }
}

/** The line for the admin page. Pure. */
export function describeBing(c: BingCoverage | null, error?: string, configured = true): string {
  if (error) return 'Bing: could not be read'
  if (!configured) return 'Bing: not connected (set BING_WEBMASTER_API_KEY in Vercel to see how many pages Bing crawled and indexed)'
  if (!c) return 'Bing: no snapshot yet (it is fetched once a day by the daily rankings job)'
  if (c.status === 'not_configured') return 'Bing: not connected (set BING_WEBMASTER_API_KEY in Vercel)'
  if (c.status === 'unknown') return `Bing: unknown (${c.note})`
  const day = c.asOf ? `, as of ${c.asOf}` : ''
  return `Bing: crawled ${c.crawled7d === null ? 'unknown' : `${c.crawled7d} pages in 7 days`}, indexed ${c.indexed === null ? 'unknown' : c.indexed} (as reported by Bing${day})`
}
