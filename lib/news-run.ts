import type { SupabaseClient } from '@supabase/supabase-js'
import { isAiConfigured } from '@/lib/ai-verify'
import { getSetting, setSetting } from '@/lib/app-settings'
import { isAutomationPaused } from '@/lib/automation-kill-switch'
import { repairDay, startOfSiteDayIso } from '@/lib/content-edits'
import { modelCallFor, type ModelCall } from '@/lib/content-repair'
import { openBudget, type HealBudget } from '@/lib/heal-loop'
import { pingIndexNow } from '@/lib/indexnow'
import { briefProblems, isAttributed, lexicalProblems, writeNewsBrief, type NewsBrief, type NewsFacts } from '@/lib/news-brief'
import { SOCIAL_ENROLMENTS_PER_DAY_CEILING, enrollNewsIfDue } from '@/lib/news-distribution'
import type { FetchDeps } from '@/lib/news-feed'
import { NO_LONGER_QUALIFIES_REASON, expireOldItems, ingestFeeds, newsTableReady, reevaluateItems, type IngestResult, type NewsItemRow } from '@/lib/news-ingest'
import { createNewsPost, markSuperseded, publishQueuedDraft } from '@/lib/news-publish'
import { newsTitle, parseNewsBody } from '@/lib/news-post'
import { classifyItem, isBreaking, isNhcSource, priorityOf, stormKey, stormKeysMatch, stormSignature, titleKey, titleSimilarity, SIMILAR_TITLE_THRESHOLD } from '@/lib/news-relevance'
import { getNewsMode, getNewsPerDay, type NewsMode } from '@/lib/news-settings'
import { maxAgeMs, sourceByKey, type NewsSource } from '@/lib/news-sources'

// Growth loop WP20: the news step inside the existing pipeline (lib/pipeline.ts). No new cron. One pass:
//   1. READ     each allowlisted feed that is due (at most once in 30 minutes, official feeds first), keep travel-affecting
//               items, drop repeats (a storm bulletin with new figures is an update, not a repeat)
//   2. EXPIRE   items too old to be news: 36 hours for storms and breaking notices, 7 days for the rest
//   3. WRITE    for up to travel_news_per_day items a day (default 2, never more than 6), our own short brief, checked by the
//               gate and the independent judge (lib/news-brief.ts), through the shared heal call budget (news may use at most
//               half of it)
//   4. SAVE     as a draft (mode draft) or live (mode publish, audit row first), then ONE social post through the existing
//               ledger. Mode off does nothing at all.
// Every limit fails closed: a count that cannot be read means nothing is written. Per-day limits are ALSO enforced by atomic
// slot rows (app_settings keys news_slot:<site day>:<kind>:<n>, each inserted with a unique key, like the heal budget), so
// two overlapping runs can never both take the last slot.

export interface NewsRunDeps {
  fetchDeps?: FetchDeps
  model?: ModelCall
  budget?: HealBudget
  now?: Date
  /** Absolute time (Date.now() scale) the step must be done by. */
  deadlineMs?: number
  sources?: NewsSource[]
  ping?: (paths: string[]) => Promise<unknown>
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

const itemMs = (i: Pick<NewsItemRow, 'published_at' | 'fetched_at'>) => Date.parse(i.published_at ?? i.fetched_at)
/** True when an item is past its news life (36 hours for a storm or a breaking notice, 7 days for the rest). */
export const itemStale = (i: NewsItemRow, nowMs: number): boolean => {
  const t = itemMs(i)
  return !Number.isFinite(t) || nowMs - t > maxAgeMs(i.category, isBreaking(i.tier, i.title, i.summary_raw))
}
const rank = (i: NewsItemRow) => priorityOf({ ...i, breaking: isBreaking(i.tier, i.title, i.summary_raw) })

// ---------------------------------------------------------------------------------------------------
// Atomic per-day slots
// ---------------------------------------------------------------------------------------------------

/** Takes one of today's `cap` slots of a kind ('attempt', 'write', 'live', 'call'). Each slot is its own app_settings row with a
 * unique key, so two overlapping runs can never both take the last one. 'error' (unreadable or unwritable) means do not proceed. */
export async function claimNewsSlot(admin: SupabaseClient, kind: string, cap: number, now: Date = new Date()): Promise<'ok' | 'full' | 'error'> {
  if (cap <= 0) return 'full'
  const prefix = `news_slot:${repairDay(now)}:${kind}:`
  const { data, error } = await admin.from('app_settings').select('key').like('key', `${prefix}%`)
  if (error) return 'error'
  const taken = new Set(((data ?? []) as { key: string }[]).map((r) => r.key))
  if (taken.size >= cap) return 'full'
  for (let n = 1; n <= cap; n++) {
    const key = `${prefix}${n}`
    if (taken.has(key)) continue
    const { error: insertError } = await admin.from('app_settings').insert({ key, value: now.toISOString() })
    if (!insertError) return 'ok'
    if ((insertError as { code?: string }).code === '23505') continue
    return 'error'
  }
  return 'full'
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

// ---------------------------------------------------------------------------------------------------
// Storm updates
// ---------------------------------------------------------------------------------------------------

/** Earlier briefs (queued or live) about the same storm whose figures differ from this item's: the ones this item updates,
 * newest first. Empty for anything that is not a storm. */
export async function olderStormItems(admin: SupabaseClient, item: NewsItemRow): Promise<NewsItemRow[]> {
  if (item.category !== 'storm') return []
  const { data } = await admin.from('news_items').select('*').eq('category', 'storm').in('status', ['queued', 'published']).not('post_slug', 'is', null).limit(100)
  const sig = stormSignature(item.title, item.summary_raw)
  // Hurricane centre items also match by storm key (name, and the ATCF id when both have one), so a "Summary for" item and a
  // Public Advisory of the same storm are recognised as the same storm even though their titles share few words.
  const sameStorm = (r: NewsItemRow) =>
    titleKey(r.title) === titleKey(item.title) ||
    titleSimilarity(r.title, item.title) >= SIMILAR_TITLE_THRESHOLD ||
    (isNhcSource(r.source_key) && isNhcSource(item.source_key) && stormKeysMatch(stormKey(r.title), stormKey(item.title)))
  return ((data ?? []) as NewsItemRow[])
    .filter((r) => r.id !== item.id && itemMs(r) < itemMs(item) && sameStorm(r) && stormSignature(r.title, r.summary_raw) !== sig)
    .sort((a, b) => itemMs(b) - itemMs(a))
}

function ingestNote(i: IngestResult): string {
  const bits: string[] = []
  if (i.fetched.length) bits.push(`read ${i.fetched.length} feed${i.fetched.length === 1 ? '' : 's'}`)
  if (i.waiting.length && !i.fetched.length) bits.push(`${i.waiting.length} feed${i.waiting.length === 1 ? '' : 's'} read recently (30 minute limit)`)
  if (i.skippedForTime.length) bits.push(`${i.skippedForTime.length} feed${i.skippedForTime.length === 1 ? '' : 's'} left for the next pass (time)`)
  if (i.stored) bits.push(`${i.stored} new item${i.stored === 1 ? '' : 's'}`)
  if (i.rejected) bits.push(`${i.rejected} refused (instruction-like text)`)
  if (i.failed.length) bits.push(`${i.failed.length} feed problem${i.failed.length === 1 ? '' : 's'} (${i.failed.map((f) => `${f.key}: ${f.error}`).join('; ').slice(0, 160)})`)
  return bits.join(', ')
}

/** Runs the news step. Returns null when the mode is off (silent: nothing in the pass record). Never throws. */
export async function runNewsStep(admin: SupabaseClient, deps: NewsRunDeps = {}): Promise<NewsStepResult | null> {
  const now = deps.now ?? new Date()
  const nowMs = now.getTime()
  const result: NewsStepResult = { ok: true, note: '', mode: 'draft', stored: 0, wrote: 0, published: 0, rejected: 0 }
  try {
    const mode = await getNewsMode(admin)
    result.mode = mode
    if (mode === 'off') return null
    if (await isAutomationPaused(admin)) return { ...result, note: 'automation is paused' }

    const ready = await newsTableReady(admin)
    if (!ready.ok) return { ...result, note: 'travel news needs one database update: run migration 0047 (supabase/migrations/0047_news_items.sql) in the Supabase SQL editor' }

    // 0: the CURRENT relevance rules over what is waiting (draft or publish mode alike), BEFORE the read, so an item that no
    // longer qualifies (a forecast discussion queued under older rules) neither becomes a candidate nor "covers" a storm.
    const requalified = await reevaluateItems(admin)

    // 1 + 2: read, filter, store, expire.
    const ingest = await ingestFeeds(admin, { fetchDeps: deps.fetchDeps, now, sources: deps.sources, deadlineMs: deps.deadlineMs })
    if (ingest.tableProblem) return { ...result, ok: false, note: `could not store news items (${ingest.tableProblem})` }
    result.stored = ingest.stored
    const expired = await expireOldItems(admin, now)
    const head = [ingestNote(ingest), expired ? `${expired} expired` : '', requalified ? `${requalified} no longer qualified` : ''].filter(Boolean).join(', ')
    const lead = head ? `${head}; ` : ''

    // 3 + 4: write.
    const perDay = await getNewsPerDay(admin)
    if (perDay === null) return { ...result, ok: false, note: `${lead}could not read the daily news number, so nothing was written` }
    if (perDay === 0) return { ...result, note: `${lead}writing is switched off (0 a day)` }
    const counts = await countToday(admin, now)
    if (!counts) return { ...result, ok: false, note: `${lead}could not count today's news posts, so nothing was written` }

    const publishing = mode === 'publish'
    const ping = deps.ping ?? pingIndexNow
    let budget: HealBudget | null = deps.budget ?? null
    const model = deps.model ?? (isAiConfigured() ? modelCallFor('travel-news') : null)
    const notes: string[] = []
    /** News may use at most HALF of the day's heal call cap (the other half stays for healing held pages). */
    const claimCall = async () => (await claimNewsSlot(admin, 'call', Math.max(1, Math.floor((budget?.cap ?? 0) / 2)), now)) === 'ok'

    const goLive = async (item: NewsItemRow, slug: string, title: string) => {
      const enrolled = await enrollNewsIfDue(admin, { slug, title, status: 'published' }, perDay)
      if (enrolled === 'ceiling') notes.push(`no social post for ${slug}: the shared daily limit of ${SOCIAL_ENROLMENTS_PER_DAY_CEILING} social posts (blog posts, guides and news together) is used up`)
      // A later bulletin of the same storm replaces the earlier live brief: mark the older ones "Update: superseded".
      for (const old of await olderStormItems(admin, item)) {
        if (old.status === 'published' && old.post_slug && (await markSuperseded(admin, old.post_slug, { title, slug }))) notes.push(`${old.post_slug} marked superseded`)
      }
      await Promise.resolve(ping([`/blog/${slug}`, '/blog', '/'])).catch(() => undefined)
    }

    // 3a: briefs that passed earlier and wait as drafts go live once the mode is publish, inside the daily limit. Each one is
    // checked AGAIN first: still fresh, still on the allowlist, the whole saved text (title, what happened, what it means, the
    // description) through the same gate, and the independent judge reads it once more.
    if (publishing && counts.published < perDay) {
      const { data: queuedRows } = await admin.from('news_items').select('*').eq('status', 'queued').not('post_slug', 'is', null).limit(50)
      const queued = ((queuedRows ?? []) as NewsItemRow[]).sort((a, b) => rank(a) - rank(b))
      for (const item of queued) {
        if (counts.published >= perDay) break
        const source = sourceByKey(item.source_key)
        if (!source || !source.enabled) {
          await setItem(admin, item.id, { status: 'rejected', reject_reason: 'the source is no longer on the allowlist', decided_at: now.toISOString() })
          result.rejected++
          continue
        }
        // Checked again right before going live (a rule may have changed since step 0, or the item was queued in between).
        if (!classifyItem(source, { title: item.title, summary: item.summary_raw }).relevant) {
          await setItem(admin, item.id, { status: 'expired', reject_reason: NO_LONGER_QUALIFIES_REASON })
          continue
        }
        if (itemStale(item, nowMs)) {
          await setItem(admin, item.id, { status: 'expired', reject_reason: 'too old to publish any more (36 hours for storms and breaking notices, 7 days for the rest); the draft was left as it is' })
          continue
        }
        const { data: post } = await admin.from('posts').select('title, body, status, meta_description').eq('slug', item.post_slug as string).maybeSingle()
        const p = post as { title: string; body: string; status: string; meta_description: string | null } | null
        const parsed = p ? parseNewsBody(p.body) : null
        if (!p || p.status !== 'draft' || !parsed || !/^News: /.test(p.title)) {
          notes.push(`a queued draft (${item.post_slug}) was left alone: it is gone, already live, or was edited out of shape`)
          continue
        }
        const facts = factsOf(item, source)
        const brief: NewsBrief = { headline: p.title.replace(/^News: /, ''), happened: parsed.happened, means: parsed.means }
        const problems = [
          ...briefProblems(brief, facts),
          ...((p.meta_description ?? '') === parsed.happened ? [] : [`description: it no longer matches the brief${lexicalProblems(p.meta_description ?? '', facts, { mask: isAttributed(p.meta_description ?? '', facts) }).map((x) => `; ${x}`).join('')}`]),
        ]
        if (problems.length) {
          await setItem(admin, item.id, { status: 'rejected', reject_reason: `the saved draft no longer passes the checks: ${problems[0]}`.slice(0, 300), decided_at: now.toISOString() })
          result.rejected++
          continue
        }
        if (!model) {
          notes.push('AI review is not configured, so queued drafts stay drafts')
          break
        }
        budget = budget ?? (await openBudget(admin, now))
        const review = await writeNewsBrief(facts, { model, budget, deadlineMs: deps.deadlineMs, claimCall, existing: brief })
        if (review.status === 'deferred') {
          notes.push(`waiting: ${review.reasons[0] ?? 'the review is not available'}`)
          break
        }
        if (review.status === 'rejected') {
          await setItem(admin, item.id, { status: 'rejected', reject_reason: reasonsText(review.reasons) || 'the independent review said no', decided_at: now.toISOString() })
          result.rejected++
          continue
        }
        if ((await claimNewsSlot(admin, 'live', perDay, now)) !== 'ok') break
        const live = await publishQueuedDraft(admin, item.post_slug as string, review.calls, now)
        if (!live.ok) {
          notes.push(`${item.post_slug}: ${live.note}`)
          continue
        }
        await setItem(admin, item.id, { status: 'published', decided_at: now.toISOString(), reject_reason: null })
        await goLive(item, item.post_slug as string, p.title)
        counts.published++
        result.published++
      }
    }

    // 3b: new items, best first: breaking official notices, other official notices, then trade news; newest first inside a group.
    const attemptsCap = perDay * 2
    if (counts.written < perDay && counts.attempts < attemptsCap && (!publishing || counts.published < perDay)) {
      const { data: newRows, error: newErr } = await admin.from('news_items').select('*').eq('status', 'new').limit(200)
      if (newErr) return { ...result, ok: false, note: `${lead}could not read the news items (${newErr.message})` }
      const candidates = ((newRows ?? []) as NewsItemRow[]).filter((r) => !itemStale(r, nowMs)).sort((a, b) => rank(a) - rank(b))
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
          // Atomic attempt slot (2 x the daily number): rejected briefs cost spend too, so they are capped as well.
          const attemptSlot = await claimNewsSlot(admin, 'attempt', attemptsCap, now)
          if (attemptSlot !== 'ok') {
            if (attemptSlot === 'error') notes.push('could not take a daily attempt slot, so nothing more was written')
            break
          }
          const facts = factsOf(item, source)
          const outcome = await writeNewsBrief(facts, { model, budget, deadlineMs: deps.deadlineMs, claimCall })
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
          const writeSlot = await claimNewsSlot(admin, 'write', perDay, now)
          if (writeSlot !== 'ok') break
          // Going live needs a live slot too; without one the brief is kept as a queued draft for tomorrow.
          const goNow = publishing && (await claimNewsSlot(admin, 'live', perDay, now)) === 'ok'
          // Only a LIVE older brief can be linked (a queued draft has no public page yet).
          const older = (await olderStormItems(admin, item)).find((o) => o.status === 'published')
          let supersedes: { title: string; slug: string } | undefined
          if (older?.post_slug) {
            const { data: oldPost } = await admin.from('posts').select('title').eq('slug', older.post_slug).maybeSingle()
            const t = (oldPost as { title: string } | null)?.title
            if (t) supersedes = { title: t, slug: older.post_slug }
          }
          const saved = await createNewsPost(admin, { item, facts, brief: outcome.brief, publish: goNow, calls: outcome.calls, stripped: outcome.stripped, supersedes, now })
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
            await goLive(item, saved.slug, newsTitle(outcome.brief.headline))
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
