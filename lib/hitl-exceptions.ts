import type { SupabaseClient } from '@supabase/supabase-js'
import { getSetting } from '@/lib/app-settings'
import { CAPTION_FAILED_PREFIX } from '@/lib/guide-release'
import { postRetryVerdict, stepResumeVerdict, RETRY_STATE_KEY, type FailedPostRow, type FailedStepRow } from '@/lib/auto-policies'
import { readWatchdogRecord, STAGE_LABELS, type WatchdogRecord } from '@/lib/funnel-watchdog'

// Exceptions only: what is LEFT for the owner once the automatic decisions have done what they safely can. Each item is one thing a
// person has to decide, written in plain words, with a severity and a place to go. The Today page can render these later; nothing here
// draws any screen. Items are recomputed from the live data every time (never stored), so one that was fixed disappears by itself.

export type HitlSource = 'post' | 'step' | 'held' | 'topics' | 'news' | 'watchdog'
export type HitlSeverity = 'bad' | 'warn' | 'info'

export interface HitlItem {
  /** Stable id, so a screen can key on it and a dismissal can remember it. */
  id: string
  source: HitlSource
  severity: HitlSeverity
  /** What needs a person, in one line. */
  title: string
  /** Why the automatic decision did not act, in plain words. */
  why: string
  /** What the person can do about it, in plain words. */
  nextStep: string
  /** The admin page to open, or null. */
  href: string | null
  /** The post slug, topic count key or funnel stage this is about. */
  subject: string
}

export interface HitlInputs {
  failedPosts: FailedPostRow[]
  /** Automatic retries each post subject already had (auto_retry_state). */
  retries: Record<string, number>
  failedSteps: FailedStepRow[]
  heldCaptionFailed: { slug: string; title: string; last_error: string | null }[]
  /** Blog topics waiting for a decision after the automatic approvals took the safe ones. null = could not be read. */
  suggestedTopics: number | null
  /** News drafts still waiting after the cooling period. null = could not be read. */
  waitingNewsDrafts: number | null
  watchdog: WatchdogRecord | null
}

const SEVERITY_RANK: Record<HitlSeverity, number> = { bad: 0, warn: 1, info: 2 }

/** Turns the live facts into the list of things a person has to look at, worst first. Pure. */
export function buildExceptions(i: HitlInputs, now: Date = new Date()): HitlItem[] {
  const out: HitlItem[] = []

  for (const row of i.failedPosts) {
    const v = postRetryVerdict(row, i.retries[row.slug] ?? 0, now, false)
    if (v.act !== 'card') continue
    out.push({ id: `post:${row.slug}`, source: 'post', severity: 'warn', title: `A post failed to go out: ${row.slug}`, why: v.why, nextStep: 'Open the posting list, read the reason, fix it and press Retry (or leave it).', href: '/admin/distribution', subject: row.slug })
  }
  for (const s of i.failedSteps) {
    const v = stepResumeVerdict(s, i.retries[`${s.slug}:${s.part}`] ?? 0, now, false)
    if (v.act !== 'card') continue
    out.push({ id: `step:${s.slug}:${s.part}`, source: 'step', severity: 'warn', title: `The ${s.part} for ${s.slug} is stuck`, why: v.why, nextStep: `Open Needs attention on the Content Autopilot page and press Retry ${s.part}, or skip it.`, href: '/admin/autopilot', subject: `${s.slug}:${s.part}` })
  }
  for (const h of i.heldCaptionFailed) {
    out.push({ id: `held:${h.slug}`, source: 'held', severity: 'warn', title: `A held post will not go out by itself: ${h.title}`, why: (h.last_error ?? '').replace(CAPTION_FAILED_PREFIX, '').trim() || 'its caption failed a check', nextStep: 'Fix the page text (the check runs again on the next pass), or approve the post by hand.', href: '/admin/distribution', subject: h.slug })
  }
  if (i.suggestedTopics !== null && i.suggestedTopics > 0) {
    out.push({ id: 'topics:waiting', source: 'topics', severity: 'info', title: `${i.suggestedTopics} blog topic${i.suggestedTopics === 1 ? ' is' : 's are'} waiting for you`, why: 'Google data does not back them yet, or they are too close to a post that already exists.', nextStep: 'Approve the ones you like and reject the rest in Topics and Autoblog.', href: '/admin/blog', subject: 'topics' })
  }
  if (i.waitingNewsDrafts !== null && i.waitingNewsDrafts > 0) {
    out.push({ id: 'news:waiting', source: 'news', severity: 'info', title: `${i.waitingNewsDrafts} news brief${i.waitingNewsDrafts === 1 ? ' is' : 's are'} still a draft`, why: 'It did not pass every check, or it needs the independent review that the news step runs.', nextStep: 'Open the travel news card to read the reason; nothing goes live until it passes.', href: '/admin/news', subject: 'news' })
  }
  for (const c of i.watchdog?.checks ?? []) {
    if (c.status === 'ok') continue
    const needsPerson = /^Needs Joel/.test(c.action)
    if (!needsPerson && c.status !== 'bad') continue
    out.push({ id: `watchdog:${c.stage}`, source: 'watchdog', severity: c.status === 'bad' ? 'bad' : 'warn', title: `${STAGE_LABELS[c.stage]}: ${c.summary}`, why: c.action.replace(/^Needs Joel:?\s*/, '') || c.summary, nextStep: c.action.replace(/^Needs Joel:?\s*/, '') || 'Open the Content Autopilot page.', href: '/admin/autopilot', subject: c.stage })
  }

  return out.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.id.localeCompare(b.id))
}

/** Reads the live facts and builds the list. A read that fails leaves that kind of item out (never invents one). Never throws. */
export async function readHitlExceptions(admin: SupabaseClient, now: Date = new Date()): Promise<{ items: HitlItem[]; unreadable: string[] }> {
  const unreadable: string[] = []
  const safe = async <T>(label: string, fn: () => PromiseLike<{ data: unknown; error: { message: string } | null }>, empty: T): Promise<T> => {
    try {
      const r = await fn()
      if (r.error) {
        unreadable.push(label)
        return empty
      }
      return (r.data ?? empty) as T
    } catch {
      unreadable.push(label)
      return empty
    }
  }
  try {
    const since = new Date(now.getTime() - 7 * 86_400_000).toISOString()
    const failedPosts = await safe<FailedPostRow[]>('failed posts', () => admin.from('post_distribution').select('slug, stage, last_error, sent_platforms, updated_at').eq('content_type', 'post').eq('stage', 'failed').limit(30), [])
    const held = await safe<{ slug: string; title: string; last_error: string | null }[]>('held posts', () => admin.from('post_distribution').select('slug, title, last_error').eq('content_type', 'post').eq('stage', 'held').like('last_error', `${CAPTION_FAILED_PREFIX}%`).limit(20), [])
    const steps: FailedStepRow[] = []
    for (const part of ['carousel', 'video'] as const) {
      const rows = await safe<Array<Record<string, unknown>>>(`failed ${part}s`, () => admin.from('content_pipeline').select('*').eq(`${part}_stage`, 'failed').gte('created_at', since).limit(20), [])
      for (const r of rows) steps.push({ slug: String(r.slug), part, last_error: (r.last_error as string | null) ?? null, updated_at: String(r.updated_at), sent: (r[`${part}_sent`] as string[] | null) ?? null })
    }
    let topics: number | null = null
    try {
      const { count, error } = await admin.from('blog_topic_queue').select('id', { count: 'exact', head: true }).eq('status', 'suggested')
      topics = error ? null : count ?? 0
    } catch {
      topics = null
    }
    let news: number | null = null
    try {
      const cutoff = new Date(now.getTime() - 24 * 3_600_000).toISOString()
      const { count, error } = await admin.from('news_items').select('id', { count: 'exact', head: true }).eq('status', 'queued').lte('decided_at', cutoff)
      news = error ? null : count ?? 0
    } catch {
      news = null
    }
    let retries: Record<string, number> = {}
    try {
      const st = JSON.parse((await getSetting(admin, RETRY_STATE_KEY)) ?? '{}') as { retries?: Record<string, { n?: number }> }
      retries = Object.fromEntries(Object.entries(st.retries ?? {}).map(([k, v]) => [k, typeof v?.n === 'number' ? v.n : 0]))
    } catch {
      retries = {}
    }
    const watchdog = await readWatchdogRecord(admin)
    return { items: buildExceptions({ failedPosts, retries, failedSteps: steps, heldCaptionFailed: held, suggestedTopics: topics, waitingNewsDrafts: news, watchdog }, now), unreadable }
  } catch {
    return { items: [], unreadable: ['everything'] }
  }
}
