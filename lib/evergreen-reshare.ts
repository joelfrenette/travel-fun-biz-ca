import type { SupabaseClient } from '@supabase/supabase-js'
import { getSettingStrict, setSetting } from '@/lib/app-settings'
import { ctrRatio, expectedCtr } from '@/lib/ctr-loop'
import type { CaptionLogEntry } from '@/lib/caption-plan'

// Evergreen re-share (hub row 3, ported from Nomad): once a day at most, ONE older, still-accurate blog post or guide gets a second trip through
// social, instead of going dead the day its launch week ends. This file is the PURE half: who is eligible, who is picked and why, the bounded
// state, and the "the caption must not repeat an earlier hook" rule. No database, no network, no clock (callers pass `now`).
//
// How a re-share travels (lib/evergreen-reshare-run.ts + lib/distribution.ts): the pick is enrolled in the SAME post_distribution ledger as every
// other social post, under its own ledger slug `evergreen-<yymmdd>-<original ledger slug>`. The posting pass then sends it with the same code as a
// new post: the checked cover card (never text only), per-network captions, hook rotation, the network pauses, the kill switch and the
// distribution mode. Nothing here posts anything.
//
// Tagging: the link keeps utm_campaign = the post (so a lead is still credited to the post) and gets utm_content "<hook style>-evergreen", so the
// Optimizer and Top posts can tell a re-share from the first run.

/** The page must have been live this long. */
export const EVERGREEN_MIN_AGE_DAYS = 60
/** No second share of the same page inside this window (first run, recap, carousel, an earlier re-share: any of them). */
export const EVERGREEN_COOLDOWN_DAYS = 45
/** At most this many re-shares per UTC day. */
export const EVERGREEN_PER_DAY = 1
/** Re-shares never take the last free slot of the shared daily enrolment ceiling: new content comes first. */
export const EVERGREEN_CEILING_RESERVE = 1
/** After a check that found nothing, wait this long before looking again (the Autopilot pass runs every 15 minutes). */
export const EVERGREEN_RECHECK_HOURS = 6
/** Search Console numbers below this many impressions are noise, not a signal. */
export const EVERGREEN_MIN_IMPRESSIONS = 20

export const EVERGREEN_SWITCH_KEY = 'evergreen_reshare_enabled'
export const EVERGREEN_STATE_KEY = 'evergreen_reshare_state'
export const EVERGREEN_STATE_MAX = 200
export const EVERGREEN_HOOKS_PER_SLUG = 8

const DAY_MS = 86_400_000

// ---- the switch -------------------------------------------------------------------------------------------------------------

/** On ONLY when the value is exactly 'on' (unset, empty, 'ON', 'true' and everything else mean off). Pure. */
export const evergreenSwitchOn = (raw: string | null | undefined): boolean => raw === 'on'

/** The switch, read fail-closed: a value that cannot be read means off. */
export async function getEvergreenEnabled(admin: SupabaseClient): Promise<boolean> {
  try {
    const r = await getSettingStrict(admin, EVERGREEN_SWITCH_KEY)
    return !r.error && evergreenSwitchOn(r.value)
  } catch {
    return false
  }
}

export async function setEvergreenEnabled(admin: SupabaseClient, on: boolean): Promise<{ error?: string }> {
  return setSetting(admin, EVERGREEN_SWITCH_KEY, on ? 'on' : 'off')
}

// ---- ledger slugs -----------------------------------------------------------------------------------------------------------

export const EVERGREEN_PREFIX = 'evergreen-'
const SLUG_RE = /^evergreen-(\d{6})-(.+)$/

const yymmdd = (d: Date): string => d.toISOString().slice(2, 10).replace(/-/g, '')

/** The ledger slug of one re-share: `evergreen-<yymmdd>-<original ledger slug>`. The post_distribution key is (content_type, slug), so a second
 * re-share months later needs a slug of its own. Pure. */
export const evergreenSlug = (baseLedgerSlug: string, now: Date): string => `${EVERGREEN_PREFIX}${yymmdd(now)}-${baseLedgerSlug}`
export const isEvergreenSlug = (slug: string): boolean => SLUG_RE.test(slug)
/** The original ledger slug (a blog slug or `guide-<kind>-<slug>`) behind a re-share's ledger slug, or null when it is not one. */
export function baseSlugOfEvergreen(slug: string): string | null {
  const m = SLUG_RE.exec(slug)
  return m ? m[2] : null
}

// ---- candidates and the pick ------------------------------------------------------------------------------------------------

export interface SearchSignal {
  impressions: number | null
  clicks: number | null
  position: number | null
}

export interface EvergreenCandidate {
  kind: 'post' | 'guide'
  /** The original ledger slug: the blog slug, or `guide-<kind>-<slug>`. */
  ledgerSlug: string
  /** The page address (`/blog/<slug>` or the guide path): where the Search Console numbers are looked up. */
  pagePath: string
  title: string
  /** When it went live (a date or a full time). Null when unknown (then it is never old enough). */
  publishedAt: string | null
  tags: string[]
  /** A blog post tied to one trip (related_package_id): a dated trip promo, not evergreen. */
  tripLinked: boolean
  /** Blog posts: true when the post fails the quality bar (lib/blog-quality.ts). Null when it could not be scored (then it is not shared). */
  belowQualityBar: boolean | null
  /** Guides: the quality_notes text. A safe page (thin, noindex) or a gate-held guide has a note and is never re-shared. */
  qualityNotes: string | null
  /** Guides: the review state ('rejected' is never shared). */
  rejected: boolean
  /** Guides about a named business (hotels, ships and so on) are never re-shared automatically. */
  namedBusiness: boolean
  /** The newest time ANY social post (first run, recap, carousel, an earlier re-share) went out or is waiting for this page, or null. */
  lastSharedAt: string | null
  /** A re-share of this page is already queued or held. */
  inFlight: boolean
  /** A person undid an earlier automatic re-share of this page. */
  vetoed: boolean
  search: SearchSignal | null
}

const msOf = (iso: string | null | undefined): number | null => {
  if (!iso) return null
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T00:00:00.000Z` : iso)
  return Number.isFinite(t) ? t : null
}

/** A four digit year in the title or slug (2019 to 2039) ties the page to a date. */
export const hasDatedYear = (text: string): boolean => /\b20[1-3]\d\b/.test(text)

const isNewsish = (c: EvergreenCandidate): boolean => c.kind === 'post' && (c.ledgerSlug.startsWith('news-') || c.tags.some((t) => t.toLowerCase() === 'travel-news'))

/** Why this page may NOT be re-shared right now, or null when it may. Fixed order, plain words. Pure. */
export function exclusionReason(c: EvergreenCandidate, now: Date): string | null {
  if (isNewsish(c)) return 'travel news is not posted to social'
  const tags = c.tags.map((t) => t.toLowerCase())
  if (c.kind === 'post') {
    if (c.ledgerSlug.startsWith('recap-') || tags.includes('recap') || tags.includes('trip-recap')) return 'a trip recap is not evergreen'
    if (c.tripLinked) return 'tied to one trip (a dated trip promo)'
    if (c.belowQualityBar === null) return 'its quality could not be checked'
    if (c.belowQualityBar) return 'below the quality bar'
    if (hasDatedYear(`${c.title} ${c.ledgerSlug}`)) return 'the title names a year (dated, not evergreen)'
  } else {
    if (c.namedBusiness) return 'about a named business (never re-shared automatically)'
    if (c.rejected) return 'the guide was rejected'
    if (c.qualityNotes && c.qualityNotes.trim()) return 'a safe page or a guide held by the quality gate (thin, kept out of search)'
    if (hasDatedYear(c.title)) return 'the title names a year (dated, not evergreen)'
  }
  const published = msOf(c.publishedAt)
  if (published === null) return 'no publish date'
  if (now.getTime() - published < EVERGREEN_MIN_AGE_DAYS * DAY_MS) return `live for less than ${EVERGREEN_MIN_AGE_DAYS} days`
  if (c.vetoed) return 'a person undid an earlier automatic re-share of it'
  if (c.inFlight) return 're-share already waiting to go out'
  const shared = msOf(c.lastSharedAt)
  if (shared !== null && now.getTime() - shared < EVERGREEN_COOLDOWN_DAYS * DAY_MS) return `shared ${Math.max(0, Math.floor((now.getTime() - shared) / DAY_MS))} days ago (at least ${EVERGREEN_COOLDOWN_DAYS} apart)`
  return null
}

export interface SearchScore {
  /** Higher is a better re-share candidate. 0 means no usable Search Console signal. */
  score: number
  /** Plain-words reason for the preview. */
  why: string
}

/** The Search Console signal: impressions with a click rate below what the position should earn. That is a hook problem (the page is seen but
 * not clicked), which a fresh caption can help with. The score is the clicks missed over the window (expected minus actual), floored at zero. Pure. */
export function searchScore(s: SearchSignal | null | undefined): SearchScore {
  if (!s || s.impressions === null || s.clicks === null || s.position === null || ![s.impressions, s.clicks, s.position].every(Number.isFinite)) return { score: 0, why: 'no Search Console numbers for this page' }
  if (s.impressions < EVERGREEN_MIN_IMPRESSIONS) return { score: 0, why: `only ${s.impressions} impressions in Search Console (too few to rank it)` }
  const expected = expectedCtr(s.position) ?? 0.005
  const ratio = ctrRatio(s.clicks, s.impressions, s.position)
  const missed = Math.max(0, expected * s.impressions - s.clicks)
  const pct = (n: number) => `${(Math.round(n * 1000) / 10).toFixed(1)}%`
  const actual = pct(s.clicks / s.impressions)
  if (missed <= 0) return { score: 0, why: `Search Console: ${s.impressions} impressions, ${s.clicks} clicks at position ${s.position.toFixed(1)} (click rate ${actual}, already as expected)` }
  return {
    score: missed,
    why: `Search Console: ${s.impressions} impressions, ${s.clicks} clicks at position ${s.position.toFixed(1)} (click rate ${actual}, about ${pct(expected)} expected${ratio !== null ? `, ${Math.round(ratio * 100)}% of it` : ''}): seen but not clicked, so a new hook may win clicks`,
  }
}

export interface RankedCandidate {
  candidate: EvergreenCandidate
  score: number
  why: string
}

export interface EvergreenPick {
  pick: RankedCandidate | null
  /** The eligible ones, best first (the preview shows the first few). */
  ranked: RankedCandidate[]
  /** How many candidates were left out, grouped by the reason. */
  excluded: Record<string, number>
}

/** The one page to re-share, or null. Eligible pages are ranked by the Search Console signal (biggest missed-clicks gap first); ties go to the one
 * shared longest ago (never shared first), then the one published longest ago, then the slug, so the pick is stable. Pure. */
export function pickEvergreen(candidates: readonly EvergreenCandidate[], now: Date): EvergreenPick {
  const excluded: Record<string, number> = {}
  const ranked: RankedCandidate[] = []
  for (const c of candidates) {
    const reason = exclusionReason(c, now)
    if (reason) {
      const key = reason.replace(/\d+ days ago/, 'recently')
      excluded[key] = (excluded[key] ?? 0) + 1
      continue
    }
    const s = searchScore(c.search)
    ranked.push({ candidate: c, score: s.score, why: s.why })
  }
  const shared = (r: RankedCandidate) => msOf(r.candidate.lastSharedAt) ?? 0
  const published = (r: RankedCandidate) => msOf(r.candidate.publishedAt) ?? 0
  ranked.sort((a, b) => b.score - a.score || shared(a) - shared(b) || published(a) - published(b) || (a.candidate.ledgerSlug < b.candidate.ledgerSlug ? -1 : a.candidate.ledgerSlug > b.candidate.ledgerSlug ? 1 : 0))
  return { pick: ranked[0] ?? null, ranked, excluded }
}

// ---- the state (app_settings.evergreen_reshare_state) -----------------------------------------------------------------------

export interface SharedEntry {
  /** The original ledger slug. */
  slug: string
  /** When the re-share was enrolled. */
  at: string
  /** The first lines of the captions used the last times (newest first, bounded). */
  hooks: string[]
}

export interface EvergreenState {
  /** Newest first, one entry per slug, at most 200. */
  shared: SharedEntry[]
  lastCheckAt: string | null
  lastCheckNote: string | null
}

export const emptyEvergreenState = (): EvergreenState => ({ shared: [], lastCheckAt: null, lastCheckNote: null })

/** Reads the stored state. Corrupt or the wrong shape reads as empty; single bad entries are dropped. Pure. */
export function parseEvergreenState(raw: string | null | undefined): EvergreenState {
  if (!raw) return emptyEvergreenState()
  try {
    const v = JSON.parse(raw) as Partial<EvergreenState> | null
    if (!v || typeof v !== 'object') return emptyEvergreenState()
    const shared: SharedEntry[] = []
    for (const e of Array.isArray(v.shared) ? (v.shared as Partial<SharedEntry>[]) : []) {
      if (!e || typeof e.slug !== 'string' || !e.slug || typeof e.at !== 'string' || !Number.isFinite(Date.parse(e.at))) continue
      shared.push({ slug: e.slug.slice(0, 200), at: e.at, hooks: Array.isArray(e.hooks) ? e.hooks.filter((h): h is string => typeof h === 'string').slice(0, EVERGREEN_HOOKS_PER_SLUG) : [] })
    }
    return {
      shared: dedupeShared(shared).slice(0, EVERGREEN_STATE_MAX),
      lastCheckAt: typeof v.lastCheckAt === 'string' && Number.isFinite(Date.parse(v.lastCheckAt)) ? v.lastCheckAt : null,
      lastCheckNote: typeof v.lastCheckNote === 'string' ? v.lastCheckNote.slice(0, 300) : null,
    }
  } catch {
    return emptyEvergreenState()
  }
}

function dedupeShared(list: SharedEntry[]): SharedEntry[] {
  const seen = new Set<string>()
  const out: SharedEntry[] = []
  for (const e of [...list].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))) {
    if (seen.has(e.slug)) continue
    seen.add(e.slug)
    out.push(e)
  }
  return out
}

/** The state after one page was re-shared: its entry goes to the front (replacing the old one) with the new hook lines in front of the older ones; the
 * list stays at 200. Pure. */
export function withShared(state: EvergreenState, slug: string, at: Date, hooks: readonly string[]): EvergreenState {
  const old = state.shared.find((e) => e.slug === slug)
  const merged = [...hooks, ...(old?.hooks ?? [])].filter((h, i, all) => h && all.indexOf(h) === i).slice(0, EVERGREEN_HOOKS_PER_SLUG)
  return { ...state, shared: [{ slug, at: at.toISOString(), hooks: merged }, ...state.shared.filter((e) => e.slug !== slug)].slice(0, EVERGREEN_STATE_MAX) }
}

/** When the last check found nothing, wait before looking again. True when a new look is due. Pure. */
export function recheckDue(state: EvergreenState, now: Date): boolean {
  const t = msOf(state.lastCheckAt)
  return t === null || now.getTime() - t >= EVERGREEN_RECHECK_HOURS * 3_600_000
}

// ---- the caption must not repeat an earlier hook ----------------------------------------------------------------------------

/** The first non-empty line of a caption, lower case, with links, hashtags, punctuation and emoji removed and spaces collapsed. Pure. */
export function hookKey(text: string): string {
  const first = (text ?? '').split('\n').find((l) => l.trim()) ?? ''
  return first
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/#\w+/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const words = (key: string): Set<string> => new Set(key.split(' ').filter((w) => w.length > 2))

/** True when the caption's hook line is NOT the same as, or nearly the same as (80% of the words shared), any earlier hook line. An empty hook is
 * never fresh. Pure. */
export function hookIsFresh(text: string, earlierHooks: readonly string[]): boolean {
  const key = hookKey(text)
  if (!key) return false
  const mine = words(key)
  for (const earlier of earlierHooks) {
    const other = hookKey(earlier)
    if (!other) continue
    if (other === key) return false
    const theirs = words(other)
    if (mine.size === 0 || theirs.size === 0) continue
    let both = 0
    for (const w of mine) if (theirs.has(w)) both++
    const union = mine.size + theirs.size - both
    if (union > 0 && both / union >= 0.8) return false
  }
  return true
}

/** Every hook line already used for this page: the caption log entries for it (any format), the lines the last re-shares stored in the state, and any extra lines the
 * caller computed (the hook the no-AI caption would open with). Pure. */
export function earlierHooksFor(slug: string, log: readonly CaptionLogEntry[], stateEntry: SharedEntry | undefined, extra: readonly string[] = []): string[] {
  const fromLog = log.filter((e) => e.slug === slug).map((e) => e.text)
  return [...fromLog, ...(stateEntry?.hooks ?? []), ...extra].map((t) => hookKey(t)).filter((k, i, all) => k && all.indexOf(k) === i)
}

/** Hook styles already used for this page (caption log styles, plus the hook_style:* / caption_style:* tags stored for it), minus 'fallback'. Pure. */
export function stylesUsedBefore(slug: string, log: readonly CaptionLogEntry[], variantTags: Record<string, unknown> | null | undefined): Set<string> {
  const out = new Set<string>()
  for (const e of log) if (e.slug === slug && e.style && e.style !== 'fallback') out.add(e.style)
  for (const [k, v] of Object.entries(variantTags ?? {})) if ((k.startsWith('hook_style:') || k.startsWith('caption_style:')) && typeof v === 'string' && v) out.add(v)
  return out
}

/** The list turned `by` places (so the no-AI caption opens with a different FAQ question or takeaway on every re-share). Pure. */
export function rotateList<T>(list: readonly T[], by: number): T[] {
  if (list.length === 0) return []
  const n = ((by % list.length) + list.length) % list.length
  return [...list.slice(n), ...list.slice(0, n)]
}

/** Which networks may go out: the ones whose caption hook is fresh. `textFor` gives the final text each network would be sent. Pure. */
export function freshNetworks(networks: readonly string[], textFor: (network: string) => string, earlierHooks: readonly string[]): { send: string[]; dropped: string[] } {
  const send: string[] = []
  const dropped: string[] = []
  for (const n of networks) (hookIsFresh(textFor(n), earlierHooks) ? send : dropped).push(n)
  return { send, dropped }
}
