import type { FallbackCaptionFacts } from '@/lib/social-captions'

// Fan-out calendar: every published blog post is spread over a week, not posted once and forgotten.
//   day 0      one carousel (hook is the title as a question or a contrast, the last slide is a question call to action)
//   day 0 to 1 three social posts with different question hooks across the networks (the normal post distribution, see lib/caption-plan.ts)
//   day 2      one reel made from the post body (inside 72 hours of publishing)
//   day 7      one recap post, "you asked, here is the answer", a text post built from a real FAQ answer of the post
// This file is the PLANNER only: pure functions, no database, no network. Given a post and "now" it says what is due. The pipeline
// (lib/autopilot.ts) asks it where it already decides what to do next, so there is no new cron. It never raises a posting cap: the
// carousel, the reel and the recap each go through the same limits as before (videos per week, the shared daily enrolment ceiling,
// the visual gate, caption problems, the kill switch and the distribution mode).

export type FanoutKind = 'carousel' | 'social' | 'reel' | 'recap'

const DAY_MS = 86_400_000

/** When each piece is due, in days after the publish date (the date starts at 00:00 UTC). */
export const FANOUT_DAYS: Record<FanoutKind, number> = { carousel: 0, social: 0, reel: 2, recap: 7 }
/** Everything except the recap lands inside this many hours of publishing. */
export const FANOUT_WINDOW_HOURS = 72
/** A recap that has not been enrolled by this many days after publishing is dropped (an old post is not recapped late). */
export const RECAP_LAST_DAY = 10
/** The three social posts use three different question hooks. */
export const SOCIAL_POST_COUNT = 3

export interface FanoutPost {
  slug: string
  /** posts.publish_date (YYYY-MM-DD) or a full ISO time. */
  publishedAt: string | Date | null | undefined
}

export interface FanoutItem {
  kind: FanoutKind
  /** What it is, in plain words. */
  what: string
  dueAt: Date
  /** The last moment it still counts as on schedule. */
  lastAt: Date
  /** True from `dueAt` on, until `lastAt` for a recap; the 72 hour window is a target, not a cut-off, for the others. */
  due: boolean
  /** True once the scheduled window has passed (a recap past day 10 is expired and never made). */
  expired: boolean
}

/** The publish moment of a post, or null when it has no usable date. A bare date is read as 00:00 UTC of that day. */
export function publishMoment(p: FanoutPost): Date | null {
  const v = p.publishedAt
  if (v === null || v === undefined || v === '') return null
  const d = v instanceof Date ? v : new Date(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00.000Z` : v)
  return Number.isFinite(d.getTime()) ? d : null
}

const WHAT: Record<FanoutKind, string> = {
  carousel: 'one carousel (title as a question or a contrast, last slide a question)',
  social: `${SOCIAL_POST_COUNT} social posts with different question hooks across the networks`,
  reel: 'one reel made from the post body',
  recap: 'one recap post: you asked, here is the answer',
}

/** What the fan-out calendar has for one post at `now`. Nothing is ever "due" for a post with no usable date. `done` marks pieces already made,
 * so they are not asked for again. Pure. */
export function planFanout(post: FanoutPost, now: Date, done: Partial<Record<FanoutKind, boolean>> = {}): { items: FanoutItem[]; due: FanoutKind[] } {
  const t0 = publishMoment(post)
  if (!t0) return { items: [], due: [] }
  const items: FanoutItem[] = (Object.keys(FANOUT_DAYS) as FanoutKind[]).map((kind) => {
    const dueAt = new Date(t0.getTime() + FANOUT_DAYS[kind] * DAY_MS)
    const lastAt = new Date(kind === 'recap' ? t0.getTime() + RECAP_LAST_DAY * DAY_MS : kind === 'social' ? t0.getTime() + DAY_MS : t0.getTime() + FANOUT_WINDOW_HOURS * 3_600_000)
    const started = now.getTime() >= dueAt.getTime()
    return { kind, what: WHAT[kind], dueAt, lastAt, due: started && !done[kind] && !(kind === 'recap' && now.getTime() > lastAt.getTime()), expired: kind === 'recap' && now.getTime() > lastAt.getTime() }
  })
  return { items, due: items.filter((i) => i.due).map((i) => i.kind) }
}

/** True when `kind` is due for the post at `now` (a post with no date is never held back: its pieces are due at once, as they were before
 * the calendar existed, so an old row cannot get stuck). */
export function isDue(post: FanoutPost, kind: FanoutKind, now: Date, done: Partial<Record<FanoutKind, boolean>> = {}): boolean {
  if (!publishMoment(post)) return kind !== 'recap' && !done[kind]
  return planFanout(post, now, done).due.includes(kind)
}

/** Which of these posts get a recap enrolled now: due (7 to 10 days after publishing), not yet enrolled, newest-first order dropped in favour of
 * the one waiting longest. At most `limit` (default 1, the daily recap allowance). Pure. */
export function recapsDue(posts: ReadonlyArray<FanoutPost>, enrolledSlugs: ReadonlySet<string>, now: Date, limit = 1): string[] {
  return posts
    .filter((p) => !p.slug.startsWith('news-') && !enrolledSlugs.has(recapSlug(p.slug)) && isDue(p, 'recap', now))
    .sort((a, b) => (publishMoment(a)?.getTime() ?? 0) - (publishMoment(b)?.getTime() ?? 0))
    .slice(0, Math.max(0, limit))
    .map((p) => p.slug)
}

/** The ledger slug of a post's recap row. The post_distribution key is (content_type, slug), so the recap needs its own slug. */
export const RECAP_PREFIX = 'recap-'
export const recapSlug = (slug: string): string => `${RECAP_PREFIX}${slug}`
export const isRecapSlug = (slug: string): boolean => slug.startsWith(RECAP_PREFIX)
export const baseSlugOfRecap = (slug: string): string => (isRecapSlug(slug) ? slug.slice(RECAP_PREFIX.length) : slug)

const firstSentence = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  const m = flat.match(/^.*?[.!?](?=\s|$)/)
  const s = (m ? m[0] : flat).trim()
  return s.length <= max ? s : ''
}

/** The facts the recap caption is built from: the hook is "You asked: <a real FAQ question of the post>" and the one line under it is the first
 * sentence of that FAQ answer. Nothing is invented. Null when the post has no FAQ with a usable question and a short first answer sentence
 * (then no recap is made for it). Pure. */
export function recapFacts(post: { title: string; faq?: unknown; tags?: unknown }): FallbackCaptionFacts | null {
  const faq = Array.isArray(post.faq) ? (post.faq as Array<{ q?: unknown; a?: unknown } | null>) : []
  for (const f of faq) {
    const q = typeof f?.q === 'string' ? f.q.replace(/\s+/g, ' ').trim() : ''
    const a = typeof f?.a === 'string' ? firstSentence(f.a, 220) : ''
    if (q && a && q.length <= 120) {
      return { title: post.title, metaDescription: a, faqQuestions: [`You asked: ${q.replace(/\?*$/, '')}?`], keyTakeaways: [], tags: Array.isArray(post.tags) ? (post.tags as unknown[]) : [] }
    }
  }
  return null
}
