// The automated system check, pure part. Plain facts go in; one list of stages in funnel order comes out. Each stage is green,
// amber or red, with ONE plain sentence that carries the real number, what the site fixed by itself, and what needs a person
// (with a link). No database and no network here, so scripts/check-admin-v2.ts and scripts/check-system-check-voice.ts can
// test every rule offline. lib/system-check-run.ts reads the facts and stores the result.
//
// Rules that hold for every stage:
//  - a number that could not be read is amber and says "could not be read". It is never shown as a zero and never green;
//  - sentences are short, plain words, no jargon (the labels are the only place a technical word may stay);
//  - no long dashes anywhere.
// The thresholds (hours quiet, ceilings) are the ones the funnel watchdog already uses; this file only reads its stored answer.

import { hotWaitLight, hotWaitSentence, waitText, type HotWait } from '@/lib/lead-desk'
import { DRY_RUN_AMBER_HOURS, dryRunSentence } from '@/lib/dry-run-shape'

export type Light = 'green' | 'amber' | 'red'

export const STAGE_IDS = ['production', 'quality', 'distribution', 'discovery', 'clicks', 'conversion', 'measurement', 'money', 'seo', 'jobs', 'ai'] as const
export type StageId = (typeof STAGE_IDS)[number]

export const STAGE_LABELS: Record<StageId, string> = {
  production: 'Production',
  quality: 'Quality',
  distribution: 'Distribution',
  discovery: 'Discovery',
  clicks: 'Clicks',
  conversion: 'Conversion',
  measurement: 'Measurement',
  money: 'Money',
  seo: 'SEO score',
  jobs: 'Daily jobs',
  ai: 'AI spending',
}

/** Where "needs you" points for each stage: a short action and the page. */
export const STAGE_NEEDS: Record<StageId, { text: string; href: string }> = {
  production: { text: 'Open the blog writer', href: '/admin/blog?tab=autoblog' },
  quality: { text: 'Open the blog list', href: '/admin/blog' },
  distribution: { text: 'Open Post Distribution', href: '/admin/distribution' },
  discovery: { text: 'Open the SEO engines', href: '/admin/seo-engines' },
  clicks: { text: 'Open Content Autopilot', href: '/admin/autopilot' },
  conversion: { text: 'Open Leads', href: '/admin/leads' },
  measurement: { text: 'Open Users and Analytics', href: '/admin/users' },
  money: { text: 'Open Orders', href: '/admin/orders' },
  seo: { text: 'Open the SEO and GEO Manager', href: '/admin/seo-manager' },
  jobs: { text: 'Open System Health', href: '/admin/system-health' },
  ai: { text: 'Open Users and Analytics', href: '/admin/users' },
}

// ---------------------------------------------------------------------------------------------------
// The facts (every one may be null = could not be read)
// ---------------------------------------------------------------------------------------------------

/** One stored answer of the funnel watchdog (lib/funnel-watchdog.ts StageCheck), reduced to what is read here. */
export interface WatchdogLike {
  stage: string
  status: 'ok' | 'warn' | 'bad'
  evidence: Record<string, number | string | null>
  unreadable?: boolean
}

export interface DecisionLike {
  at: string
  policy: string
  subject: string
  action: string
  undone_at?: string
}

export interface JobFact {
  /** green = ran on time and was fine; amber = quiet too long or reported a problem; gray = never reported. */
  light: 'green' | 'amber' | 'gray'
  /** Hours since it last reported, or null when it never has. */
  ageHours: number | null
}

export interface CheckFacts {
  now: Date
  /** The watchdog's stored daily answer. null = could not be read; checks [] = never run. */
  watchdog: { at: string | null; checks: WatchdogLike[] } | null
  /** Site crawl summary. null = could not be read; lastRun null = never run. */
  crawl: { lastRun: string | null; errors: number; warnings: number } | null
  /** SEO playbook audit. null = could not be read; score null = never run. */
  seo: { score: number | null; failing: number } | null
  jobs: { autopilot: JobFact | null; daily: JobFact | null } | null
  ai: { spend: number | null; ceiling: number } | null
  orders: { paid30d: number | null; webhookFailing: boolean } | null
  /** Picture checks that skipped a post in the last 7 days. null = could not be read. */
  gateSkips7d: number | null
  decisions: DecisionLike[] | null
  /** Hot leads (call-back requests, forms with a phone number) still waiting for an agent. undefined = not asked; null = could not be read. */
  hotLeads?: HotWait | null
  /** Whole hours Autopilot has been in dry run (nothing is published). undefined/null = not in dry run, or not known. */
  dryRunHours?: number | null
}

export interface CheckStage {
  id: StageId
  label: string
  light: Light
  /** False when a number the stage needs could not be read. Such a stage is never green. */
  read: boolean
  /** ONE plain sentence, or two very short ones. */
  sentence: string
  /** The real number the verdict used, as short text (for the right-hand side of the row). null when it could not be read. */
  number: string | null
  /** What the site fixed by itself in the last 24 hours, in the words it logged. */
  fixed: string[]
  /** What needs a person, with the page to open. null when nothing does. */
  needs: { text: string; href: string } | null
}

export interface CheckResult {
  at: string
  overall: Light
  stages: CheckStage[]
  /** The first red stage, else the first amber one, else null. */
  worst: { id: StageId; label: string; light: Light; sentence: string } | null
}

// ---------------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------------

const RANK: Record<Light, number> = { green: 0, amber: 1, red: 2 }
export const worstLight = (lights: Light[]): Light => lights.reduce<Light>((w, l) => (RANK[l] > RANK[w] ? l : w), 'green')

const fromStatus = (s: WatchdogLike['status']): Light => (s === 'bad' ? 'red' : s === 'warn' ? 'amber' : 'green')
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const word = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many)
const count = (n: number, one: string, many = `${one}s`) => `${n} ${word(n, one, many)}`
export const usd = (n: number) => `$${n.toFixed(2)}`

/** "under an hour", "5 hours" or "3 days". */
export function ageText(hours: number): string {
  if (hours < 1) return 'under an hour'
  if (hours < 48) return count(Math.round(hours), 'hour')
  return count(Math.round(hours / 24), 'day')
}

const UNREAD = 'could not be read'

function unread(id: StageId, what: string): CheckStage {
  return { id, label: STAGE_LABELS[id], light: 'amber', read: false, sentence: `${what} ${UNREAD}.`, number: null, fixed: [], needs: null }
}

function find(f: CheckFacts, stage: string): WatchdogLike | null {
  if (!f.watchdog) return null
  return f.watchdog.checks.find((c) => c.stage === stage) ?? null
}

/** The watchdog answer for a stage, or the unread stage to return when it is missing or says it could not read. */
function viaWatchdog(f: CheckFacts, id: StageId, what: string): { w: WatchdogLike } | { stage: CheckStage } {
  if (!f.watchdog) return { stage: unread(id, what) }
  const w = find(f, id)
  if (!w) return { stage: { ...unread(id, what), sentence: `The daily check has not looked at this yet.` } }
  if (w.unreadable) return { stage: unread(id, what) }
  return { w }
}

// ---------------------------------------------------------------------------------------------------
// The stages
// ---------------------------------------------------------------------------------------------------

function production(f: CheckFacts): CheckStage {
  const r = viaWatchdog(f, 'production', 'The blog and guide numbers')
  if ('stage' in r) return r.stage
  const hours = num(r.w.evidence.hours_since_last_blog_post)
  const limit = num(r.w.evidence.threshold_hours) ?? 72
  const guides = num(r.w.evidence.guides_published_48h)
  if (hours === null) return unread('production', 'The blog numbers')
  const light = fromStatus(r.w.status)
  const noPostEver = hours >= 100_000
  let sentence: string
  if (noPostEver) sentence = 'No blog post has gone out yet.'
  else if (light === 'green') sentence = `The last blog post went out ${ageText(hours)} ago.`
  else sentence = `No blog post for ${ageText(hours)}. The limit is ${limit} hours.`
  if (guides !== null && !noPostEver) sentence += ` ${count(guides, 'new guide')} went live in 2 days.`
  return { id: 'production', label: STAGE_LABELS.production, light, read: true, sentence, number: noPostEver ? 'no post yet' : `${ageText(hours)} since the last post`, fixed: [], needs: null }
}

function quality(f: CheckFacts): CheckStage {
  const r = viaWatchdog(f, 'quality', 'The quality numbers')
  if ('stage' in r) return r.stage
  const below = num(r.w.evidence.posts_below_bar)
  const total = num(r.w.evidence.published_posts)
  if (below === null || total === null) return unread('quality', 'The quality numbers')
  const light = fromStatus(r.w.status)
  const sentence = light === 'green' ? `${below} of ${total} posts are below the quality bar.` : `${below} of ${total} posts are below the quality bar, and the number is going up.`
  return { id: 'quality', label: STAGE_LABELS.quality, light, read: true, sentence, number: `${below} of ${total} below the bar`, fixed: [], needs: null }
}

function distribution(f: CheckFacts): CheckStage {
  const r = viaWatchdog(f, 'distribution', 'The social posting numbers')
  if ('stage' in r) return r.stage
  const light = fromStatus(r.w.status)
  const mode = typeof r.w.evidence.mode === 'string' ? r.w.evidence.mode : null
  const sends = num(r.w.evidence.sends_36h)
  const queued = num(r.w.evidence.queued_rows)
  let sentence: string
  let number: string
  if (mode !== null && mode !== 'auto') {
    sentence = `Posting is set to ${mode}, so nothing goes out on its own.`
    number = `mode: ${mode}`
  } else if (sends === null) {
    return unread('distribution', 'The social posting numbers')
  } else if (light === 'red') {
    sentence = sends === 0 ? `Nothing went out to social in 36 hours.${queued !== null && queued > 0 ? ` ${queued} ${word(queued, 'post is', 'posts are')} waiting.` : ''}` : 'A social network keeps failing.'
    number = `${count(sends, 'post')} sent in 36 hours`
  } else if (light === 'amber') {
    sentence = sends === 0 ? 'Nothing went out to social in 36 hours, so I ended a pause.' : 'One social network was having trouble, so I paused it.'
    number = `${count(sends, 'post')} sent in 36 hours`
  } else {
    sentence = sends > 0 ? `${count(sends, 'post')} went out to social in 36 hours.` : 'Nothing is waiting to be sent.'
    number = `${count(sends, 'post')} sent in 36 hours`
  }
  if (f.gateSkips7d !== null && f.gateSkips7d > 0) sentence += ` The picture check skipped ${count(f.gateSkips7d, 'post')} this week.`
  return { id: 'distribution', label: STAGE_LABELS.distribution, light, read: true, sentence, number, fixed: [], needs: null }
}

function discovery(f: CheckFacts): CheckStage {
  const r = viaWatchdog(f, 'discovery', 'The sitemap')
  const missing = 'w' in r ? num(r.w.evidence.new_pages_missing_from_sitemap) : null
  const wdLight: Light = 'w' in r ? fromStatus(r.w.status) : 'amber'
  const crawl = f.crawl
  const crawlRead = crawl !== null && crawl.lastRun !== null
  const errors = crawl ? crawl.errors : null
  const crawlLight: Light = !crawlRead ? 'amber' : (errors ?? 0) >= 10 ? 'red' : (errors ?? 0) > 0 ? 'amber' : 'green'
  const parts: string[] = []
  if ('stage' in r) parts.push('The sitemap could not be read.')
  else if (missing !== null && missing > 0) parts.push(`${count(missing, 'new page')} ${word(missing, 'is', 'are')} not in the sitemap yet.`)
  else if (missing === null) parts.push('The sitemap could not be read.')
  if (crawl === null) parts.push('The site check could not be read.')
  else if (!crawlRead) parts.push('The site check has not run yet.')
  else if ((errors ?? 0) > 0) parts.push(`The site check found ${count(errors ?? 0, 'broken page')}.`)
  const readAll = !('stage' in r) && missing !== null && crawlRead
  if (readAll && parts.length === 0) parts.push('New pages are in the sitemap. The site check found no errors.')
  const light = worstLight([wdLight, crawlLight, readAll ? 'green' : 'amber'])
  const number = readAll ? (errors && errors > 0 ? `${errors} site ${word(errors, 'error')}` : missing && missing > 0 ? `${missing} not in the sitemap` : 'no site errors') : null
  return { id: 'discovery', label: STAGE_LABELS.discovery, light, read: readAll, sentence: parts.join(' '), number, fixed: [], needs: null }
}

function clicks(f: CheckFacts): CheckStage {
  const r = viaWatchdog(f, 'clicks', 'The click numbers')
  if ('stage' in r) return r.stage
  const under = num(r.w.evidence.underperforming_styles)
  if (under === null) return unread('clicks', 'The click numbers')
  const needsData = r.w.evidence.needs_more_data === 'yes'
  const light = fromStatus(r.w.status)
  const sentence = needsData ? 'There are not enough posts yet to compare styles.' : under > 0 ? `${count(under, 'post style')} ${word(under, 'is', 'are')} getting fewer clicks than the rest.` : 'No post style is falling behind.'
  return { id: 'clicks', label: STAGE_LABELS.clicks, light, read: true, sentence, number: needsData ? 'still learning' : `${under} behind`, fixed: [], needs: null }
}

function conversionBase(f: CheckFacts): CheckStage {
  const r = viaWatchdog(f, 'conversion', 'The lead numbers')
  if ('stage' in r) return r.stage
  const zero = num(r.w.evidence.pages_with_visits_and_no_leads)
  if (zero === null) return unread('conversion', 'The lead numbers')
  const light = fromStatus(r.w.status)
  const floor = num(r.w.evidence.visit_floor) ?? 100
  const sentence = zero === 0 ? `Every page with ${floor} visits has brought in a lead.` : `${count(zero, 'busy page')} ${word(zero, 'has', 'have')} no leads.`
  return { id: 'conversion', label: STAGE_LABELS.conversion, light, read: true, sentence, number: `${count(zero, 'page')} with no leads`, fixed: [], needs: null }
}

/** The lead numbers, plus the lead desk: a hot lead (a call-back request, or a form with a phone number) that has waited with no agent turns the stage amber past 15 minutes and red past 60. */
function conversion(f: CheckFacts): CheckStage {
  const base = conversionBase(f)
  const hot = f.hotLeads
  const light = hotWaitLight(hot)
  if (!hot || !light) return base
  const sentence = hotWaitSentence(hot)
  const mins = Math.floor(hot.oldestMinutes)
  const number = `${count(hot.count, 'hot lead')} waiting, oldest ${waitText(mins)}`
  if (light === 'green') return { ...base, sentence: `${sentence} ${base.sentence}`.trim(), number: base.number ?? number }
  return { ...base, light: worstLight([base.light, light]), sentence: `${sentence} ${base.sentence}`.trim(), number }
}

function measurement(f: CheckFacts): CheckStage {
  const r = viaWatchdog(f, 'measurement', 'The visit numbers')
  if ('stage' in r) return r.stage
  const light = fromStatus(r.w.status)
  const tracking = r.w.evidence.visit_tracking
  const visits = num(r.w.evidence.visit_rows_48h)
  if (tracking === null || tracking === undefined) return unread('measurement', 'The visit tracking switch')
  if (tracking === 'off') return { id: 'measurement', label: STAGE_LABELS.measurement, light, read: true, sentence: 'Visit tracking is off, so no visits are counted.', number: 'tracking off', fixed: [], needs: null }
  if (visits === null) return unread('measurement', 'The visit count')
  const sentence = visits === 0 ? 'Visit tracking is on, but no visit was counted in 48 hours.' : `${count(visits, 'visit')} ${word(visits, 'was', 'were')} counted in 48 hours.`
  return { id: 'measurement', label: STAGE_LABELS.measurement, light, read: true, sentence, number: `${count(visits, 'visit')} in 48 hours`, fixed: [], needs: null }
}

function money(f: CheckFacts): CheckStage {
  if (!f.orders || f.orders.paid30d === null) {
    // A failing payment hook is still worth saying even when the count could not be read.
    if (f.orders?.webhookFailing) return { id: 'money', label: STAGE_LABELS.money, light: 'red', read: false, sentence: 'A payment reached the site but could not be saved. The payment count could not be read.', number: null, fixed: [], needs: null }
    return unread('money', 'The payment numbers')
  }
  const n = f.orders.paid30d
  if (f.orders.webhookFailing) return { id: 'money', label: STAGE_LABELS.money, light: 'red', read: true, sentence: 'A payment reached the site but could not be saved.', number: `${count(n, 'payment')} in 30 days`, fixed: [], needs: null }
  const sentence = n === 0 ? 'No payments came in over the last 30 days.' : `${count(n, 'payment')} came in over the last 30 days.`
  return { id: 'money', label: STAGE_LABELS.money, light: 'green', read: true, sentence, number: `${count(n, 'payment')} in 30 days`, fixed: [], needs: null }
}

export const SEO_GREEN_AT = 70
export const SEO_AMBER_AT = 40

function seo(f: CheckFacts): CheckStage {
  if (!f.seo) return unread('seo', 'The SEO score')
  if (f.seo.score === null) return { id: 'seo', label: STAGE_LABELS.seo, light: 'amber', read: false, sentence: 'The SEO check has not run yet.', number: null, fixed: [], needs: null }
  const s = Math.round(f.seo.score)
  const light: Light = s >= SEO_GREEN_AT ? 'green' : s >= SEO_AMBER_AT ? 'amber' : 'red'
  const tail = f.seo.failing > 0 ? ` ${count(f.seo.failing, 'item')} ${word(f.seo.failing, 'is', 'are')} failing.` : ''
  return { id: 'seo', label: STAGE_LABELS.seo, light, read: true, sentence: `The SEO score is ${s} out of 100.${tail}`, number: `${s} of 100`, fixed: [], needs: null }
}

export const DAILY_CHECK_STALE_HOURS = 36

function jobs(f: CheckFacts): CheckStage {
  if (!f.jobs) return unread('jobs', 'The job times')
  const parts: string[] = []
  const lights: Light[] = []
  let allRead = true
  const one = (name: string, j: JobFact | null) => {
    if (!j || j.light === 'gray' || j.ageHours === null) {
      allRead = false
      lights.push('amber')
      parts.push(`The ${name} has not reported yet.`)
      return
    }
    // Quiet too long, or the last run reported a problem: that is a real fault, so red.
    lights.push(j.light === 'green' ? 'green' : 'red')
    parts.push(`The ${name} ran ${ageText(j.ageHours)} ago.`)
  }
  one('15 minute job', f.jobs.autopilot)
  one('daily job', f.jobs.daily)
  // The funnel watchdog runs inside the daily job and keeps its own stamp.
  if (!f.watchdog || !f.watchdog.at) {
    allRead = false
    lights.push('amber')
    parts.push('The daily check has not reported yet.')
  } else {
    const t = Date.parse(f.watchdog.at)
    const hours = Number.isFinite(t) ? Math.max(0, (f.now.getTime() - t) / 3_600_000) : null
    if (hours === null) {
      allRead = false
      lights.push('amber')
      parts.push('The daily check time could not be read.')
    } else {
      lights.push(hours > DAILY_CHECK_STALE_HOURS ? 'amber' : 'green')
      parts.push(`The daily check ran ${ageText(hours)} ago.`)
    }
  }
  const light = worstLight(lights)
  const number = f.jobs.autopilot && f.jobs.autopilot.ageHours !== null ? `15 minute job ran ${ageText(f.jobs.autopilot.ageHours)} ago` : null
  return { id: 'jobs', label: STAGE_LABELS.jobs, light, read: allRead, sentence: parts.join(' '), number, fixed: [], needs: null }
}

function ai(f: CheckFacts): CheckStage {
  if (!f.ai || f.ai.spend === null) return unread('ai', 'The AI spending')
  const { spend, ceiling } = f.ai
  const light: Light = spend > ceiling ? 'red' : spend >= ceiling * 0.8 ? 'amber' : 'green'
  return { id: 'ai', label: STAGE_LABELS.ai, light, read: true, sentence: `The site used about ${usd(spend)} of AI in a day. The limit is ${usd(ceiling)}.`, number: `${usd(spend)} of ${usd(ceiling)}`, fixed: [], needs: null }
}

// ---------------------------------------------------------------------------------------------------
// What the site fixed by itself
// ---------------------------------------------------------------------------------------------------

const WATCHDOG_SUBJECT_STAGE: Record<string, StageId> = {
  production: 'production', quality: 'quality', distribution: 'distribution', discovery: 'discovery', clicks: 'clicks', conversion: 'conversion', measurement: 'measurement',
}

/** Which stage a logged decision belongs to, or null. Pure. */
export function stageOfDecision(d: DecisionLike): StageId | null {
  switch (d.policy) {
    case 'retry_failed_posts':
    case 'release_held_posts':
      return 'distribution'
    case 'approve_safe_topics':
    case 'publish_passing_news':
      return 'production'
    case 'seo_topics':
    case 'seo_links':
      return 'discovery'
    case 'funnel_watchdog':
      return WATCHDOG_SUBJECT_STAGE[d.subject] ?? 'distribution'
    default:
      return null
  }
}

const DASH = new RegExp('[\\u2014\\u2013]', 'g')

/** Last 24 hours of things done, by stage. A refusal, a "needs a person" line and anything already undone are not fixes. */
export function fixedByStage(log: DecisionLike[] | null, now: Date, perStage = 3): Partial<Record<StageId, string[]>> {
  const out: Partial<Record<StageId, string[]>> = {}
  if (!log) return out
  const since = now.getTime() - 86_400_000
  for (const d of [...log].reverse()) {
    const t = Date.parse(d.at)
    if (!Number.isFinite(t) || t < since || t > now.getTime() + 3_600_000) continue
    if (d.undone_at || /^(Refused|Needs)/i.test(d.action)) continue
    const id = stageOfDecision(d)
    if (!id) continue
    const list = (out[id] ??= [])
    if (list.length < perStage) list.push(`${d.action.replace(DASH, ' - ').replace(/\s+/g, ' ').trim()}.`.replace(/\.\.$/, '.'))
  }
  return out
}

// ---------------------------------------------------------------------------------------------------
// The whole check
// ---------------------------------------------------------------------------------------------------

export function evaluateCheck(f: CheckFacts): CheckResult {
  const fixed = fixedByStage(f.decisions, f.now)
  const conversionTop = f.watchdog ? find(f, 'conversion') : null
  const stages = [production(f), quality(f), distribution(f), discovery(f), clicks(f), conversion(f), measurement(f), money(f), seo(f), jobs(f), ai(f)].map((s) => {
    const needs = s.light === 'green' ? null : { ...STAGE_NEEDS[s.id] }
    if (needs && s.id === 'conversion' && conversionTop && typeof conversionTop.evidence.top_page === 'string') needs.text = `Look at ${conversionTop.evidence.top_page}`
    // A hot lead with no agent is the most urgent thing on this stage: send the person to the Today card where an agent is chosen.
    if (needs && s.id === 'conversion' && ['amber', 'red'].includes(hotWaitLight(f.hotLeads) ?? '')) {
      needs.text = 'Assign an agent'
      needs.href = '/admin'
    }
    // Dry run for more than 24 hours: the Production row turns amber (never green, red stays red) and says so with the real hours.
    if (s.id === 'production' && typeof f.dryRunHours === 'number' && f.dryRunHours > DRY_RUN_AMBER_HOURS) {
      const light: Light = s.light === 'red' ? 'red' : 'amber'
      return { ...s, light, read: true, sentence: dryRunSentence(f.dryRunHours), number: `dry run for ${f.dryRunHours} hours`, fixed: fixed[s.id] ?? [], needs: { text: 'Turn dry run off', href: '/admin/autopilot' } }
    }
    return { ...s, fixed: fixed[s.id] ?? [], needs }
  })
  // The no-green-without-reading rule, enforced once for every stage.
  for (const s of stages) if (!s.read && s.light === 'green') s.light = 'amber'
  const overall = worstLight(stages.map((s) => s.light))
  const bad = stages.find((s) => s.light === 'red') ?? stages.find((s) => s.light === 'amber') ?? null
  return {
    at: f.now.toISOString(),
    overall,
    stages,
    worst: bad ? { id: bad.id, label: bad.label, light: bad.light, sentence: bad.sentence } : null,
  }
}

/** The whole list as an all-unread fixture: what the page shows when nothing at all could be read. */
export function unreadFacts(now: Date): CheckFacts {
  return { now, watchdog: null, crawl: null, seo: null, jobs: null, ai: null, orders: null, gateSkips7d: null, decisions: null }
}

// ---------------------------------------------------------------------------------------------------
// Storage (app_settings system_check_state) and the five minute cache
// ---------------------------------------------------------------------------------------------------

export const SYSTEM_CHECK_KEY = 'system_check_state'
export const SYSTEM_CHECK_TTL_MS = 5 * 60_000
/** The Today strip and the 7 am brief accept a stored answer this old rather than wait for a fresh one. */
export const SYSTEM_CHECK_STALE_MS = 26 * 3_600_000

export function serializeCheck(r: CheckResult): string {
  return JSON.stringify({ v: 1, ...r })
}

export function parseCheck(raw: string | null | undefined): CheckResult | null {
  if (!raw) return null
  try {
    const p = JSON.parse(raw) as Partial<CheckResult> & { v?: number }
    if (!p || p.v !== 1 || typeof p.at !== 'string' || !Number.isFinite(Date.parse(p.at)) || !Array.isArray(p.stages)) return null
    const lights: Light[] = ['green', 'amber', 'red']
    const stages: CheckStage[] = []
    for (const s of p.stages as CheckStage[]) {
      if (!s || !(STAGE_IDS as readonly string[]).includes(s.id) || !lights.includes(s.light) || typeof s.sentence !== 'string') continue
      stages.push({
        id: s.id,
        label: STAGE_LABELS[s.id],
        light: s.light,
        read: s.read === true,
        sentence: s.sentence,
        number: typeof s.number === 'string' ? s.number : null,
        fixed: Array.isArray(s.fixed) ? s.fixed.filter((x) => typeof x === 'string').slice(0, 5) : [],
        needs: s.needs && typeof s.needs.text === 'string' && typeof s.needs.href === 'string' ? { text: s.needs.text, href: s.needs.href } : null,
      })
    }
    if (stages.length === 0) return null
    const overall = worstLight(stages.map((s) => s.light))
    const bad = stages.find((s) => s.light === 'red') ?? stages.find((s) => s.light === 'amber') ?? null
    return { at: p.at, overall, stages, worst: bad ? { id: bad.id, label: bad.label, light: bad.light, sentence: bad.sentence } : null }
  } catch {
    return null
  }
}

/** True when a stored answer is young enough to reuse. A time in the future (a clock slip) is not fresh. Pure. */
export function isFresh(at: string, now: number, ttlMs: number = SYSTEM_CHECK_TTL_MS): boolean {
  const t = Date.parse(at)
  return Number.isFinite(t) && now - t >= -60_000 && now - t < ttlMs
}

/** The small summary the Today strip and the menu dot show. */
export interface CheckSummary {
  at: string
  overall: Light
  counts: Record<Light, number>
  worst: CheckResult['worst']
}

export function summarizeCheck(r: CheckResult): CheckSummary {
  const counts: Record<Light, number> = { green: 0, amber: 0, red: 0 }
  for (const s of r.stages) counts[s.light]++
  return { at: r.at, overall: r.overall, counts, worst: r.worst }
}

/** One line for the 7 am brief and the plain-text version: "System check: 8 green, 2 amber, 1 red." Pure. */
export function checkBriefLines(r: CheckResult | null, max = 4): string[] {
  if (!r) return ['System check: could not be read.']
  const c = summarizeCheck(r).counts
  const head = `System check: ${c.green} green, ${c.amber} amber, ${c.red} red.`
  const bad = r.stages.filter((s) => s.light !== 'green').sort((a, b) => RANK[b.light] - RANK[a.light]).slice(0, max)
  return [head, ...bad.map((s) => `${s.label} (${s.light}): ${s.sentence}`)]
}
