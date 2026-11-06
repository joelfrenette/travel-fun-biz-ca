import type { SupabaseClient } from '@supabase/supabase-js'
import { getSetting, setSetting } from '@/lib/app-settings'
import { robotsAllows, type FetchDeps } from '@/lib/news-feed'
import { FETCH_TIMEOUT_MS, MAX_ROBOTS_BYTES, NEWS_ROBOTS_TOKEN } from '@/lib/news-sources'
import { UK_ADVISORY_HOSTS, urlOnHosts, type UkEvent } from '@/lib/country-advisory'
import { SITE_URL } from '@/lib/site'

// The ONE-TIME UK backfill from the GOV.UK Content API. The Atom feed lists only the 20 most recently updated countries, so the UK line
// reached 20 countries. The API index (one JSON document, about 300 KB) lists every country with its latest change line, date and link,
// so ONE request (plus robots.txt) is enough: there is no per-country loop. Facts checked 2026-11-05 (docs/country-advisory-pages-design.md
// section 11): robots.txt does not disallow /api/content/, and the content is published under the Open Government Licence v3.0, which
// allows reuse with attribution (shown on every UK block). UK advice has no numeric level; none is read or invented here.

export const UK_API_INDEX_URL = 'https://www.gov.uk/api/content/foreign-travel-advice'
/** Honest about what it is and what it reads. Same robots.txt token as the news reader (the token is the product name before the slash). */
export const UK_API_USER_AGENT = `TravelFunBizNewsReader/1.0 (+${SITE_URL}; reads public RSS and Atom feeds and, once, the GOV.UK travel advice index; contact via the site)`
export const UK_API_MAX_BYTES = 1_500_000
/** A hard cap on countries taken from one read (GOV.UK lists about 226). */
export const UK_API_MAX_COUNTRIES = 300
/** Polite spacing between the two requests of a run (robots.txt, then the index): 1 request per second. */
export const UK_API_PAUSE_MS = 1000
/** A failed or refused attempt is not repeated for this long, so a blocked reader does not knock on the door every half hour. */
export const UK_API_RETRY_MS = 6 * 3_600_000
export const UK_API_STATE_KEY = 'uk_full_backfill_state'

export type UkIndexResult = { ok: true; events: UkEvent[]; skipped: number } | { ok: false; error: string }

/** Pure. The index JSON as UK events: country name, the official change line, the page link and the official update date. An entry
 * with no country name, a withdrawn page, or a link that is not on gov.uk is left out (counted, never guessed). Capped. */
export function parseUkTravelAdviceIndex(text: string, max: number = UK_API_MAX_COUNTRIES): UkIndexResult {
  let j: unknown
  try {
    j = JSON.parse(text)
  } catch {
    return { ok: false, error: 'the UK travel advice index could not be read as JSON' }
  }
  const children = (j as { links?: { children?: unknown } } | null)?.links?.children
  if (!Array.isArray(children) || children.length === 0) return { ok: false, error: 'the UK travel advice index had no country list' }
  const events: UkEvent[] = []
  let skipped = 0
  for (const c of children.slice(0, max)) {
    const o = c as { document_type?: unknown; withdrawn?: unknown; web_url?: unknown; public_updated_at?: unknown; details?: { change_description?: unknown; country?: { name?: unknown; slug?: unknown } } }
    const name = typeof o?.details?.country?.name === 'string' ? o.details.country.name.trim() : ''
    const slug = typeof o?.details?.country?.slug === 'string' ? o.details.country.slug : ''
    const line = typeof o?.details?.change_description === 'string' ? o.details.change_description : ''
    const url = typeof o?.web_url === 'string' ? o.web_url : ''
    const when = typeof o?.public_updated_at === 'string' ? o.public_updated_at : null
    if (o?.document_type !== 'travel_advice' || o?.withdrawn === true || !name || !line.trim() || !urlOnHosts(url, UK_ADVISORY_HOSTS)) {
      skipped++
      continue
    }
    events.push({ country: name.slice(0, 80), summary: line, url, publishedAt: when, guid: `uk-api:${slug || name}:${when ?? ''}`.slice(0, 400) })
  }
  return { ok: true, events, skipped }
}

const sleep = (ms: number) => (ms > 0 ? new Promise<void>((r) => setTimeout(r, ms)) : Promise.resolve())

async function getCapped(deps: FetchDeps, url: string, accept: string, cap: number): Promise<{ text: string; status: number } | { error: string; status?: number }> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS)
  try {
    // redirect: 'manual' and any redirect is refused: the reader never leaves the exact address it was given.
    const res = await deps.fetch(url, { method: 'GET', redirect: 'manual', signal: ctl.signal, headers: { 'User-Agent': UK_API_USER_AGENT, Accept: accept } })
    if (res.status >= 300 && res.status < 400) return { error: `HTTP ${res.status} (a redirect, not followed)`, status: res.status }
    if (!res.ok) return { error: `HTTP ${res.status}`, status: res.status }
    const text = await res.text()
    if (text.length > cap) return { error: 'the response was larger than the size limit' }
    return { text, status: res.status }
  } catch (e) {
    return { error: ctl.signal.aborted ? 'the request timed out' : `the request failed (${e instanceof Error ? e.message.slice(0, 80) : 'unknown'})` }
  } finally {
    clearTimeout(timer)
  }
}

/** Reads robots.txt, then (only if the index path is allowed for us) the index, one second apart. Never reads anything else.
 * An unreadable robots.txt means "do not go" (404 and 410 mean no rules). */
export async function fetchUkTravelAdviceIndex(deps: FetchDeps, pauseMs: number = UK_API_PAUSE_MS): Promise<UkIndexResult> {
  const idx = new URL(UK_API_INDEX_URL)
  const robots = await getCapped(deps, `${idx.origin}/robots.txt`, 'text/plain', MAX_ROBOTS_BYTES)
  let allowed: boolean
  if ('error' in robots) {
    if (robots.status === 404 || robots.status === 410) allowed = true
    else return { ok: false, error: `could not read robots.txt (${robots.error}), so the UK index was not fetched` }
  } else allowed = robotsAllows(robots.text, idx.pathname, NEWS_ROBOTS_TOKEN)
  if (!allowed) return { ok: false, error: 'the GOV.UK robots.txt does not allow the travel advice index to be read' }
  await sleep(pauseMs)
  const r = await getCapped(deps, UK_API_INDEX_URL, 'application/json', UK_API_MAX_BYTES)
  if ('error' in r) return { ok: false, error: r.error }
  return parseUkTravelAdviceIndex(r.text)
}

/** True when an attempt was made less than UK_API_RETRY_MS ago. */
export const attemptedRecently = (raw: string | null | undefined, nowMs: number): boolean => {
  try {
    const t = Date.parse((JSON.parse(raw ?? 'null') as { lastAttemptAt?: string } | null)?.lastAttemptAt ?? '')
    return Number.isFinite(t) && nowMs - t < UK_API_RETRY_MS
  } catch {
    return false
  }
}

/** Records the attempt BEFORE the request (a crash or a slow host can never cause a retry storm). False = could not save, so do not go. */
export async function recordAttempt(admin: SupabaseClient, now: Date): Promise<boolean> {
  const { error } = await setSetting(admin, UK_API_STATE_KEY, JSON.stringify({ lastAttemptAt: now.toISOString() }))
  return !error
}

export async function recentlyAttempted(admin: SupabaseClient, nowMs: number): Promise<boolean> {
  return attemptedRecently(await getSetting(admin, UK_API_STATE_KEY), nowMs)
}
