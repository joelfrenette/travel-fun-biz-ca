import type { SupabaseClient } from '@supabase/supabase-js'
import { getSetting, setSetting } from '@/lib/app-settings'
import { appendDecisions, decision, policyGate, type AutoDecision } from '@/lib/auto-decisions'
import { findDuplicate } from '@/lib/content-dedupe'
import { FROM_CITIES } from '@/lib/from-cities'
import { intentOf, type Intent } from '@/lib/keyword-cluster'
import { GROUP_SIMILARITY, groupBySimilarity, jaccard, stems } from '@/lib/keyword-score'
import { bestPageFor, MATCH_THRESHOLD, type SeoPage } from '@/lib/seo-pages'
import { topicConflict, type PostFact } from '@/lib/blog-topics'
import { bucketQueries, emptyIntel, parseIntel, type QueryIntel } from '@/lib/question-intel'

// QUERY MINING (SEO engine 1). Reads what people type into Google before landing on (or missing) this site and answers two questions:
//   a) NEW PAGE OPPORTUNITIES: searches Google already shows us for where no page of ours is a good match. Related searches are grouped
//      into one topic (the same near-duplicate grouping as the keyword engine), ranked striking distance (position 8 to 30) first, then
//      by impressions, and each topic says what kind of page would answer it best, with the numbers as evidence.
//   b) STRIKING-DISTANCE REFRESH: our own pages sitting at position 8 to 20 for a search that has impressions, for the click-rate and
//      refresh loops to work on.
// The pure functions below take plain rows and pages; the database half (stored result, pushing safe topics to the blog topic queue)
// is at the bottom. Nothing is invented: every number is a Search Console row. Nothing is ever published from here.

export interface QueryPageRow {
  query: string
  path: string
  clicks: number
  impressions: number
  position: number
}

export interface QueryRow {
  query: string
  clicks: number
  impressions: number
  position: number
}

/** A search needs at least this many impressions in the 28 days to count as demand. */
export const MIN_OPPORTUNITY_IMPRESSIONS = 5
/** A new-page proposal needs at least this many impressions in total to be pushed to the blog topic queue. */
export const MIN_QUEUE_IMPRESSIONS = 10
export const STRIKING_FROM = 8
export const STRIKING_TO_PROPOSAL = 30
export const STRIKING_TO_REFRESH = 20
export const MIN_REFRESH_IMPRESSIONS = 10
export const MAX_PROPOSALS = 20
export const MAX_REFRESH = 25
export const TOPICS_PUSHED_PER_DAY = 3
export const MINING_KEY = 'seo_mining_state'

export type ProposalPageType = 'blog' | 'guide' | 'from-city' | 'compare' | 'best-time'

export const PAGE_TYPE_NAME: Record<ProposalPageType, string> = {
  blog: 'a blog post',
  guide: 'a guide page',
  'from-city': 'a "from your city" page',
  compare: 'a compare page',
  'best-time': 'a best-time-to-visit page',
}

/** The kind of page that answers a search best, from its words. Deterministic. Pure. */
export function proposalPageType(query: string): ProposalPageType {
  const q = query.toLowerCase()
  if (/\b(vs|versus|compare|comparison)\b/.test(q)) return 'compare'
  if (/\bbest time\b|\bwhen (?:to|is the best)\b|\bbest (?:month|season)s?\b|\bweather\b|\bseason\b|\bhurricane\b/.test(q)) return 'best-time'
  const fromCity = FROM_CITIES.some((c) => new RegExp(`\\b(?:from|departing|leaving|out of)\\s+${c.city.toLowerCase()}\\b`).test(q) || new RegExp(`\\b${c.city.toLowerCase()}\\s+(?:departures?|to)\\b`).test(q))
  if (fromCity) return 'from-city'
  if (/\bguide\b|\bthings to do\b|\bwhat to (?:do|see)\b|\bwhere to stay\b|\bhotels?\b|\bresorts?\b|\bcruise lines?\b|\bships?\b|\bitinerary\b|\bport\b|\bexcursions?\b|\bsights?\b|\battractions?\b/.test(q)) return 'guide'
  return 'blog'
}

export interface ProposalQuery {
  query: string
  impressions: number
  position: number
}

export interface Proposal {
  id: string
  /** The main search of the topic (most impressions). */
  primary: string
  queries: ProposalQuery[]
  impressions: number
  /** Best (lowest) average position of any search in the topic. */
  bestPosition: number
  /** Position 8 to 30: Google already almost shows us. */
  striking: boolean
  pageType: ProposalPageType
  intent: Intent
  /** The closest page we have and how much of the search it covers (0 to 1), when it is at least a partial match. */
  nearestPath: string | null
  nearestScore: number
  /** Plain words: the numbers behind the proposal. */
  evidence: string
  /** True when it may be pushed to the blog topic queue by itself (a blog post, real demand, a clear topic). */
  safeForQueue: boolean
}

const slugOf = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

/** One row per search (clicks and impressions added up, position weighted by impressions) from query + page rows. Pure. */
export function queryRowsFromPairs(pairs: readonly QueryPageRow[]): QueryRow[] {
  const by = new Map<string, { clicks: number; imp: number; weighted: number }>()
  for (const r of pairs) {
    if (!r.query) continue
    const cur = by.get(r.query) ?? { clicks: 0, imp: 0, weighted: 0 }
    cur.clicks += r.clicks
    cur.imp += r.impressions
    cur.weighted += r.position * Math.max(r.impressions, 1)
    by.set(r.query, cur)
  }
  return [...by.entries()].map(([query, v]) => ({ query, clicks: v.clicks, impressions: v.imp, position: v.imp > 0 || v.weighted > 0 ? v.weighted / Math.max(v.imp, 1) : 0 }))
}

/** New page opportunities: searches with impressions that no page of ours covers well, grouped into topics and ranked. Pure.
 * `threshold` is the share of a search's meaningful words a page must contain to count as covering it (default MATCH_THRESHOLD). */
export function findOpportunities(queries: readonly QueryRow[], pages: readonly SeoPage[], opts: { threshold?: number; minImpressions?: number; limit?: number } = {}): Proposal[] {
  const threshold = opts.threshold ?? MATCH_THRESHOLD
  const minImp = opts.minImpressions ?? MIN_OPPORTUNITY_IMPRESSIONS
  const open = queries
    .filter((q) => q.query && q.impressions >= minImp && stems(q.query).size >= 1 && !bestPageFor(q.query, pages, threshold))
    .sort((a, b) => b.impressions - a.impressions || a.position - b.position || a.query.localeCompare(b.query))
  const groups = groupBySimilarity(open, (q) => q.query)
  const proposals: Proposal[] = groups.map((members) => {
    const primary = members[0]
    const impressions = members.reduce((s, m) => s + m.impressions, 0)
    const bestPosition = Math.min(...members.map((m) => (m.position > 0 ? m.position : 999)))
    const striking = members.some((m) => m.position >= STRIKING_FROM && m.position <= STRIKING_TO_PROPOSAL)
    const pageType = proposalPageType(primary.query)
    const near = nearestPage(primary.query, pages)
    const intent = intentOf(primary.query)
    const evidence =
      `Google showed us ${impressions} time${impressions === 1 ? '' : 's'} in 28 days for ${members.length === 1 ? 'this search' : `${members.length} related searches`}` +
      (bestPosition < 999 ? `, best average position ${bestPosition.toFixed(1)}${striking ? ' (close to page one)' : ''}` : '') +
      '; no page of ours covers it' +
      (near ? ` (the closest, ${near.path}, covers ${Math.round(near.score * 100)}% of the words)` : '')
    return {
      id: slugOf(primary.query),
      primary: primary.query,
      queries: members.slice(0, 8).map((m) => ({ query: m.query, impressions: m.impressions, position: Math.round(m.position * 10) / 10 })),
      impressions,
      bestPosition: bestPosition === 999 ? 0 : Math.round(bestPosition * 10) / 10,
      striking,
      pageType,
      intent,
      nearestPath: near?.path ?? null,
      nearestScore: near ? Math.round(near.score * 100) / 100 : 0,
      evidence,
      safeForQueue: pageType === 'blog' && impressions >= MIN_QUEUE_IMPRESSIONS && stems(primary.query).size >= 2,
    }
  })
  proposals.sort((a, b) => Number(b.striking) - Number(a.striking) || b.impressions - a.impressions || a.bestPosition - b.bestPosition || a.primary.localeCompare(b.primary))
  return proposals.slice(0, opts.limit ?? MAX_PROPOSALS)
}

function nearestPage(query: string, pages: readonly SeoPage[]): { path: string; score: number } | null {
  const hit = bestPageFor(query, pages, 0.34)
  return hit ? { path: hit.page.path, score: hit.score } : null
}

export interface RefreshTarget {
  path: string
  query: string
  position: number
  impressions: number
  clicks: number
}

/** Our own pages at position 8 to 20 for a search with impressions, best opportunity first (most impressions), at most one search per
 * page (its strongest). Only pages that exist and are indexable. Pure. */
export function strikingRefreshTargets(pairs: readonly QueryPageRow[], pages: readonly SeoPage[], opts: { limit?: number } = {}): RefreshTarget[] {
  const known = new Set(pages.filter((p) => !p.thin).map((p) => p.path))
  const best = new Map<string, RefreshTarget>()
  for (const r of pairs) {
    if (!known.has(r.path)) continue
    if (r.position < STRIKING_FROM || r.position > STRIKING_TO_REFRESH || r.impressions < MIN_REFRESH_IMPRESSIONS) continue
    const cur = best.get(r.path)
    if (!cur || r.impressions > cur.impressions) best.set(r.path, { path: r.path, query: r.query, position: Math.round(r.position * 10) / 10, impressions: r.impressions, clicks: r.clicks })
  }
  return [...best.values()].sort((a, b) => b.impressions - a.impressions || a.position - b.position).slice(0, opts.limit ?? MAX_REFRESH)
}

// ---------------------------------------------------------------------------------------------------
// Topic safety: which proposals may be pushed to the blog topic queue
// ---------------------------------------------------------------------------------------------------

export interface QueueFact {
  keyword: string
  keywords?: string[] | null
}

/** Why a proposal must NOT become a topic (a duplicate of a queued idea, or of a post), or null when it is fresh. Uses the same
 * near-duplicate grouping, the same-keyword rule and the diversity rules as the blog topic engine. Pure. */
export function proposalBlockReason(p: Proposal, queue: readonly QueueFact[], posts: readonly PostFact[], now: Date = new Date()): string | null {
  const mine = [p.primary, ...p.queries.map((q) => q.query)]
  const mineStems = mine.map((m) => stems(m))
  for (const q of queue) {
    for (const theirs of [q.keyword, ...(q.keywords ?? [])]) {
      const t = stems(theirs)
      if (mineStems.some((m) => jaccard(m, t) >= GROUP_SIMILARITY)) return `"${q.keyword}" is already in the topic queue`
    }
  }
  const dupTitle = findDuplicate(p.primary, posts.map((x) => ({ title: x.title })))
  if (dupTitle) return `too close to the post "${dupTitle.title}"`
  const conflict = topicConflict({ angle: topicAngle(p), keyword: p.primary, keywords: mine.slice(0, 6) }, posts as PostFact[], { now })
  if (conflict) return conflict.reason
  return null
}

export function topicAngle(p: Proposal): string {
  return `A blog post that answers the search "${p.primary}" for someone deciding whether and which trip to book with us.`
}

export function topicWhy(p: Proposal): string {
  return p.evidence
}

// ---------------------------------------------------------------------------------------------------
// Stored result
// ---------------------------------------------------------------------------------------------------

export interface MiningState {
  at: string
  source: 'live' | 'stored' | 'none'
  rowCount: number
  proposals: Proposal[]
  refresh: RefreshTarget[]
  /** Topics pushed to the queue per UTC day (kept for the last 7 days). */
  pushed: { day: string; keyword: string; topicId: string }[]
  note: string
  /** Question-style, buyer-intent and 7+ word searches (hub WP5). Optional: results stored before this existed have none. */
  intel?: QueryIntel
}

export const emptyMiningState = (): MiningState => ({ at: '', source: 'none', rowCount: 0, proposals: [], refresh: [], pushed: [], note: '' })

/** Reads the stored result. Anything that is not the right shape reads as empty. Pure. */
export function parseMiningState(raw: string | null | undefined): MiningState {
  if (!raw) return emptyMiningState()
  try {
    const v = JSON.parse(raw) as Partial<MiningState>
    if (!v || typeof v !== 'object' || typeof v.at !== 'string') return emptyMiningState()
    return {
      at: v.at,
      source: v.source === 'live' || v.source === 'stored' ? v.source : 'none',
      rowCount: Number(v.rowCount) || 0,
      proposals: Array.isArray(v.proposals) ? (v.proposals as Proposal[]).slice(0, MAX_PROPOSALS) : [],
      refresh: Array.isArray(v.refresh) ? (v.refresh as RefreshTarget[]).slice(0, MAX_REFRESH) : [],
      pushed: Array.isArray(v.pushed) ? (v.pushed as MiningState['pushed']).filter((x) => x && typeof x.day === 'string' && typeof x.keyword === 'string').slice(-30) : [],
      note: typeof v.note === 'string' ? v.note : '',
      ...(v.intel ? { intel: parseIntel(v.intel) } : {}),
    }
  } catch {
    return emptyMiningState()
  }
}

export async function readMiningState(admin: SupabaseClient): Promise<MiningState> {
  try {
    return parseMiningState(await getSetting(admin, MINING_KEY))
  } catch {
    return emptyMiningState()
  }
}

/** Search Console queries from the stored daily snapshot (gsc_rankings), used when the live call is not available. One row per search. [] on any failure. */
export async function readStoredQueryRows(admin: SupabaseClient, now: Date = new Date()): Promise<QueryRow[]> {
  try {
    const since = new Date(now.getTime() - 28 * 86_400_000).toISOString().slice(0, 10)
    const { data, error } = await admin.from('gsc_rankings').select('key, position, clicks, impressions, day').eq('kind', 'query').gte('day', since).limit(5000)
    if (error || !data) return []
    // Each day's row is a trailing 28-day total: only the newest day's row of each search is used (never summed).
    const newest = new Map<string, { day: string; row: QueryRow }>()
    for (const r of data as { key: string; position: number | string; clicks: number | string; impressions: number | string; day: string }[]) {
      const row: QueryRow = { query: String(r.key || '').toLowerCase(), position: Number(r.position) || 0, clicks: Number(r.clicks) || 0, impressions: Number(r.impressions) || 0 }
      if (!row.query) continue
      const cur = newest.get(row.query)
      if (!cur || r.day > cur.day) newest.set(row.query, { day: r.day, row })
    }
    return [...newest.values()].map((x) => x.row)
  } catch {
    return []
  }
}

export interface MiningInput {
  /** Live query + page rows (empty when the live call failed or Search Console is not set up). */
  pairs: QueryPageRow[]
  /** Stored query rows, used only when `pairs` is empty. */
  stored: QueryRow[]
  pages: SeoPage[]
}

/** The pure core of a mining run: rows and pages in, the stored result (without the pushed list) out. */
export function mine(input: MiningInput, now: Date = new Date()): Omit<MiningState, 'pushed'> {
  const live = input.pairs.length > 0
  const queries = live ? queryRowsFromPairs(input.pairs) : input.stored
  if (queries.length === 0) return { at: now.toISOString(), source: 'none', rowCount: 0, proposals: [], refresh: [], note: 'Search Console gave no rows (not set up, or no data yet), so nothing was mined.', intel: emptyIntel() }
  return {
    at: now.toISOString(),
    source: live ? 'live' : 'stored',
    rowCount: queries.length,
    proposals: findOpportunities(queries, input.pages),
    refresh: live ? strikingRefreshTargets(input.pairs, input.pages) : [],
    note: live ? '' : 'The live page report was not available, so the saved daily snapshot was used (no page-level numbers: the refresh list is empty).',
    intel: bucketQueries(queries),
  }
}

export interface PushResult {
  pushed: { keyword: string; topicId: string }[]
  decisions: AutoDecision[]
  note: string
}

/** Pushes SAFE proposals to the blog topic queue as 'suggested' (never approved, never published from here). At most TOPICS_PUSHED_PER_DAY a
 * day (counted from the decisions log), only blog-post proposals with real impressions, none that duplicate a queued idea or a post.
 * Each push is one line in the Autopilot decisions log with an Undo (turns the topic down). Never throws. */
export async function pushSafeTopics(admin: SupabaseClient, proposals: readonly Proposal[], now: Date = new Date()): Promise<PushResult> {
  const out: PushResult = { pushed: [], decisions: [], note: '' }
  try {
    const gate = await policyGate(admin, 'seo_topics', now)
    if (!gate.allowed) return { ...out, note: gate.reason }
    const room = Math.min(gate.room, TOPICS_PUSHED_PER_DAY)
    const safe = proposals.filter((p) => p.safeForQueue)
    if (safe.length === 0) return out
    const [{ data: queue, error: qErr }, { data: posts, error: pErr }] = await Promise.all([
      admin.from('blog_topic_queue').select('keyword, keywords').limit(2000),
      admin.from('posts').select('slug, title, primary_keyword, secondary_keywords, tags, body, publish_date, created_at, related_package_id').limit(1000),
    ])
    if (qErr || pErr) return { ...out, note: 'could not read the topic queue or the posts, so nothing was pushed' }
    const queueRows = (queue ?? []) as QueueFact[]
    const postRows = (posts ?? []) as PostFact[]
    for (const p of safe) {
      if (out.pushed.length >= room) break
      const why = proposalBlockReason(p, [...queueRows, ...out.pushed.map((x) => ({ keyword: x.keyword }))], postRows, now)
      if (why) continue
      const row = { angle: topicAngle(p), keyword: p.primary, why: topicWhy(p), source: 'seo-engines (Search Console)', keywords: [p.primary, ...p.queries.map((q) => q.query).filter((q) => q !== p.primary)].slice(0, 6), status: 'suggested' as const }
      const { data, error } = await admin.from('blog_topic_queue').insert(row).select('id').maybeSingle()
      const id = (data as { id?: string } | null)?.id
      if (error || !id) continue
      out.pushed.push({ keyword: p.primary, topicId: id })
      out.decisions.push(decision('seo_topics', p.primary, `Suggested the blog topic "${p.primary}" (not approved, not written)`, p.evidence, { kind: 'topic-withdraw', ref: id }, now))
    }
    await appendDecisions(admin, out.decisions)
    out.note = out.pushed.length ? `suggested ${out.pushed.length} topic${out.pushed.length === 1 ? '' : 's'}` : ''
    return out
  } catch (e) {
    return { ...out, note: `topic push failed: ${e instanceof Error ? e.message : 'unknown error'}` }
  }
}

/** Mines, stores the result (bounded) and pushes safe topics. Never throws. */
export async function runMining(admin: SupabaseClient, input: MiningInput, now: Date = new Date(), opts: { push?: boolean } = {}): Promise<{ state: MiningState; note: string }> {
  const prev = await readMiningState(admin)
  const core = mine(input, now)
  let push: PushResult = { pushed: [], decisions: [], note: '' }
  if (opts.push !== false && core.proposals.length > 0) push = await pushSafeTopics(admin, core.proposals, now)
  const day = now.toISOString().slice(0, 10)
  const keep = new Date(now.getTime() - 7 * 86_400_000).toISOString().slice(0, 10)
  const pushed = [...prev.pushed.filter((x) => x.day >= keep), ...push.pushed.map((x) => ({ day, keyword: x.keyword, topicId: x.topicId }))].slice(-30)
  const state: MiningState = { ...core, pushed, note: [core.note, push.note].filter(Boolean).join(' ') }
  try {
    await setSetting(admin, MINING_KEY, JSON.stringify(state))
  } catch {
    // a result that cannot be saved is only a missing card
  }
  const note = `${core.proposals.length} page idea${core.proposals.length === 1 ? '' : 's'}, ${core.refresh.length} to refresh${push.pushed.length ? `, ${push.note}` : ''}`
  return { state, note }
}
