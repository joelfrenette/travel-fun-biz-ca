import { rankKeywords, type KeywordScore, type ScoreKeyword, type ScorePackage } from '@/lib/keyword-score'
import { findDuplicate, slugify } from '@/lib/content-dedupe'

// The pure half of the keyword intelligence engine (lib/keyword-intel.ts is the half that talks to the
// database and the vendors). No database, no network: given recorded research rows and the real
// packages, it works out
//   - topics: near-duplicate phrases become one cluster with a primary phrase (the grouping lives in
//     lib/keyword-score.ts, reused here, not copied)
//   - intent and funnel stage, from the words of a phrase
//   - a plain-English opportunity label per phrase and per topic, with the reason
//   - the checks every AI-written blog idea must pass before it is saved
//   - the date maths for the weekly claim and for ranking progress
// Every number it shows comes from a research row or a Search Console row. Nothing is invented.

export type Intent = 'informational' | 'commercial' | 'transactional'
export type FunnelStage = 'awareness' | 'consideration' | 'decision'
export type Opportunity = 'RANKING' | 'ALMOST' | 'SHOOT_FOR' | 'TARGETED' | 'SKIP'

export const OPPORTUNITY_LABEL: Record<Opportunity, string> = {
  RANKING: 'Ranking',
  ALMOST: 'Almost there',
  SHOOT_FOR: 'Shoot for',
  TARGETED: 'Has a page',
  SKIP: 'Skip',
}
export const INTENT_LABEL: Record<Intent, string> = { informational: 'Informational', commercial: 'Commercial', transactional: 'Transactional' }

/** A usable, untargeted phrase must score at least this (out of 100) to be worth a post. A tuning
 * constant, not a measured value: lower it to be less picky. */
export const SHOOT_FOR_MIN_SCORE = 40

// ---- intent and funnel ---------------------------------------------------------------------------------

const QUESTION_START = /^(how(?! much)|what|when|why|where|which|who|is|are|can|do|does|should|will)\b/
const TRANSACTIONAL = /\b(book|booking|bookings|buy|reserve|reservation|price|prices|pricing|cost|costs|how much|deal|deals|sale|quote|quotes|rates?|packages?|payment plan)\b/
const INFORMATIONAL = /\b(guide|tips|ideas|things to do|packing|pack|what to|how to|meaning|safe|safety|weather|visa|requirements|best time|worth it|pros and cons|first time|beginners?|itinerary)\b/
const COMMERCIAL = /\b(best|top|vs|versus|compare|comparison|review|reviews|cheap|affordable|luxury|trip|trips|tour|tours|cruise|cruises|getaway|getaways|vacation|vacations|singles|group|groups|yacht|yachts|sailing|holiday|holidays|excursions?)\b/

/** What the searcher is after, read from the words of the phrase. Deterministic and cheap. */
export function intentOf(phrase: string): Intent {
  const p = phrase.toLowerCase().replace(/[^a-z0-9\s$'-]/g, ' ').replace(/\s+/g, ' ').trim()
  if (QUESTION_START.test(p)) return 'informational'
  if (TRANSACTIONAL.test(p)) return 'transactional'
  if (INFORMATIONAL.test(p)) return 'informational'
  if (COMMERCIAL.test(p)) return 'commercial'
  return 'informational'
}

/** Where in the buying journey the searcher is: learning, comparing, or ready to book. */
export function funnelStageOf(intentOrPhrase: Intent | string): FunnelStage {
  const intent: Intent = intentOrPhrase === 'informational' || intentOrPhrase === 'commercial' || intentOrPhrase === 'transactional' ? intentOrPhrase : intentOf(intentOrPhrase)
  return intent === 'informational' ? 'awareness' : intent === 'commercial' ? 'consideration' : 'decision'
}

// ---- opportunity ----------------------------------------------------------------------------------------

const GATE_REASON = /^(Not about|The trip|Skipped before|Already|A near-duplicate)/

/** The one-line verdict for a phrase. Order matters: what Google already does for us beats everything.
 *   RANKING    Google shows us at position 1 to 10 (and has shown us at all)
 *   ALMOST     position 11 to 30
 *   SKIP       it was skipped before (a person or the autoblog said so)
 *   TARGETED   a page targets it but it is not on Google's first three pages yet
 *   SKIP       the gate says no (not about a trip we sell, the trip has left, a near-duplicate is covered)
 *   SHOOT_FOR  usable, not targeted, and scores at least SHOOT_FOR_MIN_SCORE
 *   SKIP       usable but the score is too low to be worth a post */
export function opportunityOf(row: ScoreKeyword, score: number, eligible: boolean, reasons: string[] = []): { label: Opportunity; reason: string } {
  const pos = row.gsc_position
  const shown = (row.gsc_impressions ?? 0) > 0
  if (pos != null && shown && pos >= 1 && pos <= 10) return { label: 'RANKING', reason: `Google shows us at position ${Math.round(pos)}` }
  if (pos != null && shown && pos > 10 && pos <= 30) return { label: 'ALMOST', reason: `Google shows us at position ${Math.round(pos)}: a focused push could reach page one` }
  if (/^skipped/i.test(row.note ?? '')) return { label: 'SKIP', reason: `Skipped before (${row.note})` }
  if (row.target_path) return { label: 'TARGETED', reason: `${row.target_path} targets it, but Google does not show us on its first three pages yet` }
  if (!eligible) return { label: 'SKIP', reason: reasons.find((r) => GATE_REASON.test(r)) ?? 'Not usable for a blog post right now' }
  if (score >= SHOOT_FOR_MIN_SCORE) return { label: 'SHOOT_FOR', reason: reasons.find((r) => !GATE_REASON.test(r) && /position|peaks|searches a month/.test(r)) ?? `Usable and scores ${score} out of 100` }
  return { label: 'SKIP', reason: `Usable, but scores only ${score} out of 100, so not worth a post yet` }
}

// ---- clusters -------------------------------------------------------------------------------------------

export interface ClassifiedKeyword {
  keyword: string
  clusterId: string
  primary: string
  intent: Intent
  funnel: FunnelStage
  opportunity: Opportunity
  reason: string
  score: number
  eligible: boolean
  reasons: string[]
  packageName: string | null
  packageSlug: string | null
}

export interface KeywordCluster {
  id: string
  primary: string
  /** Every phrase in the topic, primary first, then best score first. */
  members: string[]
  secondary: string[]
  opportunity: Opportunity
  reason: string
  score: number
  intent: Intent
  funnel: FunnelStage
  /** Google monthly volume of the primary phrase, null when never looked up or too small to report. */
  volume: number | null
  competition: number | null
  packageName: string | null
  packageSlug: string | null
}

const PRIORITY: Opportunity[] = ['RANKING', 'ALMOST', 'TARGETED']

/** Scores every phrase, groups near-duplicates into topics, and labels each phrase and each topic. */
export function buildClusters(rows: ScoreKeyword[], packages: ScorePackage[], now = new Date(), peaks: Record<string, { peak: number }> = {}): { keywords: ClassifiedKeyword[]; clusters: KeywordCluster[] } {
  const ranked: KeywordScore[] = rankKeywords(rows, packages, now, peaks)
  const rowOf = new Map(rows.map((r) => [r.keyword, r]))
  const byPrimary = new Map<string, ClassifiedKeyword[]>()

  for (const ks of ranked) {
    const row = rowOf.get(ks.keyword) as ScoreKeyword
    const opp = opportunityOf(row, ks.score, ks.eligible, ks.reasons)
    const intent = intentOf(ks.keyword)
    const item: ClassifiedKeyword = {
      keyword: ks.keyword,
      clusterId: slugify(ks.primary),
      primary: ks.primary,
      intent,
      funnel: funnelStageOf(intent),
      opportunity: opp.label,
      reason: opp.reason,
      score: ks.score,
      eligible: ks.eligible,
      reasons: ks.reasons,
      packageName: ks.packageName,
      packageSlug: ks.packageSlug,
    }
    const list = byPrimary.get(ks.primary)
    if (list) list.push(item)
    else byPrimary.set(ks.primary, [item])
  }

  const clusters: KeywordCluster[] = []
  for (const [primary, members] of byPrimary) {
    // A topic that already has an owner (it ranks, almost ranks, or has a page) is not a new post: its
    // other phrases stop being "shoot for", so one topic can never turn into two posts.
    const owner = PRIORITY.map((p) => members.find((m) => m.opportunity === p)).find(Boolean)
    if (owner) {
      for (const m of members) {
        if (m.opportunity === 'SHOOT_FOR') {
          m.opportunity = 'SKIP'
          m.reason = `Same topic as "${owner.keyword}", which is already ${owner.opportunity === 'TARGETED' ? 'targeted by a page' : owner.opportunity === 'RANKING' ? 'ranking' : 'close to ranking'}`
        }
      }
    }
    const head = members.find((m) => m.keyword === primary) ?? members[0]
    const rep = owner ?? head
    const headRow = rowOf.get(head.keyword)
    const volume = headRow?.volume ?? null
    clusters.push({
      id: head.clusterId,
      primary,
      members: [primary, ...members.filter((m) => m.keyword !== primary).map((m) => m.keyword)],
      secondary: members.filter((m) => m.keyword !== primary).map((m) => m.keyword),
      opportunity: rep.opportunity,
      reason: rep.reason,
      score: head.score,
      intent: head.intent,
      funnel: head.funnel,
      volume: volume != null && volume > 0 ? volume : null,
      competition: headRow?.competition ?? null,
      packageName: head.packageName,
      packageSlug: head.packageSlug,
    })
  }
  return { keywords: ranked.map((ks) => (byPrimary.get(ks.primary) as ClassifiedKeyword[]).find((c) => c.keyword === ks.keyword) as ClassifiedKeyword), clusters }
}

// ---- the plan: AI-written blog ideas, checked in plain code --------------------------------------------

export interface PlanDraft {
  title_idea: string
  angle: string
  primary_keyword: string
  secondary_keywords: string[]
  who_for: string
  package_slug: string | null
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()
const EM = String.fromCharCode(0x2014)
const EN = String.fromCharCode(0x2013)

/** Dashes become commas (house style: no em or en dashes anywhere). */
export function removeDashes(s: string): string {
  return s.split(EM).join(', ').split(EN).join(', ').replace(/\s+,/g, ',').replace(/,\s*,/g, ',').replace(/\s{2,}/g, ' ').trim()
}

export const MAX_SECONDARY = 6
export const MIN_SECONDARY = 3

function toTitle(phrase: string): string {
  return phrase.replace(/\b[a-z]/g, (c) => c.toUpperCase())
}

/** The idea made without the AI: used when the AI is off, fails, or its answer does not pass the checks, so
 * a good topic is never lost just because a model slipped. */
export function mechanicalPlanItem(cluster: KeywordCluster): PlanDraft {
  return {
    title_idea: toTitle(cluster.primary),
    angle: `A blog post that answers the search "${cluster.primary}" for someone deciding whether and which trip to book with us.`,
    primary_keyword: cluster.primary,
    secondary_keywords: cluster.secondary.slice(0, MAX_SECONDARY),
    who_for: '',
    package_slug: cluster.packageSlug,
  }
}

const NUMBER_WORDS = /\b(two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|hundred|thousand)\b/g
const numbersIn = (s: string) => s.match(/\d+/g) ?? []

export type PlanCheck = { ok: true; item: PlanDraft; fixes: string[] } | { ok: false; problems: string[] }

/** Checks one idea the model wrote for one cluster. The model is never trusted:
 *   - the primary keyword must BE the cluster's primary phrase
 *   - secondary phrases must be members of the cluster (others are dropped, then topped up from the cluster)
 *   - package_slug must be a real published slug, otherwise it is replaced by the code's own match or null
 *   - no digits in the text unless they are in the keywords or the real package text, no dollar signs
 *   - no dashes (they are replaced), sensible lengths
 * `packageText` is the real package name, destination and description the model was shown. */
export function validatePlanItem(raw: unknown, cluster: KeywordCluster, validSlugs: Set<string>, packageText = ''): PlanCheck {
  const problems: string[] = []
  const fixes: string[] = []
  if (!raw || typeof raw !== 'object') return { ok: false, problems: ['the idea is not an object'] }
  const r = raw as Record<string, unknown>
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

  const primary = norm(str(r.primary_keyword))
  if (primary !== norm(cluster.primary)) problems.push(`primary keyword "${primary || '(missing)'}" is not the cluster primary "${cluster.primary}"`)

  const title = removeDashes(str(r.title_idea))
  const angle = removeDashes(str(r.angle))
  const who = removeDashes(str(r.who_for))
  if (title.length < 10 || title.length > 100) problems.push('title idea is missing or not between 10 and 100 characters')
  if (angle.length < 20 || angle.length > 300) problems.push('angle is missing or not between 20 and 300 characters')
  if (who.length > 160) problems.push('who-for line is longer than 160 characters')
  if (/[$]/.test(`${title} ${angle} ${who}`)) problems.push('mentions a price')
  // A superlative in the idea only gets repaired away later by the writer's gate; better not to plan one.
  // "best time to visit" is ordinary search wording, so that phrase alone is allowed.
  const superlative = `${title} ${angle} ${who}`.replace(/\bbest (?:time|times|season|months?)\b/gi, '').match(/\b(?:best|top|ultimate|number one|must-see|world-class|perfect|greatest|finest|unbeatable)\b/i)
  if (superlative) problems.push(`uses a superlative ("${superlative[0]}")`)

  const allowedNumbers = new Set(numbersIn(`${cluster.members.join(' ')} ${packageText}`))
  const stray = numbersIn(`${title} ${angle} ${who}`).filter((n) => !allowedNumbers.has(n))
  // Number words count too ("seven reasons", "two weeks"): allowed only when the keywords or package say them.
  const haystack = ` ${norm(`${cluster.members.join(' ')} ${packageText}`).replace(/[^a-z0-9 ]/g, ' ')} `
  const strayWords = (`${title} ${angle} ${who}`.toLowerCase().match(NUMBER_WORDS) ?? []).filter((w) => !haystack.includes(` ${w} `))
  stray.push(...strayWords)
  if (stray.length) problems.push(`uses a number that is not in the keywords or the package (${[...new Set(stray)].join(', ')})`)

  if (problems.length) return { ok: false, problems }

  const members = new Map(cluster.secondary.map((m) => [norm(m), m]))
  const wanted = Array.isArray(r.secondary_keywords) ? (r.secondary_keywords as unknown[]).map((v) => norm(str(v))).filter(Boolean) : []
  const secondary: string[] = []
  for (const w of wanted) {
    const real = members.get(w)
    if (!real) fixes.push(`dropped "${w}": not a phrase of this topic`)
    else if (!secondary.includes(real)) secondary.push(real)
  }
  const target = Math.min(MIN_SECONDARY, cluster.secondary.length)
  for (const m of cluster.secondary) {
    if (secondary.length >= target) break
    if (!secondary.includes(m)) {
      secondary.push(m)
      fixes.push(`added "${m}" from the topic`)
    }
  }

  const slug = str(r.package_slug)
  let package_slug: string | null = null
  if (slug && validSlugs.has(slug)) package_slug = slug
  else {
    if (slug) fixes.push(`package "${slug}" is not a real published package`)
    package_slug = cluster.packageSlug && validSlugs.has(cluster.packageSlug) ? cluster.packageSlug : null
  }

  return { ok: true, fixes, item: { title_idea: title, angle, primary_keyword: cluster.primary, secondary_keywords: secondary.slice(0, MAX_SECONDARY), who_for: who, package_slug } }
}

export interface PlanDedupeContext {
  /** Existing posts: title plus the keywords they were written for, when recorded. */
  posts: { title: string; primary_keyword?: string | null; secondary_keywords?: string[] | null }[]
  /** Queue rows in ANY status (suggested, approved, used, rejected). */
  queue: { keyword: string; keywords?: string[] | null; cluster_id?: string | null }[]
}

/** Why a cluster must not become a new idea, or null when it is fresh. */
export function planDuplicateReason(cluster: KeywordCluster, ctx: PlanDedupeContext): string | null {
  const mine = new Set(cluster.members.map(norm))
  for (const q of ctx.queue) {
    if (q.cluster_id && q.cluster_id === cluster.id) return 'this topic is already in the idea queue'
    const theirs = [q.keyword, ...(q.keywords ?? [])].map(norm)
    if (theirs.some((t) => mine.has(t))) return `"${q.keyword}" is already in the idea queue`
  }
  for (const p of ctx.posts) {
    const theirs = [p.primary_keyword ?? '', ...(p.secondary_keywords ?? [])].map(norm).filter(Boolean)
    if (theirs.some((t) => mine.has(t))) return `a post already targets "${p.primary_keyword ?? p.title}"`
  }
  const dup = findDuplicate(cluster.primary, ctx.posts.map((p) => ({ title: p.title })))
  if (dup) return `too close to the post "${dup.title}"`
  return null
}

/** The clusters to turn into ideas this week: SHOOT_FOR, best score first, fresh ones only, at most `limit`. */
export function chooseClustersToPlan(clusters: KeywordCluster[], ctx: PlanDedupeContext, limit: number): { chosen: KeywordCluster[]; skipped: { cluster: KeywordCluster; reason: string }[] } {
  const candidates = clusters
    .filter((c) => c.opportunity === 'SHOOT_FOR')
    .sort((a, b) => b.score - a.score || (b.volume ?? 0) - (a.volume ?? 0) || a.primary.localeCompare(b.primary))
  const chosen: KeywordCluster[] = []
  const skipped: { cluster: KeywordCluster; reason: string }[] = []
  for (const c of candidates) {
    if (chosen.length >= limit) break
    const why = planDuplicateReason(c, ctx)
    if (why) skipped.push({ cluster: c, reason: why })
    else chosen.push(c)
  }
  return { chosen, skipped }
}

/** The spend log is pruned by AGE (entries older than SPEND_LOG_KEEP_DAYS go), never by a small count, so a burst
 * of cheap runs can never push a real spend entry out of the 7-day budget maths. The hard cap only guards size. */
export const SPEND_LOG_KEEP_DAYS = 10
export const SPEND_LOG_HARD_CAP = 200
export function pruneSpendLog<T extends { at: string }>(log: T[], now = Date.now()): T[] {
  return log.filter((e) => now - Date.parse(e.at) <= SPEND_LOG_KEEP_DAYS * 86_400_000).slice(0, SPEND_LOG_HARD_CAP)
}

// ---- dates and ranking progress -------------------------------------------------------------------------

/** "2026-W41": the ISO week of a date (weeks start on Monday, week 1 holds the first Thursday). */
export function isoWeekKey(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const day = t.getUTCDay() || 7
  t.setUTCDate(t.getUTCDate() + 4 - day)
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1)
  const week = Math.ceil(((t.getTime() - yearStart) / 86_400_000 + 1) / 7)
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

/** The soonest the weekly engine may run again: the Monday after the week it last ran in, and never sooner
 * than 5 days after that run. Null `last` means it is due now. */
export const ENGINE_MIN_GAP_DAYS = 5
export function nextEngineRunAt(last: Date | null, now = new Date()): Date {
  if (!last || Number.isNaN(last.getTime())) return now
  const day = last.getUTCDay() || 7
  const nextMonday = new Date(Date.UTC(last.getUTCFullYear(), last.getUTCMonth(), last.getUTCDate() + (8 - day)))
  const minGap = new Date(last.getTime() + ENGINE_MIN_GAP_DAYS * 86_400_000)
  return new Date(Math.max(nextMonday.getTime(), minGap.getTime()))
}

export interface RankHistoryPoint {
  day: string
  position: number
  clicks: number
  impressions: number
}

export interface PositionSummary {
  /** Latest recorded Google position, null when Search Console has never shown us for it. */
  position: number | null
  /** Positive = moved up (the position number fell) compared with about 7 / 28 days earlier; null when there is no snapshot that old. */
  change7: number | null
  change28: number | null
  /** Search Console reports clicks and impressions as a trailing 28-day total, so these are 28-day figures. */
  clicks: number | null
  impressions: number | null
  latestDay: string | null
}

const dayNumber = (ymd: string) => Math.floor(Date.parse(`${ymd}T00:00:00Z`) / 86_400_000)
const TOLERANCE_DAYS = 3

/** Where a phrase stands now and how it moved. A snapshot counts as "7 days ago" if it is within 3 days of
 * that date; with less history than that the change is null (shown as "not enough history"). */
export function summarizeHistory(points: RankHistoryPoint[]): PositionSummary {
  const sorted = [...points].filter((p) => p.position >= 1).sort((a, b) => a.day.localeCompare(b.day))
  const latest = sorted[sorted.length - 1]
  if (!latest) return { position: null, change7: null, change28: null, clicks: null, impressions: null, latestDay: null }
  const change = (daysAgo: number): number | null => {
    const target = dayNumber(latest.day) - daysAgo
    let best: RankHistoryPoint | null = null
    for (const p of sorted) {
      if (p === latest) continue
      const gap = Math.abs(dayNumber(p.day) - target)
      if (gap <= TOLERANCE_DAYS && (!best || gap < Math.abs(dayNumber(best.day) - target))) best = p
    }
    return best ? Math.round((best.position - latest.position) * 10) / 10 : null
  }
  return { position: Math.round(latest.position * 10) / 10, change7: change(7), change28: change(28), clicks: latest.clicks, impressions: latest.impressions, latestDay: latest.day }
}
