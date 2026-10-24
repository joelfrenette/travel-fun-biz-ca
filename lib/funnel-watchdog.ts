import type { SupabaseClient } from '@supabase/supabase-js'
import { getSetting, getSettingStrict, setSetting } from '@/lib/app-settings'
import { decision, policyGate, appendDecisions, type AutoDecision } from '@/lib/auto-decisions'
import { AUTOPILOT_KEY } from '@/lib/autopilot'
import { AUTOMATION_PAUSED_KEY } from '@/lib/automation-kill-switch'
import { getDistributionMode } from '@/lib/distribution'
import { getActivePlatforms } from '@/lib/social-provider'
import { readPauses, writePauses, pausedNow, NETWORK_PAUSE_HOURS, type NetworkPauses } from '@/lib/network-pause'
import { postsBelowQualityBar } from '@/lib/blog-quality-count'
import { readCapUsage, getGuideCaps } from '@/lib/guide-run'
import { readPlanStatus } from '@/lib/guide-plan-status'
import { isIndexNowConfigured } from '@/lib/indexnow'
import { INDEXNOW_LAST_KEY, runIndexNowCatchup } from '@/lib/indexnow-catchup'
import { readOptimizerSummary } from '@/lib/optimizer-run'
import { isVisitTrackingOn } from '@/lib/visit-tracking'
import { readAllPages } from '@/lib/paged-read'
import { isNewsSlug } from '@/lib/news-post'
import { SITE_URL } from '@/lib/site'
import { STRIKING_MAX, STRIKING_MIN } from '@/lib/blog-topics'

// The funnel watchdog: once a day (inside the existing daily gsc-snapshot cron, no new schedule) it checks each stage of the funnel
// with an explicit number, and where a safe, bounded repair exists it makes it. Every check answers {stage, status ok|warn|bad,
// the numbers it used, what was done or "needs Joel"}. A number that could not be read is reported as "could not be read", never
// as a zero. The pure part (evaluateFunnel) takes plain facts and is tested with fixtures; the reading part fills the facts in.

export type Stage = 'production' | 'quality' | 'distribution' | 'discovery' | 'clicks' | 'conversion' | 'measurement'
export type Status = 'ok' | 'warn' | 'bad'

export const STAGE_LABELS: Record<Stage, string> = {
  production: 'Production (writing)',
  quality: 'Quality',
  distribution: 'Distribution (social)',
  discovery: 'Indexing and discovery',
  clicks: 'Clicks',
  conversion: 'Conversion',
  measurement: 'Measurement',
}

/** The thresholds, in one place. */
export const THRESHOLDS = {
  /** No blog post for this long while the writer is on: nudge it once. */
  blogQuietHours: 72,
  /** No guide for this long while guides are waiting: report. */
  guideQuietHours: 48,
  /** Posts below the quality bar must rise by this many since the last check to count as rising. */
  qualityRise: 3,
  /** A share of published posts below the bar at or above this is red when rising. */
  qualityShareBad: 0.25,
  /** No social send for this long while rows are queued or posts exist. */
  sendQuietHours: 36,
  /** A network that fails this many times in a row is paused for 24 hours; after a pause, one failure pauses it again. */
  networkFailStreak: 3,
  /** After this many pauses in a row the watchdog stops pausing and asks for a person. */
  maxPauseStrikes: 2,
  /** The IndexNow catch-up counts as stale after this long. */
  indexNowStaleHours: 36,
  /** A published page must be in the sitemap after this long. */
  sitemapGraceHours: 6,
  /** A page with at least this many visits and no leads is a conversion card candidate. */
  conversionMinVisits: 100,
  /** No visit rows for this long while tracking is on. */
  measurementQuietHours: 48,
  /** A pause needs this many days of nudging to be called "again": a nudge happens at most once in this window. */
  nudgeWindowHours: 72,
} as const

export interface PlannedAction {
  kind: 'nudge-autoblog' | 'pause-network' | 'resume-networks' | 'indexnow-catchup'
  network?: string
  strikes?: number
}

export interface StageCheck {
  stage: Stage
  status: Status
  /** One plain sentence for the card. */
  summary: string
  /** The real numbers the verdict used. null = could not be read. */
  evidence: Record<string, number | string | null>
  /** What was done, or what is left to the optimizer or the refresh loop, or "needs Joel: ...". */
  action: string
  /** True when a number the check needs could not be read (the status is then warn, never ok). */
  unreadable?: boolean
  /** A repair the runner may make (absent after it is made or when none applies). */
  plan?: PlannedAction
}

export interface NetworkFailureRow {
  stage: string
  sent_platforms: string[] | null
  last_error: string | null
  updated_at: string
}

export interface WatchdogFacts {
  now: Date
  paused: boolean | null
  autopilotOn: boolean | null
  autoblogMode: string | null
  /** Hours since the newest published (non-news) blog post. null = could not be read. */
  hoursSinceBlogPost: number | null
  blogEverPublished: boolean | null
  /** Hours since the watchdog last nudged the writer (null = never). */
  hoursSinceNudge: number | null
  guidesPublished48h: number | null
  guidesWaiting: number | null
  guideCaps: { today: number | null; week: number | null; perDay: number; perWeek: number } | null
  belowBar: { count: number; total: number } | null
  belowBarPrev: number | null
  distributionMode: string | null
  sends36h: number | null
  queuedRows: number | null
  recentPosts7d: number | null
  networks: string[] | null
  pauses: NetworkPauses | null
  /** Consecutive failures per network since its last clean send or the end of its last pause. */
  networkStreaks: Record<string, number> | null
  newPagesMissingFromSitemap: number | null
  indexNowConfigured: boolean
  indexNowLastAgeHours: number | null
  strikingPages: number | null
  /** Optimizer arms that clearly trail their peers. null = could not be read. */
  armsUnderperforming: number | null
  optimizerNeedsData: boolean | null
  zeroLeadPages: { path: string; visits: number }[] | null
  visitTrackingOn: boolean | null
  visits48h: number | null
}

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1))
const unread = (stage: Stage, what: string, evidence: StageCheck['evidence'] = {}): StageCheck => ({ stage, status: 'warn', summary: `${what} could not be read right now.`, evidence, action: 'Checked again tomorrow.', unreadable: true })
const rank: Record<Status, number> = { ok: 0, warn: 1, bad: 2 }
const worst = (a: Status, b: Status): Status => (rank[a] >= rank[b] ? a : b)

// ---------------------------------------------------------------------------------------------------
// Pure checks
// ---------------------------------------------------------------------------------------------------

function production(f: WatchdogFacts): StageCheck {
  const ev: StageCheck['evidence'] = { hours_since_last_blog_post: f.hoursSinceBlogPost === null ? null : Math.round(f.hoursSinceBlogPost), threshold_hours: THRESHOLDS.blogQuietHours, guides_published_48h: f.guidesPublished48h, guides_waiting: f.guidesWaiting }
  const writerOn = f.autoblogMode === 'publish' && f.autopilotOn === true && f.paused === false
  const parts: { status: Status; text: string; action: string; plan?: PlannedAction }[] = []

  if (f.hoursSinceBlogPost === null || f.blogEverPublished === null) {
    return unread('production', 'The newest blog post time', ev)
  }
  if (!writerOn) {
    parts.push({ status: 'ok', text: 'The blog writer is off or paused, so a quiet blog is expected.', action: 'Nothing to do.' })
  } else if (f.hoursSinceBlogPost > THRESHOLDS.blogQuietHours) {
    const hrs = Math.round(f.hoursSinceBlogPost)
    if (f.hoursSinceNudge !== null && f.hoursSinceNudge < THRESHOLDS.nudgeWindowHours) {
      parts.push({ status: 'bad', text: `No blog post for ${hrs} hours; the writer was already nudged ${Math.round(f.hoursSinceNudge)} hours ago.`, action: 'Needs Joel: the writer was nudged and still nothing was published. Look at Needs attention on the Content Autopilot page.' })
    } else {
      parts.push({ status: 'warn', text: `No blog post for ${hrs} hours (the limit is ${THRESHOLDS.blogQuietHours}).`, action: 'Asked the writer to run on the next pass (once).', plan: { kind: 'nudge-autoblog' } })
    }
  } else {
    parts.push({ status: 'ok', text: `A blog post went out ${Math.round(f.hoursSinceBlogPost)} hours ago.`, action: 'Nothing to do.' })
  }

  if (f.guidesPublished48h === null || f.guidesWaiting === null) {
    parts.push({ status: 'warn', text: 'The guide counts could not be read.', action: 'Checked again tomorrow.' })
  } else if (f.guidesPublished48h === 0 && f.guidesWaiting > 0) {
    const caps = f.guideCaps
    if (!caps || caps.today === null || caps.week === null) parts.push({ status: 'warn', text: `No guide in 48 hours with ${f.guidesWaiting} waiting, and the guide limits could not be read.`, action: 'Checked again tomorrow.' })
    else if (caps.today >= caps.perDay || caps.week >= caps.perWeek) parts.push({ status: 'ok', text: `No guide in 48 hours, but the guide limit is used (${caps.week} of ${caps.perWeek} this week).`, action: 'Nothing to do: the limit is working as set.' })
    else parts.push({ status: 'warn', text: `No guide in 48 hours with ${f.guidesWaiting} waiting, and the limit has room (${caps.week} of ${caps.perWeek} this week).`, action: 'Reported. Look at the guide failures list; the limiter is not what is stopping it.' })
  } else {
    parts.push({ status: 'ok', text: `Guides: ${f.guidesPublished48h} in 48 hours, ${f.guidesWaiting} waiting.`, action: 'Nothing to do.' })
  }

  const status = parts.reduce<Status>((s, p) => worst(s, p.status), 'ok')
  const lead = parts.find((p) => p.status === status) ?? parts[0]
  return { stage: 'production', status, summary: parts.map((p) => p.text).join(' '), evidence: ev, action: lead.action, plan: parts.find((p) => p.plan)?.plan }
}

function quality(f: WatchdogFacts): StageCheck {
  if (!f.belowBar) return unread('quality', 'The count of posts below the quality bar')
  const { count, total } = f.belowBar
  const ev = { posts_below_bar: count, published_posts: total, last_check: f.belowBarPrev, rise_needed: THRESHOLDS.qualityRise }
  if (f.belowBarPrev === null) return { stage: 'quality', status: 'ok', summary: `${count} of ${total} posts are below the quality bar. This is the first check, so there is nothing to compare yet.`, evidence: ev, action: 'Saved as the starting point.' }
  const rise = count - f.belowBarPrev
  const share = total > 0 ? count / total : 0
  const rising = rise >= THRESHOLDS.qualityRise
  if (rising && share >= THRESHOLDS.qualityShareBad) return { stage: 'quality', status: 'bad', summary: `Posts below the bar rose by ${rise} to ${count} of ${total} (${Math.round(share * 100)}%).`, evidence: ev, action: 'Needs Joel if it is still this high after the next refresh run. The refresh loop runs first.' }
  if (rising) return { stage: 'quality', status: 'warn', summary: `Posts below the bar rose by ${rise} to ${count} of ${total}.`, evidence: ev, action: 'Left to the weekly refresh loop, which runs first. Nothing was changed.' }
  return { stage: 'quality', status: 'ok', summary: `${count} of ${total} posts are below the bar (${rise >= 0 ? 'up' : 'down'} ${Math.abs(rise)} since the last check).`, evidence: ev, action: 'Nothing to do.' }
}

function distribution(f: WatchdogFacts): StageCheck {
  const ev: StageCheck['evidence'] = { mode: f.distributionMode, sends_36h: f.sends36h, queued_rows: f.queuedRows, posts_7d: f.recentPosts7d, networks: f.networks ? f.networks.length : null, paused_networks: f.pauses ? pausedNow(f.pauses, f.now).join(', ') || 'none' : null }
  if (f.distributionMode === null) return unread('distribution', 'The posting mode', ev)
  if (f.distributionMode !== 'auto') return { stage: 'distribution', status: 'ok', summary: `Posting is in "${f.distributionMode}" mode, so no automatic sends are expected.`, evidence: ev, action: 'Nothing to do.' }
  if (f.sends36h === null || f.queuedRows === null || f.recentPosts7d === null) return unread('distribution', 'The social send counts', ev)
  if (f.networks === null || f.pauses === null || f.networkStreaks === null) return unread('distribution', 'The network list or failure history', ev)

  // 1) a network that keeps failing
  const activePauses = pausedNow(f.pauses, f.now)
  for (const net of f.networks) {
    const streak = f.networkStreaks[net] ?? 0
    const strikes = f.pauses[net]?.strikes ?? 0
    const need = f.pauses[net] ? 1 : THRESHOLDS.networkFailStreak
    if (activePauses.includes(net) || streak < need) continue
    if (strikes >= THRESHOLDS.maxPauseStrikes) {
      return { stage: 'distribution', status: 'bad', summary: `${net} failed again after ${strikes} pauses (${streak} failures in a row).`, evidence: { ...ev, [`${net}_failures_in_a_row`]: streak }, action: `Needs Joel: reconnect ${net}; the watchdog stopped pausing it.` }
    }
    return { stage: 'distribution', status: 'warn', summary: `${net} failed ${streak} times in a row.`, evidence: { ...ev, [`${net}_failures_in_a_row`]: streak }, action: `Paused ${net} for ${NETWORK_PAUSE_HOURS} hours; the next post after that is the test.`, plan: { kind: 'pause-network', network: net, strikes: strikes + 1 } }
  }

  // 2) nothing went out at all
  const somethingToSend = f.queuedRows > 0 || f.recentPosts7d > 0
  if (f.sends36h === 0 && somethingToSend) {
    if (f.networks.length === 0) return { stage: 'distribution', status: 'bad', summary: `No social send in ${THRESHOLDS.sendQuietHours} hours, and no network is able to post.`, evidence: ev, action: 'Needs Joel: connect or tick a network in the Posting card.' }
    if (activePauses.length > 0) return { stage: 'distribution', status: 'warn', summary: `No social send in ${THRESHOLDS.sendQuietHours} hours; ${activePauses.join(', ')} ${activePauses.length === 1 ? 'is' : 'are'} paused.`, evidence: ev, action: 'Ended the pause so the next pass can post.', plan: { kind: 'resume-networks' } }
    return { stage: 'distribution', status: 'bad', summary: `No social send in ${THRESHOLDS.sendQuietHours} hours although ${f.queuedRows} rows are queued and ${f.recentPosts7d} posts went live this week; ${f.networks.length} network${f.networks.length === 1 ? '' : 's'} look fine.`, evidence: ev, action: 'Needs Joel: open Needs attention on the Content Autopilot page for the reason.' }
  }
  return { stage: 'distribution', status: 'ok', summary: f.sends36h > 0 ? `${f.sends36h} social send${f.sends36h === 1 ? '' : 's'} in the last ${THRESHOLDS.sendQuietHours} hours.` : 'Nothing is waiting to be sent.', evidence: ev, action: 'Nothing to do.' }
}

function discovery(f: WatchdogFacts): StageCheck {
  const ev: StageCheck['evidence'] = { new_pages_missing_from_sitemap: f.newPagesMissingFromSitemap, indexnow_last_run_hours_ago: f.indexNowLastAgeHours === null ? null : Math.round(f.indexNowLastAgeHours), striking_distance_pages: f.strikingPages }
  const issues: string[] = []
  let plan: PlannedAction | undefined
  if (f.newPagesMissingFromSitemap !== null && f.newPagesMissingFromSitemap > 0) {
    issues.push(`${f.newPagesMissingFromSitemap} new page${f.newPagesMissingFromSitemap === 1 ? ' is' : 's are'} not in the sitemap yet`)
    plan = { kind: 'indexnow-catchup' }
  }
  if (f.indexNowConfigured && (f.indexNowLastAgeHours === null ? false : f.indexNowLastAgeHours > THRESHOLDS.indexNowStaleHours)) {
    issues.push(`the IndexNow catch-up has not run for ${Math.round(f.indexNowLastAgeHours as number)} hours`)
    plan = { kind: 'indexnow-catchup' }
  }
  const striking = f.strikingPages !== null && f.strikingPages > 0 ? ` ${f.strikingPages} page${f.strikingPages === 1 ? ' is' : 's are'} near page one (position ${STRIKING_MIN} to ${STRIKING_MAX}); the click-rate loop picks them up daily.` : ''
  if (issues.length) return { stage: 'discovery', status: 'warn', summary: `${issues.join(' and ')}.${striking}`, evidence: ev, action: 'Ran the IndexNow catch-up for pages changed in the last 48 hours.', plan }
  if (f.newPagesMissingFromSitemap === null) {
    return { ...unread('discovery', 'The sitemap'), evidence: ev, summary: `The sitemap could not be read right now.${striking}` }
  }
  return { stage: 'discovery', status: 'ok', summary: `New pages are in the sitemap and pings are current.${striking}`, evidence: ev, action: 'Nothing to do.' }
}

function clicks(f: WatchdogFacts): StageCheck {
  const ev = { underperforming_styles: f.armsUnderperforming, needs_more_data: f.optimizerNeedsData === null ? null : f.optimizerNeedsData ? 'yes' : 'no' }
  if (f.armsUnderperforming === null || f.optimizerNeedsData === null) return unread('clicks', 'The optimizer results', ev)
  if (f.optimizerNeedsData) return { stage: 'clicks', status: 'ok', summary: 'Not enough sends yet to compare hook styles or networks.', evidence: ev, action: 'Nothing to do.' }
  if (f.armsUnderperforming > 0) return { stage: 'clicks', status: 'warn', summary: `${f.armsUnderperforming} hook style${f.armsUnderperforming === 1 ? '' : 's'} or network${f.armsUnderperforming === 1 ? '' : 's'} clearly trail${f.armsUnderperforming === 1 ? 's' : ''} the rest.`, evidence: ev, action: 'Left to the optimizer, which steers away from it. Nothing was changed.' }
  return { stage: 'clicks', status: 'ok', summary: 'No hook style or network clearly trails the rest.', evidence: ev, action: 'Nothing to do.' }
}

function conversion(f: WatchdogFacts): StageCheck {
  if (f.zeroLeadPages === null) return unread('conversion', 'Visits per page or leads')
  const ev = { pages_with_visits_and_no_leads: f.zeroLeadPages.length, visit_floor: THRESHOLDS.conversionMinVisits }
  if (f.zeroLeadPages.length === 0) return { stage: 'conversion', status: 'ok', summary: `No page has ${THRESHOLDS.conversionMinVisits}+ visits and zero leads.`, evidence: ev, action: 'Nothing to do.' }
  const top = f.zeroLeadPages.slice(0, 3).map((p) => `${p.path} (${p.visits})`).join(', ')
  return { stage: 'conversion', status: 'warn', summary: `${f.zeroLeadPages.length} page${f.zeroLeadPages.length === 1 ? ' has' : 's have'} ${THRESHOLDS.conversionMinVisits}+ visits and no leads: ${top}.`, evidence: { ...ev, top_page: f.zeroLeadPages[0].path, top_page_visits: f.zeroLeadPages[0].visits }, action: 'Needs Joel: decide whether the page needs a clearer call to action (a card candidate). Nothing was changed.' }
}

function measurement(f: WatchdogFacts): StageCheck {
  const ev = { visit_tracking: f.visitTrackingOn === null ? null : f.visitTrackingOn ? 'on' : 'off', visit_rows_48h: f.visits48h }
  if (f.visitTrackingOn === null) return unread('measurement', 'The visit tracking switch', ev)
  if (!f.visitTrackingOn) return { stage: 'measurement', status: 'ok', summary: 'Visit tracking is off (by choice), so no visits are expected.', evidence: ev, action: 'Nothing to do.' }
  if (f.visits48h === null) return unread('measurement', 'The visit count', ev)
  if (f.visits48h === 0) return { stage: 'measurement', status: 'bad', summary: `Visit tracking is on but no visit was recorded in ${THRESHOLDS.measurementQuietHours} hours.`, evidence: ev, action: 'Needs Joel: open the live site and check the tracker (consent banner, ad blockers, the daily cap).' }
  return { stage: 'measurement', status: 'ok', summary: `${f.visits48h} visits recorded in the last ${THRESHOLDS.measurementQuietHours} hours.`, evidence: ev, action: 'Nothing to do.' }
}

/** All seven checks over plain facts. Pure. */
export function evaluateFunnel(f: WatchdogFacts): StageCheck[] {
  return [production(f), quality(f), distribution(f), discovery(f), clicks(f), conversion(f), measurement(f)]
}

/** Consecutive failures per network, newest first, counting only events after `since[net]` (the end of its last pause). A clean send
 * to the network ends the streak. A row counts as a failure for a network when it is failed or still queued with an error that names the
 * network and the network is not in its sent_platforms. Pure. */
export function networkStreaks(rows: NetworkFailureRow[], networks: string[], pauses: NetworkPauses): Record<string, number> {
  const out: Record<string, number> = {}
  const sorted = [...rows].sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))
  const alias = (n: string) => (n === 'x' ? ['x', 'twitter'] : n === 'twitter' ? ['twitter', 'x'] : [n])
  for (const net of networks) {
    const names = alias(net)
    const after = pauses[net] ? Date.parse(pauses[net].until) : 0
    let streak = 0
    for (const r of sorted) {
      if (Date.parse(r.updated_at) <= after) break
      const sent = (r.sent_platforms ?? []).some((s) => names.includes(s.toLowerCase()))
      if (sent) break
      const mentioned = !!r.last_error && names.some((n) => new RegExp(`(^|[^a-z])${n}\\s*:`, 'i').test(r.last_error as string))
      if (mentioned && (r.stage === 'failed' || r.stage === 'queued')) streak++
    }
    out[net] = streak
  }
  return out
}

// ---------------------------------------------------------------------------------------------------
// Reading the facts (every read is separate; a failed one is null, never zero)
// ---------------------------------------------------------------------------------------------------

export const WATCHDOG_STATE_KEY = 'funnel_watchdog_state'
export const WATCHDOG_LAST_KEY = 'funnel_watchdog_last'
export const AUTOBLOG_NUDGE_KEY = 'autoblog_nudge'

interface WatchdogState {
  belowBar?: number
  lastNudgeAt?: string
  /** stage -> UTC day a "needs Joel" line was last written, so it is logged once a day. */
  loggedDay?: Record<string, string>
}

function parseState(raw: string | null): WatchdogState {
  try {
    const v = JSON.parse(raw ?? '{}') as WatchdogState | null
    return v && typeof v === 'object' ? v : {}
  } catch {
    return {}
  }
}

async function safe<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn()
  } catch {
    return null
  }
}

const hoursAgo = (iso: string | null | undefined, now: Date): number | null => {
  const t = Date.parse(iso ?? '')
  return Number.isFinite(t) ? Math.max(0, (now.getTime() - t) / 3_600_000) : null
}

export interface WatchdogDeps {
  now?: Date
  /** Replaces the live sitemap read (returns the paths in it, or null when it cannot be read). */
  sitemapPaths?: () => Promise<string[] | null>
  catchup?: () => Promise<{ ok: boolean; note: string }>
}

async function defaultSitemapPaths(): Promise<string[] | null> {
  try {
    const res = await fetch(`${SITE_URL}/sitemap.xml`, { signal: AbortSignal.timeout(8000), headers: { 'user-agent': 'funnel-watchdog' } })
    if (!res.ok) return null
    const xml = await res.text()
    const paths = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => {
      try {
        return new URL(m[1]).pathname.replace(/\/$/, '') || '/'
      } catch {
        return ''
      }
    })
    return paths.length ? paths.filter(Boolean) : null
  } catch {
    return null
  }
}

export async function readWatchdogFacts(admin: SupabaseClient, deps: WatchdogDeps = {}): Promise<WatchdogFacts> {
  const now = deps.now ?? new Date()
  const iso = (ms: number) => new Date(now.getTime() - ms).toISOString()
  const H = 3_600_000
  const state = parseState(await getSetting(admin, WATCHDOG_STATE_KEY).catch(() => null))

  const paused = await safe(async () => {
    const r = await getSettingStrict(admin, AUTOMATION_PAUSED_KEY)
    if (r.error) throw new Error(r.error)
    return r.value === 'true'
  })
  const autopilotOn = await safe(async () => {
    const r = await getSettingStrict(admin, AUTOPILOT_KEY)
    if (r.error) throw new Error(r.error)
    return r.value === 'on'
  })
  const autoblogMode = await safe(async () => {
    const r = await getSettingStrict(admin, 'autoblog_mode')
    if (r.error) throw new Error(r.error)
    return r.value
  })

  const blog = await safe(async () => {
    const { data, error } = await admin.from('posts').select('slug, created_at').eq('status', 'published').order('created_at', { ascending: false }).limit(40)
    if (error) throw new Error(error.message)
    const real = ((data ?? []) as { slug: string; created_at: string }[]).filter((p) => !isNewsSlug(p.slug))
    return { ever: real.length > 0, hours: real.length ? hoursAgo(real[0].created_at, now) : 1e6 }
  })

  const guides48 = await safe(async () => {
    const { count, error } = await admin.from('guides').select('id', { count: 'exact', head: true }).eq('status', 'published').gte('created_at', iso(48 * H))
    if (error) throw new Error(error.message)
    return count ?? 0
  })
  const plan = await safe(() => readPlanStatus(admin))
  const guideCaps = await safe(async () => {
    const [usage, caps] = await Promise.all([readCapUsage(admin), getGuideCaps(admin)])
    return { today: usage.today, week: usage.week, perDay: caps.perDay, perWeek: caps.perWeek }
  })

  const belowBar = await safe(() => postsBelowQualityBar(admin, now))

  const distributionMode = await safe(() => getDistributionMode(admin))
  const sends = await safe(async () => {
    const { data, error } = await admin.from('post_distribution').select('stage, sent_platforms, updated_at').eq('stage', 'done').gte('updated_at', iso(THRESHOLDS.sendQuietHours * H)).limit(200)
    if (error) throw new Error(error.message)
    return ((data ?? []) as { sent_platforms: string[] | null }[]).filter((r) => (r.sent_platforms ?? []).length > 0).length
  })
  const queued = await safe(async () => {
    const { count, error } = await admin.from('post_distribution').select('slug', { count: 'exact', head: true }).eq('stage', 'queued')
    if (error) throw new Error(error.message)
    return count ?? 0
  })
  const posts7 = await safe(async () => {
    const { count, error } = await admin.from('posts').select('id', { count: 'exact', head: true }).eq('status', 'published').gte('created_at', iso(7 * 24 * H))
    if (error) throw new Error(error.message)
    return count ?? 0
  })
  const networks = await safe(async () => (await getActivePlatforms(admin)).platforms)
  const pauses = await readPauses(admin)
  const streaks = await safe(async () => {
    if (!networks || !pauses) throw new Error('no networks')
    const { data, error } = await admin.from('post_distribution').select('stage, sent_platforms, last_error, updated_at').in('stage', ['failed', 'queued', 'done']).order('updated_at', { ascending: false }).limit(100)
    if (error) throw new Error(error.message)
    return networkStreaks((data ?? []) as NetworkFailureRow[], networks, pauses)
  })

  // Indexing: pages published in the last 7 days (and older than the grace) that the live sitemap does not list.
  const missing = await safe(async () => {
    const listed = await (deps.sitemapPaths ?? defaultSitemapPaths)()
    if (!listed) throw new Error('no sitemap')
    const set = new Set(listed)
    const { data, error } = await admin.from('posts').select('slug, created_at').eq('status', 'published').gte('created_at', iso(7 * 24 * H)).lte('created_at', iso(THRESHOLDS.sitemapGraceHours * H)).limit(100)
    if (error) throw new Error(error.message)
    return ((data ?? []) as { slug: string }[]).filter((p) => !set.has(`/blog/${p.slug}`)).length
  })
  const indexNowAge = await safe(async () => {
    const raw = await getSetting(admin, INDEXNOW_LAST_KEY)
    if (!raw) return null
    return hoursAgo((JSON.parse(raw) as { at?: string }).at, now)
  })
  const striking = await safe(async () => {
    const { data, error } = await admin.from('gsc_rankings').select('key, position, impressions').eq('kind', 'page').gte('day', iso(7 * 24 * H).slice(0, 10)).limit(2000)
    if (error) throw new Error(error.message)
    const pages = new Set<string>()
    for (const r of (data ?? []) as { key: string; position: number | string; impressions: number | string }[]) {
      const p = Number(r.position)
      if (Number(r.impressions) >= 20 && p >= STRIKING_MIN && p <= STRIKING_MAX) pages.add(r.key)
    }
    return pages.size
  })

  const opt = await safe(() => readOptimizerSummary(admin))
  let under: number | null = null
  let needsData: boolean | null = null
  if (opt && opt.ok) {
    needsData = opt.summary.needMoreData
    const groups = new Map<string, { sends: number; perSend: number | null; status: string }[]>()
    for (const a of opt.summary.arms) groups.set(`${a.network}|${a.format}|${a.dim}`, [...(groups.get(`${a.network}|${a.format}|${a.dim}`) ?? []), a])
    under = 0
    for (const arms of groups.values()) {
      const best = Math.max(0, ...arms.map((a) => a.perSend ?? 0))
      for (const a of arms) if (a.status === 'active' && a.perSend !== null && best > 0 && a.perSend < best * 0.5 && a.sends >= opt.summary.minSends) under++
    }
  }

  const tracking = await safe(() => isVisitTrackingOn(admin))
  const visits48 = await safe(async () => {
    const { count, error } = await admin.from('site_visits').select('id', { count: 'exact', head: true }).gte('created_at', iso(THRESHOLDS.measurementQuietHours * H))
    if (error) throw new Error(error.message)
    return count ?? 0
  })
  const zero = await safe(async () => {
    const since = iso(28 * 24 * H)
    const v = await readAllPages<{ landing_path: string | null }>((from, to) => admin.from('site_visits').select('landing_path').gte('created_at', since).order('created_at', { ascending: false }).range(from, to), 40)
    const l = await readAllPages<{ page_path: string | null }>((from, to) => admin.from('leads').select('page_path').eq('is_test', false).gte('created_at', since).order('created_at', { ascending: false }).range(from, to), 40)
    if ((!v.ok && !v.capped) || !l.ok) throw new Error('could not read visits or leads')
    const visits = new Map<string, number>()
    for (const r of v.rows) if (r.landing_path) visits.set(r.landing_path, (visits.get(r.landing_path) ?? 0) + 1)
    const leads = new Set(l.rows.map((r) => r.page_path).filter(Boolean) as string[])
    return [...visits.entries()].filter(([path, n]) => n >= THRESHOLDS.conversionMinVisits && !leads.has(path)).sort((a, b) => b[1] - a[1]).map(([path, n]) => ({ path, visits: n }))
  })

  return {
    now,
    paused,
    autopilotOn,
    autoblogMode,
    hoursSinceBlogPost: blog ? blog.hours : null,
    blogEverPublished: blog ? blog.ever : null,
    hoursSinceNudge: hoursAgo(state.lastNudgeAt, now),
    guidesPublished48h: guides48,
    guidesWaiting: plan ? plan.summary.waiting : null,
    guideCaps,
    belowBar,
    belowBarPrev: typeof state.belowBar === 'number' ? state.belowBar : null,
    distributionMode,
    sends36h: sends,
    queuedRows: queued,
    recentPosts7d: posts7,
    networks,
    pauses,
    networkStreaks: streaks,
    newPagesMissingFromSitemap: missing,
    indexNowConfigured: isIndexNowConfigured(),
    indexNowLastAgeHours: indexNowAge,
    strikingPages: striking,
    armsUnderperforming: under,
    optimizerNeedsData: needsData,
    zeroLeadPages: zero,
    visitTrackingOn: tracking,
    visits48h: visits48,
  }
}

// ---------------------------------------------------------------------------------------------------
// Running it
// ---------------------------------------------------------------------------------------------------

export interface WatchdogRecord {
  at: string
  checks: StageCheck[]
}

export async function readWatchdogRecord(admin: SupabaseClient): Promise<WatchdogRecord | null> {
  try {
    const v = JSON.parse((await getSetting(admin, WATCHDOG_LAST_KEY)) ?? 'null') as WatchdogRecord | null
    return v && typeof v.at === 'string' && Array.isArray(v.checks) ? v : null
  } catch {
    return null
  }
}

/** Makes the planned repair. Returns the log entry, or null when it did nothing. */
async function perform(admin: SupabaseClient, check: StageCheck, plan: PlannedAction, f: WatchdogFacts, deps: WatchdogDeps): Promise<AutoDecision | null> {
  const now = f.now
  if (plan.kind === 'nudge-autoblog') {
    const r = await setSetting(admin, AUTOBLOG_NUDGE_KEY, now.toISOString())
    return r.error ? null : decision('funnel_watchdog', 'production', 'Asked the blog writer to run on the next pass', check.summary, null, now)
  }
  if (plan.kind === 'pause-network' && plan.network) {
    const pauses = { ...(f.pauses ?? {}) }
    pauses[plan.network] = { since: now.toISOString(), until: new Date(now.getTime() + NETWORK_PAUSE_HOURS * 3_600_000).toISOString(), strikes: plan.strikes ?? 1 }
    const r = await writePauses(admin, pauses)
    return r.error ? null : decision('funnel_watchdog', plan.network, `Paused ${plan.network} for ${NETWORK_PAUSE_HOURS} hours`, check.summary, { kind: 'unpause-network', ref: plan.network }, now)
  }
  if (plan.kind === 'resume-networks') {
    const active = pausedNow(f.pauses ?? {}, now)
    const pauses = { ...(f.pauses ?? {}) }
    for (const n of active) delete pauses[n]
    const r = await writePauses(admin, pauses)
    return r.error ? null : decision('funnel_watchdog', 'distribution', `Ended the pause on ${active.join(', ')}`, check.summary, null, now)
  }
  if (plan.kind === 'indexnow-catchup') {
    const res = await (deps.catchup ?? (() => runIndexNowCatchup(admin)))()
    return decision('funnel_watchdog', 'discovery', 'Ran the IndexNow catch-up', `${check.summary} Result: ${res.note}`, null, now)
  }
  return null
}

export interface WatchdogRun {
  record: WatchdogRecord
  note: string
  decisions: AutoDecision[]
}

/** The daily run. Reads, evaluates, makes the bounded repairs (unless paused, switched off or over the daily limit; then it only
 * reports), logs, and saves the result for the card. Never throws. */
export async function runFunnelWatchdog(admin: SupabaseClient, deps: WatchdogDeps = {}): Promise<WatchdogRun> {
  const now = deps.now ?? new Date()
  const empty: WatchdogRun = { record: { at: now.toISOString(), checks: [] }, note: '', decisions: [] }
  try {
    const facts = await readWatchdogFacts(admin, { ...deps, now })
    const checks = evaluateFunnel(facts)
    const gate = await policyGate(admin, 'funnel_watchdog', now)
    const log: AutoDecision[] = []
    const state = parseState(await getSetting(admin, WATCHDOG_STATE_KEY).catch(() => null))
    const day = now.toISOString().slice(0, 10)
    const loggedDay = { ...(state.loggedDay ?? {}) }
    let room = gate.room

    for (const c of checks) {
      const plan = c.plan
      delete c.plan
      if (plan) {
        if (!gate.allowed || room <= 0) {
          c.action = `Report only: ${gate.allowed ? 'today\'s repair limit is used' : gate.reason}. Planned: ${c.action.charAt(0).toLowerCase()}${c.action.slice(1)}`
        } else {
          const entry = await perform(admin, c, plan, facts, deps)
          if (entry) {
            log.push(entry)
            room--
            if (plan.kind === 'nudge-autoblog') state.lastNudgeAt = now.toISOString()
          } else {
            c.action = 'The repair could not be made; it will be tried again tomorrow.'
          }
        }
      }
      // A "needs Joel" result is logged once a day so the log shows it without repeating itself.
      if (c.status !== 'ok' && /^Needs Joel/.test(c.action) && loggedDay[c.stage] !== day) {
        loggedDay[c.stage] = day
        log.push(decision('funnel_watchdog', c.stage, 'Needs Joel: ' + c.summary, c.action.replace(/^Needs Joel:?\s*/, ''), null, now))
      }
    }
    if (facts.belowBar) state.belowBar = facts.belowBar.count
    state.loggedDay = loggedDay
    await setSetting(admin, WATCHDOG_STATE_KEY, JSON.stringify(state)).catch(() => undefined)

    const record: WatchdogRecord = { at: now.toISOString(), checks }
    await setSetting(admin, WATCHDOG_LAST_KEY, JSON.stringify(record)).catch(() => undefined)
    await appendDecisions(admin, log)
    const bad = checks.filter((c) => c.status === 'bad').length
    const warn = checks.filter((c) => c.status === 'warn').length
    return { record, decisions: log, note: `funnel watchdog: ${checks.length - bad - warn} ok, ${warn} warn, ${bad} bad${log.length ? `, ${log.length} logged` : ''}` }
  } catch (e) {
    return { ...empty, note: `funnel watchdog failed: ${e instanceof Error ? e.message : 'unknown error'}` }
  }
}

// ---------------------------------------------------------------------------------------------------
// The autoblog nudge (read by the pipeline's write step)
// ---------------------------------------------------------------------------------------------------

/** True when the watchdog asked for one extra writer run in the last 24 hours. */
export async function autoblogNudgePending(admin: SupabaseClient, now: Date = new Date()): Promise<boolean> {
  try {
    const raw = await getSetting(admin, AUTOBLOG_NUDGE_KEY)
    const t = Date.parse(raw ?? '')
    return Number.isFinite(t) && now.getTime() - t < 24 * 3_600_000
  } catch {
    return false
  }
}

export async function clearAutoblogNudge(admin: SupabaseClient): Promise<void> {
  await setSetting(admin, AUTOBLOG_NUDGE_KEY, '').catch(() => undefined)
}
