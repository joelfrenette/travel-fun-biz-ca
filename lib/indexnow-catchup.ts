import type { SupabaseClient } from '@supabase/supabase-js'
import { getSettingStrict, setSetting } from '@/lib/app-settings'
import { repairDay } from '@/lib/content-edits'
import { guideKinds, GUIDE_KINDS, type GuideKind } from '@/lib/guides'
import { isIndexNowConfigured, pingIndexNow, type IndexNowResult } from '@/lib/indexnow'

// The IndexNow daily catch-up (hub row 14). lib/indexnow.ts pings at the moment a page is published or edited, from
// several routes, and a ping can be lost (a timeout, a 429, a deploy mid-flight). Once a day, inside the existing
// pipeline (no new cron), this looks at every published post, guide, page copy and trip changed in the last 48 hours
// and re-pings the ones with no recorded successful ping, in ONE batch of at most 100 URLs.
//
// The record is a single app_settings row (INDEXNOW_LEDGER_KEY): a JSON map of path -> time of the last ping this step
// made. A page counts as done when its recorded ping is newer than its updated_at. Pings made at publish time are not
// recorded (they come from many routes), so a page can be pinged once more here: harmless, and capped.
// Fails closed: a ledger that cannot be read, or is not the expected JSON, means NOTHING is pinged and the step says so.

export const INDEXNOW_LEDGER_KEY = 'indexnow_ledger'
export const INDEXNOW_LAST_KEY = 'indexnow_catchup_last'
const DAY_PREFIX = 'indexnow_catchup_day'
export const CATCHUP_WINDOW_MS = 48 * 3_600_000
export const CATCHUP_MAX_URLS = 100
const LEDGER_KEEP_MS = 7 * 86_400_000

export type Ledger = Record<string, string>

export interface Candidate {
  path: string
  updatedAt: string
}

export interface CatchupResult {
  ok: boolean
  note: string
}

/** Parses the stored ledger. Null when the text is not a JSON object of path -> time (unreadable: fail closed). Pure. */
export function parseLedger(raw: string | null): Ledger | null {
  if (raw === null || raw.trim() === '') return {}
  try {
    const v = JSON.parse(raw) as unknown
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null
    const out: Ledger = {}
    for (const [k, t] of Object.entries(v as Record<string, unknown>)) {
      if (typeof t !== 'string' || !Number.isFinite(Date.parse(t))) return null
      out[k] = t
    }
    return out
  } catch {
    return null
  }
}

/** The paths to ping: changed inside the window, with no recorded ping newer than the change. Newest change first,
 * one entry per path, at most `max`. `waiting` is how many more qualified but did not fit. Pure. */
export function selectCatchupPaths(candidates: Candidate[], ledger: Ledger, now: number, max = CATCHUP_MAX_URLS): { paths: string[]; waiting: number } {
  const seen = new Set<string>()
  const due: Candidate[] = []
  for (const c of candidates) {
    const changed = Date.parse(c.updatedAt)
    if (!c.path || seen.has(c.path) || !Number.isFinite(changed)) continue
    if (now - changed > CATCHUP_WINDOW_MS || changed > now + 3_600_000) continue
    const pinged = Date.parse(ledger[c.path] ?? '')
    if (Number.isFinite(pinged) && pinged >= changed) continue
    seen.add(c.path)
    due.push(c)
  }
  due.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
  return { paths: due.slice(0, max).map((d) => d.path), waiting: Math.max(0, due.length - max) }
}

/** Drops ledger entries older than a week, so the row stays small. Pure. */
export function pruneLedger(ledger: Ledger, now: number): Ledger {
  const out: Ledger = {}
  for (const [k, t] of Object.entries(ledger)) if (now - Date.parse(t) <= LEDGER_KEEP_MS) out[k] = t
  return out
}

type Row = Record<string, unknown>
const s = (v: unknown) => (typeof v === 'string' ? v : '')

/** Every published page changed inside the window. Returns an error text when ANY read failed (the caller then pings nothing). */
export async function readChangedPages(admin: SupabaseClient, now: number): Promise<{ candidates: Candidate[]; error?: string }> {
  const since = new Date(now - CATCHUP_WINDOW_MS).toISOString()
  const candidates: Candidate[] = []
  const read = async (table: string, cols: string): Promise<Row[] | string> => {
    const { data, error } = await admin.from(table).select(cols).eq('status', 'published').gte('updated_at', since).limit(500)
    return error ? `${table}: ${error.message}` : ((data ?? []) as unknown as Row[])
  }
  const [posts, guides, copies, trips] = await Promise.all([read('posts', 'slug, updated_at'), read('guides', 'kind, slug, updated_at'), read('page_copy', 'path, updated_at'), read('travel_packages', 'slug, updated_at')])
  for (const r of [posts, guides, copies, trips]) if (typeof r === 'string') return { candidates: [], error: r }
  for (const r of posts as Row[]) if (s(r.slug)) candidates.push({ path: `/blog/${s(r.slug)}`, updatedAt: s(r.updated_at) })
  for (const r of guides as Row[]) {
    const kind = s(r.kind) as GuideKind
    if (GUIDE_KINDS.includes(kind) && s(r.slug)) candidates.push({ path: `${guideKinds[kind].urlPrefix}/${s(r.slug)}`, updatedAt: s(r.updated_at) })
  }
  for (const r of copies as Row[]) if (s(r.path).startsWith('/')) candidates.push({ path: s(r.path), updatedAt: s(r.updated_at) })
  for (const r of trips as Row[]) if (s(r.slug)) candidates.push({ path: `/packages/${s(r.slug)}`, updatedAt: s(r.updated_at) })
  return { candidates }
}

export interface CatchupDeps {
  now?: Date
  ping?: (paths: string[]) => Promise<IndexNowResult>
  configured?: () => boolean
}

/** Runs the catch-up now (no daily claim). Never throws. */
export async function runIndexNowCatchup(admin: SupabaseClient, deps: CatchupDeps = {}): Promise<CatchupResult> {
  const now = (deps.now ?? new Date()).getTime()
  const ping = deps.ping ?? pingIndexNow
  try {
    const ledgerRead = await getSettingStrict(admin, INDEXNOW_LEDGER_KEY)
    if (ledgerRead.error) return { ok: false, note: `could not read the list of pings already sent (${ledgerRead.error}), so nothing was sent` }
    const ledger = parseLedger(ledgerRead.value)
    if (!ledger) return { ok: false, note: `the list of pings already sent (${INDEXNOW_LEDGER_KEY}) is not readable, so nothing was sent` }

    const changed = await readChangedPages(admin, now)
    if (changed.error) return { ok: false, note: `could not read the pages (${changed.error}), so nothing was sent` }

    const { paths, waiting } = selectCatchupPaths(changed.candidates, ledger, now)
    if (paths.length === 0) return { ok: true, note: 'every page changed in the last 48 hours was already pinged' }

    const result = await ping(paths)
    if (!result.ok) return { ok: false, note: `Bing and the other search engines did not take ${paths.length} page${paths.length === 1 ? '' : 's'} (${result.error ?? result.skipped ?? `HTTP ${result.status ?? 'unknown'}`}); it tries again tomorrow` }

    const stamp = new Date(now).toISOString()
    const next = pruneLedger({ ...ledger, ...Object.fromEntries(paths.map((p) => [p, stamp])) }, now)
    const saved = await setSetting(admin, INDEXNOW_LEDGER_KEY, JSON.stringify(next))
    const note = `sent ${paths.length} changed page${paths.length === 1 ? '' : 's'} to IndexNow${waiting ? `; ${waiting} more wait for tomorrow` : ''}`
    if (saved.error) return { ok: false, note: `${note}, but the record could not be saved (${saved.error}), so they may be sent again tomorrow` }
    return { ok: true, note }
  } catch (e) {
    return { ok: false, note: e instanceof Error ? e.message : 'the IndexNow catch-up failed' }
  }
}

/** The pipeline step: once a day (a claim row, like the heal's), only when IndexNow is set up. Null when nothing was due.
 * The outcome is also stored (INDEXNOW_LAST_KEY) for the admin. Never throws. */
export async function runIndexNowCatchupIfDue(admin: SupabaseClient, deps: CatchupDeps = {}): Promise<CatchupResult | null> {
  const now = deps.now ?? new Date()
  if (!(deps.configured ?? isIndexNowConfigured)()) return null
  try {
    const { error } = await admin.from('app_settings').insert({ key: `${DAY_PREFIX}:${repairDay(now)}`, value: now.toISOString() })
    if (error) return (error as { code?: string }).code === '23505' ? null : { ok: false, note: `could not claim today's IndexNow catch-up: ${error.message}` }
    const result = await runIndexNowCatchup(admin, deps)
    await setSetting(admin, INDEXNOW_LAST_KEY, JSON.stringify({ at: now.toISOString(), ...result })).catch(() => undefined)
    return result
  } catch (e) {
    return { ok: false, note: e instanceof Error ? e.message : 'the IndexNow catch-up failed' }
  }
}
