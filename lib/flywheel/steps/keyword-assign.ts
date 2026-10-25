import type { SupabaseClient } from '@supabase/supabase-js'
import { isVetoed, logDecision, readJsonSetting, writeJsonSetting } from '@/lib/flywheel/ctx'
import type { FlywheelContext, FlywheelResult, FlywheelStep } from '@/lib/flywheel/types'
import { buildClusters, mechanicalPlanItem, removeDashes, type KeywordCluster } from '@/lib/keyword-cluster'
import type { ScoreKeyword, ScorePackage } from '@/lib/keyword-score'
import { readTrendPeaks } from '@/lib/keyword-ideas'
import { findSameMeaning, type MeaningDoc } from '@/lib/topic-meaning'
import { judgeTopicMeaning, loadMeaningContext } from '@/lib/topic-meaning-run'
import { fitTitle } from '@/lib/title-fit'
import { isNewsSlug } from '@/lib/news-post'
import { SITE_ID } from '@/lib/site'

// WP9: Keyword target-page auto-assignment (policy keyword_assign, docs/factory/AUTOPILOT-AUDIT.md "WP9").
//
// The gap: a keyword in keyword_research that has real Google demand (a recorded volume) and scored "Shoot for" (usable, not ranking,
// no page of ours targets it) never got a target. connectKeywordsToRankingPages only links keywords Google ALREADY shows us for.
//
// Each day, at most `ctx.room` (cap 5) of the best such keywords are handled, in score order, one of two ways:
//   1. ASSIGN: a page we already have (published blog post, published guide or destination, published package) says the same thing as
//      the keyword (lib/topic-meaning.ts, the strict "same" band). The keyword's target_path is set to that page. Only a null
//      target_path is ever filled, so a page someone chose by hand is never changed.
//   2. SUGGEST: no page covers it. A PENDING suggestion (status 'suggested', never approved) goes into the blog topic queue, made without
//      the AI from the keyword cluster (mechanicalPlanItem), with a title fitted to 60 characters (fitTitle). Skipped when the same-meaning
//      check (lib/topic-meaning-run.ts) says it duplicates a post or topic, when the keyword is already queued, or when the open queue is full.
//      A person still approves it, and the existing autoblog then writes it. (Guide and destination pages already get their drafts from
//      lib/guide-seeds.ts and lib/guide-plan.ts, which the daily guide step works through; once such a page is published, rule 1 links it.)
//
// Cost and safety: only keyword rows already cached in keyword_research are read. No DataForSEO, Search Console or AI-for-volume call is
// made here. Nothing is published. Both actions are logged with an Undo (kind fw:keyword_assign).
// "Handled once": app_settings.keyword_assign_done (keyword row id -> what was done), bounded.

export const DONE_KEY = 'keyword_assign_done'
/** A keyword needs at least this Google monthly volume to count as "has demand". */
export const MIN_VOLUME = 10
/** Do not add suggestions while this many topics already wait for a decision (same limit as the weekly keyword engine). */
export const OPEN_QUEUE_LIMIT = 12
/** A keyword skipped as a duplicate is looked at again after this many days. */
export const DUP_RECHECK_DAYS = 30
const MAX_DONE = 400
const MAX_ROWS = 2000
const SOURCE = 'keyword_assign'

type DoneResult = 'assigned' | 'queued' | 'dup'
interface DoneEntry {
  at: string
  result: DoneResult
  keyword?: string
  /** assigned: the path that was set. */
  path?: string
  /** queued: the blog_topic_queue row id. */
  topic?: string
  undone?: boolean
}
type DoneMap = Record<string, DoneEntry>

interface KwRow extends ScoreKeyword {
  id: string
  country?: string | null
}
interface PageDoc {
  path: string
  title: string
}

const bound = (m: DoneMap): DoneMap => {
  const keys = Object.keys(m)
  if (keys.length <= MAX_DONE) return m
  const keep = keys.sort((a, b) => (m[a].at < m[b].at ? -1 : 1)).slice(keys.length - MAX_DONE)
  return Object.fromEntries(keep.map((k) => [k, m[k]]))
}

const toTitle = (phrase: string): string => phrase.replace(/\b[a-z]/g, (c) => c.toUpperCase())

/** The fitted working title for a queued suggestion: dashes removed, at most 60 characters. Pure. */
export function suggestionTitle(cluster: Pick<KeywordCluster, 'primary'>): string {
  return fitTitle(removeDashes(toTitle(cluster.primary)))
}

/** The keyword rows worth handling, best first: a "Shoot for" topic whose primary phrase has demand and no target page, and which has not
 * been handled before (a duplicate skip is retried after DUP_RECHECK_DAYS). Pure. */
export function pickCandidates(rows: KwRow[], packages: ScorePackage[], done: DoneMap, now: Date, peaks: Record<string, { peak: number }> = {}): { row: KwRow; cluster: KeywordCluster }[] {
  const { clusters } = buildClusters(rows, packages, now, peaks)
  const byKeyword = new Map(rows.map((r) => [r.keyword, r]))
  const out: { row: KwRow; cluster: KeywordCluster }[] = []
  for (const c of clusters) {
    if (c.opportunity !== 'SHOOT_FOR') continue
    const row = byKeyword.get(c.primary)
    if (!row || !row.id || row.target_path) continue
    if ((row.volume ?? 0) < MIN_VOLUME) continue
    const d = done[row.id]
    if (d && !(d.result === 'dup' && now.getTime() - Date.parse(d.at) > DUP_RECHECK_DAYS * 86_400_000)) continue
    out.push({ row, cluster: c })
  }
  return out.sort((a, b) => b.cluster.score - a.cluster.score || (b.row.volume ?? 0) - (a.row.volume ?? 0))
}

/** A keyword is linked to an existing page only when the meaning score is this high, well above the "same" band (0.72) used to reject
 * duplicate topics: "greek isles cruise for singles" scores 0.85 against a page called "Greek Isles Cruise" and is a different search. */
export const ASSIGN_MIN_SCORE = 0.9

/** The existing page a keyword says the same thing as, or null. Strict: needs ASSIGN_MIN_SCORE. Pure. */
export function matchExistingPage(keyword: string, pages: PageDoc[]): PageDoc | null {
  if (!pages.length) return null
  const docs: MeaningDoc[] = pages.map((p) => ({ kind: 'post', slug: p.path, title: p.title, keyword: null }))
  const r = findSameMeaning({ keyword }, docs)
  if (r.band !== 'same' || !r.best || r.best.score < ASSIGN_MIN_SCORE) return null
  return pages.find((p) => p.path === r.best!.doc.slug) ?? null
}

async function loadPages(admin: SupabaseClient): Promise<{ pages: PageDoc[]; packages: ScorePackage[] } | { error: string }> {
  const pk = await admin.from('travel_packages').select('slug, name, destination, category, short_description, available_from, available_to').eq('status', 'published')
  if (pk.error) return { error: `could not read packages (${pk.error.message})` }
  const packages = ((pk.data ?? []) as (ScorePackage & { slug?: string })[]).filter((p) => !!p.slug)
  const pages: PageDoc[] = []
  const seen = new Set<string>()
  const add = (path: string, title: string | null | undefined) => {
    if (!title || seen.has(path)) return
    seen.add(path)
    pages.push({ path, title })
  }
  for (const p of packages as { slug: string; name?: string; destination?: string | null }[]) {
    add(`/packages/${p.slug}`, p.name)
    if (p.destination) add(`/destinations/${p.destination.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`, p.destination)
  }
  const gd = await admin.from('guides').select('kind, slug, name').eq('status', 'published')
  if (!gd.error) for (const g of (gd.data ?? []) as { kind: string; slug: string | null; name: string | null }[]) if (g.slug) add(`/${g.kind}/${g.slug}`, g.name)
  const ps = await admin.from('posts').select('slug, title').eq('status', 'published')
  if (!ps.error) for (const p of (ps.data ?? []) as { slug: string | null; title: string | null }[]) if (p.slug && !isNewsSlug(p.slug)) add(`/blog/${p.slug}`, p.title)
  return { pages, packages }
}

async function runKeywordAssign(ctx: FlywheelContext): Promise<FlywheelResult> {
  if (ctx.dryRun) return { ran: false, reason: 'dry run: nothing is written' }
  if (ctx.room <= 0) return { ran: false, reason: 'the daily limit is used up' }
  const { admin, now } = ctx

  // Cached research rows only. No vendor is called.
  const kw = await admin.from('keyword_research').select('id, keyword, volume, cpc, competition, gsc_impressions, gsc_position, target_path, note').eq('country', SITE_ID).limit(MAX_ROWS)
  if (kw.error) throw new Error(`could not read keywords (${kw.error.message})`)
  const rows = ((Array.isArray(kw.data) ? kw.data : []) as KwRow[]).filter((r) => r.keyword)
  if (!rows.length) return { ran: false, reason: 'no keywords are recorded yet' }

  const loaded = await loadPages(admin)
  if ('error' in loaded) throw new Error(loaded.error)

  const done = await readJsonSetting<DoneMap>(admin, DONE_KEY, {})
  const peaks = await readTrendPeaks(admin)
  const candidates = pickCandidates(rows, loaded.packages, done, now, peaks)
  if (!candidates.length) return { ran: false, reason: 'no keyword with demand is waiting for a page' }

  const q = await admin.from('blog_topic_queue').select('keyword, status')
  const queueRows = (q.error ? [] : (q.data ?? [])) as { keyword: string; status: string }[]
  const taken = new Set(queueRows.map((r) => r.keyword.toLowerCase()))
  let open = queueRows.filter((r) => r.status === 'suggested' || r.status === 'approved').length
  const meaning = await loadMeaningContext(admin, now)

  let assigned = 0
  let queued = 0
  let changed = false
  const failures: string[] = []
  const save = async (): Promise<boolean> => {
    const w = await writeJsonSetting(admin, DONE_KEY, bound(done))
    changed = false
    return !w.error
  }

  for (const { row, cluster } of candidates) {
    if (assigned + queued >= ctx.room) break
    if (ctx.remainingMs() < 2_000) break
    try {
      if (await isVetoed(admin, 'keyword_assign', row.keyword)) continue

      // 1. A page we already have says the same thing: link it.
      const page = matchExistingPage(row.keyword, loaded.pages)
      if (page) {
        const { error } = await admin.from('keyword_research').update({ target_path: page.path, updated_at: now.toISOString() }).eq('id', row.id).is('target_path', null)
        if (error) {
          failures.push(error.message)
          continue
        }
        assigned++
        done[row.id] = { at: now.toISOString(), result: 'assigned', keyword: row.keyword, path: page.path }
        const saved = await save()
        await logDecision(admin, 'keyword_assign', row.keyword, 'Gave a keyword its target page', `"${row.keyword}" (${row.volume} searches a month) says the same thing as ${page.path}, which had no keyword pointed at it.`, saved ? { kind: 'fw:keyword_assign', ref: row.id } : null, now)
        continue
      }

      // 2. Nothing covers it: queue a pending suggestion, unless it would be a duplicate or the queue is already full.
      if (taken.has(row.keyword.toLowerCase())) {
        done[row.id] = { at: now.toISOString(), result: 'dup', keyword: row.keyword }
        changed = true
        continue
      }
      const draft = mechanicalPlanItem(cluster)
      const title = suggestionTitle(cluster)
      if (meaning) {
        const v = await judgeTopicMeaning(admin, { keyword: draft.primary_keyword, angle: draft.angle, title }, meaning)
        if (v) {
          done[row.id] = { at: now.toISOString(), result: 'dup', keyword: row.keyword }
          changed = true
          continue
        }
      }
      if (open >= OPEN_QUEUE_LIMIT) {
        // Not marked done: it is picked up again once someone clears the queue.
        failures.push(`the topic queue already holds ${open} open ideas`)
        break
      }
      const insert: Record<string, unknown> = {
        angle: removeDashes(draft.angle),
        keyword: draft.primary_keyword,
        why: `Has demand (${row.volume} Google searches a month) and no page of ours targets it. Added by the keyword page step; a person decides.`,
        source: SOURCE,
        status: 'suggested',
        keywords: [draft.primary_keyword, ...draft.secondary_keywords],
        cluster_id: cluster.id,
        title_idea: title,
        score: Math.round(cluster.score),
      }
      if (draft.package_slug) insert.package_slug = draft.package_slug
      const { data, error } = await admin.from('blog_topic_queue').insert(insert).select('id').single()
      const topicId = (data as { id?: string } | null)?.id
      if (error || !topicId) {
        failures.push(error?.message ?? 'the topic was not saved')
        continue
      }
      queued++
      open++
      taken.add(row.keyword.toLowerCase())
      meaning?.docs.push({ kind: 'queued', slug: draft.primary_keyword, title: draft.angle, keyword: draft.primary_keyword, id: topicId })
      done[row.id] = { at: now.toISOString(), result: 'queued', keyword: row.keyword, topic: topicId }
      const saved = await save()
      await logDecision(admin, 'keyword_assign', row.keyword, 'Suggested a new topic for a keyword with no page', `"${row.keyword}" has ${row.volume} Google searches a month and no page. It is waiting in the topic queue as "${title}" for you to approve.`, saved ? { kind: 'fw:keyword_assign', ref: row.id } : null, now)
    } catch (e) {
      failures.push(e instanceof Error ? e.message : 'unknown error')
    }
  }
  if (changed) await save()

  const acted = assigned + queued
  if (acted === 0 && failures.length === 0) return { ran: false, reason: 'every waiting keyword was already covered or a duplicate' }
  if (acted === 0) return { ran: false, reason: `nothing was added (${failures[0]})` }
  const parts = [assigned ? `linked ${assigned} keyword${assigned === 1 ? '' : 's'} to a page` : '', queued ? `queued ${queued} suggested topic${queued === 1 ? '' : 's'}` : ''].filter(Boolean)
  return { ran: true, acted, note: `${parts.join(' and ')}${failures.length ? `, ${failures.length} problem${failures.length === 1 ? '' : 's'}` : ''}` }
}

async function undoKeywordAssign(admin: SupabaseClient, ref: string): Promise<{ ok: boolean; message: string }> {
  const done = await readJsonSetting<DoneMap>(admin, DONE_KEY, {})
  const e = done[ref]
  if (!e || (e.result !== 'assigned' && e.result !== 'queued')) return { ok: false, message: 'There is no record of this action, so it cannot be undone.' }
  if (e.undone) return { ok: false, message: 'This was already undone.' }

  if (e.result === 'assigned') {
    const { data, error } = await admin.from('keyword_research').select('id, target_path').eq('id', ref).maybeSingle()
    if (error) return { ok: false, message: `Could not read the keyword (${error.message}).` }
    if (!data) return { ok: false, message: 'That keyword is gone.' }
    const now = (data as { target_path: string | null }).target_path
    if (now !== e.path) return { ok: false, message: `The keyword's page is now ${now ?? 'empty'}, changed by a person, so it was left alone.` }
    const { error: e2 } = await admin.from('keyword_research').update({ target_path: null, updated_at: new Date().toISOString() }).eq('id', ref).eq('target_path', e.path as string)
    if (e2) return { ok: false, message: e2.message }
    done[ref] = { ...e, undone: true }
    await writeJsonSetting(admin, DONE_KEY, bound(done))
    return { ok: true, message: 'The keyword has no target page again. It will not be assigned again by itself.' }
  }

  const { data, error } = await admin.from('blog_topic_queue').select('id, status, used_slug').eq('id', e.topic).maybeSingle()
  if (error) return { ok: false, message: `Could not read the topic (${error.message}).` }
  if (!data) return { ok: false, message: 'That topic no longer exists.' }
  const t = data as { status: string; used_slug: string | null }
  if (t.status !== 'suggested' || t.used_slug) return { ok: false, message: t.used_slug ? 'A post was already written from this topic.' : `The topic is now ${t.status}, decided by a person, so it was left alone.` }
  const { error: e2 } = await admin.from('blog_topic_queue').delete().eq('id', e.topic).eq('status', 'suggested')
  if (e2) return { ok: false, message: e2.message }
  done[ref] = { ...e, undone: true }
  await writeJsonSetting(admin, DONE_KEY, bound(done))
  return { ok: true, message: 'The suggested topic was removed. The keyword will not be suggested again by itself.' }
}

export const keywordAssignStep: FlywheelStep = {
  id: 'keyword_assign',
  policy: 'keyword_assign',
  label: 'Keyword target-page auto-assignment',
  order: 90,
  floorMs: 10_000,
  run: runKeywordAssign,
  undo: undoKeywordAssign,
}
