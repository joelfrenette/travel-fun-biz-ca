import type { SupabaseClient } from '@supabase/supabase-js'
import { getSettingStrict, setSetting } from '@/lib/app-settings'
import { CADENCE_LOG_KEY } from '@/lib/publish-cadence'
import { extractFacts, fetchFollow, fetchSitemap, normUrl, pool, realFetch, REQUEST_TIMEOUT_MS, type FetchLike } from '@/lib/site-crawl'
import { GUIDE_KINDS, guidePath, type GuideKind } from '@/lib/guides'
import { SITE_URL } from '@/lib/site'

// Post-publish verify (hub WP1). A page that was just published (blog post, guide, trip) is fetched the way Googlebot fetches it, with NO
// cookies, a few minutes later, and checked: HTTP 200, a canonical link that points at the page itself, exactly one H1, JSON-LD that parses,
// and the address listed in the sitemap. It exists because of the 2026-10-24 trip-page bug: pages that rendered fine for a signed-in browser
// answered HTTP 500 to a visitor with no cookie, and nothing noticed.
//
// PURE half first (verifyPage, planPass, applyResults, the state parser): no network, no database. Then a thin runner (runPublishVerifyIfDue).
//
// Rules:
//  - READ ONLY against the site. It never edits, unpublishes or deletes anything. (The one automatic remedy is the flywheel step verify_fix,
//    which only refreshes the cached copy of a failing page and re-pings search engines, then lets this check look again.) (The guide repair ladder's "safe page" rung rebuilds TEXT for
//    the quality gate; it does not fix a rendering fault, and nothing in the ladder unpublishes, so there is no automatic action to take here.
//    A failure becomes a Needs attention item and a log line, and a person or Claude looks at the page.)
//  - "Could not read" is `unknown`, never `pass` (the SEO playbook audit rule), and unknown never raises an issue.
//  - Bounded: at most VERIFY_MAX_URLS_PER_PASS pages per pipeline pass (plus ONE sitemap read), REQUEST_TIMEOUT_MS (6 s) each.
//  - Timing: the cache mirror (CACHE-LOOP.md) can take up to 5 minutes to show a new page to a visitor with no cookie, and app/sitemap.ts
//    revalidates hourly, so a page is not looked at before VERIFY_MIN_AGE_MS, and "not in the sitemap yet" is only a failure after SITEMAP_GRACE_MS.

export const VERIFY_STATE_KEY = 'publish_verify_state'
export const VERIFY_MAX_URLS_PER_PASS = 6
/** The cache mirror can take up to 5 minutes to serve a new page to a visitor with no cookie. */
export const VERIFY_MIN_AGE_MS = 6 * 60_000
/** app/sitemap.ts has `revalidate = 3600`: a page may be missing from the sitemap for up to an hour. */
export const SITEMAP_GRACE_MS = 75 * 60_000
/** How far back the publish ledger is read for pages still to check. */
export const VERIFY_LOOKBACK_MS = 6 * 3_600_000
/** A failing check is repeated once on the next pass (a cold start or a deploy in progress can give one bad answer) before it is reported. */
export const VERIFY_FAIL_TRIES = 2
/** A page that could not be read this many times is dropped quietly (no issue: unknown is not a failure). */
export const VERIFY_UNKNOWN_TRIES = 4
/** Reported failures are re-checked on later passes (at most this many per pass) and dropped after this long. */
export const VERIFY_REFAIL_PER_PASS = 2
export const VERIFY_FAILING_KEEP_MS = 7 * 86_400_000
const CHECKED_KEEP = 40
const FAILING_KEEP = 20
const PENDING_KEEP = 20

export type VerifyKind = 'post' | 'guide' | 'trip'
export type VerifyVerdict = 'pass' | 'fail' | 'pending' | 'unknown'

export interface FetchedPage {
  status: number
  finalUrl: string
  hops: number
  body: string
  xRobots?: string
  error?: string
}

export interface VerifyInput {
  /** The public address the page should have (absolute). */
  url: string
  /** What the cookie-less fetch returned; null when nothing was fetched. */
  fetched: FetchedPage | null
  /** The normalised addresses listed in the sitemap; null when the sitemap could not be read. */
  sitemap: ReadonlySet<string> | null
  /** How long ago the page went live (ms). */
  ageMs: number
}

export interface VerifyResult {
  url: string
  verdict: VerifyVerdict
  /** Plain-English reasons, empty unless the verdict is `fail`. */
  failures: string[]
  /** Things that were not failures but are worth knowing (a noindex page, an unreadable sitemap). */
  notes: string[]
}

const isNoindex = (robots: readonly string[], xRobots: string | undefined) => robots.some((d) => d === 'noindex' || d === 'none') || /noindex|none/i.test(xRobots ?? '')

/** The checks for ONE fetched page. Pure. */
export function verifyPage(i: VerifyInput): VerifyResult {
  const f = i.fetched
  if (!f || f.error || f.status === 0) return { url: i.url, verdict: 'unknown', failures: [], notes: [`could not read the page (${f?.error ?? 'no answer'})`] }
  if (f.status !== 200) return { url: i.url, verdict: 'fail', failures: [`HTTP ${f.status} for a visitor with no cookie (a 200 is expected)`], notes: [] }

  const failures: string[] = []
  const notes: string[] = []
  if (f.hops > 0) failures.push(`the address redirects (${f.hops} jump${f.hops === 1 ? '' : 's'}) to ${f.finalUrl}`)

  const facts = extractFacts(f.body)
  const noindex = isNoindex(facts.robots, f.xRobots)

  if (!noindex) {
    if (!facts.canonical) failures.push('no canonical link')
    else {
      const c = normUrl(facts.canonical, f.finalUrl)
      const want = normUrl(i.url)
      if (!c || !want || c !== want) failures.push(`the canonical link points at ${facts.canonical}, not at the page itself`)
    }
  } else {
    notes.push('the page is noindex, so a canonical link and a sitemap entry are not expected')
  }

  if (facts.h1Count === 0) failures.push('no H1 heading')
  else if (facts.h1Count > 1) failures.push(`${facts.h1Count} H1 headings (exactly one is expected)`)

  if (facts.jsonLd.length === 0) failures.push('no JSON-LD structured data')
  else {
    const broken = facts.jsonLd.filter((t) => {
      try {
        JSON.parse(t)
        return false
      } catch {
        return true
      }
    }).length
    if (broken) failures.push(`${broken} JSON-LD block${broken === 1 ? '' : 's'} do not parse`)
  }

  let sitemapPending = false
  let sitemapUnknown = false
  if (!noindex) {
    const want = normUrl(i.url)
    if (!i.sitemap) {
      sitemapUnknown = true
      notes.push('could not read the sitemap, so its entry was not checked')
    } else if (want && !i.sitemap.has(want)) {
      if (i.ageMs < SITEMAP_GRACE_MS) {
        sitemapPending = true
        notes.push('not in the sitemap yet (it is rebuilt hourly), will be checked again')
      } else failures.push('not in the sitemap')
    }
  }

  const verdict: VerifyVerdict = failures.length ? 'fail' : sitemapPending ? 'pending' : sitemapUnknown ? 'unknown' : 'pass'
  return { url: i.url, verdict, failures, notes }
}

// ---------------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------------

export interface VerifyEntry {
  path: string
  kind: VerifyKind
  /** When it went live (ISO). */
  at: string
  tries: number
  reasons?: string[]
  /** When it was first reported as failing (ISO). */
  since?: string
}

export interface CheckedEntry {
  path: string
  /** When it was last checked (ISO). */
  at: string
  verdict: VerifyVerdict
}

export interface VerifyState {
  v: 1
  lastRun: string | null
  lastNote: string
  pending: VerifyEntry[]
  failing: VerifyEntry[]
  checked: CheckedEntry[]
}

export const emptyVerifyState = (): VerifyState => ({ v: 1, lastRun: null, lastNote: '', pending: [], failing: [], checked: [] })

const isKind = (k: unknown): k is VerifyKind => k === 'post' || k === 'guide' || k === 'trip'
const isVerdict = (v: unknown): v is VerifyVerdict => v === 'pass' || v === 'fail' || v === 'pending' || v === 'unknown'

function parseEntries(v: unknown): VerifyEntry[] {
  if (!Array.isArray(v)) return []
  const out: VerifyEntry[] = []
  for (const r of v as Partial<VerifyEntry>[]) {
    if (!r || typeof r.path !== 'string' || !r.path.startsWith('/') || !isKind(r.kind) || typeof r.at !== 'string' || !Number.isFinite(Date.parse(r.at))) continue
    out.push({ path: r.path, kind: r.kind, at: r.at, tries: typeof r.tries === 'number' && r.tries >= 0 ? Math.floor(r.tries) : 0, ...(Array.isArray(r.reasons) ? { reasons: r.reasons.filter((x): x is string => typeof x === 'string').slice(0, 6) } : {}), ...(typeof r.since === 'string' ? { since: r.since } : {}) })
  }
  return out
}

/** The stored state, or an empty one for a missing or damaged value. Pure. */
export function parseVerifyState(raw: string | null | undefined): VerifyState {
  if (!raw) return emptyVerifyState()
  try {
    const p = JSON.parse(raw) as Partial<VerifyState>
    if (!p || p.v !== 1) return emptyVerifyState()
    const checked: CheckedEntry[] = []
    if (Array.isArray(p.checked)) for (const c of p.checked as Partial<CheckedEntry>[]) if (c && typeof c.path === 'string' && typeof c.at === 'string' && isVerdict(c.verdict)) checked.push({ path: c.path, at: c.at, verdict: c.verdict })
    return { v: 1, lastRun: typeof p.lastRun === 'string' ? p.lastRun : null, lastNote: typeof p.lastNote === 'string' ? p.lastNote : '', pending: parseEntries(p.pending), failing: parseEntries(p.failing), checked }
  } catch {
    return emptyVerifyState()
  }
}

// ---------------------------------------------------------------------------------------------------
// What to look at
// ---------------------------------------------------------------------------------------------------

export interface Candidate {
  path: string
  kind: VerifyKind
  /** When it went live (ISO). */
  at: string
}

/** The pages in the publish ledger (lib/publish-cadence.ts) that went live inside the look-back window. Anything malformed is dropped. Pure. */
export function candidatesFromLedger(raw: string | null | undefined, now: number): Candidate[] {
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const out: Candidate[] = []
  for (const r of parsed as { t?: unknown; k?: unknown; at?: unknown }[]) {
    if (!r || typeof r.k !== 'string' || typeof r.at !== 'string') continue
    const at = Date.parse(r.at)
    if (!Number.isFinite(at) || now - at > VERIFY_LOOKBACK_MS || at > now + 60_000) continue
    if (r.t === 'post' && r.k.startsWith('post:') && r.k.length > 5) out.push({ path: `/blog/${r.k.slice(5)}`, kind: 'post', at: r.at })
    else if (r.t === 'guide') {
      const m = /^guide:([a-z-]+):(.+)$/.exec(r.k)
      if (m && (GUIDE_KINDS as readonly string[]).includes(m[1])) out.push({ path: guidePath(m[1] as GuideKind, m[2]), kind: 'guide', at: r.at })
    }
  }
  return out
}

/** Which candidates still need a first look: old enough, and not already pending, failing or checked since they went live. Pure. */
export function newCandidates(all: readonly Candidate[], state: VerifyState, now: number): Candidate[] {
  const seen = new Set([...state.pending.map((e) => e.path), ...state.failing.map((e) => e.path)])
  const lastChecked = new Map<string, number>()
  for (const c of state.checked) lastChecked.set(c.path, Math.max(lastChecked.get(c.path) ?? 0, Date.parse(c.at)))
  const byPath = new Map<string, Candidate>()
  for (const c of all) {
    const have = byPath.get(c.path)
    if (!have || Date.parse(c.at) > Date.parse(have.at)) byPath.set(c.path, c)
  }
  return [...byPath.values()]
    .filter((c) => !seen.has(c.path) && now - Date.parse(c.at) >= VERIFY_MIN_AGE_MS && (lastChecked.get(c.path) ?? 0) < Date.parse(c.at))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
}

/** The pages to fetch in this pass, at most `max`: a couple of reported failures (to see whether they were fixed), then the unresolved
 * ones, then pages never looked at. Pure. */
export function planPass(state: VerifyState, fresh: readonly Candidate[], now: number, max: number = VERIFY_MAX_URLS_PER_PASS): VerifyEntry[] {
  const out: VerifyEntry[] = []
  const take = (e: VerifyEntry) => {
    if (out.length < max && !out.some((x) => x.path === e.path)) out.push(e)
  }
  state.failing.slice(0, VERIFY_REFAIL_PER_PASS).forEach(take)
  state.pending.filter((e) => now - Date.parse(e.at) >= VERIFY_MIN_AGE_MS).forEach(take)
  fresh.forEach((c) => take({ path: c.path, kind: c.kind, at: c.at, tries: 0 }))
  return out
}

/** Folds this pass's results into the state. Pure. `results` maps a path to its verdict. Returns the new state and the paths newly reported. */
export function applyResults(state: VerifyState, planned: readonly VerifyEntry[], results: ReadonlyMap<string, VerifyResult>, now: number): { state: VerifyState; newlyFailing: string[]; fixed: string[] } {
  const nowIso = new Date(now).toISOString()
  const plannedPaths = new Set(planned.map((p) => p.path))
  const pending = state.pending.filter((e) => !plannedPaths.has(e.path))
  const failing = state.failing.filter((e) => !plannedPaths.has(e.path))
  const checked = [...state.checked]
  const newlyFailing: string[] = []
  const fixed: string[] = []
  const wasFailing = new Map(state.failing.map((e) => [e.path, e]))

  for (const e of planned) {
    const r = results.get(e.path)
    if (!r) {
      // Not reached (out of time): leave it exactly where it was.
      if (wasFailing.has(e.path)) failing.push(wasFailing.get(e.path) as VerifyEntry)
      else pending.push(e)
      continue
    }
    const ageMs = now - Date.parse(e.at)
    if (r.verdict === 'pass') {
      checked.push({ path: e.path, at: nowIso, verdict: 'pass' })
      if (wasFailing.has(e.path)) fixed.push(e.path)
      continue
    }
    if (r.verdict === 'pending') {
      if (ageMs > VERIFY_LOOKBACK_MS) checked.push({ path: e.path, at: nowIso, verdict: 'unknown' })
      else pending.push({ ...e })
      continue
    }
    if (r.verdict === 'unknown') {
      const tries = e.tries + 1
      if (wasFailing.has(e.path)) failing.push({ ...(wasFailing.get(e.path) as VerifyEntry) }) // could not re-check a reported failure: it stays reported
      else if (tries >= VERIFY_UNKNOWN_TRIES) checked.push({ path: e.path, at: nowIso, verdict: 'unknown' })
      else pending.push({ ...e, tries })
      continue
    }
    // fail
    const tries = e.tries + 1
    if (wasFailing.has(e.path)) {
      failing.push({ ...(wasFailing.get(e.path) as VerifyEntry), tries, reasons: r.failures.slice(0, 6) })
    } else if (tries >= VERIFY_FAIL_TRIES) {
      failing.push({ ...e, tries, reasons: r.failures.slice(0, 6), since: nowIso })
      newlyFailing.push(e.path)
    } else {
      pending.push({ ...e, tries, reasons: r.failures.slice(0, 6) })
    }
  }

  const keepAfter = now - VERIFY_FAILING_KEEP_MS
  return {
    state: {
      v: 1,
      lastRun: nowIso,
      lastNote: state.lastNote,
      pending: pending.slice(-PENDING_KEEP),
      failing: failing.filter((e) => Date.parse(e.since ?? e.at) >= keepAfter).slice(-FAILING_KEEP),
      checked: checked.slice(-CHECKED_KEEP),
    },
    newlyFailing,
    fixed,
  }
}

// ---------------------------------------------------------------------------------------------------
// Remediation (flywheel step verify_fix, lib/flywheel/steps/verify-fix.ts). The verify itself stays read only; the step refreshes the cached
// copy of a failing page and re-pings it, and the next verify pass re-checks it. These are the pure rules for WHICH pages it may touch.
// ---------------------------------------------------------------------------------------------------

export const VERIFY_FIX_STATE_KEY = 'publish_verify_fix_state'
/** One page is refreshed at most this many times (each time followed by a re-check) before it is left to the Needs attention item. */
export const VERIFY_FIX_MAX_PER_PAGE = 2
export const VERIFY_FIX_KEEP = 30

export interface FixRecord {
  /** How many times this page has been refreshed. */
  n: number
  /** When it was last refreshed (ISO). */
  at: string
}
export type FixState = Record<string, FixRecord>

/** The stored refresh counts, or {} for a missing or damaged value. Pure. */
export function parseFixState(raw: string | null | undefined): FixState {
  if (!raw) return {}
  try {
    const p = JSON.parse(raw) as unknown
    if (!p || typeof p !== 'object' || Array.isArray(p)) return {}
    const out: FixState = {}
    for (const [path, r] of Object.entries(p as Record<string, Partial<FixRecord>>)) {
      if (path.startsWith('/') && r && typeof r.n === 'number' && r.n >= 0 && typeof r.at === 'string' && Number.isFinite(Date.parse(r.at))) out[path] = { n: Math.floor(r.n), at: r.at }
    }
    return out
  } catch {
    return {}
  }
}

/** Keeps only the newest VERIFY_FIX_KEEP records. Pure. */
export function boundFixState(s: FixState): FixState {
  return Object.fromEntries(Object.entries(s).sort((a, b) => Date.parse(a[1].at) - Date.parse(b[1].at)).slice(-VERIFY_FIX_KEEP))
}

/** The pages worth a refresh now, at most `max`: a page that failed once and is waiting for its re-check (cheapest to rescue), then pages
 * already reported. Never a page that has used its VERIFY_FIX_MAX_PER_PAGE refreshes, and never one refreshed since the last verify pass
 * (it has not been re-checked yet, so we do not know whether the refresh worked). A page with no recorded reason is skipped. Pure. */
export function remediationTargets(state: VerifyState, fixes: FixState, now: number, max: number): VerifyEntry[] {
  const lastRun = state.lastRun ? Date.parse(state.lastRun) : NaN
  const out: VerifyEntry[] = []
  const consider = (e: VerifyEntry) => {
    if (out.length >= max || out.some((x) => x.path === e.path)) return
    if (!e.reasons?.length) return
    if (now - Date.parse(e.since ?? e.at) > VERIFY_FAILING_KEEP_MS) return
    const f = fixes[e.path]
    if (f) {
      if (f.n >= VERIFY_FIX_MAX_PER_PAGE) return
      if (!Number.isFinite(lastRun) || lastRun <= Date.parse(f.at)) return
    }
    out.push(e)
  }
  state.pending.filter((e) => e.tries >= 1).forEach(consider)
  state.failing.forEach(consider)
  return out
}

/** The reported failures, for the Needs attention item. Pure. */
export function failingSummary(state: VerifyState): { path: string; reasons: string[] }[] {
  return state.failing.map((e) => ({ path: e.path, reasons: e.reasons?.length ? e.reasons : ['the page did not pass the check'] }))
}

// ---------------------------------------------------------------------------------------------------
// The runner (the only part that touches the network and the database)
// ---------------------------------------------------------------------------------------------------

export interface VerifyRunOptions {
  /** The fetch function (the real one by default; the offline check passes a fake). */
  fetchFn?: FetchLike
  now?: number
  siteUrl?: string
  /** Pages published in the last hours whose rows are not in the ledger (trips are edited in the admin, not by the pipeline). */
  extraCandidates?: readonly Candidate[]
}

/** Trips (travel_packages) that went live or were edited in the last 2 hours. Read only; a failed read gives none. */
async function recentTrips(admin: SupabaseClient, now: number): Promise<Candidate[]> {
  try {
    const since = new Date(now - 2 * 3_600_000).toISOString()
    const { data, error } = await admin.from('travel_packages').select('slug, updated_at').eq('status', 'published').gte('updated_at', since).order('updated_at', { ascending: false }).limit(3)
    if (error) return []
    return ((data ?? []) as { slug: string; updated_at: string }[]).filter((r) => r.slug && Number.isFinite(Date.parse(r.updated_at))).map((r) => ({ path: `/packages/${r.slug}`, kind: 'trip' as const, at: r.updated_at }))
  } catch {
    return []
  }
}

/** One pass of the post-publish verify. Silent (returns null) when there is nothing to look at. Never throws. */
export async function runPublishVerifyIfDue(admin: SupabaseClient, opts: VerifyRunOptions = {}): Promise<{ ok: boolean; note: string } | null> {
  if ((process.env.PUBLISH_VERIFY ?? '').trim().toLowerCase() === 'off') return null
  const now = opts.now ?? Date.now()
  const fetchFn = opts.fetchFn ?? realFetch
  const siteUrl = (opts.siteUrl ?? SITE_URL).replace(/\/$/, '')
  try {
    const stored = await getSettingStrict(admin, VERIFY_STATE_KEY)
    if (stored.error) return { ok: true, note: `could not read the verify state (${stored.error}), nothing was checked` }
    const state = parseVerifyState(stored.value)

    const ledger = await getSettingStrict(admin, CADENCE_LOG_KEY)
    const fromLedger = ledger.error ? [] : candidatesFromLedger(ledger.value, now)
    const trips = opts.extraCandidates ? [...opts.extraCandidates] : await recentTrips(admin, now)
    const fresh = newCandidates([...fromLedger, ...trips], state, now)
    const planned = planPass(state, fresh, now)
    if (planned.length === 0) return null

    // ONE sitemap read for the pass (it lists every public page, so a single read serves all of them).
    const sm = await fetchSitemap(siteUrl, fetchFn)
    const sitemap = sm.error ? null : new Set(sm.urls)

    const results = new Map<string, VerifyResult>()
    await pool(planned, 3, async (e) => {
      const url = `${siteUrl}${e.path}`
      // No cookie header is ever sent (fetchFollow sends only a user agent and an accept header), the way a search engine fetches.
      const fetched = await fetchFollow(url, fetchFn, { method: 'GET', timeoutMs: REQUEST_TIMEOUT_MS, readBody: true })
      results.set(e.path, verifyPage({ url, fetched, sitemap, ageMs: now - Date.parse(e.at) }))
    })

    const applied = applyResults(state, planned, results, now)
    for (const p of applied.newlyFailing) console.error(`[publish-verify] ${p} failed: ${results.get(p)?.failures.join('; ')}`)
    const passed = [...results.values()].filter((r) => r.verdict === 'pass').length
    const pendingNow = [...results.values()].filter((r) => r.verdict === 'pending' || r.verdict === 'unknown').length
    const note = `checked ${results.size} new page${results.size === 1 ? '' : 's'} as a visitor with no cookie: ${passed} fine${applied.newlyFailing.length ? `, ${applied.newlyFailing.length} FAILED (${applied.newlyFailing.join(', ')})` : ''}${pendingNow ? `, ${pendingNow} to look at again` : ''}${applied.fixed.length ? `, ${applied.fixed.length} fixed since the last look` : ''}`
    const res = await setSetting(admin, VERIFY_STATE_KEY, JSON.stringify({ ...applied.state, lastNote: note }))
    return { ok: !res.error, note: res.error ? `${note} (could not save the state: ${res.error})` : note }
  } catch (e) {
    return { ok: true, note: `the publish check could not run (${e instanceof Error ? e.message : 'unknown error'})` }
  }
}

/** The stored state for the Needs attention list; null when it cannot be read. */
export async function readVerifyState(admin: SupabaseClient): Promise<VerifyState | null> {
  try {
    const stored = await getSettingStrict(admin, VERIFY_STATE_KEY)
    if (stored.error) return null
    return parseVerifyState(stored.value)
  } catch {
    return null
  }
}
