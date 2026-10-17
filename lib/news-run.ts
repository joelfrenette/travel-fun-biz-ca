import type { SupabaseClient } from '@supabase/supabase-js'
import { isAiConfigured } from '@/lib/ai-verify'
import { getSetting, setSetting } from '@/lib/app-settings'
import { isAutomationPaused } from '@/lib/automation-kill-switch'
import { startOfSiteDayIso } from '@/lib/content-edits'
import { modelCallFor, type ModelCall } from '@/lib/content-repair'
import { openBudget, type HealBudget } from '@/lib/heal-loop'
import { pingIndexNow } from '@/lib/indexnow'
import { briefProblems, writeNewsBrief, type NewsFacts } from '@/lib/news-brief'
import { enrollNewsIfDue } from '@/lib/news-distribution'
import type { FetchDeps } from '@/lib/news-feed'
import { expireOldItems, ingestFeeds, newsTableReady, type IngestResult, type NewsItemRow } from '@/lib/news-ingest'
import { createNewsPost, publishQueuedDraft } from '@/lib/news-publish'
import { newsTitle, parseNewsBody } from '@/lib/news-post'
import { isBreaking, priorityOf } from '@/lib/news-relevance'
import { getNewsMode, getNewsPerDay, type NewsMode } from '@/lib/news-settings'
import { NEWS_MAX_AGE_DAYS, sourceByKey, type NewsSource } from '@/lib/news-sources'

// Growth loop WP20: the news step inside the existing pipeline (lib/pipeline.ts). No new cron. One pass:
//   1. READ     each allowlisted feed that is due (at most once in 30 minutes), keep travel-affecting items, drop repeats
//   2. EXPIRE   items older than 7 days that nothing was written about
//   3. WRITE    for up to travel_news_per_day items a day (default 2, never more than 6), our own short brief, checked by the
//               gate and the independent judge (lib/news-brief.ts), through the shared heal call budget
//   4. SAVE     as a draft (mode draft) or live (mode publish, audit row first), then ONE social post through the existing
//               ledger. Mode off does nothing at all.
// Every limit fails closed: a count that cannot be read means nothing is written.

export interface NewsRunDeps {
  fetchDeps?: FetchDeps
  model?: ModelCall
  budget?: HealBudget
  now?: Date
  /** Absolute time (Date.now() scale) the step must be done by. */
  deadlineMs?: number
  sources?: NewsSource[]
  ping?: (paths: string[]) => Promise<unknown>
  /** Overrides site.phone in the saved body (checks only). */
  phone?: string
}

export interface NewsStepResult {
  ok: boolean
  note: string
  mode: NewsMode
  stored: number
  wrote: number
  published: number
  rejected: number
}

const DEFER_PREFIX = 'news_defer:'
const MAX_DEFERRALS = 3
const reasonsText = (reasons: string[]) => reasons.slice(0, 3).join('; ').slice(0, 300)

const factsOf = (item: NewsItemRow, source: NewsSource): NewsFacts => ({ sourceName: source.name, tier: source.tier, title: item.title, summary: item.summary_raw, url: item.url, publishedAt: item.published_at, category: item.category })

async function setItem(admin: SupabaseClient, id: string, patch: Record<string, unknown>): Promise<boolean> {
  const { error } = await admin.from('news_items').update(patch).eq('id', id)
  return !error
}

interface DayCounts {
  written: number
  published: number
  attempts: number
}

/** What was decided today (site day): briefs written (queued or published), items published, and all decisions including
 * rejections. Null when it cannot be read (the caller then writes nothing). */
export async function countToday(admin: SupabaseClient, now: Date): Promise<DayCounts | null> {
  const { data, error } = await admin.from('news_items').select('status').gte('decided_at', startOfSiteDayIso(now)).limit(500)
  if (error) return null
  const rows = (data ?? []) as { status: string }[]
  return {
    written: rows.filter((r) => r.status === 'queued' || r.status === 'published').length,
    published: rows.filter((r) => r.status === 'published').length,
    attempts: rows.filter((r) => r.status === 'queued' || r.status === 'published' || r.status === 'rejected').length,
  }
}

function ingestNote(i: IngestResult): string {
  const bits: string[] = []
  if (i.fetched.length) bits.push(`read ${i.fetched.length} feed${i.fetched.length === 1 ? '' : 's'}`)
  if (i.waiting.length && !i.fetched.length) bits.push(`${i.waiting.length} feed${i.waiting.length === 1 ? '' : 's'} read recently (30 minute limit)`)
  if (i.stored) bits.push(`${i.stored} new item${i.stored === 1 ? '' : 's'}`)
  if (i.rejected) bits.push(`${i.rejected} refused (instruction-like text)`)
  if (i.failed.length) bits.push(`${i.failed.length} feed problem${i.failed.length === 1 ? '' : 's'} (${i.failed.map((f) => `${f.key}: ${f.error}`).join('; ').slice(0, 160)})`)
  return bits.join(', ')
}

/** Runs the news step. Returns null when the mode is off (silent: nothing in the pass record). Never throws. */
export async function runNewsStep(admin: SupabaseClient, deps: NewsRunDeps = {}): Promise<NewsStepResult | null> {
  const now = deps.now ?? new Date()
  const result: NewsStepResult = { ok: true, note: '', mode: 'draft', stored: 0, wrote: 0, published: 0, rejected: 0 }
  try {
    const mode = await getNewsMode(admin)
    result.mode = mode
    if (mode === 'off') return null
    if (await isAutomationPaused(admin)) return { ...result, note: 'automation is paused' }

    const ready = await newsTableReady(admin)
    if (!ready.ok) return { ...result, note: 'travel news needs one database update: run migration 0047 (supabase/migrations/0047_news_items.sql) in the Supabase SQL editor' }

    // 1 + 2: read, filter, store, expire.
    const ingest = await ingestFeeds(admin, { fetchDeps: deps.fetchDeps, now, sources: deps.sources })
    if (ingest.tableProblem) return { ...result, ok: false, note: `could not store news items (${ingest.tableProblem})` }
    result.stored = ingest.stored
    const expired = await expireOldItems(admin, now)
    const head = [ingestNote(ingest), expired ? `${expired} expired` : ''].filter(Boolean).join(', ')

    // 3 + 4: write.
    const perDay = await getNewsPerDay(admin)
    if (perDay === null) return { ...result, ok: false, note: `${head ? `${head}; ` : ''}could not read the daily news number, so nothing was written` }
    if (perDay === 0) return { ...result, note: `${head ? `${head}; ` : ''}writing is switched off (0 a day)` }
    const counts = await countToday(admin, now)
    if (!counts) return { ...result, ok: false, note: `${head ? `${head}; ` : ''}could not count today's news posts, so nothing was written` }

    const publishing = mode === 'publish'
    const ping = deps.ping ?? pingIndexNow
    let budget: HealBudget | null = deps.budget ?? null
    const model = deps.model ?? (isAiConfigured() ? modelCallFor('travel-news') : null)
    const notes: string[] = []
    const goLive = async (slug: string, title: string) => {
      await enrollNewsIfDue(admin, { slug, title, status: 'published' }, perDay)
      await Promise.resolve(ping([`/blog/${slug}`, '/blog', '/'])).catch(() => undefined)
    }

    // 3a: briefs that passed earlier and wait as drafts go live once the mode is publish, inside the daily limit.
    if (publishing && counts.published < perDay) {
      const { data: queuedRows } = await admin.from('news_items').select('*').eq('status', 'queued').not('post_slug', 'is', null).limit(50)
      const queued = ((queuedRows ?? []) as NewsItemRow[]).sort((a, b) => priorityOf({ ...a, breaking: isBreaking(a.tier, a.title, a.summary_raw) }) - priorityOf({ ...b, breaking: isBreaking(b.tier, b.title, b.summary_raw) }))
      for (const item of queued) {
        if (counts.published >= perDay) break
        const source = sourceByKey(item.source_key)
        if (!source || !source.enabled) {
          await setItem(admin, item.id, { status: 'rejected', reject_reason: 'the source is no longer on the allowlist', decided_at: now.toISOString() })
          result.rejected++
          continue
        }
        // The saved text is checked again with the same gate before it goes live (a person may have edited the draft).
        const { data: post } = await admin.from('posts').select('title, body, status').eq('slug', item.post_slug as string).maybeSingle()
        const p = post as { title: string; body: string; status: string } | null
        const parsed = p ? parseNewsBody(p.body) : null
        if (!p || p.status !== 'draft' || !parsed) {
          notes.push(`a queued draft (${item.post_slug}) was left alone: it is gone, already live, or was edited out of shape`)
          continue
        }
        const problems = briefProblems({ headline: p.title.replace(/^news:\s*/i, ''), happened: parsed.happened, means: parsed.means }, factsOf(item, source))
        if (problems.length) {
          await setItem(admin, item.id, { status: 'rejected', reject_reason: `the saved draft no longer passes the checks: ${problems[0]}`.slice(0, 300), decided_at: now.toISOString() })
          result.rejected++
          continue
        }
        const live = await publishQueuedDraft(admin, item.post_slug as string, 0, now)
        if (!live.ok) {
          notes.push(`${item.post_slug}: ${live.note}`)
          continue
        }
        await setItem(admin, item.id, { status: 'published', decided_at: now.toISOString(), reject_reason: null })
        await goLive(item.post_slug as string, p.title)
        counts.published++
        result.published++
      }
    }

    // 3b: new items, best first: breaking official notices, other official notices, then trade news; newest first inside a group.
    const attemptsCap = perDay * 2
    if (counts.written < perDay && counts.attempts < attemptsCap && (!publishing || counts.published < perDay)) {
      const { data: newRows, error: newErr } = await admin.from('news_items').select('*').eq('status', 'new').limit(200)
      if (newErr) return { ...result, ok: false, note: `${head ? `${head}; ` : ''}could not read the news items (${newErr.message})` }
      const cutoff = now.getTime() - NEWS_MAX_AGE_DAYS * 86_400_000
      const candidates = ((newRows ?? []) as NewsItemRow[])
        .filter((r) => Date.parse(r.published_at ?? r.fetched_at) >= cutoff)
        .sort((a, b) => priorityOf({ ...a, breaking: isBreaking(a.tier, a.title, a.summary_raw) }) - priorityOf({ ...b, breaking: isBreaking(b.tier, b.title, b.summary_raw) }))
      if (candidates.length && !model) notes.push('AI writing is not configured, so no brief was written')
      else if (candidates.length && model) {
        budget = budget ?? (await openBudget(admin, now))
        for (const item of candidates) {
          if (counts.written >= perDay || counts.attempts >= attemptsCap || (publishing && counts.published >= perDay)) break
          if (deps.deadlineMs !== undefined && deps.deadlineMs - Date.now() < 30_000) {
            notes.push('ran out of time; the rest waits for the next pass')
            break
          }
          const source = sourceByKey(item.source_key)
          if (!source || !source.enabled) {
            await setItem(admin, item.id, { status: 'rejected', reject_reason: 'the source is no longer on the allowlist', decided_at: now.toISOString() })
            result.rejected++
            counts.attempts++
            continue
          }
          const facts = factsOf(item, source)
          const outcome = await writeNewsBrief(facts, { model, budget, deadlineMs: deps.deadlineMs })
          if (outcome.status === 'deferred') {
            const n = (Number(await getSetting(admin, `${DEFER_PREFIX}${item.id}`)) || 0) + 1
            await setSetting(admin, `${DEFER_PREFIX}${item.id}`, String(n))
            if (n >= MAX_DEFERRALS && !/limit|time/.test(outcome.reasons[0] ?? '')) {
              await setItem(admin, item.id, { status: 'rejected', reject_reason: `could not be written after ${n} tries: ${reasonsText(outcome.reasons)}`.slice(0, 300), decided_at: now.toISOString() })
              result.rejected++
              counts.attempts++
            } else notes.push(`waiting: ${outcome.reasons[0] ?? 'the writer is not available'}`)
            break
          }
          if (outcome.status === 'rejected' || !outcome.brief) {
            await setItem(admin, item.id, { status: 'rejected', reject_reason: reasonsText(outcome.reasons) || 'no brief passed the checks', decided_at: now.toISOString() })
            result.rejected++
            counts.attempts++
            continue
          }
          const saved = await createNewsPost(admin, { item, facts, brief: outcome.brief, publish: publishing, calls: outcome.calls, stripped: outcome.stripped, now })
          if (!saved.ok || !saved.slug) {
            notes.push(`${item.title.slice(0, 50)}: ${saved.note}`)
            counts.attempts++
            continue
          }
          const live = saved.published
          await setItem(admin, item.id, { status: live ? 'published' : 'queued', post_slug: saved.slug, decided_at: now.toISOString(), reject_reason: null })
          counts.written++
          counts.attempts++
          result.wrote++
          if (live) {
            counts.published++
            result.published++
            await goLive(saved.slug, newsTitle(outcome.brief.headline))
          } else if (publishing) notes.push(`${saved.slug}: ${saved.note}`)
        }
      }
    }

    const done = result.wrote || result.rejected || result.published ? `wrote ${result.wrote} (${publishing ? 'live' : 'draft'}), published ${result.published}, rejected ${result.rejected}` : ''
    result.note = [head, done, ...notes, `mode ${mode}, ${perDay} a day`].filter(Boolean).join('; ')
    return result
  } catch (e) {
    return { ...result, ok: false, note: e instanceof Error ? e.message : 'the news step failed' }
  }
}
