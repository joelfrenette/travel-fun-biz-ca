import type { SupabaseClient } from '@supabase/supabase-js'
import { getSetting, getSettingStrict, setSetting } from '@/lib/app-settings'
import { AUTOMATION_PAUSED_KEY } from '@/lib/automation-kill-switch'
import { actionsToday, appendDecisions, gateDecision, isVetoedIn, readDecisions, readVetoes, POLICY_CAPS, type AutoDecision } from '@/lib/auto-decisions'
import { getDistributionMode } from '@/lib/distribution'
import { countBelowBar } from '@/lib/blog-quality-count'
import type { PackageGrounding } from '@/lib/blog-topics'
import { allEnrolmentsSince, SOCIAL_ENROLMENTS_PER_DAY_CEILING, utcDayStart } from '@/lib/news-distribution'
import { checkCadence, postLimits } from '@/lib/publish-cadence'
import { GUIDE_KINDS, guidePath, type GuideKind } from '@/lib/guides'
import { HELD_GUIDE_KINDS } from '@/lib/guide-distribution'
import { guideDistributionSlug } from '@/lib/guide-post-source'
import {
  EVERGREEN_CEILING_RESERVE,
  EVERGREEN_COOLDOWN_DAYS,
  EVERGREEN_MIN_AGE_DAYS,
  EVERGREEN_PER_DAY,
  EVERGREEN_PREFIX,
  EVERGREEN_STATE_KEY,
  baseSlugOfEvergreen,
  evergreenSlug,
  getEvergreenEnabled,
  parseEvergreenState,
  pickEvergreen,
  recheckDue,
  withShared,
  type EvergreenCandidate,
  type EvergreenPick,
  type EvergreenState,
  type SearchSignal,
} from '@/lib/evergreen-reshare'

// Evergreen re-share, the I/O half (the rules are in lib/evergreen-reshare.ts). Two entry points:
//   previewNextPick()        READ ONLY. What would be picked next and why, plus whether anything would go out today. Writes nothing.
//   autopilotEvergreenStep() ONE small step inside the existing 15 minute Autopilot pass (no new cron). Enrols at most one page a day into the normal
//                            post_distribution ledger; the posting pass sends it through every gate a new post goes through.
// It never sends anything itself, never raises a posting cap, and does nothing at all while the switch (app_settings.evergreen_reshare_enabled) is off.

const DAY_MS = 86_400_000
const POLICY = 'evergreen_reshare' as const

type Row = Record<string, unknown>
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

// ---------------------------------------------------------------------------------------------------
// Loading the candidates (reads only)
// ---------------------------------------------------------------------------------------------------

interface LedgerInfo {
  /** Newest real share per original ledger slug (ms). Failed rows and "Skipped" closes are not shares. */
  lastShared: Map<string, number>
  /** Original ledger slugs that have a queued or held re-share. */
  inFlight: Set<string>
}

/** Pure: which ledger rows count as a share of which page. The original row, its recap row and every earlier re-share all count. */
export function ledgerInfo(rows: ReadonlyArray<{ slug: string; stage: string; last_error: string | null; created_at: string; updated_at: string | null }>): LedgerInfo {
  const lastShared = new Map<string, number>()
  const inFlight = new Set<string>()
  for (const r of rows) {
    const evergreenBase = baseSlugOfEvergreen(r.slug)
    const base = evergreenBase ?? (r.slug.startsWith('recap-') ? r.slug.slice('recap-'.length) : r.slug)
    if (evergreenBase && (r.stage === 'queued' || r.stage === 'held')) inFlight.add(base)
    if (r.stage === 'failed') continue
    if (r.stage === 'done' && (r.last_error ?? '').startsWith('Skipped')) continue
    const t = Date.parse(r.updated_at ?? r.created_at)
    if (Number.isFinite(t) && t > (lastShared.get(base) ?? 0)) lastShared.set(base, t)
  }
  return { lastShared, inFlight }
}

async function readLedger(admin: SupabaseClient): Promise<LedgerInfo | null> {
  const { data, error } = await admin.from('post_distribution').select('slug, stage, last_error, created_at, updated_at').eq('content_type', 'post').order('created_at', { ascending: false }).limit(3000)
  if (error) return null
  return ledgerInfo((data ?? []) as Parameters<typeof ledgerInfo>[0])
}

/** The newest Search Console snapshot for these paths (read only; the numbers are rolling 28 day totals of ONE day's rows). Empty when there is none. */
async function readSearchSignals(admin: SupabaseClient, paths: string[]): Promise<Map<string, SearchSignal>> {
  const out = new Map<string, SearchSignal>()
  try {
    const latest = await admin.from('content_performance').select('day').order('day', { ascending: false }).limit(1)
    const day = (latest.data?.[0] as { day?: string } | undefined)?.day
    if (latest.error || !day) return out
    for (let i = 0; i < paths.length; i += 100) {
      const { data, error } = await admin.from('content_performance').select('path, clicks, impressions, position').eq('day', day).in('path', paths.slice(i, i + 100))
      if (error) return out
      for (const r of (data ?? []) as { path: string; clicks: number | null; impressions: number | null; position: number | null }[]) out.set(r.path, { clicks: r.clicks, impressions: r.impressions, position: r.position })
    }
  } catch {
    // no signal is not an error: the page simply ranks last
  }
  return out
}

/** Every published blog post and guide old enough to be a candidate, with everything the rules need. Reads only. Null when a required read failed. */
export async function loadCandidates(admin: SupabaseClient, now: Date = new Date()): Promise<{ candidates: EvergreenCandidate[]; state: EvergreenState } | null> {
  const cutoffDate = new Date(now.getTime() - EVERGREEN_MIN_AGE_DAYS * DAY_MS).toISOString().slice(0, 10)
  const today = now.toISOString().slice(0, 10)
  const [postsRes, pkRes, ledger, vetoes, stateRaw] = await Promise.all([
    admin.from('posts').select('*').eq('status', 'published').lte('publish_date', cutoffDate).limit(500),
    admin.from('travel_packages').select('name, slug, destination, short_description, full_description, highlights, available_from, available_to').eq('status', 'published').limit(300),
    readLedger(admin),
    readVetoes(admin),
    getSetting(admin, EVERGREEN_STATE_KEY),
  ])
  if (postsRes.error || pkRes.error || !ledger) return null
  const state = parseEvergreenState(stateRaw)
  const sharedByState = new Map(state.shared.map((e) => [e.slug, Date.parse(e.at)]))

  let guideRows: Row[] = []
  const withReview = await admin.from('guides').select('kind, slug, name, status, quality_notes, created_at, review_state').eq('status', 'published').limit(1500)
  if (withReview.error) {
    // review_state arrives with migration 0041: until then, read without it.
    const plain = await admin.from('guides').select('kind, slug, name, status, quality_notes, created_at').eq('status', 'published').limit(1500)
    if (plain.error) return null
    guideRows = (plain.data ?? []) as Row[]
  } else {
    guideRows = (withReview.data ?? []) as Row[]
  }

  const packages = (pkRes.data ?? []) as PackageGrounding[]
  const postRows = ((postsRes.data ?? []) as Row[]).filter((r) => !str(r.publish_date) || str(r.publish_date).slice(0, 10) <= today)

  const paths = [...postRows.map((r) => `/blog/${str(r.slug)}`), ...guideRows.map((g) => guidePath(str(g.kind) as GuideKind, str(g.slug)))]
  const signals = await readSearchSignals(admin, paths)

  const lastOf = (slug: string): string | null => {
    const t = Math.max(ledger.lastShared.get(slug) ?? 0, sharedByState.get(slug) ?? 0)
    return t > 0 ? new Date(t).toISOString() : null
  }

  const candidates: EvergreenCandidate[] = []
  for (const r of postRows) {
    const slug = str(r.slug)
    if (!slug) continue
    let below: boolean | null = null
    try {
      below = countBelowBar([r], packages, now).count > 0
    } catch {
      below = null
    }
    candidates.push({
      kind: 'post',
      ledgerSlug: slug,
      pagePath: `/blog/${slug}`,
      title: str(r.title),
      publishedAt: str(r.publish_date) || str(r.created_at) || null,
      tags: strList(r.tags),
      tripLinked: !!r.related_package_id,
      belowQualityBar: below,
      qualityNotes: null,
      rejected: false,
      namedBusiness: false,
      lastSharedAt: lastOf(slug),
      inFlight: ledger.inFlight.has(slug),
      vetoed: isVetoedIn(vetoes, POLICY, slug),
      search: signals.get(`/blog/${slug}`) ?? null,
    })
  }
  for (const g of guideRows) {
    const kind = str(g.kind) as GuideKind
    if (!(GUIDE_KINDS as readonly string[]).includes(kind)) continue
    const ledgerSlug = guideDistributionSlug(kind, str(g.slug))
    const path = guidePath(kind, str(g.slug))
    candidates.push({
      kind: 'guide',
      ledgerSlug,
      pagePath: path,
      title: str(g.name),
      publishedAt: str(g.created_at) || null,
      tags: [],
      tripLinked: false,
      belowQualityBar: null,
      qualityNotes: typeof g.quality_notes === 'string' ? g.quality_notes : null,
      rejected: g.review_state === 'rejected',
      namedBusiness: HELD_GUIDE_KINDS.includes(kind),
      lastSharedAt: lastOf(ledgerSlug),
      inFlight: ledger.inFlight.has(ledgerSlug),
      vetoed: isVetoedIn(vetoes, POLICY, ledgerSlug),
      search: signals.get(path) ?? null,
    })
  }
  return { candidates, state }
}

// ---------------------------------------------------------------------------------------------------
// The gates that apply to every re-share (same switches as a new post)
// ---------------------------------------------------------------------------------------------------

export interface DayGate {
  allowed: boolean
  /** Plain words: why not, or "clear". */
  reason: string
  /** True for the routine "already done today" refusals, which the run log does not repeat every 15 minutes. */
  quiet?: boolean
}

/** May ONE re-share be enrolled right now? Checks, in order: the Pause all automation switch, the distribution mode, today's re-share allowance (1), the shared
 * daily enrolment ceiling (re-shares leave the last slot to new content), and the publish cadence gap (a re-share waits out the stagger after a new post
 * goes live). Anything that cannot be read means "no" (fail closed). Reads only. */
export async function dayGate(admin: SupabaseClient, now: Date = new Date()): Promise<DayGate> {
  try {
    const paused = await getSettingStrict(admin, AUTOMATION_PAUSED_KEY)
    const log = await readDecisions(admin)
    const gate = gateDecision({ paused: paused.error ? null : paused.value === 'true', toggle: 'on', usedToday: actionsToday(log, POLICY, now), cap: Math.min(EVERGREEN_PER_DAY, POLICY_CAPS[POLICY]) })
    if (!gate.allowed) return { allowed: false, reason: gate.reason, quiet: gate.reason.startsWith("today's limit") }
    const mode = await getDistributionMode(admin)
    if (mode === 'off') return { allowed: false, reason: 'distribution is off (Where it posts), so nothing is enrolled' }
    const dayStart = utcDayStart(now)
    const { count, error } = await admin.from('post_distribution').select('slug', { count: 'exact', head: true }).like('slug', `${EVERGREEN_PREFIX}%`).gte('created_at', dayStart)
    if (error) return { allowed: false, reason: 'could not count today\'s re-shares, so nothing was done' }
    if ((count ?? 0) >= EVERGREEN_PER_DAY) return { allowed: false, reason: 'today\'s re-share is already in the posting list', quiet: true }
    const all = await allEnrolmentsSince(admin, dayStart)
    if (all === null) return { allowed: false, reason: 'could not count today\'s social posts, so nothing was done' }
    if (all >= SOCIAL_ENROLMENTS_PER_DAY_CEILING - EVERGREEN_CEILING_RESERVE) return { allowed: false, reason: `${all} social posts are already enrolled today (the daily ceiling is ${SOCIAL_ENROLMENTS_PER_DAY_CEILING}; re-shares leave the last slot to new content)` }
    const cadence = await checkCadence(admin, 'post', postLimits(), now)
    if (!cadence.allowed) return { allowed: false, reason: cadence.note }
    return { allowed: true, reason: mode === 'prepare' ? 'clear (review mode: it would wait for your approval)' : 'clear' }
  } catch {
    return { allowed: false, reason: 'could not check the switches, so nothing was done' }
  }
}

// ---------------------------------------------------------------------------------------------------
// Preview (read only)
// ---------------------------------------------------------------------------------------------------

export interface PreviewItem {
  title: string
  path: string
  kind: 'post' | 'guide'
  why: string
  publishedAt: string | null
  lastSharedAt: string | null
}
export interface EvergreenPreview {
  switchOn: boolean
  /** The page that would be picked, or null. */
  pick: PreviewItem | null
  /** The next few after it. */
  next: PreviewItem[]
  /** Pages left out, by reason. */
  excluded: { reason: string; count: number }[]
  /** Would a re-share be enrolled right now if the switch were on? */
  today: DayGate
  note: string
}

const toItem = (r: EvergreenPick['ranked'][number]): PreviewItem => ({ title: r.candidate.title, path: r.candidate.pagePath, kind: r.candidate.kind, why: r.why, publishedAt: r.candidate.publishedAt, lastSharedAt: r.candidate.lastSharedAt })

/** READ ONLY. What would be picked next and why. Works with the switch off too (that is the point of a preview). Never writes, never sends. */
export async function previewNextPick(admin: SupabaseClient, now: Date = new Date()): Promise<EvergreenPreview> {
  const [switchOn, today, loaded] = await Promise.all([getEvergreenEnabled(admin), dayGate(admin, now), loadCandidates(admin, now)])
  if (!loaded) return { switchOn, pick: null, next: [], excluded: [], today, note: 'Could not read the posts, guides or the posting list, so nothing can be previewed.' }
  const result = pickEvergreen(loaded.candidates, now)
  const excluded = Object.entries(result.excluded).map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count)
  const note = result.pick
    ? `${result.ranked.length} of ${loaded.candidates.length} pages qualify (live ${EVERGREEN_MIN_AGE_DAYS}+ days, not shared for ${EVERGREEN_COOLDOWN_DAYS} days, quality passed).`
    : `Nothing qualifies right now (${loaded.candidates.length} pages looked at).`
  return { switchOn, pick: result.pick ? toItem(result.pick) : null, next: result.ranked.slice(1, 4).map(toItem), excluded, today, note }
}

// ---------------------------------------------------------------------------------------------------
// The step inside the Autopilot pass
// ---------------------------------------------------------------------------------------------------

async function saveCheck(admin: SupabaseClient, state: EvergreenState, now: Date, note: string): Promise<void> {
  await setSetting(admin, EVERGREEN_STATE_KEY, JSON.stringify({ ...state, lastCheckAt: now.toISOString(), lastCheckNote: note.slice(0, 300) })).catch(() => undefined)
}

/** ONE small step of the existing 15 minute Autopilot pass. Does nothing, and costs one read, while the switch is off. When on: applies the day gate, picks the
 * best page, enrols it as a normal queued (or, in review mode, held) post_distribution row, writes one line to the decisions log (with an Undo while it has not
 * gone out) and remembers it in the state. Never throws. Returns a short note for the run log, or null for nothing to say. */
export async function autopilotEvergreenStep(admin: SupabaseClient, now: Date = new Date()): Promise<string | null> {
  try {
    if (!(await getEvergreenEnabled(admin))) return null
    const state = parseEvergreenState(await getSetting(admin, EVERGREEN_STATE_KEY))
    if (!recheckDue(state, now)) return null
    const gate = await dayGate(admin, now)
    // A closed gate is not "checked and found nothing": it is looked at again on the next pass.
    if (!gate.allowed) return gate.quiet ? null : `evergreen: ${gate.reason}`

    const loaded = await loadCandidates(admin, now)
    if (!loaded) return 'evergreen: could not read the posts or the posting list, will try again'
    const { pick } = pickEvergreen(loaded.candidates, now)
    if (!pick) {
      await saveCheck(admin, loaded.state, now, 'nothing qualified')
      return 'evergreen: nothing qualifies today'
    }

    const c = pick.candidate
    const mode = await getDistributionMode(admin)
    const ledgerSlug = evergreenSlug(c.ledgerSlug, now)
    const held = mode === 'prepare'
    const row: Record<string, unknown> = { content_type: 'post', slug: ledgerSlug, title: c.title, stage: held ? 'held' : 'queued' }
    if (c.kind === 'guide') row.path = c.pagePath
    const { error } = await admin.from('post_distribution').insert(row)
    if (error) return `evergreen: could not add ${c.pagePath} to the posting list (${error.message.slice(0, 120)})`

    // Two passes at the same instant could both get here: count again and take this row back out if the day is over its allowance or the ceiling.
    const after = await allEnrolmentsSince(admin, utcDayStart(now))
    const { count } = await admin.from('post_distribution').select('slug', { count: 'exact', head: true }).like('slug', `${EVERGREEN_PREFIX}%`).gte('created_at', utcDayStart(now))
    if (after === null || after > SOCIAL_ENROLMENTS_PER_DAY_CEILING || (count ?? 0) > EVERGREEN_PER_DAY) {
      await admin.from('post_distribution').delete().eq('content_type', 'post').eq('slug', ledgerSlug).neq('stage', 'done')
      return 'evergreen: another post took the slot, nothing enrolled'
    }

    const decision: AutoDecision = {
      at: now.toISOString(),
      policy: POLICY,
      subject: c.ledgerSlug,
      action: held ? `Prepared an evergreen re-share of "${c.title}" for your approval` : `Queued an evergreen re-share of "${c.title}"`,
      reason: `${pick.why}. Live since ${String(c.publishedAt).slice(0, 10)}, ${c.lastSharedAt ? `last shared ${c.lastSharedAt.slice(0, 10)}` : 'never shared on social'}. It goes through the same image check, caption checks, network pauses and kill switch as a new post, with a new hook.`,
      undo: held ? null : { kind: 'rehold-post', ref: ledgerSlug },
    }
    await appendDecisions(admin, [decision])
    await setSetting(admin, EVERGREEN_STATE_KEY, JSON.stringify({ ...withShared(loaded.state, c.ledgerSlug, now, []), lastCheckAt: now.toISOString(), lastCheckNote: `enrolled ${c.pagePath}` }))
    return `evergreen: ${held ? 'prepared' : 'queued'} a re-share of ${c.pagePath}`
  } catch (err) {
    console.error('[evergreen] step failed:', err instanceof Error ? err.message : err)
    return null
  }
}

/** Used by the card: the stored state plus the recent re-shares, newest first. */
export async function readEvergreenCard(admin: SupabaseClient): Promise<{ switchOn: boolean; state: EvergreenState; recent: AutoDecision[]; readable: boolean }> {
  const switchRead = await getSettingStrict(admin, 'evergreen_reshare_enabled')
  const [switchOn, state, log] = await Promise.all([getEvergreenEnabled(admin), getSetting(admin, EVERGREEN_STATE_KEY).then(parseEvergreenState), readDecisions(admin)])
  return { switchOn, state, recent: [...log].reverse().filter((d) => d.policy === POLICY).slice(0, 8), readable: !switchRead.error }
}
