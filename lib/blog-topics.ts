import { TOPIC_PATTERN_TEXT } from '@/lib/hook-rules'
import type { SupabaseClient } from '@supabase/supabase-js'
import { callAnthropic, anthropicText, parseModelJson, isAiConfigured } from '@/lib/ai-verify'
import { findDuplicate } from '@/lib/content-dedupe'
import { nextUp, rankKeywords, type ScoreKeyword, type ScorePackage } from '@/lib/keyword-score'
import { readTrendPeaks } from '@/lib/keyword-ideas'
import { getNearMissKeywords } from '@/lib/search-console'
import { SITE_ID } from '@/lib/site'
import { getSetting, setSetting } from '@/lib/app-settings'
import { generateSlug } from '@/lib/utils'
import { isNewsSlug } from '@/lib/news-post'

// Ported from Nomad Escape Plan's modules/marketing/blog-topics.ts (Factory Phase 2:
// blog/autoblog), trimmed to what this site's own blog needs: no visa/passport material (100%
// Nomad's own domain). GSC "near-miss keyword" enrichment was deferred out of that first port on
// purpose (roadmap sort_order 1020) and ships now, in lib/search-console.ts's getNearMissKeywords.
// Kept: AI-suggested topics grounded in this site's actual packages and posts, an admin approval
// queue, and a same-keyword dedupe so the strategist never re-proposes something already live or
// already rejected.
export interface TopicIdea {
  angle: string
  keyword: string
  why: string
  source: string
  /** The keyword set the post is shooting for: primary first (same as `keyword`), then secondary phrases of
   * the same topic. Absent on ideas that are about a single phrase. */
  keywords?: string[]
  /** Set when the idea was made for one package by "Promote this package" (WP15): the writer then grounds the post
   * in that exact trip instead of guessing from the angle's words. */
  package_slug?: string | null
}

export interface BlogTopicQueueRow {
  id: string
  angle: string
  keyword: string
  why: string
  source: string
  status: 'suggested' | 'approved' | 'used' | 'rejected'
  scheduled_for: string | null
  used_slug: string | null
  used_at: string | null
  created_at: string
  /** Migration 0032 columns: null/absent on older rows or before the migration is applied. */
  keywords?: string[] | null
  cluster_id?: string | null
  title_idea?: string | null
  score?: number | null
  /** Migration 0039 column: the package an idea was made for by Promote this package. Null/absent otherwise. */
  package_slug?: string | null
}

/** The keyword set of a queue row: its `keywords` when recorded, otherwise just its one phrase. */
export function keywordSetOf(row: { keyword: string; keywords?: string[] | null }): string[] {
  const set = (row.keywords ?? []).map((k) => k.trim()).filter(Boolean)
  if (!set.length) return [row.keyword]
  return set[0].toLowerCase() === row.keyword.toLowerCase() ? set : [row.keyword, ...set]
}

// A trip-focused starting point when the AI is unconfigured or returns nothing usable. Not a
// content plan - just enough that "run autoblog now" has somewhere to land instead of failing.
const TOPIC_CLUSTERS: TopicIdea[] = [
  { angle: 'What to pack for a group trip so nobody’s the person who forgot something', keyword: 'group trip packing list', why: 'evergreen, low competition', source: 'static fallback' },
  { angle: 'How to talk your friends into finally booking the trip you keep planning', keyword: 'plan a group trip with friends', why: 'evergreen, matches our audience', source: 'static fallback' },
  { angle: 'Solo on a group trip: what it’s actually like the first time', keyword: 'solo travel group trip', why: 'evergreen, matches singles getaways', source: 'static fallback' },
  { angle: 'River cruise vs ocean cruise: which one fits your group', keyword: 'river cruise vs ocean cruise', why: 'evergreen, matches our packages', source: 'static fallback' },
]

/** Compact, real material for the AI prompt: recent post titles, live packages, and every keyword
 * already in play (queued or rejected) so it isn't re-suggested. Never invents anything - if a
 * table is empty, that section is just omitted. */
async function gatherTopicMaterial(admin: SupabaseClient): Promise<string> {
  const [{ data: posts }, { data: packages }, { data: queue }] = await Promise.all([
    admin.from('posts').select('title').order('created_at', { ascending: false }).limit(40),
    admin.from('travel_packages').select('name, destination, category, short_description, available_from, available_to').eq('status', 'published').order('created_at', { ascending: false }).limit(60),
    admin.from('blog_topic_queue').select('keyword').in('status', ['suggested', 'approved', 'used', 'rejected']).limit(200),
  ])
  const lines: string[] = []
  if (posts?.length) lines.push(`Existing blog post titles (do not repeat these angles):\n${posts.map((p: { title: string }) => `- ${p.title}`).join('\n')}`)
  if (packages?.length) {
    // short_description and dates are included so the AI grounds an angle in what's actually sold
    // (e.g. a sailing-yacht cruise, not a generic "overwater bungalow" cliche for the destination)
    // and in the real travel year - without these the model only sees name/destination/category and
    // fills the gap with plausible-sounding but wrong detail.
    const describe = (p: { name: string; category: string; short_description: string | null; available_from: string | null; available_to: string | null }) => {
      const bits = [`${p.name} (${p.category})`]
      if (p.short_description) bits.push(p.short_description)
      const year = p.available_from?.slice(0, 4) || p.available_to?.slice(0, 4)
      if (year) bits.push(`travels in ${year}`)
      return bits.join(' - ')
    }
    const byDest = new Map<string, string[]>()
    for (const p of packages as { name: string; destination: string; category: string; short_description: string | null; available_from: string | null; available_to: string | null }[]) {
      byDest.set(p.destination, [...(byDest.get(p.destination) ?? []), describe(p)])
    }
    lines.push(`Real packages we sell, by destination (use these details - never invent a detail that contradicts them):\n${[...byDest.entries()].map(([dest, names]) => `- ${dest}:\n  ${names.join('\n  ')}`).join('\n')}`)
  }
  if (queue?.length) lines.push(`Keywords already queued, used or rejected (never propose these again):\n${(queue as { keyword: string }[]).map((q) => q.keyword).join(', ')}`)

  // Found 2026-10-03: the admin's Keyword Research tool (real DataForSEO search-volume data, paid
  // for with real money) never fed into topic suggestions at all - Joel could look up and "assign"
  // a high-volume keyword to a page, but nothing downstream ever used that data to decide what to
  // write next. Surfacing the highest-volume keywords that have no real page assigned yet
  // (target_path IS NULL) gives the strategist validated search demand instead of pure guesswork,
  // the same spirit as the GSC near-miss signal below. Only ever a real recorded `volume` number -
  // never invented.
  const { data: researchedKeywords } = await admin
    .from('keyword_research')
    .select('keyword, volume')
    .eq('country', SITE_ID)
    .is('target_path', null)
    .not('volume', 'is', null)
    .order('volume', { ascending: false })
    .limit(10)
  if (researchedKeywords?.length) {
    lines.push(
      `Real search-volume data from DataForSEO, not yet assigned to any page (favour one of these when it fits a real angle - never invent a volume number, only use what's listed):\n${(researchedKeywords as { keyword: string; volume: number }[])
        .map((r) => `- ${r.keyword} (${r.volume}/mo search volume)`)
        .join('\n')}`,
    )
  }

  // Never blocks a run — Search Console being unconfigured, empty, or briefly failing just means
  // this section is omitted, same as posts/packages/queue above when their table is empty.
  const nearMiss = await getNearMissKeywords(28, 10)
  if (nearMiss.length) {
    lines.push(
      `Already ranking 5-20 in Google (a focused post here is the fastest realistic win - favour at least one of these):\n${nearMiss
        .map((r) => `- ${r.query} (position ${r.position.toFixed(1)}, ${r.impressions} impressions/28d)`)
        .join('\n')}`,
    )
  }

  return lines.join('\n\n')
}

/** Ask the model for `count` new topic ideas grounded in real site material. Returns [] when the
 * AI is unconfigured or the reply isn't usable JSON - never invents ideas from nothing. */
export async function suggestTopics(admin: SupabaseClient, opts: { count: number }): Promise<TopicIdea[]> {
  if (!isAiConfigured()) return []
  const material = await gatherTopicMaterial(admin)
  const prompt = `You suggest blog post topics for a travel agency's site (hosted group trips, river and ocean cruises, singles getaways).

${material || '(no existing posts, packages or queued keywords yet)'}

Suggest ${opts.count} NEW topic ideas. Each must be a genuinely different angle from every title and keyword listed above - do not rephrase one of them. Ground each idea in something real from the material above when possible (a destination or package we actually sell), but a general travel-planning angle is fine too. Prefer packages and destinations that have the fewest existing posts above; do not suggest a second post about a package or destination that already has one unless no other package is listed. Prefer packages whose travel year is the current or next year (${new Date().getFullYear()} or ${new Date().getFullYear() + 1}); do not write about a package whose travel dates have already passed. Never invent a specific trip, price, date or traveler story that isn't in the material.

${TOPIC_PATTERN_TEXT}

Return ONLY minified JSON of this exact shape, nothing else:
{"ideas":[{"angle":"<one-sentence post angle>","keyword":"<target search phrase, lowercase>","why":"<short reason this angle is worth writing, <100 chars>","source":"ai suggestion"}]}`

  try {
    const r = await callAnthropic({ max_tokens: 1500, messages: [{ role: 'user', content: prompt }] }, { timeoutMs: 40_000, feature: 'blog-topics' })
    if (!r || !r.res.ok) {
      const body = r ? await r.res.text().catch(() => '') : ''
      console.error('[blog-topics] suggestTopics: Anthropic call failed', r ? `status ${r.res.status}` : '(no response)', body.slice(0, 500))
      return []
    }
    const data = await r.res.json()
    const parsed = parseModelJson<{ ideas?: TopicIdea[] }>(anthropicText(data))
    if (!parsed) console.error('[blog-topics] suggestTopics: model reply was not valid JSON of the expected shape')
    const ideas = Array.isArray(parsed?.ideas) ? parsed!.ideas : []
    return ideas.filter((i) => typeof i?.angle === 'string' && typeof i?.keyword === 'string' && i.angle && i.keyword)
  } catch (err) {
    console.error('[blog-topics] suggestTopics threw:', err instanceof Error ? err.message : err)
    return []
  }
}

/** Insert ideas into the queue, skipping any whose keyword is already queued/approved OR already
 * used/rejected - the unique index only backs the queued/approved half, so without checking the
 * used/rejected statuses too a model slip could silently re-insert a keyword that was already
 * decided on. */
export async function queueIdeas(admin: SupabaseClient, ideas: TopicIdea[], status: 'suggested' | 'approved' = 'suggested'): Promise<{ queued: number }> {
  if (ideas.length === 0) return { queued: 0 }
  const { data: taken } = await admin.from('blog_topic_queue').select('keyword').in('status', ['suggested', 'approved', 'used', 'rejected'])
  const takenKeywords = new Set((taken ?? []).map((r: { keyword: string }) => r.keyword.toLowerCase()))
  const rows = ideas.filter((i) => !takenKeywords.has(i.keyword.toLowerCase())).map((i) => ({ ...i, status }))
  if (rows.length === 0) return { queued: 0 }
  const { error } = await admin.from('blog_topic_queue').insert(rows)
  if (error) throw new Error(error.message)
  return { queued: rows.length }
}

// ---- auto-approval of engine ideas (WP18-B) -------------------------------------------------------------
// The approval queue was never the bottleneck: ideas sat as "suggested" because nobody had time to click. A good
// idea (score 70+, about a trip we really sell, nothing wrong with it) is now approved by the engine itself while
// the approved-and-unused backlog is small. Everything else stays "suggested". Reject in the admin is still a veto
// (a rejected keyword is never queued again), and every auto-approval is logged so the Autopilot page can say so.
export const AUTO_APPROVE_MIN_SCORE = 70
export const AUTO_APPROVE_MAX_BACKLOG = 10
export const AUTO_APPROVE_LOG_KEY = 'blog_topics_auto_approved'
const AUTO_APPROVE_LOG_KEEP = 200

export interface AutoApproveInput {
  score: number | null | undefined
  /** The real published package the idea is about, or null/empty when it has none. */
  packageSlug: string | null | undefined
  /** Problems found by the plan checks on the final idea text. Any problem keeps the idea as "suggested". */
  blockers: string[]
}

/** Pure: may the engine approve this idea itself? `approvedUnused` is null when the backlog could not be counted
 * (fail closed: nothing is auto-approved then). */
export function autoApproveDecision(idea: AutoApproveInput, approvedUnused: number | null): { approve: boolean; reason: string } {
  if (approvedUnused === null) return { approve: false, reason: 'could not count the approved backlog' }
  if (approvedUnused >= AUTO_APPROVE_MAX_BACKLOG) return { approve: false, reason: `${approvedUnused} approved ideas are already waiting (limit ${AUTO_APPROVE_MAX_BACKLOG})` }
  if (typeof idea.score !== 'number' || !Number.isFinite(idea.score) || idea.score < AUTO_APPROVE_MIN_SCORE) return { approve: false, reason: `score is under ${AUTO_APPROVE_MIN_SCORE}` }
  if (!idea.packageSlug) return { approve: false, reason: 'no real trip to ground it in' }
  if (idea.blockers.length > 0) return { approve: false, reason: `needs a look: ${idea.blockers.join('; ')}` }
  return { approve: true, reason: `score ${idea.score}, about a real trip, no problems found` }
}

/** How many approved ideas have not been written yet, or null when it could not be counted. */
export async function countApprovedUnused(admin: SupabaseClient): Promise<number | null> {
  const { count, error } = await admin.from('blog_topic_queue').select('id', { count: 'exact', head: true }).eq('status', 'approved')
  return error ? null : (count ?? 0)
}

export interface AutoApprovalEntry {
  at: string
  keyword: string
  score: number
  reason: string
}

/** The log of ideas the engine approved by itself (newest last, capped). Empty when unreadable. */
export async function readAutoApprovals(admin: SupabaseClient): Promise<AutoApprovalEntry[]> {
  try {
    const parsed = JSON.parse((await getSetting(admin, AUTO_APPROVE_LOG_KEY)) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((e): e is AutoApprovalEntry => !!e && typeof e.at === 'string' && typeof e.keyword === 'string') : []
  } catch {
    return []
  }
}

export async function recordAutoApprovals(admin: SupabaseClient, entries: AutoApprovalEntry[]): Promise<void> {
  if (!entries.length) return
  try {
    const all = [...(await readAutoApprovals(admin)), ...entries].slice(-AUTO_APPROVE_LOG_KEEP)
    await setSetting(admin, AUTO_APPROVE_LOG_KEY, JSON.stringify(all))
  } catch {
    // the idea is approved either way; only the counter on the page would miss it
  }
}

/** Counts for the Autopilot page. */
export function summariseAutoApprovals(entries: AutoApprovalEntry[], now: number = Date.now()): { total: number; last7: number } {
  return { total: entries.length, last7: entries.filter((e) => now - Date.parse(e.at) < 7 * 86_400_000).length }
}

export async function listTopicQueue(admin: SupabaseClient): Promise<BlogTopicQueueRow[]> {
  const { data, error } = await admin.from('blog_topic_queue').select('*').order('created_at', { ascending: false }).limit(200)
  if (error) throw new Error(error.message)
  return data ?? []
}

export async function setTopicStatus(
  admin: SupabaseClient,
  id: string,
  status: BlogTopicQueueRow['status'],
  patch: { scheduled_for?: string | null; used_slug?: string | null } = {},
): Promise<void> {
  const { scheduled_for, used_slug } = patch
  const update: Record<string, unknown> = { status }
  if (scheduled_for !== undefined) update.scheduled_for = scheduled_for
  if (used_slug !== undefined) { update.used_slug = used_slug; update.used_at = new Date().toISOString() }
  const { error } = await admin.from('blog_topic_queue').update(update).eq('id', id)
  if (error) throw new Error(error.message)
}

export async function deleteTopic(admin: SupabaseClient, id: string): Promise<void> {
  const { error } = await admin.from('blog_topic_queue').delete().eq('id', id)
  if (error) throw new Error(error.message)
}

/** Approved topics whose scheduled date (if any) has arrived, oldest first. */
export async function dueApprovedTopics(admin: SupabaseClient): Promise<BlogTopicQueueRow[]> {
  const today = new Date().toISOString().slice(0, 10)
  const { data, error } = await admin
    .from('blog_topic_queue')
    .select('*')
    .eq('status', 'approved')
    .or(`scheduled_for.is.null,scheduled_for.lte.${today}`)
    .order('scheduled_for', { ascending: true, nullsFirst: true })
    .order('created_at', { ascending: true })
  if (error) throw new Error(error.message)
  return data ?? []
}

export interface PackageGrounding {
  name: string
  slug: string
  destination: string
  short_description: string | null
  full_description: string | null
  highlights: string[] | null
  available_from: string | null
  available_to: string | null
}

/** The "one post per package" wall of the autoblog run: 30 days for ordinary topics, 7 days for an idea made by Promote
 * this package, which is never thrown away by the wall but moved `rescheduleTo` (a week on) and left approved. Pure. */
export function packageWall(promoted: boolean, now: Date = new Date()): { days: number; reschedule: boolean; rescheduleTo: string } {
  return { days: promoted ? 7 : 30, reschedule: promoted, rescheduleTo: new Date(now.getTime() + 7 * 86_400_000).toISOString().slice(0, 10) }
}

/** Find the published package a topic is actually about, by checking whether the topic's angle
 * or keyword mentions the package's destination or name. Returns null when nothing matches -
 * never guesses a "closest" package, since grounding a post in the wrong product would be worse
 * than not grounding it at all. */
export async function findGroundingPackage(admin: SupabaseClient, topic: Pick<TopicIdea, 'angle' | 'keyword'> & { package_slug?: string | null }): Promise<PackageGrounding | null> {
  const { data, error } = await admin
    .from('travel_packages')
    .select('name, slug, destination, short_description, full_description, highlights, available_from, available_to')
    .eq('status', 'published')
    .limit(200)
  if (error || !data) return null
  const haystack = `${topic.angle} ${topic.keyword}`.toLowerCase()
  const rows = data as PackageGrounding[]
  // An idea made for one package by Promote this package (WP15) is grounded in exactly that package.
  if (topic.package_slug) {
    const exact = rows.find((p) => p.slug === topic.package_slug)
    if (exact) return exact
  }
  return (
    rows.find((p) => {
      const dest = p.destination?.toLowerCase()
      const name = p.name?.toLowerCase()
      return (!!dest && haystack.includes(dest)) || (!!name && haystack.includes(name))
    }) ?? null
  )
}

/** Fold a matched package's real facts into the angle text handed to composeFullPost, so its
 * AI steps (which only ever see `angle`, not the DB) can't contradict the actual product. Returns
 * the angle unchanged when no package matched - composeFullPost still works for general
 * travel-advice topics, it just isn't grounded in a specific package. Never invents a detail: only
 * facts already on the `pkg` row are included. */
export function groundAngleInPackage(angle: string, pkg: PackageGrounding | null): string {
  if (!pkg) return angle
  const facts: string[] = [`Real package being promoted: "${pkg.name}" (${pkg.destination}).`]
  if (pkg.short_description) facts.push(`What it actually is: ${pkg.short_description}`)
  if (pkg.highlights?.length) facts.push(`Its real stops/highlights (do not invent different ones): ${pkg.highlights.join(', ')}`)
  if (pkg.available_from || pkg.available_to) facts.push(`Its real travel dates: ${pkg.available_from ?? 'unknown'} to ${pkg.available_to ?? 'unknown'}`)
  facts.push('Name this real package by name in the post and use only these real stops/dates/details - never invent a different itinerary, stop list, or date range.')
  return `${angle}\n\n${facts.join(' ')}`
}


// ---- topic conflicts and diversity (loop-blog-quality) ----------------------------------------------------
// The editor audit found three Cologne-to-Basel posts, two Puerto Plata, three Croatia and three solo-traveller posts among
// ten. The old check compared a topic's angle text with post TITLES only. These rules compare the keyword and the trip against
// EVERY post. They are pure; autoblog-run reads the posts and applies the verdict ('duplicate' is dropped for good, 'defer' waits).

export const SAME_TRIP_WALL_DAYS = 45
export const SOLO_WALL_DAYS = 14
export const DESTINATION_WALL_DAYS = 30
export const DESTINATION_MAX_IN_WALL = 2

/** What the rules need to know about a post already written (published or draft). */
export interface PostFact {
  slug: string
  title: string
  primary_keyword?: string | null
  secondary_keywords?: string[] | null
  tags?: string[] | null
  body?: string | null
  publish_date?: string | null
  created_at?: string | null
  related_package_id?: string | null
}

/** What the rules need to know about the topic about to be written. */
export interface TopicFacts {
  angle: string
  keyword: string
  keywords?: string[]
  /** The real package the topic is grounded in, when there is one. */
  packageSlug?: string | null
  /** The destination slug of that package (see generateSlug), when known. */
  destinationSlug?: string | null
}

export interface TopicConflict {
  /** 'duplicate': drop the topic for good. 'defer': try again on `until` (YYYY-MM-DD). */
  kind: 'duplicate' | 'defer'
  reason: string
  until?: string
}

const TOPIC_STOP = new Set(['a', 'an', 'the', 'to', 'for', 'of', 'in', 'on', 'and', 'or', 'vs', 'with', 'what', 'how', 'is', 'are', 'do', 'does', 'your', 'you', 'my', 'our', 'from', 'about', 'at', 'it', 'be', 'can', 'should'])
/** Words that describe the kind of post, not what it is about: never the "primary noun". */
const TOPIC_GENERIC = new Set(['trip', 'trips', 'travel', 'travelling', 'traveling', 'guide', 'tips', 'tip', 'first', 'time', 'timers', 'best', 'group', 'vacation', 'holiday', 'package', 'packages', 'worth', 'booking', 'book', 'plan', 'planning', 'need', 'know', 'things', 'ideas', 'complete', 'beginner', 'beginners'])

const topicTokens = (s: string): string[] => s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !TOPIC_STOP.has(w))

/** The nouns a keyword is really about (no stop words, no post-kind words), as 5-letter stems. Pure. */
export function primaryNounsOf(keyword: string): string[] {
  return [...new Set(topicTokens(keyword).filter((w) => !TOPIC_GENERIC.has(w)).map((w) => w.slice(0, 5)))]
}

const ROUTE_NOT_PLACE = new Set(['how', 'way', 'ways', 'time', 'want', 'need', 'ready', 'going', 'back', 'close', 'next', 'safe', 'easy', 'best', 'tips', 'things', 'what', 'where', 'when', 'why', 'trip', 'travel', 'plan', 'guide', 'able', 'used', 'prepare', 'listen', 'talk', 'say', 'been', 'due', 'key', 'right', 'ideas', 'reasons', 'steps', 'solo', 'add', 'adds', 'tell', 'ask', 'look', 'guests', 'travelers', 'travellers', 'everything', 'something', 'anything', 'nothing', 'the', 'a', 'an', 'your', 'you', 'book', 'make', 'see', 'know', 'pick', 'choose', 'visit', 'get', 'have', 'avoid', 'take', 'find', 'decide', 'pack', 'enjoy', 'join', 'start', 'go', 'be', 'do', 'worth', 'help', 'keep', 'bring', 'try', 'check', 'compare', 'save', 'spend', 'stay', 'skip', 'expect', 'understand', 'consider', 'choose'])

/** "Cologne to Basel" in any text (any capitalisation), as "cologne>basel", or null. Pure. */
export function routeKeyOf(text: string): string | null {
  for (const m of text.matchAll(/\b([a-z]{3,})\s+(?:to|and|-)\s+([a-z]{3,})\b/gi)) {
    const a = m[1].toLowerCase()
    const b = m[2].toLowerCase()
    if (ROUTE_NOT_PLACE.has(a) || ROUTE_NOT_PLACE.has(b)) continue
    // Title Case or a lower-case keyword: both words must look like names (no trailing "ing"/"ed" verbs).
    if (/(?:ing|ed)$/.test(a) || /(?:ing|ed)$/.test(b)) continue
    return `${a}>${b}`
  }
  return null
}

/** True when a text is a solo-traveller angle. Pure. */
export const isSoloAngle = (text: string): boolean => /\bsolo\b|\btravell?ing alone\b|\bon your own\b|\bsingle travell?ers?\b|\bgoing alone\b/i.test(text)

const dayMs = 86_400_000
const dateOf = (p: PostFact): number => {
  const ms = Date.parse(p.publish_date || p.created_at || '')
  return Number.isFinite(ms) ? ms : 0
}
const addDays = (ms: number, days: number): string => new Date(ms + days * dayMs).toISOString().slice(0, 10)
const packageSlugsIn = (body: string): string[] => [...body.matchAll(/\/packages\/([a-z0-9][a-z0-9-]*)/gi)].map((m) => m[1].toLowerCase())
const destinationSlugsIn = (body: string): string[] => [...body.matchAll(/\/destinations\/([a-z0-9][a-z0-9-]*)/gi)].map((m) => m[1].toLowerCase())

const tokenOverlap = (a: string[], b: string[]): number => {
  const A = new Set(a)
  const B = new Set(b)
  if (!A.size || !B.size) return 0
  let shared = 0
  for (const t of A) if (B.has(t)) shared++
  return shared / Math.min(A.size, B.size)
}

/** The first post whose primary or secondary keyword is the same search as `keyword` (80% of the words shared, both ways round). Pure. */
export function postWithSameKeyword(keyword: string, posts: PostFact[]): PostFact | null {
  const t = topicTokens(keyword)
  if (t.length < 2) return null
  return posts.find((p) => [p.primary_keyword, ...(p.secondary_keywords ?? [])].some((k) => !!k && tokenOverlap(t, topicTokens(k)) >= 0.8 && Math.abs(topicTokens(k).length - t.length) <= 1)) ?? null
}

/** The rules, in order: same keyword (drop), same trip and noun within 45 days (wait), one solo angle per 14 days (wait), two posts
 * per destination per 30 days (wait). `packageDest` maps a package slug to its destination slug. `now` is injected for tests. Pure. */
export function topicConflict(topic: TopicFacts, posts: PostFact[], opts: { now?: Date; packageDest?: Map<string, string> } = {}): TopicConflict | null {
  const now = (opts.now ?? new Date()).getTime()
  const packageDest = opts.packageDest ?? new Map<string, string>()
  const keywords = [...new Set([topic.keyword, ...(topic.keywords ?? [])].filter(Boolean))]

  for (const k of keywords.slice(0, 1)) {
    const same = postWithSameKeyword(k, posts)
    if (same) return { kind: 'duplicate', reason: `the keyword "${k}" is already the target of the post "${same.title}"` }
  }

  const topicText = `${topic.angle} ${topic.keyword}`
  const topicRoute = routeKeyOf(topicText)
  const nouns = primaryNounsOf(topic.keyword)
  const tripOf = (p: PostFact): { slugs: string[]; route: string | null } => ({ slugs: packageSlugsIn(p.body ?? ''), route: routeKeyOf(`${p.title} ${p.primary_keyword ?? ''}`) })
  const newest = (list: PostFact[]) => list.reduce((m, p) => Math.max(m, dateOf(p)), 0)

  // Same trip (its package page, or the same "A to B" route) and the same primary noun, within 45 days.
  const sameTrip = posts.filter((p) => {
    if (now - dateOf(p) > SAME_TRIP_WALL_DAYS * dayMs) return false
    const t = tripOf(p)
    const tripMatch = (!!topic.packageSlug && t.slugs.includes(topic.packageSlug.toLowerCase())) || (!!topicRoute && t.route === topicRoute)
    if (!tripMatch) return false
    const postNouns = primaryNounsOf(`${p.primary_keyword ?? ''} ${p.title}`)
    return nouns.length === 0 || nouns.some((n) => postNouns.includes(n))
  })
  if (sameTrip.length) return { kind: 'defer', reason: `"${sameTrip[0].title}" already covers this trip and subject in the last ${SAME_TRIP_WALL_DAYS} days`, until: addDays(newest(sameTrip), SAME_TRIP_WALL_DAYS + 1) }

  if (isSoloAngle(topicText)) {
    const solo = posts.filter((p) => now - dateOf(p) <= SOLO_WALL_DAYS * dayMs && isSoloAngle(`${p.title} ${p.primary_keyword ?? ''} ${(p.tags ?? []).join(' ')}`))
    if (solo.length >= 1) return { kind: 'defer', reason: `a solo-traveller post ("${solo[0].title}") went out in the last ${SOLO_WALL_DAYS} days; one per ${SOLO_WALL_DAYS} days`, until: addDays(newest(solo), SOLO_WALL_DAYS + 1) }
  }

  const dest = (topic.destinationSlug ?? '').toLowerCase()
  if (dest) {
    const inDest = posts.filter((p) => {
      if (now - dateOf(p) > DESTINATION_WALL_DAYS * dayMs) return false
      const slugs = packageSlugsIn(p.body ?? '')
      return destinationSlugsIn(p.body ?? '').includes(dest) || slugs.some((s) => packageDest.get(s) === dest)
    })
    if (inDest.length >= DESTINATION_MAX_IN_WALL) {
      const oldest = inDest.reduce((m, p) => Math.min(m, dateOf(p)), Number.MAX_SAFE_INTEGER)
      return { kind: 'defer', reason: `${inDest.length} posts about ${dest} went out in the last ${DESTINATION_WALL_DAYS} days (at most ${DESTINATION_MAX_IN_WALL})`, until: addDays(oldest, DESTINATION_WALL_DAYS + 1) }
    }
  }
  return null
}

/** Reads every post (published and draft, the retired ones left out by the caller) and the package-to-destination map, then applies
 * topicConflict. FAILS OPEN: if a read fails the topic is not blocked here (the 30-day package wall and the title check still apply). */
export async function checkTopicConflict(admin: SupabaseClient, topic: TopicFacts, opts: { retired?: Set<string>; now?: Date } = {}): Promise<TopicConflict | null> {
  try {
    const [{ data: posts, error }, { data: pk }] = await Promise.all([
      admin.from('posts').select('slug, title, primary_keyword, secondary_keywords, tags, body, publish_date, created_at, related_package_id').limit(500),
      admin.from('travel_packages').select('slug, destination').limit(300),
    ])
    if (error || !posts) return null
    const packageDest = new Map<string, string>(((pk ?? []) as { slug: string; destination: string | null }[]).filter((p) => p.slug && p.destination).map((p) => [p.slug.toLowerCase(), generateSlug(p.destination as string)]))
    const facts = (posts as PostFact[]).filter((p) => !opts.retired?.has(p.slug) && !isNewsSlug(p.slug))
    return topicConflict(topic, facts, { now: opts.now, packageDest })
  } catch {
    return null
  }
}

// ---- Search Console support (gsc_rankings, striking distance first) -----------------------------------------

export interface GscQuery {
  key: string
  position: number
  impressions: number
}

/** Positions that are close enough to page one that one focused post can move them. */
export const STRIKING_MIN = 8
export const STRIKING_MAX = 20

/** The last 28 days of query rows from gsc_rankings, one row per query (impression-weighted position). [] on any failure or an empty table. */
export async function readGscQueries(admin: SupabaseClient, now: Date = new Date()): Promise<GscQuery[]> {
  try {
    const since = new Date(now.getTime() - 28 * dayMs).toISOString().slice(0, 10)
    const { data, error } = await admin.from('gsc_rankings').select('key, position, impressions').eq('kind', 'query').gte('day', since).limit(5000)
    if (error || !data) return []
    const by = new Map<string, { imp: number; weighted: number; n: number; plain: number }>()
    for (const r of data as { key: string; position: number | string; impressions: number | string }[]) {
      const pos = Number(r.position)
      const imp = Number(r.impressions) || 0
      if (!r.key || !Number.isFinite(pos)) continue
      const cur = by.get(r.key) ?? { imp: 0, weighted: 0, n: 0, plain: 0 }
      cur.imp += imp
      cur.weighted += pos * Math.max(imp, 1)
      cur.n += Math.max(imp, 1)
      cur.plain += pos
      by.set(r.key, cur)
    }
    return [...by.entries()].map(([key, v]) => ({ key, position: v.weighted / v.n, impressions: v.imp }))
  } catch {
    return []
  }
}

/** How well Search Console supports a topic: the best matching query (80% of the words shared) by striking distance, then by impressions. Pure. */
export function gscSupport(keywords: string[], rows: GscQuery[]): { impressions: number; position: number | null; striking: boolean } {
  let best: GscQuery | null = null
  for (const k of keywords) {
    const t = topicTokens(k)
    if (t.length === 0) continue
    for (const r of rows) {
      if (tokenOverlap(t, topicTokens(r.key)) < 0.8) continue
      const strike = (q: GscQuery) => q.position >= STRIKING_MIN && q.position <= STRIKING_MAX
      if (!best || (strike(r) && !strike(best)) || (strike(r) === strike(best) && r.impressions > best.impressions)) best = r
    }
  }
  if (!best) return { impressions: 0, position: null, striking: false }
  return { impressions: best.impressions, position: best.position, striking: best.position >= STRIKING_MIN && best.position <= STRIKING_MAX }
}

/** Reorders candidates so topics Search Console supports come first: striking-distance ones (position 8 to 20), then other topics with
 * impressions, then the rest. The order inside each group is kept. With no rows the list is returned unchanged. Pure. */
export function rankByGsc<T extends { keyword: string; keywords?: string[] | null }>(items: T[], rows: GscQuery[]): T[] {
  if (rows.length === 0) return items
  const rank = (it: T): number => {
    const s = gscSupport([it.keyword, ...(it.keywords ?? [])], rows)
    return s.striking ? 0 : s.impressions > 0 ? 1 : 2
  }
  return items
    .map((it, i) => ({ it, i, r: rank(it), imp: gscSupport([it.keyword, ...(it.keywords ?? [])], rows).impressions }))
    .sort((a, b) => a.r - b.r || b.imp - a.imp || a.i - b.i)
    .map((x) => x.it)
}

/** KEYWORD FIRST: the next blog post is about the best-scoring usable researched keyword (lib/keyword-score.ts:
 * winnability, demand, intent and timing, gated to trips we really sell and phrases nothing covers yet),
 * skipping any whose trip already has a post in the last 30 days so a pass is not wasted. Near-duplicate
 * phrases ride along as secondary phrases of the same post. Returns null when nothing qualifies, and the
 * caller falls back to an AI-chosen topic. Once the post is written the caller connects the main phrase to
 * it, so it is not picked again. */
export async function pickKeywordTopic(admin: SupabaseClient, existing: { title: string; primary_keyword?: string | null; secondary_keywords?: string[] | null }[]): Promise<TopicIdea | null> {
  const [{ data: rows }, { data: pk }] = await Promise.all([
    admin.from('keyword_research').select('keyword, volume, cpc, competition, gsc_impressions, gsc_position, target_path, note').eq('country', SITE_ID),
    admin.from('travel_packages').select('slug, name, destination, available_from, available_to').eq('status', 'published'),
  ])
  if (!rows?.length || !pk?.length) return null
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString()
  const peaks = await readTrendPeaks(admin)
  // Phrases already inside a waiting idea's keyword set belong to that idea (an engine idea may be approved
  // any time), so they are not picked a second time. Falls back to the single keyword column before 0032.
  const open = await admin.from('blog_topic_queue').select('keyword, keywords').in('status', ['suggested', 'approved']).limit(500)
  const openRows = (open.error ? ((await admin.from('blog_topic_queue').select('keyword').in('status', ['suggested', 'approved']).limit(500)).data ?? []) : (open.data ?? [])) as { keyword: string; keywords?: string[] | null }[]
  const inQueue = new Set(openRows.flatMap((q) => [q.keyword, ...(q.keywords ?? [])]).map((k) => k.toLowerCase()))
  for (const c of nextUp(rankKeywords(rows as ScoreKeyword[], pk as ScorePackage[], new Date(), peaks), 12)) {
    if (findDuplicate(c.keyword, existing)) continue
    // loop-blog-quality: also the same search as a post's primary or secondary keyword, not only its title.
    if (postWithSameKeyword(c.keyword, existing.map((e) => ({ slug: '', title: e.title, primary_keyword: e.primary_keyword, secondary_keywords: e.secondary_keywords })))) continue
    if ([c.keyword, ...c.secondary].some((k) => inQueue.has(k.toLowerCase()))) continue
    if (c.packageSlug) {
      const { count, error } = await admin.from('posts').select('id', { count: 'exact', head: true }).gte('created_at', since).ilike('body', `%/packages/${c.packageSlug}%`)
      if (error || (count ?? 0) > 0) continue
    }
    const also = c.secondary.length ? ` Also work in these related searches: ${c.secondary.slice(0, 4).join(', ')}.` : ''
    const angle = `A blog post that answers the search "${c.keyword}" for someone deciding whether and which trip to book with us.${also}`
    return { angle, keyword: c.keyword, keywords: [c.keyword, ...c.secondary.slice(0, 5)], why: `Keyword score ${c.score}/100 (winnability ${c.parts.winnability}, demand ${c.parts.demand}, intent ${c.parts.intent}, timing ${c.parts.timing})${c.packageName ? `, about "${c.packageName}"` : ''}`, source: 'keyword research' }
  }
  return null
}

/** Remember that a keyword could not be used right now, so the next pass moves on to the next one. */
export async function markKeywordSkipped(admin: SupabaseClient, keyword: string, reason: string): Promise<void> {
  await admin
    .from('keyword_research')
    .update({ note: `skipped ${new Date().toISOString().slice(0, 10)}: ${reason}`, updated_at: new Date().toISOString() })
    .eq('keyword', keyword)
    .eq('country', SITE_ID)
    .is('target_path', null)
}

/** No admin-approved topic due today: ask the AI for one fresh idea not already covered, falling
 * back to a static cluster only if the AI is unconfigured or returns nothing. Never blocks a run
 * on human approval - approval gates the *queue*, not whether autoblog can write anything at all. */
export async function pickOneTopic(admin: SupabaseClient, existingPostTitles: string[]): Promise<TopicIdea | null> {
  const ideas = await suggestTopics(admin, { count: 3 })
  const notDuplicate = ideas.filter((i) => !findDuplicate(i.angle, existingPostTitles.map((title) => ({ title }))))
  // loop-blog-quality: among the fresh ideas, the one Search Console already supports (striking distance first). Fails open.
  const fresh = rankByGsc(notDuplicate, await readGscQueries(admin))[0]
  if (fresh) return fresh
  const usedClusters = new Set((await admin.from('blog_topic_queue').select('keyword').eq('status', 'used')).data?.map((r: { keyword: string }) => r.keyword) ?? [])
  return TOPIC_CLUSTERS.find((c) => !usedClusters.has(c.keyword)) ?? TOPIC_CLUSTERS[0] ?? null
}
