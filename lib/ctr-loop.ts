import type { SupabaseClient } from '@supabase/supabase-js'
import { isAiConfigured, parseModelJson } from '@/lib/ai-verify'
import { getSetting, setSetting } from '@/lib/app-settings'
import { POST_EXPERIENCE_CLAIM_PATTERNS } from '@/lib/blog-composer'
import { callModelText, EST_COST_USD_PER_CALL, MIN_MS_PER_CALL, type ContentEdit, type ContentType, type ModelCall } from '@/lib/content-repair'
import { deleteEdits, editsLoggable, insertEdits, recordRepairSpend, repairDay, revertEdit } from '@/lib/content-edits'
import { COUNT_CLAIM, EXPERIENCE_CLAIM_PATTERNS, RECENCY_PATTERNS, SUPERLATIVE_PATTERNS, WORD_NUMBER_PATTERNS, numbersIn } from '@/lib/guide-composer'
import { guideKinds, GUIDE_KINDS, type GuideKind } from '@/lib/guides'
import { judgePrompt, openBudget, type HealBudget } from '@/lib/heal-loop'
import type { QueryPagePair } from '@/lib/rankings'
import { getQueryPagePairs, isSearchConsoleConfigured } from '@/lib/search-console'
import { site } from '@/lib/site'

// The title and meta click-rate loop and the cannibalisation detector (hub row 2). It runs INSIDE the daily heal-content
// step (lib/content-heal-run.ts): no new cron, and every model call is taken from the heal loop's own daily call budget
// (lib/heal-loop.ts openBudget), so it can never spend past the limit you set.
//
//  (a) FIND   pages whose Google click rate is well below what their position normally earns (content_performance holds
//             the daily Search Console snapshot; every value is a trailing 28-day total as of that day, so ONE day's row
//             is read and days are never added together).
//  (b) TRY    for at most CTR_PAGES_PER_DAY pages a day: one suggester call proposes ONE new search title and description
//             using only facts on the page itself; a plain-code gate checks it; an independent judge call (the heal
//             loop's QA prompt) must pass it; then it is logged to content_edits BEFORE it is applied (so Undo works
//             on the Content edits page) and the experiment (page, old, new, baseline) is saved. After 30 days (28 days
//             plus Search Console's 2 day delay) the new numbers are compared with the baseline and the change is
//             undone by itself if the click rate fell.
//  (c) WATCH  search phrases where two or more of our pages show up: ONE informational item lists the top 5.
//
// Nothing here publishes a new page or edits a body: only the search title and search description of a page that is
// already live, and only through the same log-then-apply path the heal uses.

// ---------------------------------------------------------------------------------------------------
// Tunables (all documented; none are secrets)
// ---------------------------------------------------------------------------------------------------

/** A page needs at least this many impressions (28 days) before its click rate means anything. */
export const CTR_IMPRESSION_FLOOR = 200
/** "Well below" = under half of the expected click rate for its position. */
export const CTR_UNDERPERFORM_RATIO = 0.5
/** Pages ranked worse than this on average are ignored: no title fixes a page nobody sees. */
export const CTR_MAX_POSITION = 15
/** At most this many pages get a new title and description a day. */
export const CTR_PAGES_PER_DAY = 2
/** Compare this long after the change: 28 days of data plus Search Console's 2 day delay. */
export const CTR_EVAL_AFTER_DAYS = 30
/** Give up and keep the change if no usable numbers exist this long after it. */
export const CTR_GIVE_UP_DAYS = 60
/** Undo when the page's click rate, measured against what its position should earn, fell by this much or more. */
export const CTR_REVERT_DROP = 0.1
/** After the test the page needs at least this many impressions, otherwise the result is "too little data" and the change stays. */
export const CTR_MIN_AFTER_IMPRESSIONS = CTR_IMPRESSION_FLOOR / 2
/** A page whose attempt was turned down is not tried again for this long; one whose test finished is left alone longer. */
export const CTR_RETRY_REJECTED_DAYS = 14
export const CTR_RETRY_FINISHED_DAYS = 90
/** The newest Search Console snapshot must be at most this old. */
export const CTR_MAX_SNAPSHOT_AGE_DAYS = 4

export const CTR_TITLE_MIN = 20
export const CTR_TITLE_MAX = 60
export const CTR_DESC_MIN = 70
export const CTR_DESC_MAX = 155

const EXPERIMENT_PREFIX = 'ctr_exp:'
const TRIED_PREFIX = 'ctr_tried:'
const SLOT_PREFIX = 'ctr_loop_slot'
export const CANNIBAL_KEY = 'ctr_cannibalisation'
const SUGGEST_TOKENS = 600
const JUDGE_TOKENS = 1200
const CALL_TIMEOUT_MS = 45_000
const DAY_MS = 86_400_000

/** Expected organic click rate by average position 1 to 20. An APPROXIMATION from widely published industry click-rate
 * studies (position 1 near 28 percent, position 10 near 2.4 percent), not Search Console's own numbers and not a promise:
 * it only decides which pages look unusually weak, and the before/after comparison below is measured against the SAME table
 * so a drift in the table cancels out. Fractional positions are interpolated. */
export const EXPECTED_CTR_BY_POSITION: readonly number[] = [0.28, 0.15, 0.11, 0.08, 0.065, 0.05, 0.04, 0.032, 0.028, 0.024, 0.018, 0.015, 0.013, 0.011, 0.01, 0.009, 0.008, 0.007, 0.0065, 0.006]

/** Expected click rate (0 to 1) at an average position, or null outside 1 to 20 (too far down for the table to mean anything). Pure. */
export function expectedCtr(position: number | null | undefined): number | null {
  const p = Number(position)
  if (!Number.isFinite(p) || p < 1 || p > EXPECTED_CTR_BY_POSITION.length) return null
  const lo = Math.floor(p)
  const hi = Math.min(EXPECTED_CTR_BY_POSITION.length, lo + 1)
  const t = p - lo
  return EXPECTED_CTR_BY_POSITION[lo - 1] * (1 - t) + EXPECTED_CTR_BY_POSITION[hi - 1] * t
}

/** Actual click rate divided by the expected one: 1 means "as expected". Null when either is unknown. Pure. */
export function ctrRatio(clicks: number | null | undefined, impressions: number | null | undefined, position: number | null | undefined): number | null {
  const imp = Number(impressions)
  const exp = expectedCtr(position)
  if (!Number.isFinite(imp) || imp <= 0 || exp === null || clicks === null || clicks === undefined || !Number.isFinite(Number(clicks))) return null
  return Number(clicks) / imp / exp
}

// ---------------------------------------------------------------------------------------------------
// (a) Finding the weak pages
// ---------------------------------------------------------------------------------------------------

export interface PerfRow {
  path: string
  clicks: number | null
  impressions: number | null
  position: number | null
}

export interface Underperformer {
  path: string
  clicks: number
  impressions: number
  position: number
  ctr: number
  expected: number
  ratio: number
  /** Clicks the page would get at the expected rate, minus what it got: the order the loop works in. */
  lostClicks: number
}

/** Pages with enough impressions whose click rate is well below the expected one for their position, biggest gap first. Pure. */
export function findUnderperformers(rows: PerfRow[], opts: { floor?: number; ratio?: number; maxPosition?: number } = {}): Underperformer[] {
  const floor = opts.floor ?? CTR_IMPRESSION_FLOOR
  const ratio = opts.ratio ?? CTR_UNDERPERFORM_RATIO
  const maxPos = opts.maxPosition ?? CTR_MAX_POSITION
  const seen = new Set<string>()
  const out: Underperformer[] = []
  for (const r of rows) {
    const clicks = Number(r.clicks)
    const impressions = Number(r.impressions)
    const position = Number(r.position)
    // A null number means "not recorded", never zero: a page with no click figure is skipped, not counted as unclicked.
    if (r.clicks === null || r.impressions === null || r.position === null || r.clicks === undefined || r.impressions === undefined || r.position === undefined) continue
    if (!r.path || seen.has(r.path) || !Number.isFinite(clicks) || !Number.isFinite(impressions) || !Number.isFinite(position)) continue
    if (impressions < floor || position < 1 || position > maxPos) continue
    const expected = expectedCtr(position)
    if (expected === null) continue
    const ctr = clicks / impressions
    if (ctr >= expected * ratio) continue
    seen.add(r.path)
    out.push({ path: r.path, clicks, impressions, position, ctr, expected, ratio: ctr / expected, lostClicks: expected * impressions - clicks })
  }
  return out.sort((a, b) => b.lostClicks - a.lostClicks)
}

// ---------------------------------------------------------------------------------------------------
// (b) The proposal: prompt, gate, judge
// ---------------------------------------------------------------------------------------------------

export interface Proposal {
  title: string
  description: string
}

export interface PageFacts {
  oldTitle: string
  oldDescription: string
  /** The page's own text: the only place a fact may come from. */
  source: string
  keyword: string | null
}

const LONG_DASH = new RegExp('[' + String.fromCharCode(0x2013, 0x2014) + ']')
const URGENCY = /\b(hurry|last chance|limited time|limited spots|don'?t miss|act (now|fast)|book now|before it'?s too late|selling fast|sale|deal|discount|bargain|cheap(est)?)\b/i
const FIRST_PERSON_TITLE = /\b(i|my|we|our|us)\b/i
const WEB_OR_CONTACT = /https?:\/\/|\bwww\.|@|\d{3}[\s.)-]*\d{3}[\s.-]*\d{4}/i
const PLACEHOLDER = /\[[^\]]*\]|\{\{|\}\}|lorem ipsum|\btodo\b|\btbd\b/i
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

const siteWords = new Set(norm(site.name).split(' ').filter(Boolean))

/** Capitalised words in the middle of a text (a name of a place, ship, hotel or person). The first word of the text and of
 * each clause is skipped, because it is capitalised anyway. The prompt asks for sentence case, so any other capital is a name. */
export function namedWordsIn(text: string): string[] {
  const out: string[] = []
  const re = /[A-Za-z][A-Za-z'’-]*/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const word = m[0]
    if (word.length < 3 || !/^[A-Z]/.test(word)) continue
    const before = text.slice(0, m.index).replace(/\s+$/, '')
    if (before === '' || /[:.!?|-]$/.test(before)) continue
    out.push(word.replace(/['’]s$/i, ''))
  }
  return out
}

/** Everything the plain-code gate refuses, as short reasons. Empty means the proposal passes. Pure. The gate is the law: a
 * proposal that fails it is dropped whatever the judge would say. */
export function ctrGate(p: Proposal, page: PageFacts): string[] {
  const out: string[] = []
  const title = p.title.trim()
  const desc = p.description.trim()
  const both = `${title}\n${desc}`
  if (!title || !desc) return ['the title or the description is empty']
  if (title.length < CTR_TITLE_MIN || title.length > CTR_TITLE_MAX) out.push(`title is ${title.length} characters (needs ${CTR_TITLE_MIN} to ${CTR_TITLE_MAX})`)
  if (desc.length < CTR_DESC_MIN || desc.length > CTR_DESC_MAX) out.push(`description is ${desc.length} characters (needs ${CTR_DESC_MIN} to ${CTR_DESC_MAX})`)
  if (norm(title) === norm(page.oldTitle) && norm(desc) === norm(page.oldDescription)) out.push('nothing changed')
  if (norm(title) === norm(desc)) out.push('the title and the description are the same')
  if (LONG_DASH.test(both) || /\s--\s/.test(both)) out.push('contains a long dash')
  if (WEB_OR_CONTACT.test(both)) out.push('contains a web address, email address or phone number')
  if (/[$€£]|\b(cad|usd)\b/i.test(both)) out.push('mentions a price')
  if (PLACEHOLDER.test(both)) out.push('placeholder text')
  if (/!/.test(both)) out.push('exclamation mark')
  if (URGENCY.test(both)) out.push('urgency or discount wording')
  if (/\b[A-Z]{5,}\b/.test(both.replace(/[A-Z]{5,}(?=\.ca|\.com)/g, ''))) out.push('shouting in capital letters')
  for (const [pattern, label] of SUPERLATIVE_PATTERNS) if (pattern.test(both)) out.push(`superlative or rating claim (${label})`)
  if ([...EXPERIENCE_CLAIM_PATTERNS, ...POST_EXPERIENCE_CLAIM_PATTERNS].some((x) => x.test(both))) out.push('experience claim')
  if (FIRST_PERSON_TITLE.test(title)) out.push('first person in the title')
  if (RECENCY_PATTERNS.some((x) => x.test(both))) out.push('recency claim')
  if (COUNT_CLAIM.test(both) || WORD_NUMBER_PATTERNS.some((x) => x.test(both))) out.push('a count or size claim')

  // Facts only from the page itself: every number, and every name, must already be on the page or in the old text.
  const known = `${page.source}\n${page.oldTitle}\n${page.oldDescription}`
  const allowedNumbers = new Set(numbersIn(known).map((n) => String(Number(n.replace(/,/g, '')))))
  const strangers = [...new Set(numbersIn(both).map((n) => String(Number(n.replace(/,/g, '')))).filter((n) => !allowedNumbers.has(n)))]
  if (strangers.length) out.push(`number not on the page: ${strangers.slice(0, 4).join(', ')}`)
  const knownWords = new Set(norm(known).split(' ').filter(Boolean))
  const unknownNames = [...new Set([...namedWordsIn(title), ...namedWordsIn(desc)].filter((w) => !knownWords.has(norm(w)) && !siteWords.has(norm(w))))]
  if (unknownNames.length) out.push(`name not on the page: ${unknownNames.slice(0, 4).join(', ')}`)

  // Do not throw away the phrase the page is aimed at.
  if (page.keyword && norm(page.oldTitle).includes(norm(page.keyword)) && !norm(title).includes(norm(page.keyword))) out.push(`dropped the target phrase "${page.keyword}" from the title`)
  return out
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s)

export function suggestPrompt(page: PageFacts, perf: { ctr: number; expected: number; position: number }, queries: string[]): string {
  const hints = queries.length ? `\n\nPHRASES PEOPLE TYPE BEFORE THEY SEE THIS PAGE (wording hints only, NEVER facts about the page):\n${queries.map((q) => `- ${q}`).join('\n')}` : ''
  return `You write the search-result title and description for ONE page of a Canadian travel agency website. The page ranks around position ${perf.position.toFixed(1)} on Google but only ${(perf.ctr * 100).toFixed(1)} percent of people click it, where about ${(perf.expected * 100).toFixed(1)} percent is typical. Write a clearer, more specific title and description so the right readers click. Be honest: do not promise anything the page does not say.\n\nTHE PAGE (the ONLY source for any fact):\n${clip(page.source, 5000)}\n\nCURRENT TITLE: ${page.oldTitle}\nCURRENT DESCRIPTION: ${page.oldDescription || '(none)'}${hints}\n\nRules: title ${CTR_TITLE_MIN} to ${CTR_TITLE_MAX} characters, description ${CTR_DESC_MIN} to ${CTR_DESC_MAX} characters. Use sentence case: only the first word and real names are capitalised. Lead the title with the main topic of the page${page.keyword ? ` (keep the phrase "${page.keyword}" if it is in the current title)` : ''}. Say plainly what the reader gets. Use ONLY facts, names and numbers that appear in THE PAGE. No superlatives or ratings (best, top, famous, luxury, award-winning), no prices, no dates or years unless they are in THE PAGE, no urgency, no exclamation marks, no quotation marks, no web addresses, never the long dash character. Never write in the first person, and never say what the agency has done; the description may offer help ("our advisors can help you plan this").\n\nReturn ONLY minified JSON: {"meta_title":"...","meta_description":"..."}`
}

/** Reads the suggester's answer. Null when it is not usable JSON with two strings. Pure. */
export function parseProposal(raw: string | null): Proposal | null {
  if (!raw) return null
  const j = parseModelJson<{ meta_title?: unknown; meta_description?: unknown }>(raw)
  if (!j || typeof j.meta_title !== 'string' || typeof j.meta_description !== 'string') return null
  const tidy = (s: string) => s.replace(/\s+/g, ' ').trim().replace(/^["'“‘]+|["'”’]+$/g, '').trim()
  return { title: tidy(j.meta_title), description: tidy(j.meta_description) }
}

/** The judge's verdict. Same strictness as the heal loop: a "pass" with any failure listed is a fail; an unreadable answer is not a pass. */
export function parseJudge(raw: string | null): { pass: boolean; answered: boolean; reasons: string[] } {
  if (!raw) return { pass: false, answered: false, reasons: ['the QA review did not answer'] }
  const j = parseModelJson<{ pass?: unknown; failures?: unknown }>(raw)
  if (!j || typeof j !== 'object' || typeof j.pass !== 'boolean') return { pass: false, answered: false, reasons: ['the QA review was unreadable'] }
  const failures = Array.isArray(j.failures) ? j.failures : []
  const pass = j.pass === true && failures.length === 0
  const reasons = pass ? [] : failures.length ? failures.map((f) => `QA reviewer: ${typeof (f as { reason?: unknown })?.reason === 'string' ? (f as { reason: string }).reason.slice(0, 120) : 'breaks a rule'}`) : ['QA reviewer said fail without naming a sentence']
  return { pass, answered: true, reasons }
}

// ---------------------------------------------------------------------------------------------------
// The page behind a path
// ---------------------------------------------------------------------------------------------------

type Row = Record<string, unknown>
const str = (v: unknown) => (typeof v === 'string' ? v : '')

export interface EditablePage {
  type: Extract<ContentType, 'post' | 'guide' | 'page_copy'>
  table: 'posts' | 'guides' | 'page_copy'
  id: string
  path: string
  /** What is stored in the two columns (empty when the page uses its own name instead). */
  storedTitle: string
  storedDescription: string
  facts: PageFacts
}

const plainText = (s: string) => s.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`>#]/g, ' ').replace(/\s+/g, ' ').trim()

/** The live page behind a site path that this loop may edit: a published blog post, guide or page copy. Null for anything else
 * (a trip page, an index page, a page that is not published, a table that cannot be read). Trips are left alone on purpose:
 * their facts are the product, so only the heal's narrow trip fixes may touch them. */
export async function resolveEditablePage(admin: SupabaseClient, path: string): Promise<EditablePage | null> {
  const clean = path.split(/[?#]/)[0].replace(/\/+$/, '')
  try {
    const blog = /^\/blog\/([^/]+)$/.exec(clean)?.[1]
    if (blog) {
      const { data } = await admin.from('posts').select('*').eq('slug', blog).eq('status', 'published').maybeSingle()
      const r = data as Row | null
      if (!r) return null
      const keyword = str(r.primary_keyword) || null
      return { type: 'post', table: 'posts', id: str(r.id), path: clean, storedTitle: str(r.meta_title), storedDescription: str(r.meta_description), facts: { oldTitle: str(r.meta_title) || str(r.title), oldDescription: str(r.meta_description), source: plainText(`${str(r.title)}\n\n${str(r.body)}`), keyword } }
    }
    const kind = GUIDE_KINDS.find((k) => clean.startsWith(`${guideKinds[k].urlPrefix}/`)) as GuideKind | undefined
    if (kind) {
      const slug = clean.slice(guideKinds[kind].urlPrefix.length + 1)
      if (!slug || slug.includes('/')) return null
      const { data } = await admin.from('guides').select('*').eq('kind', kind).eq('slug', slug).eq('status', 'published').maybeSingle()
      const r = data as Row | null
      if (!r) return null
      return { type: 'guide', table: 'guides', id: str(r.id), path: clean, storedTitle: str(r.meta_title), storedDescription: str(r.meta_description), facts: { oldTitle: str(r.meta_title) || str(r.name), oldDescription: str(r.meta_description), source: plainText(`${str(r.name)}\n\n${str(r.summary)}\n\n${str(r.body)}`), keyword: str(r.primary_keyword) || null } }
    }
    const { data } = await admin.from('page_copy').select('*').eq('path', clean).eq('status', 'published').maybeSingle()
    const r = data as Row | null
    if (!r) return null
    const takeaways = Array.isArray(r.key_takeaways) ? (r.key_takeaways as unknown[]).filter((x): x is string => typeof x === 'string').join('\n') : ''
    return { type: 'page_copy', table: 'page_copy', id: str(r.id), path: clean, storedTitle: str(r.meta_title), storedDescription: str(r.meta_description), facts: { oldTitle: str(r.meta_title), oldDescription: str(r.meta_description), source: plainText(`${clean.replace(/^\/[^/]+\//, '').replace(/-/g, ' ')}\n\n${str(r.intro)}\n\n${takeaways}`), keyword: str(r.primary_keyword) || null } }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------------------------------
// The experiment record (one app_settings row per test, so two overlapping runs cannot overwrite each other)
// ---------------------------------------------------------------------------------------------------

export type ExperimentStatus = 'running' | 'kept' | 'reverted' | 'inconclusive' | 'undone_by_person' | 'revert_blocked'

export interface Experiment {
  path: string
  type: EditablePage['type']
  contentId: string
  startedAt: string
  oldTitle: string
  newTitle: string
  oldDescription: string
  newDescription: string
  /** The stored column values before the change (what Undo puts back). */
  storedTitleBefore: string
  storedDescriptionBefore: string
  baselineCtr: number
  baselinePosition: number
  baselineImpressions: number
  editIds: string[]
  status: ExperimentStatus
  evaluatedAt?: string
  afterCtr?: number
  afterPosition?: number
  afterImpressions?: number
  note?: string
}

export const experimentKey = (path: string, startedAt: string) => `${EXPERIMENT_PREFIX}${startedAt.slice(0, 10)}:${path}`

export function parseExperiment(raw: string | null | undefined): Experiment | null {
  try {
    const e = JSON.parse(raw ?? 'null') as Partial<Experiment> | null
    if (!e || typeof e.path !== 'string' || typeof e.startedAt !== 'string' || !Number.isFinite(Date.parse(e.startedAt)) || !Array.isArray(e.editIds) || typeof e.status !== 'string') return null
    return e as Experiment
  } catch {
    return null
  }
}

/** The first day (YYYY-MM-DD) whose 28-day snapshot is entirely after the change. Pure. */
export function evalDayOf(startedAt: string): string {
  return new Date(Date.parse(startedAt) + CTR_EVAL_AFTER_DAYS * DAY_MS).toISOString().slice(0, 10)
}

export type Decision = 'revert' | 'keep' | 'inconclusive'

/** Compares the click rate before and after, each measured against the rate its position should earn (so a page that simply
 * moved up or down is not blamed or credited for it). Reverts only on a clear fall; too little data or no usable position
 * keeps the change and says so. Pure. */
export function decideExperiment(
  baseline: { clicks?: number; impressions: number; position: number; ctr: number },
  after: { clicks: number | null; impressions: number | null; position: number | null },
): { decision: Decision; reason: string; before: number | null; afterRatio: number | null } {
  const before = ctrRatio(baseline.ctr * baseline.impressions, baseline.impressions, baseline.position)
  const afterRatio = ctrRatio(after.clicks, after.impressions, after.position)
  if (!Number.isFinite(Number(after.impressions)) || Number(after.impressions) < CTR_MIN_AFTER_IMPRESSIONS) return { decision: 'inconclusive', reason: 'too few impressions after the change to judge', before, afterRatio }
  if (before === null || afterRatio === null) return { decision: 'inconclusive', reason: 'the page ranks outside the first 20 results, so the click rate cannot be judged', before, afterRatio }
  if (afterRatio < before * (1 - CTR_REVERT_DROP)) return { decision: 'revert', reason: `click rate against its position fell from ${before.toFixed(2)} to ${afterRatio.toFixed(2)} of expected`, before, afterRatio }
  return { decision: 'keep', reason: `click rate against its position went from ${before.toFixed(2)} to ${afterRatio.toFixed(2)} of expected`, before, afterRatio }
}

// ---------------------------------------------------------------------------------------------------
// (c) Cannibalisation
// ---------------------------------------------------------------------------------------------------

export const CANNIBAL_PAGE_MIN_IMPRESSIONS = 10
export const CANNIBAL_QUERY_MIN_IMPRESSIONS = 100
export const CANNIBAL_TOP = 5
/** Listing pages that naturally show up beside a detail page for the same phrase: not competition. */
const INDEX_PATHS = new Set(['/', '/blog', '/packages', '/destinations', '/best-time-to-visit', '/compare', '/who-we-are', ...GUIDE_KINDS.map((k) => guideKinds[k].urlPrefix)])

export interface CannibalPage {
  path: string
  clicks: number
  impressions: number
}

export interface CannibalItem {
  query: string
  impressions: number
  pages: CannibalPage[]
  /** The page that earns the clicks for this phrase (most clicks, then most impressions). */
  stronger: string
}

/** Search phrases where two or more of our pages get impressions, the busiest first (top 5). Pure. */
export function findCannibalisation(pairs: QueryPagePair[], top = CANNIBAL_TOP): CannibalItem[] {
  const byQuery = new Map<string, Map<string, CannibalPage>>()
  for (const p of pairs) {
    const q = p.query.trim().toLowerCase()
    const path = p.path.replace(/\/+$/, '') || '/'
    if (!q || INDEX_PATHS.has(path) || path.startsWith('/admin') || path.startsWith('/api')) continue
    const pages = byQuery.get(q) ?? new Map<string, CannibalPage>()
    const cur = pages.get(path) ?? { path, clicks: 0, impressions: 0 }
    cur.clicks += Number(p.clicks) || 0
    cur.impressions += Number(p.impressions) || 0
    pages.set(path, cur)
    byQuery.set(q, pages)
  }
  const items: CannibalItem[] = []
  for (const [query, pages] of byQuery) {
    const list = [...pages.values()].filter((p) => p.impressions >= CANNIBAL_PAGE_MIN_IMPRESSIONS).sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions || a.path.localeCompare(b.path))
    if (list.length < 2) continue
    const impressions = list.reduce((n, p) => n + p.impressions, 0)
    if (impressions < CANNIBAL_QUERY_MIN_IMPRESSIONS) continue
    items.push({ query, impressions, pages: list, stronger: list[0].path })
  }
  return items.sort((a, b) => b.impressions - a.impressions || a.query.localeCompare(b.query)).slice(0, top)
}

export interface CannibalRecord {
  at: string
  items: CannibalItem[]
}

export async function readCannibalisation(admin: SupabaseClient): Promise<CannibalRecord | null> {
  try {
    const v = JSON.parse((await getSetting(admin, CANNIBAL_KEY)) ?? 'null') as CannibalRecord | null
    return v && typeof v.at === 'string' && Array.isArray(v.items) ? v : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------------------------------

export interface CtrLoopResult {
  calls: number
  changedPaths: string[]
  problems: string[]
  note: string
  started: number
  checked: number
  reverted: number
  /** True when anything happened worth a line in the heal note. */
  active: boolean
}

export interface CtrLoopOpts {
  deadlineMs?: number
  now?: Date
  /** Replaces the model (checks use a stub; nothing here may reach a paid API from a check). */
  model?: ModelCall
  /** Replaces the Search Console query+page read. */
  getPairs?: () => Promise<QueryPagePair[]>
  budget?: HealBudget
}

const isMissingTable = (message: string | undefined) => !!message && /does not exist|schema cache|relation .* not found|could not find the table/i.test(message)

interface TriedRow {
  at: string
  outcome: string
}

async function readTried(admin: SupabaseClient): Promise<Map<string, TriedRow> | string> {
  const { data, error } = await admin.from('app_settings').select('key, value').like('key', `${TRIED_PREFIX}%`)
  if (error) return error.message
  const out = new Map<string, TriedRow>()
  for (const r of (data ?? []) as { key: string; value: string }[]) {
    try {
      const v = JSON.parse(r.value) as TriedRow
      if (typeof v.at === 'string') out.set(r.key.slice(TRIED_PREFIX.length), v)
    } catch {
      // an unreadable marker is ignored: the page may be tried again, still capped by the daily slots
    }
  }
  return out
}

async function markTried(admin: SupabaseClient, path: string, outcome: string, now: Date): Promise<void> {
  await setSetting(admin, `${TRIED_PREFIX}${path}`, JSON.stringify({ at: now.toISOString(), outcome })).catch(() => undefined)
}

/** True while a page is still resting after an earlier attempt or test. Pure. */
export function isResting(t: TriedRow | undefined, now: number): boolean {
  if (!t) return false
  const age = now - Date.parse(t.at)
  if (!Number.isFinite(age)) return false
  return age < (t.outcome === 'rejected' ? CTR_RETRY_REJECTED_DAYS : CTR_RETRY_FINISHED_DAYS) * DAY_MS
}

/** Claims one of today's CTR_PAGES_PER_DAY slots (an atomic unique-key insert, like the heal's repair slots). False when taken or unreadable. */
async function claimSlot(admin: SupabaseClient, path: string, day: string): Promise<{ ok: boolean; problem?: string }> {
  const prefix = `${SLOT_PREFIX}:${day}:`
  const { data, error } = await admin.from('app_settings').select('key').like('key', `${prefix}%`)
  if (error) return { ok: false, problem: `could not read today's click-rate slots (${error.message})` }
  const taken = new Set(((data ?? []) as { key: string }[]).map((r) => r.key))
  for (let n = 1; n <= CTR_PAGES_PER_DAY; n++) {
    if (taken.has(`${prefix}${n}`)) continue
    const { error: insertError } = await admin.from('app_settings').insert({ key: `${prefix}${n}`, value: path })
    if (!insertError) return { ok: true }
    if ((insertError as { code?: string }).code !== '23505') return { ok: false, problem: `could not claim a click-rate slot (${insertError.message})` }
  }
  return { ok: false }
}

async function slotsLeftToday(admin: SupabaseClient, day: string): Promise<number | null> {
  const { data, error } = await admin.from('app_settings').select('key').like('key', `${SLOT_PREFIX}:${day}:%`)
  return error ? null : Math.max(0, CTR_PAGES_PER_DAY - (data ?? []).length)
}

/** The newest content_performance snapshot, or a reason it cannot be used. One day's rows only: the numbers are rolling 28 day totals. */
async function readLatestPerformance(admin: SupabaseClient, now: Date): Promise<{ day: string; rows: PerfRow[] } | { skip: string; problem?: string }> {
  const latest = await admin.from('content_performance').select('day').order('day', { ascending: false }).limit(1)
  if (latest.error) return isMissingTable(latest.error.message) ? { skip: 'the performance table is not set up' } : { skip: 'unreadable', problem: `could not read the Search Console numbers (${latest.error.message})` }
  const day = (latest.data?.[0] as { day?: string } | undefined)?.day
  if (!day) return { skip: 'no Search Console numbers yet' }
  if (now.getTime() - Date.parse(day) > CTR_MAX_SNAPSHOT_AGE_DAYS * DAY_MS) return { skip: `the newest Search Console numbers are from ${day}, too old to use` }
  const rows: PerfRow[] = []
  for (let page = 0; page < 10; page++) {
    const { data, error } = await admin.from('content_performance').select('path, clicks, impressions, position').eq('day', day).range(page * 1000, page * 1000 + 999)
    if (error) return { skip: 'unreadable', problem: `could not read the Search Console numbers (${error.message})` }
    rows.push(...((data ?? []) as PerfRow[]))
    if ((data ?? []).length < 1000) break
  }
  return { day, rows }
}

async function readExperiments(admin: SupabaseClient): Promise<{ key: string; exp: Experiment }[] | string> {
  const { data, error } = await admin.from('app_settings').select('key, value').like('key', `${EXPERIMENT_PREFIX}%`)
  if (error) return error.message
  const out: { key: string; exp: Experiment }[] = []
  for (const r of (data ?? []) as { key: string; value: string }[]) {
    const exp = parseExperiment(r.value)
    if (exp) out.push({ key: r.key, exp })
  }
  return out
}

/** Checks every running test: undone by a person, due for its comparison, or still waiting. Free (no model). */
async function evaluateExperiments(admin: SupabaseClient, now: Date, out: CtrLoopResult): Promise<void> {
  const all = await readExperiments(admin)
  if (typeof all === 'string') {
    out.problems.push(`click-rate test: could not read the running tests (${all})`)
    return
  }
  const running = all.filter((x) => x.exp.status === 'running')
  if (running.length === 0) return
  const ids = running.flatMap((x) => x.exp.editIds)
  const reverted = new Map<string, boolean>()
  if (ids.length) {
    const { data, error } = await admin.from('content_edits').select('id, reverted_at').in('id', ids)
    if (error) {
      out.problems.push(`click-rate test: could not read the change log (${error.message})`)
      return
    }
    for (const r of (data ?? []) as { id: string; reverted_at: string | null }[]) reverted.set(r.id, !!r.reverted_at)
  }
  const save = async (key: string, exp: Experiment) => {
    const saved = await setSetting(admin, key, JSON.stringify(exp))
    if (saved.error) out.problems.push(`click-rate test: could not save the result for ${exp.path} (${saved.error})`)
  }
  for (const { key, exp } of running) {
    const live = exp.editIds.filter((id) => reverted.get(id) === false)
    if (live.length === 0) {
      // A person pressed Undo on the Content edits page, or the edit rows are gone: the test is over and the page stays as they left it.
      await save(key, { ...exp, status: 'undone_by_person', evaluatedAt: now.toISOString(), note: 'undone by a person before the comparison' })
      await markTried(admin, exp.path, 'finished', now)
      out.checked++
      continue
    }
    const dueDay = evalDayOf(exp.startedAt)
    if (now.toISOString().slice(0, 10) < dueDay) continue
    const ageDays = (now.getTime() - Date.parse(exp.startedAt)) / DAY_MS
    const perf = await admin.from('content_performance').select('day, clicks, impressions, position').eq('path', exp.path).gte('day', dueDay).order('day', { ascending: false }).limit(1)
    if (perf.error) {
      out.problems.push(`click-rate test: could not read the numbers for ${exp.path} (${perf.error.message})`)
      continue
    }
    const row = perf.data?.[0] as { day: string; clicks: number | null; impressions: number | null; position: number | null } | undefined
    if (!row) {
      if (ageDays > CTR_GIVE_UP_DAYS) {
        await save(key, { ...exp, status: 'inconclusive', evaluatedAt: now.toISOString(), note: 'no Search Console numbers for this page after the change; the change stays' })
        await markTried(admin, exp.path, 'finished', now)
        out.checked++
      }
      continue
    }
    const verdict = decideExperiment({ impressions: exp.baselineImpressions, position: exp.baselinePosition, ctr: exp.baselineCtr }, { clicks: row.clicks === null ? null : Number(row.clicks), impressions: row.impressions === null ? null : Number(row.impressions), position: row.position === null ? null : Number(row.position) })
    const after = { afterCtr: Number(row.impressions) > 0 ? Number(row.clicks) / Number(row.impressions) : 0, afterPosition: Number(row.position), afterImpressions: Number(row.impressions), evaluatedAt: now.toISOString() }
    out.checked++
    if (verdict.decision !== 'revert') {
      await save(key, { ...exp, ...after, status: verdict.decision === 'keep' ? 'kept' : 'inconclusive', note: verdict.reason })
      await markTried(admin, exp.path, 'finished', now)
      continue
    }
    // The click rate fell: put the old title and description back with the same Undo the Content edits page uses. No force:
    // a field changed since by someone else is left alone, and the test says so.
    let blocked = ''
    for (const id of live) {
      const r = await revertEdit(admin, id)
      if (!r.ok) blocked = r.needsForce ? 'the page was changed again after the test started, so it was left as it is' : (r.error ?? 'the change could not be undone')
    }
    if (blocked) {
      await save(key, { ...exp, ...after, status: 'revert_blocked', note: `${verdict.reason}; ${blocked}` })
      if (!/changed again/.test(blocked)) out.problems.push(`click-rate test: ${exp.path} should be undone but ${blocked}`)
    } else {
      await save(key, { ...exp, ...after, status: 'reverted', note: verdict.reason })
      out.reverted++
    }
    await markTried(admin, exp.path, 'finished', now)
  }
}

/** The whole loop for one daily heal run. Never throws; every problem is returned as plain text for Needs attention. */
export async function runCtrLoop(admin: SupabaseClient, opts: CtrLoopOpts = {}): Promise<CtrLoopResult> {
  const now = opts.now ?? new Date()
  const out: CtrLoopResult = { calls: 0, changedPaths: [], problems: [], note: '', started: 0, checked: 0, reverted: 0, active: false }
  const lines: string[] = []
  try {
    if (!(await editsLoggable(admin))) return { ...out, note: 'click-rate test: waiting for the change log (migration 0033)' }

    // (b, second half) finish the tests that are due. Free.
    await evaluateExperiments(admin, now, out)
    if (out.checked) lines.push(`checked ${out.checked} earlier title test${out.checked === 1 ? '' : 's'}${out.reverted ? ` (${out.reverted} undone because the click rate fell)` : ''}`)

    // (c) cannibalisation. Free (one cached Search Console read, shared with (b)).
    let pairs: QueryPagePair[] = []
    if (opts.getPairs || isSearchConsoleConfigured()) {
      try {
        pairs = await (opts.getPairs ?? getQueryPagePairs)()
      } catch {
        pairs = []
      }
      if (pairs.length) {
        const items = findCannibalisation(pairs)
        const saved = await setSetting(admin, CANNIBAL_KEY, JSON.stringify({ at: now.toISOString(), items } satisfies CannibalRecord))
        if (saved.error) out.problems.push(`click-rate test: could not save the competing pages list (${saved.error})`)
        else if (items.length) lines.push(`${items.length} search phrase${items.length === 1 ? '' : 's'} where two of our pages compete`)
      }
    }

    // (a, b) start new tests. Needs the model, the heal budget, time, and today's slots.
    const model = opts.model ?? callModelText
    if (!opts.model && !isAiConfigured()) return finish(out, lines)
    const day = repairDay(now)
    const left = await slotsLeftToday(admin, day)
    if (left === null) {
      out.problems.push('click-rate test: could not read how many pages were tried today, so none was tried')
      return finish(out, lines)
    }
    if (left === 0) return finish(out, lines)

    const perf = await readLatestPerformance(admin, now)
    if ('skip' in perf) {
      if (perf.problem) out.problems.push(`click-rate test: ${perf.problem}`)
      return finish(out, lines)
    }
    const weak = findUnderperformers(perf.rows)
    if (weak.length === 0) return finish(out, lines)

    const tried = await readTried(admin)
    if (typeof tried === 'string') {
      out.problems.push(`click-rate test: could not read which pages were tried before (${tried}), so none was tried`)
      return finish(out, lines)
    }
    const exps = await readExperiments(admin)
    if (typeof exps === 'string') {
      out.problems.push(`click-rate test: could not read the running tests (${exps}), so none was started`)
      return finish(out, lines)
    }
    const busy = new Set(exps.filter((x) => x.exp.status === 'running').map((x) => x.exp.path))

    const budget = opts.budget ?? (await openBudget(admin, now))
    if (!budget.readable) return finish(out, lines) // the heal loop's own Needs attention item already says the counter is unreadable
    if (budget.remaining() < 2) {
      lines.push("no title test started (today's heal limit is used up)")
      return finish(out, lines)
    }

    // An object, not a plain variable: the closure below sets it, and TypeScript would otherwise narrow it to null.
    const st = { stop: null as 'budget' | 'time' | null }
    const call = async (prompt: string, maxTokens: number): Promise<string | null> => {
      if (opts.deadlineMs !== undefined && opts.deadlineMs - Date.now() < MIN_MS_PER_CALL) {
        st.stop = 'time'
        return null
      }
      if (!(await budget.take(1))) {
        st.stop = 'budget'
        return null
      }
      out.calls++
      const timeout = opts.deadlineMs === undefined ? CALL_TIMEOUT_MS : Math.max(5_000, Math.min(CALL_TIMEOUT_MS, opts.deadlineMs - Date.now() - 3_000))
      try {
        return await model(prompt, maxTokens, timeout)
      } catch {
        return null
      }
    }

    const notes: string[] = []
    for (const w of weak) {
      if (out.started + notes.length >= left || st.stop) break
      if (busy.has(w.path) || isResting(tried.get(w.path), now.getTime())) continue
      if (budget.remaining() < 2) break
      const page = await resolveEditablePage(admin, w.path)
      if (!page) continue

      const slot = await claimSlot(admin, w.path, day)
      if (!slot.ok) {
        if (slot.problem) out.problems.push(`click-rate test: ${slot.problem}`)
        break
      }
      const queries = pairs.filter((p) => p.path.replace(/\/+$/, '') === w.path).sort((a, b) => b.impressions - a.impressions).slice(0, 3).map((p) => p.query)
      const callsBefore = out.calls

      const suggested = parseProposal(await call(suggestPrompt(page.facts, w, queries), SUGGEST_TOKENS))
      if (!suggested) {
        if (!st.stop) {
          await markTried(admin, w.path, 'rejected', now)
          notes.push(`${w.path}: the suggestion could not be read`)
        }
        continue
      }
      const blockers = ctrGate(suggested, page.facts)
      if (blockers.length) {
        await markTried(admin, w.path, 'rejected', now)
        notes.push(`${w.path}: turned down by the checks (${blockers.slice(0, 2).join('; ')})`)
        continue
      }
      const judgeText = `SEARCH AND SHARE TEXT:\n- ${suggested.title}\n- ${suggested.description}`
      const judged = parseJudge(await call(judgePrompt(page.facts.source, judgeText), JUDGE_TOKENS))
      if (!judged.pass) {
        if (judged.answered) {
          await markTried(admin, w.path, 'rejected', now)
          notes.push(`${w.path}: turned down by the QA review (${judged.reasons[0] ?? 'it failed'})`)
        }
        continue
      }

      // Log first, then apply. The page is read again so a title an admin changed meanwhile is never overwritten.
      const fresh = await resolveEditablePage(admin, w.path)
      if (!fresh || fresh.storedTitle !== page.storedTitle || fresh.storedDescription !== page.storedDescription) {
        notes.push(`${w.path}: changed while it was being checked, left alone`)
        continue
      }
      const usedCalls = Math.max(1, out.calls - callsBefore)
      const reason = `Search title and description reworded to lift the click rate (${(w.ctr * 100).toFixed(1)} percent of searchers clicked at position ${w.position.toFixed(1)}, where about ${(w.expected * 100).toFixed(1)} percent is typical). It is checked after ${CTR_EVAL_AFTER_DAYS} days and undone by itself if the click rate falls.`
      const edits: ContentEdit[] = []
      const mk = (field: 'meta_title' | 'meta_description', before: string, after: string) => edits.push({ content_type: page.type, content_id: page.id, path: page.path, field, reason, before, after, method: 'generate', published_after: true, cost_usd: 0 })
      if (suggested.title !== page.storedTitle) mk('meta_title', page.storedTitle, suggested.title)
      if (suggested.description !== page.storedDescription) mk('meta_description', page.storedDescription, suggested.description)
      if (edits.length === 0) continue
      edits[0].cost_usd = Math.round(usedCalls * EST_COST_USD_PER_CALL * 10000) / 10000
      const logged = await insertEdits(admin, edits)
      if (logged.error) {
        out.problems.push(`click-rate test: the change log could not be written (${logged.error})`)
        break
      }
      const { error: updateError } = await admin.from(page.table).update({ meta_title: suggested.title, meta_description: suggested.description, updated_at: now.toISOString() }).eq('status', 'published').eq('id', page.id)
      if (updateError) {
        await deleteEdits(admin, logged.ids)
        out.problems.push(`click-rate test: could not update ${page.path} (${updateError.message})`)
        continue
      }
      const exp: Experiment = {
        path: page.path,
        type: page.type,
        contentId: page.id,
        startedAt: now.toISOString(),
        oldTitle: page.facts.oldTitle,
        newTitle: suggested.title,
        oldDescription: page.facts.oldDescription,
        newDescription: suggested.description,
        storedTitleBefore: page.storedTitle,
        storedDescriptionBefore: page.storedDescription,
        baselineCtr: w.ctr,
        baselinePosition: w.position,
        baselineImpressions: w.impressions,
        editIds: logged.ids,
        status: 'running',
      }
      const saved = await setSetting(admin, experimentKey(page.path, exp.startedAt), JSON.stringify(exp))
      if (saved.error) {
        // The change is live and logged (Undo works) but the test would never be compared: take it back so nothing runs unwatched.
        for (const id of logged.ids) await revertEdit(admin, id, { force: true })
        out.problems.push(`click-rate test: could not save the test for ${page.path} (${saved.error}), so the change was undone`)
        break
      }
      await markTried(admin, page.path, 'started', now)
      busy.add(page.path)
      out.started++
      out.changedPaths.push(page.path)
    }
    // The day's estimated spend (a display number) counts every call made, kept or turned down.
    if (out.calls) await recordRepairSpend(admin, out.calls)
    if (out.started) lines.push(`started ${out.started} title test${out.started === 1 ? '' : 's'} (${out.changedPaths.join(', ')})`)
    if (notes.length) lines.push(notes.join('; '))
    if (st.stop === 'budget') lines.push("stopped at today's heal limit")
    return finish(out, lines)
  } catch (e) {
    out.problems.push(`click-rate test: ${e instanceof Error ? e.message : 'failed'}`)
    return finish(out, lines)
  }
}

function finish(out: CtrLoopResult, lines: string[]): CtrLoopResult {
  const note = lines.length ? `click-rate test: ${lines.join('; ')}` : ''
  return { ...out, note, active: lines.length > 0 }
}
