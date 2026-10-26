import type { SupabaseClient } from '@supabase/supabase-js'
import { getSetting, setSetting } from '@/lib/app-settings'
import { decision, policyGate, appendDecisions, readVetoes, isVetoedIn, type AutoDecision } from '@/lib/auto-decisions'
import { getDistributionMode } from '@/lib/distribution'
import { resolveIssue } from '@/lib/issues'
import { NETWORK_PAUSE_HOURS, pausedNow, readPauses, writePauses } from '@/lib/network-pause'
import { AUTO_APPROVE_MAX_BACKLOG, countApprovedUnused, gscSupport, rankByGsc, readGscQueries, setTopicStatus, topicConflict, type GscQuery, type PostFact, type TopicFacts } from '@/lib/blog-topics'
import { findDuplicate } from '@/lib/content-dedupe'
import { generateSlug } from '@/lib/utils'
import { isNewsSlug, newsHeadlineOf, parseNewsBody, trustedHeadline } from '@/lib/news-post'
import { SITE_ID, SITE_URL } from '@/lib/site'
import { AUTO_HOLD_PREFIX, CAPTION_FAILED_PREFIX, guideCaptionProblems, readReleaseHours } from '@/lib/guide-release'
import { guideFromPath, loadGuidePostSource, packageSlugFromPath } from '@/lib/guide-post-source'
import { getTripSocialEnabled, tripReleaseProblems, type TripSocialPackage } from '@/lib/trip-social'
import { isGuessedPropertyNote } from '@/lib/guide-run'
import { gateComposedCover } from '@/lib/cover-gate'
import { getNewsMode, getNewsPerDay, getNewsSocialEnabled } from '@/lib/news-settings'
import { claimNewsSlot, countToday, itemStale } from '@/lib/news-run'
import { publishQueuedDraft } from '@/lib/news-publish'
import { briefProblems, isAttributed, lexicalProblems, type BriefOutcome, type NewsBrief, type NewsFacts } from '@/lib/news-brief'
import { classifyItem, isNhcSource } from '@/lib/news-relevance'
import { sourceByKey } from '@/lib/news-sources'
import { isTemplateBrief } from '@/lib/news-nhc'
import { isUkFcdoSource, isUkTemplateBrief } from '@/lib/news-uk'
import { isCaAdvisorySource, isCaTemplateBrief } from '@/lib/news-ca'
import { enrollNewsIfDue } from '@/lib/news-distribution'
import { pingIndexNow } from '@/lib/indexnow'
import type { NewsItemRow } from '@/lib/news-ingest'

// The four automatic decisions the owner approved. Every one is a PURE verdict function (tested offline with allow and deny tables)
// plus a small runner that reads the data, asks the verdict, acts through an existing code path, and writes the log line with an Undo.
// The runners are called from the existing 15-minute pipeline (lib/pipeline.ts); there is no new schedule.
// Common rules (lib/auto-decisions.ts): the master pause, a per-policy switch, a per-day cap, and anything a person turned down is
// never touched. Nothing here calls an AI model or posts anything itself: a retry only puts a row back in the queue, and the normal
// send code does the rest.

const HOUR = 3_600_000
const MINUTE = 60_000

// ---------------------------------------------------------------------------------------------------
// Error classification (policy 1)
// ---------------------------------------------------------------------------------------------------

export type ErrorClass = 'self-fixable' | 'ambiguous' | 'needs-person'

/** Things a retry cannot fix: sign-in and setup problems, and a network or service refusing the content itself (a 4xx). */
const NEEDS_PERSON =
  /\b(401|403|400|404|409|410|413|415|422)\b|unauthori[sz]ed|forbidden|api key|token|expired|reconnect|credential|permission|not (set|configured|connected)|no (accounts?|profile)|none of your selected|no longer (published|live)|access denied|invalid|rejected|not allowed|violat|duplicate|too (long|large|big)|unsupported|policy|spam|blocked|banned|suspend|community guidelines|does not support|aspect ratio|resolution/i
/** Might already have posted (a timeout, a 500, an unconfirmed send): a retry could post it twice, so a person checks. */
const AMBIGUOUS = /time(d)?[ -]?out|\b(408|500|504)\b|did not confirm|has not confirmed|not confirmed|no record/i
/** Things that usually pass by themselves: a busy service, a rate limit, a dropped connection, a check that could not run yet. */
const SELF_FIXABLE =
  /\b(429|502|503)\b|rate.?limit|too many requests|temporar|try again|service unavailable|bad gateway|econnreset|econnrefused|enotfound|socket hang up|fetch failed|network (error|request)|could not be (checked|reached)|unreachable|overloaded|did not finish|could not (generate|write)/i

/** One failed network in a send error reads "network: message", joined with "; ". */
const splitSegments = (text: string): string[] => text.split(/;\s+(?=[a-z][a-z/ ]*:\s)/i).map((x) => x.trim()).filter(Boolean)
const TIKTOK_TITLE_SEGMENT = /^[a-z/ ]*tiktok[a-z/ ]*:\s*tiktok title is too long/i
/** A network that cannot post until a person sets it up once (Pinterest needs a board chosen in GoHighLevel). */
const NEEDS_SETUP_SEGMENT = /^pinterest\s*:\s*pinterest board id is required/i

/** The error without the parts the send path now repairs by itself. Pure. */
export function withoutRepairedSegments(text: string): string {
  return splitSegments(text).filter((seg) => !TIKTOK_TITLE_SEGMENT.test(seg)).join('; ')
}

/** Networks named in the error that need a one-time setup, and the error without them. Pure. */
export function splitSetupBlocked(text: string | null | undefined): { blocked: string[]; rest: string } {
  const segs = splitSegments((text ?? '').trim())
  const blocked = segs.filter((seg) => NEEDS_SETUP_SEGMENT.test(seg)).map((seg) => seg.split(':')[0].trim().toLowerCase())
  return { blocked, rest: segs.filter((seg) => !NEEDS_SETUP_SEGMENT.test(seg)).join('; ') }
}

/** Sorts a send or step error into: a retry will probably fix it, it may already have posted, or a person must look. Unknown text is
 * treated as needing a person (never guess in favour of posting twice). Pure. */
export function classifySendError(text: string | null | undefined): { cls: ErrorClass; why: string } {
  const raw = (text ?? '').trim()
  if (!raw) return { cls: 'needs-person', why: 'no reason was recorded' }
  // A TikTok title over 90 is repaired at send time (lib/ghl-social.ts fitTikTokTitle), so a retry passes. Segments the code now repairs are taken out first.
  const t = withoutRepairedSegments(raw)
  if (!t) return { cls: 'self-fixable', why: 'the TikTok title is now shortened to 90 before sending, so a retry passes' }
  if (NEEDS_PERSON.test(t)) return { cls: 'needs-person', why: 'a retry cannot fix this (sign-in, setup or the network refused the content)' }
  if (AMBIGUOUS.test(t)) return { cls: 'ambiguous', why: 'it may already have been posted, so a person should check before it is sent again' }
  if (SELF_FIXABLE.test(t)) return { cls: 'self-fixable', why: 'a temporary problem that usually passes by itself' }
  return { cls: 'needs-person', why: 'the reason is not one that is known to pass by itself' }
}

// ---------------------------------------------------------------------------------------------------
// Policy 1: retry failed posts and resume stuck steps
// ---------------------------------------------------------------------------------------------------

/** How long a failed post waits before the 1st, 2nd and 3rd automatic retry (from the time it last failed). */
export const RETRY_WAITS_MS: readonly number[] = [15 * MINUTE, 2 * HOUR, 12 * HOUR]
export const MAX_AUTO_RETRIES = RETRY_WAITS_MS.length
/** A network that needs a one-time setup is left out this long (NETWORK_PAUSE_HOURS is the watchdog's 24-hour pause). */
export const SETUP_PAUSE_HOURS = Math.max(NETWORK_PAUSE_HOURS, 7 * 24)
/** A failed carousel or video step must be this old before it is resumed (once). */
export const STUCK_STEP_HOURS = 2
export const RETRY_STATE_KEY = 'auto_retry_state'

export interface FailedPostRow {
  slug: string
  stage: string
  last_error: string | null
  sent_platforms: string[] | null
  updated_at: string
}

export type RetryVerdict =
  | { act: 'retry'; n: number; why: string }
  | { act: 'wait'; why: string }
  | { act: 'card'; why: string }
  | { act: 'skip'; why: string }

/** Should this failed post row be put back in the queue now? `n` is how many automatic retries it has had. Pure. */
export function postRetryVerdict(row: FailedPostRow, n: number, now: Date, vetoed: boolean): RetryVerdict {
  if (vetoed) return { act: 'skip', why: 'a person undid an automatic retry of this post' }
  if (row.stage !== 'failed') return { act: 'skip', why: `the post is ${row.stage}, not failed` }
  const sent = row.sent_platforms ?? []
  if (sent.length > 0) return { act: 'card', why: `it already reached ${sent.join(', ')}, so a retry could post it there twice; check which network is missing` }
  const c = classifySendError(row.last_error)
  if (c.cls !== 'self-fixable') return { act: 'card', why: c.why }
  if (n >= MAX_AUTO_RETRIES) return { act: 'card', why: `${MAX_AUTO_RETRIES} automatic retries did not fix it` }
  const waitMs = RETRY_WAITS_MS[n]
  const since = now.getTime() - Date.parse(row.updated_at)
  if (!Number.isFinite(since)) return { act: 'skip', why: 'the failure time is not readable' }
  if (since < waitMs) return { act: 'wait', why: `waiting ${Math.round(waitMs / MINUTE)} minutes since it failed` }
  return { act: 'retry', n: n + 1, why: `${c.why}; retry ${n + 1} of ${MAX_AUTO_RETRIES}, nothing has been posted yet` }
}

export interface FailedStepRow {
  slug: string
  part: 'carousel' | 'video'
  last_error: string | null
  updated_at: string
  /** Networks this step already reached (carousel_sent or video_sent). */
  sent: string[] | null
}

/** Should this failed carousel or video step be resumed now (once)? A video is only resumed when it never rendered (a retry of a
 * rendered video would spend render credit again). `n` is how many automatic resumes it has had. Pure. */
export function stepResumeVerdict(row: FailedStepRow, n: number, now: Date, vetoed: boolean): RetryVerdict {
  if (vetoed) return { act: 'skip', why: 'a person undid an automatic resume of this step' }
  if ((row.sent ?? []).length > 0) return { act: 'card', why: `the ${row.part} already reached ${(row.sent ?? []).join(', ')}, so it was not resumed (it could post twice)` }
  const c = classifySendError(row.last_error)
  if (c.cls !== 'self-fixable') return { act: 'card', why: c.why }
  if (row.part === 'video' && !/did not finish|could not write/i.test(row.last_error ?? '')) return { act: 'card', why: 'a video retry spends render credit, so only a person restarts it unless it never finished rendering' }
  if (n >= 1) return { act: 'card', why: 'it was already resumed once and failed again' }
  const age = now.getTime() - Date.parse(row.updated_at)
  if (!Number.isFinite(age)) return { act: 'skip', why: 'the failure time is not readable' }
  if (age < STUCK_STEP_HOURS * HOUR) return { act: 'wait', why: `waiting ${STUCK_STEP_HOURS} hours since it stopped` }
  return { act: 'retry', n: 1, why: `${c.why}; resumed once, ${Math.round(age / HOUR)} hours after it stopped` }
}

interface RetryState {
  retries: Record<string, { n: number; at: string }>
  carded: Record<string, string>
}

function parseRetryState(raw: string | null): RetryState {
  try {
    const v = JSON.parse(raw ?? '{}') as Partial<RetryState> | null
    return { retries: v && typeof v.retries === 'object' && v.retries ? v.retries : {}, carded: v && typeof v.carded === 'object' && v.carded ? v.carded : {} }
  } catch {
    return { retries: {}, carded: {} }
  }
}

const newest = <T extends Record<string, { at?: string } | string>>(m: T, keep: number): T => {
  const stamp = (v: { at?: string } | string) => (typeof v === 'string' ? v : v.at ?? '')
  return Object.fromEntries(Object.entries(m).sort((a, b) => stamp(a[1]).localeCompare(stamp(b[1]))).slice(-keep)) as T
}

export interface RunResult {
  /** Rows changed. */
  acted: number
  note: string
  decisions: AutoDecision[]
}

export interface RetryDeps {
  retryPost?: (slug: string) => Promise<string | null>
  retryStep?: (part: 'carousel' | 'video', slug: string) => Promise<string | null>
}

/** Runs policy 1. Never throws. */
export async function runRetryFailedPosts(admin: SupabaseClient, now: Date = new Date(), deps: RetryDeps = {}): Promise<RunResult> {
  const out: RunResult = { acted: 0, note: '', decisions: [] }
  try {
    const gate = await policyGate(admin, 'retry_failed_posts', now)
    if (!gate.allowed) return { ...out, note: gate.reason }
    const retryPost = deps.retryPost ?? ((slug: string) => resolveIssue(admin, 'retry-post', slug))
    const retryStep = deps.retryStep ?? ((part: 'carousel' | 'video', slug: string) => resolveIssue(admin, part === 'video' ? 'retry-video' : 'retry-carousel', slug))
    let room = gate.room
    const state = parseRetryState(await getSetting(admin, RETRY_STATE_KEY))
    const vetoes = await readVetoes(admin)
    let dirty = false
    const log: AutoDecision[] = []
    const card = (subject: string, title: string, why: string) => {
      if (state.carded[subject]) return
      state.carded[subject] = now.toISOString()
      dirty = true
      log.push(decision('retry_failed_posts', subject, `Needs Joel: ${title}`, why, null, now))
    }

    // Failed social posts. Only in auto mode (a held review mode must never post by itself).
    if ((await getDistributionMode(admin)) === 'auto') {
      const { data } = await admin.from('post_distribution').select('slug, stage, last_error, sent_platforms, updated_at').eq('content_type', 'post').eq('stage', 'failed').order('updated_at', { ascending: true }).limit(30)
      let pauses = await readPauses(admin)
      for (const row of (data ?? []) as FailedPostRow[]) {
        // A network that needs a one-time setup (Pinterest board) is paused for a week so posts stop failing on it; the post is judged on the rest.
        const setup = splitSetupBlocked(row.last_error)
        for (const net of setup.blocked) {
          if (!pauses || pausedNow(pauses, now).includes(net)) continue
          pauses[net] = { until: new Date(now.getTime() + SETUP_PAUSE_HOURS * HOUR).toISOString(), since: now.toISOString(), strikes: (pauses[net]?.strikes ?? 0) + 1 }
          if ((await writePauses(admin, pauses)).error) { pauses = null; break }
          dirty = true
          log.push(decision('retry_failed_posts', net, `Paused ${net} for ${SETUP_PAUSE_HOURS / 24} days`, `${net} refuses every post until it is set up once (Pinterest: choose a board in the GoHighLevel Social Planner). Other networks keep posting. Setup is on the setup checklist.`, { kind: 'unpause-network', ref: net }, now))
        }
        const n = state.retries[row.slug]?.n ?? 0
        const judged = setup.blocked.length && pauses ? { ...row, last_error: setup.rest || null } : row
        const v = postRetryVerdict(judged, n, now, isVetoedIn(vetoes, 'retry_failed_posts', row.slug))
        if (v.act === 'card') card(row.slug, `the post "${row.slug}" failed`, v.why)
        if (v.act !== 'retry' || room <= 0) continue
        const err = await retryPost(row.slug)
        if (err) continue
        state.retries[row.slug] = { n: v.n, at: now.toISOString() }
        dirty = true
        room--
        out.acted++
        log.push(decision('retry_failed_posts', row.slug, 'Put the failed post back in the posting queue', v.why, { kind: 'requeue-post', ref: row.slug }, now))
      }
    }

    // Stuck carousel and video steps (failed, waiting for a person who never came). Resumed once.
    const since = new Date(now.getTime() - 7 * 86_400_000).toISOString()
    const steps: FailedStepRow[] = []
    for (const part of ['carousel', 'video'] as const) {
      const { data } = await admin.from('content_pipeline').select('*').eq(`${part}_stage`, 'failed').gte('created_at', since).limit(20)
      for (const r of (data ?? []) as Array<Record<string, unknown>>) {
        steps.push({ slug: String(r.slug), part, last_error: (r.last_error as string | null) ?? null, updated_at: String(r.updated_at), sent: (r[`${part}_sent`] as string[] | null) ?? null })
      }
    }
    for (const s of steps) {
      const subject = `${s.slug}:${s.part}`
      const n = state.retries[subject]?.n ?? 0
      const v = stepResumeVerdict(s, n, now, isVetoedIn(vetoes, 'retry_failed_posts', subject))
      if (v.act === 'card') card(subject, `the ${s.part} for "${s.slug}" is stuck`, v.why)
      if (v.act !== 'retry' || room <= 0) continue
      const err = await retryStep(s.part, s.slug)
      if (err) continue
      state.retries[subject] = { n: v.n, at: now.toISOString() }
      dirty = true
      room--
      out.acted++
      log.push(decision('retry_failed_posts', subject, `Resumed the stuck ${s.part} step`, v.why, null, now))
    }

    if (dirty) await setSetting(admin, RETRY_STATE_KEY, JSON.stringify({ retries: newest(state.retries, 200), carded: newest(state.carded, 200) }))
    await appendDecisions(admin, log)
    out.decisions = log
    out.note = out.acted ? `retried ${out.acted}` : log.length ? `${log.length} need a person` : ''
    return out
  } catch (e) {
    return { ...out, note: `retry policy failed: ${e instanceof Error ? e.message : 'unknown error'}` }
  }
}

// ---------------------------------------------------------------------------------------------------
// Policy 2: approve safe blog topics from Google data
// ---------------------------------------------------------------------------------------------------

export const TOPICS_PER_DAY = 2

export interface TopicCandidate {
  id: string
  angle: string
  keyword: string
  keywords?: string[] | null
  package_slug?: string | null
  status: string
}

export interface TopicContext {
  gsc: GscQuery[]
  /** keyword_research rows with a real volume (a grounded keyword is one of these). */
  researched: GscQuery[]
  posts: PostFact[]
  titles: { title: string }[]
  packageDest: Map<string, string>
}

export interface TopicVerdict {
  approve: boolean
  reason: string
}

/** May the engine approve this suggested topic by itself? It needs Search Console support (striking distance 8 to 20, or any
 * impressions), a keyword with real research behind it, and no clash with a post that already exists. Anything else stays for a
 * person. A rejected, used or already-approved topic is never touched. Pure. */
export function safeTopicVerdict(c: TopicCandidate, ctx: TopicContext, now: Date, vetoed: boolean): TopicVerdict {
  if (vetoed) return { approve: false, reason: 'a person undid an automatic approval of this topic' }
  if (c.status !== 'suggested') return { approve: false, reason: `the topic is ${c.status}, not waiting for a decision` }
  const keywords = [c.keyword, ...(c.keywords ?? [])].filter(Boolean)
  if (!c.keyword || !c.keyword.trim()) return { approve: false, reason: 'the topic has no keyword' }
  const support = gscSupport(keywords, ctx.gsc)
  if (!support.striking && support.impressions <= 0) return { approve: false, reason: 'Google Search Console shows no impressions for this keyword yet' }
  const grounded = gscSupport([c.keyword], ctx.researched)
  if (grounded.impressions <= 0) return { approve: false, reason: 'the keyword has no research volume behind it yet' }
  const dup = findDuplicate(c.angle, ctx.titles)
  if (dup) return { approve: false, reason: `too close to the post "${dup.title}"` }
  const dest = c.package_slug ? ctx.packageDest.get(c.package_slug.toLowerCase()) ?? null : null
  const facts: TopicFacts = { angle: c.angle, keyword: c.keyword, keywords: c.keywords ?? undefined, packageSlug: c.package_slug ?? null, destinationSlug: dest }
  const conflict = topicConflict(facts, ctx.posts, { now, packageDest: ctx.packageDest })
  if (conflict) return { approve: false, reason: conflict.reason }
  const how = support.striking ? `Google shows it at position ${support.position?.toFixed(1)} (page 1 is close)` : `Google already shows it ${support.impressions} times in 28 days`
  return { approve: true, reason: `${how}; the keyword has research volume; no clash with an existing post` }
}

/** Runs policy 2. Never throws. */
export async function runApproveSafeTopics(admin: SupabaseClient, now: Date = new Date()): Promise<RunResult> {
  const out: RunResult = { acted: 0, note: '', decisions: [] }
  try {
    const gate = await policyGate(admin, 'approve_safe_topics', now)
    if (!gate.allowed) return { ...out, note: gate.reason }
    const backlog = await countApprovedUnused(admin)
    if (backlog === null) return { ...out, note: 'could not count the approved topics, so nothing was approved' }
    if (backlog >= AUTO_APPROVE_MAX_BACKLOG) return { ...out, note: `${backlog} approved topics are already waiting` }

    const { data: queue, error } = await admin.from('blog_topic_queue').select('id, angle, keyword, keywords, package_slug, status').eq('status', 'suggested').limit(100)
    if (error) return { ...out, note: `could not read the topics (${error.message})` }
    const candidates = (queue ?? []) as TopicCandidate[]
    if (!candidates.length) return out

    const gsc = await readGscQueries(admin, now)
    if (!gsc.length) return { ...out, note: 'no Search Console data, so no topic could be checked' }
    const [{ data: kw }, { data: posts, error: pErr }, { data: pk }] = await Promise.all([
      admin.from('keyword_research').select('keyword, volume').eq('country', SITE_ID).not('volume', 'is', null).limit(2000),
      admin.from('posts').select('slug, title, primary_keyword, secondary_keywords, tags, body, publish_date, created_at, related_package_id').limit(500),
      admin.from('travel_packages').select('slug, destination').limit(300),
    ])
    if (pErr || !posts) return { ...out, note: 'could not read the posts, so nothing was approved' }
    const packageDest = new Map<string, string>(((pk ?? []) as { slug: string; destination: string | null }[]).filter((p) => p.slug && p.destination).map((p) => [p.slug.toLowerCase(), generateSlug(p.destination as string)]))
    const ctx: TopicContext = {
      gsc,
      researched: ((kw ?? []) as { keyword: string; volume: number | string | null }[]).filter((r) => r.keyword && Number(r.volume) > 0).map((r) => ({ key: r.keyword, position: 0, impressions: Number(r.volume) })),
      posts: (posts as PostFact[]).filter((p) => !isNewsSlug(p.slug)),
      titles: (posts as PostFact[]).map((p) => ({ title: p.title })),
      packageDest,
    }
    const vetoes = await readVetoes(admin)
    const ranked = rankByGsc(candidates, gsc)
    let room = Math.min(gate.room, TOPICS_PER_DAY)
    const log: AutoDecision[] = []
    for (const c of ranked) {
      if (room <= 0) break
      const v = safeTopicVerdict(c, ctx, now, isVetoedIn(vetoes, 'approve_safe_topics', c.keyword))
      if (!v.approve) continue
      try {
        await setTopicStatus(admin, c.id, 'approved')
      } catch {
        continue
      }
      room--
      out.acted++
      log.push(decision('approve_safe_topics', c.keyword, `Approved the blog topic "${c.keyword}"`, v.reason, { kind: 'topic-pending', ref: c.id }, now))
    }
    await appendDecisions(admin, log)
    out.decisions = log
    out.note = out.acted ? `approved ${out.acted} topic${out.acted === 1 ? '' : 's'}` : ''
    return out
  } catch (e) {
    return { ...out, note: `topic policy failed: ${e instanceof Error ? e.message : 'unknown error'}` }
  }
}

// ---------------------------------------------------------------------------------------------------
// Policy 3: publish news briefs that passed every check
// ---------------------------------------------------------------------------------------------------

/** A saved news draft waits this long after it was written before the policy may publish it. */
export const NEWS_COOLING_HOURS = 2

export interface NewsDraftFacts {
  mode: string
  /** Hours since the draft was saved. */
  ageHours: number
  vetoed: boolean
  sourceAllowed: boolean
  stillRelevant: boolean
  stale: boolean
  /** The saved post is still a draft shaped like a news brief. */
  draftIntact: boolean
  /** Problems found by the plain-code gate on the saved text (empty = clean). */
  problems: string[]
  /** 'ok' for a template brief (plain code, no model) or when the independent judge passed it; 'none' when no judge was available. */
  review: 'ok' | 'rejected' | 'deferred' | 'none'
  publishedToday: number
  perDay: number
}

/** May this queued news draft go live by itself now? Pure. */
export function newsDraftVerdict(f: NewsDraftFacts): { publish: boolean; reason: string } {
  if (f.vetoed) return { publish: false, reason: 'a person undid an automatic publish of this brief' }
  if (f.mode !== 'publish') return { publish: false, reason: 'news is not in publish mode' }
  if (f.ageHours < NEWS_COOLING_HOURS) return { publish: false, reason: `it cools for ${NEWS_COOLING_HOURS} hours first (${f.ageHours.toFixed(1)} so far)` }
  if (!f.sourceAllowed) return { publish: false, reason: 'its source is no longer on the allowlist' }
  if (!f.stillRelevant) return { publish: false, reason: 'it no longer qualifies as travel news' }
  if (f.stale) return { publish: false, reason: 'it is too old to be news now' }
  if (!f.draftIntact) return { publish: false, reason: 'the draft is gone, already live, or was edited out of shape' }
  if (f.problems.length) return { publish: false, reason: `it fails a check: ${f.problems[0]}` }
  if (f.review === 'none') return { publish: false, reason: 'it needs the independent review, which the news step does itself' }
  if (f.review === 'deferred') return { publish: false, reason: 'the independent review is not available right now' }
  if (f.review === 'rejected') return { publish: false, reason: 'the independent review said no' }
  if (f.publishedToday >= f.perDay) return { publish: false, reason: `today's news limit of ${f.perDay} is used` }
  return { publish: true, reason: `it passed every check and cooled for ${NEWS_COOLING_HOURS} hours` }
}

export interface NewsPolicyDeps {
  /** The independent judge for a brief that was written by the model (the same call the news step makes). Omitted: only plain-code template briefs are published. */
  review?: (facts: NewsFacts, brief: NewsBrief) => Promise<Pick<BriefOutcome, 'status'>>
  ping?: (paths: string[]) => Promise<unknown>
}

const factsOf = (item: NewsItemRow, name: string, tier: NewsItemRow['tier']): NewsFacts => ({ sourceName: name, tier, title: item.title, summary: item.summary_raw, url: item.url, publishedAt: item.published_at, category: item.category })

/** Runs policy 3. Never throws. */
export async function runPublishPassingNews(admin: SupabaseClient, now: Date = new Date(), deps: NewsPolicyDeps = {}): Promise<RunResult> {
  const out: RunResult = { acted: 0, note: '', decisions: [] }
  try {
    const gate = await policyGate(admin, 'publish_passing_news', now)
    if (!gate.allowed) return { ...out, note: gate.reason }
    const mode = await getNewsMode(admin)
    if (mode !== 'publish') return { ...out, note: 'news is not in publish mode' }
    const perDay = await getNewsPerDay(admin)
    if (perDay === null || perDay === 0) return { ...out, note: perDay === 0 ? 'news writing is switched off (0 a day)' : 'could not read the daily news number' }
    const counts = await countToday(admin, now)
    if (!counts) return { ...out, note: 'could not count today\'s news posts' }
    if (counts.published >= perDay) return { ...out, note: `today's news limit of ${perDay} is used` }

    const { data: rows, error } = await admin.from('news_items').select('*').eq('status', 'queued').not('post_slug', 'is', null).order('decided_at', { ascending: true }).limit(30)
    if (error) return { ...out, note: `could not read the news drafts (${error.message})` }
    const vetoes = await readVetoes(admin)
    const ping = deps.ping ?? pingIndexNow
    const log: AutoDecision[] = []
    let room = gate.room
    let published = counts.published

    for (const item of (rows ?? []) as NewsItemRow[]) {
      if (room <= 0 || published >= perDay) break
      const slug = item.post_slug as string
      const source = sourceByKey(item.source_key)
      const savedAt = Date.parse(item.decided_at ?? item.fetched_at)
      const ageHours = Number.isFinite(savedAt) ? (now.getTime() - savedAt) / HOUR : 0
      if (ageHours < NEWS_COOLING_HOURS) continue
      if (isVetoedIn(vetoes, 'publish_passing_news', slug)) continue

      const { data: post } = await admin.from('posts').select('title, body, status, meta_description, alt_text').eq('slug', slug).maybeSingle()
      const p = post as { title: string; body: string; status: string; meta_description: string | null; alt_text: string | null } | null
      const parsed = p ? parseNewsBody(p.body) : null
      const intact = !!p && p.status === 'draft' && !!parsed && (trustedHeadline(p) !== null || /^News: /.test(p.title))
      let problems: string[] = []
      let review: NewsDraftFacts['review'] = 'none'
      let brief: NewsBrief | null = null
      let facts: NewsFacts | null = null
      if (source && p && parsed && intact) {
        facts = factsOf(item, source.name, source.tier)
        brief = { headline: newsHeadlineOf(p), happened: parsed.happened, means: parsed.means }
        const templated = (isNhcSource(item.source_key) && isTemplateBrief(facts, item.source_key, brief)) || (isUkFcdoSource(item.source_key) && isUkTemplateBrief(facts, item.source_key, brief)) || (isCaAdvisorySource(item.source_key) && isCaTemplateBrief(facts, item.source_key, brief))
        problems = [
          ...briefProblems(brief, facts, { template: templated }),
          ...((p.meta_description ?? '') === parsed.happened ? [] : [`description: it no longer matches the brief${lexicalProblems(p.meta_description ?? '', facts, { mask: isAttributed(p.meta_description ?? '', facts) }).map((x) => `; ${x}`).join('')}`]),
        ]
        if (templated) review = 'ok'
        else if (deps.review && problems.length === 0) review = (await deps.review(facts, brief)).status === 'ok' ? 'ok' : 'rejected'
      }
      const v = newsDraftVerdict({
        mode,
        ageHours,
        vetoed: false,
        sourceAllowed: !!source && source.enabled,
        stillRelevant: !!source && classifyItem(source, { title: item.title, summary: item.summary_raw }).relevant,
        stale: itemStale(item, now.getTime()),
        draftIntact: intact,
        problems,
        review,
        publishedToday: published,
        perDay,
      })
      if (!v.publish || !p) continue
      if ((await claimNewsSlot(admin, 'live', perDay, now)) !== 'ok') break
      const live = await publishQueuedDraft(admin, slug, 0, now)
      if (!live.ok) continue
      await admin.from('news_items').update({ status: 'published', decided_at: now.toISOString(), reject_reason: null }).eq('id', item.id)
      if (await getNewsSocialEnabled(admin)) await enrollNewsIfDue(admin, { slug, title: p.title, status: 'published' }, perDay).catch(() => undefined)
      await Promise.resolve(ping([`/blog/${slug}`, '/blog', '/'])).catch(() => undefined)
      published++
      room--
      out.acted++
      log.push(decision('publish_passing_news', slug, `Published the news brief "${p.title}"`, v.reason, { kind: 'unpublish-news', ref: slug }, now))
    }
    await appendDecisions(admin, log)
    out.decisions = log
    out.note = out.acted ? `published ${out.acted} news brief${out.acted === 1 ? '' : 's'}` : ''
    return out
  } catch (e) {
    return { ...out, note: `news policy failed: ${e instanceof Error ? e.message : 'unknown error'}` }
  }
}

// ---------------------------------------------------------------------------------------------------
// Policy 4: release held posts after the hold
// ---------------------------------------------------------------------------------------------------

export interface HeldRowFacts {
  mode: string
  /** guide_social_release_hours (0 = never release by itself). */
  hours: number
  slug: string
  created_at: string
  last_error: string | null
  sent_platforms: string[] | null
  vetoed: boolean
  captionProblems: string[]
  /** The composed cover passed the visual gate, failed it, or the check could not run. */
  cover: 'pass' | 'fail' | 'unknown'
  /** The guide's name was taken from a trip title (not confirmed as a real property). */
  guessedName: boolean
}

/** May this held row go to the queue now? Pure. */
export function releaseVerdict(f: HeldRowFacts, now: Date): { release: boolean; reason: string } {
  if (f.vetoed) return { release: false, reason: 'a person undid an automatic release of this post' }
  if (f.mode !== 'auto') return { release: false, reason: 'posts are released only in auto mode' }
  if (f.hours <= 0) return { release: false, reason: 'the hold time is 0, so only a person releases posts' }
  const note = f.last_error ?? ''
  if (!note.startsWith(AUTO_HOLD_PREFIX) && !note.startsWith(CAPTION_FAILED_PREFIX)) return { release: false, reason: 'held by a person (no automatic hold note), so it stays held' }
  if ((f.sent_platforms ?? []).length > 0) return { release: false, reason: 'it already reached a network' }
  const age = (now.getTime() - Date.parse(f.created_at)) / HOUR
  if (!Number.isFinite(age) || age < f.hours) return { release: false, reason: `it has waited ${Number.isFinite(age) ? age.toFixed(1) : '?'} of ${f.hours} hours` }
  if (f.guessedName) return { release: false, reason: 'the name was guessed from a trip title and has not been checked by a person' }
  if (f.captionProblems.length) return { release: false, reason: `the caption fails a check: ${f.captionProblems[0]}` }
  if (f.cover === 'fail') return { release: false, reason: 'the cover picture failed the visual check' }
  if (f.cover === 'unknown') return { release: false, reason: 'the cover picture could not be checked right now' }
  return { release: true, reason: `held ${f.hours}+ hours, the caption passed every check and the cover passed the visual check` }
}

export interface ReleaseDeps {
  cover?: (kind: 'guide' | 'trip', slug: string) => Promise<'pass' | 'fail' | 'unknown'>
}

const defaultCover = async (kind: 'guide' | 'trip', slug: string): Promise<'pass' | 'fail' | 'unknown'> => {
  const started = Date.now()
  const r = await gateComposedCover({ base: SITE_URL, kind, slug, hasTime: () => Date.now() - started < 20_000 })
  return r.status === 'pass' ? 'pass' : r.status === 'skip' ? 'fail' : 'unknown'
}

/** Runs policy 4 over held guide and trip rows. Never throws. */
export async function runReleaseHeldPosts(admin: SupabaseClient, now: Date = new Date(), deps: ReleaseDeps = {}): Promise<RunResult> {
  const out: RunResult = { acted: 0, note: '', decisions: [] }
  try {
    const gate = await policyGate(admin, 'release_held_posts', now)
    if (!gate.allowed) return { ...out, note: gate.reason }
    const mode = await getDistributionMode(admin)
    if (mode !== 'auto') return { ...out, note: 'posts are released only in auto mode' }
    const hours = await readReleaseHours(admin)
    if (hours === null) return { ...out, note: 'could not read the hold time' }
    if (hours === 0) return { ...out, note: 'the hold time is 0' }
    const cutoff = new Date(now.getTime() - hours * HOUR).toISOString()
    const { data, error } = await admin.from('post_distribution').select('slug, title, path, created_at, last_error, sent_platforms').eq('content_type', 'post').eq('stage', 'held').not('path', 'is', null).lte('created_at', cutoff).order('created_at', { ascending: true }).limit(20)
    if (error) return { ...out, note: `could not read the held posts (${error.message})` }
    const rows = ((data ?? []) as { slug: string; title: string; path: string; created_at: string; last_error: string | null; sent_platforms: string[] | null }[]).filter((r) => r.slug.startsWith('guide-') || r.slug.startsWith('package-'))
    if (!rows.length) return out

    const dayStart = `${now.toISOString().slice(0, 10)}T00:00:00.000Z`
    const used = async (prefix: string): Promise<number | null> => {
      const { count, error: e } = await admin.from('post_distribution').select('slug', { count: 'exact', head: true }).like('slug', `${prefix}%`).not('path', 'is', null).in('stage', ['queued', 'done']).gte('updated_at', dayStart)
      return e ? null : count ?? 0
    }
    const guideUsed = await used('guide-')
    const tripUsed = await used('package-')
    let guideRoom = guideUsed === null ? 0 : Math.max(0, 1 - guideUsed)
    let tripRoom = tripUsed === null ? 0 : Math.max(0, 1 - tripUsed)
    const tripsOn = await getTripSocialEnabled(admin)
    const vetoes = await readVetoes(admin)
    const cover = deps.cover ?? defaultCover
    const log: AutoDecision[] = []
    let room = gate.room
    let covers = 0

    for (const row of rows) {
      if (room <= 0) break
      const isTrip = row.slug.startsWith('package-')
      if (isTrip ? !tripsOn || tripRoom <= 0 : guideRoom <= 0) continue
      if (isVetoedIn(vetoes, 'release_held_posts', row.slug)) continue
      let problems: string[] = []
      let guessed = false
      let coverSlug = row.slug
      try {
        const src = await loadGuidePostSource(admin, row.path)
        if (isTrip) {
          const tripSlug = packageSlugFromPath(row.path)
          if (!tripSlug) continue
          coverSlug = tripSlug
          const { data: t } = await admin.from('travel_packages').select('*').eq('slug', tripSlug).maybeSingle()
          problems = tripReleaseProblems((t as TripSocialPackage | null) ?? null, src, now.toISOString().slice(0, 10))
        } else {
          problems = src ? guideCaptionProblems(src) : ['the guide is no longer published']
          const g = guideFromPath(row.path)
          if (g) {
            const { data: gr } = await admin.from('guides').select('quality_notes').eq('kind', g.kind).eq('slug', g.slug).maybeSingle()
            guessed = isGuessedPropertyNote((gr as { quality_notes: string | null } | null)?.quality_notes)
          }
        }
      } catch {
        continue
      }
      // The visual check is a network fetch of our own cover route: only for rows that already passed everything else, a few per pass.
      let cv: HeldRowFacts['cover'] = 'unknown'
      if (problems.length === 0 && !guessed && covers < 3) {
        covers++
        cv = await cover(isTrip ? 'trip' : 'guide', coverSlug).catch(() => 'unknown' as const)
      }
      const v = releaseVerdict({ mode, hours, slug: row.slug, created_at: row.created_at, last_error: row.last_error, sent_platforms: row.sent_platforms, vetoed: false, captionProblems: problems, cover: cv, guessedName: guessed }, now)
      if (!v.release) continue
      const { data: moved, error: mErr } = await admin.from('post_distribution').update({ stage: 'queued', last_error: null, updated_at: now.toISOString() }).eq('content_type', 'post').eq('slug', row.slug).eq('stage', 'held').select('slug')
      if (mErr || !moved?.length) continue
      room--
      if (isTrip) tripRoom--
      else guideRoom--
      out.acted++
      log.push(decision('release_held_posts', row.slug, `Released the held post "${row.title}"`, v.reason, { kind: 'rehold-post', ref: row.slug }, now))
    }
    await appendDecisions(admin, log)
    out.decisions = log
    out.note = out.acted ? `released ${out.acted} held post${out.acted === 1 ? '' : 's'}` : ''
    return out
  } catch (e) {
    return { ...out, note: `release policy failed: ${e instanceof Error ? e.message : 'unknown error'}` }
  }
}

/** All four runners in the order the pipeline wants them (release and retry before the posting step, so the rows they move are sent in
 * the same pass). Each is independent; one failing never stops the others. */
export async function runAutoPolicies(admin: SupabaseClient, now: Date = new Date(), deps: { retry?: RetryDeps; news?: NewsPolicyDeps; release?: ReleaseDeps } = {}): Promise<string> {
  const notes: string[] = []
  for (const run of [
    () => runPublishPassingNews(admin, now, deps.news),
    () => runApproveSafeTopics(admin, now),
    () => runReleaseHeldPosts(admin, now, deps.release),
    () => runRetryFailedPosts(admin, now, deps.retry),
  ]) {
    try {
      const r = await run()
      if (r.note) notes.push(r.note)
    } catch (e) {
      notes.push(e instanceof Error ? e.message : 'an automatic decision failed')
    }
  }
  return notes.join('; ')
}
