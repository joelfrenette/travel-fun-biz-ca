import type { SupabaseClient } from '@supabase/supabase-js'
import { getSetting, setSetting } from '@/lib/app-settings'
import { SITE_ID } from '@/lib/site'
import { anthropicText, callAnthropic, isAiConfigured, parseModelJson } from '@/lib/ai-verify'
import { getAccountBalance, isKeywordDataConfigured, listKeywords, lookupKeywords, type KeywordCountry, type KeywordRow } from '@/lib/keywords'
import { claimKeywordWeek, KEYWORD_LAST_RUN_KEY, getKeywordBudget, logKeywordSpend, readKeywordRefreshInfo, refreshKeywordsIfDue, releaseKeywordWeek, runKeywordResearch, seedPhrases, spentLastWeek } from '@/lib/keyword-refresh'
import { collectIdeas, IDEAS_KEY, readIdeas, readTrendPeaks, refreshTrendPeaksIfDue } from '@/lib/keyword-ideas'
import { getSearchConsoleQueries, isSearchConsoleConfigured } from '@/lib/search-console'
import { rankedPageByKeyword } from '@/lib/keyword-pages'
import { listSitePages, type SitePage } from '@/lib/site-pages'
import type { ScorePackage } from '@/lib/keyword-score'
import { keywordSetOf, type BlogTopicQueueRow } from '@/lib/blog-topics'
import {
  buildClusters,
  chooseClustersToPlan,
  ENGINE_MIN_GAP_DAYS,
  isoWeekKey,
  mechanicalPlanItem,
  nextEngineRunAt,
  summarizeHistory,
  validatePlanItem,
  type ClassifiedKeyword,
  type KeywordCluster,
  type Opportunity,
  type PlanDraft,
  type PositionSummary,
  type RankHistoryPoint,
} from '@/lib/keyword-cluster'

// The keyword intelligence engine: one weekly run (and a "Run the engine now" button) that turns raw
// research into the end result on the Keyword Research page: which keywords we should shoot for, which
// we already rank for, and the next blog ideas, each with the keyword set the post is shooting for.
//
// Stages, each with its own cap (the dollar cap is autopilot_keyword_budget_usd, shared with the older
// weekly research, counted from the spend log over the last 7 days):
//   1 SEEDS    free. Seed phrases from real trips, customer questions and published guides, plus up to
//              MAX_TRACK_FROM_SEARCH_CONSOLE new phrases Google already shows us for.
//   2 EXPAND   paid, within the budget. DataForSEO keyword ideas for 3 seeds (lib/keyword-refresh.ts), then
//              autocomplete / People Also Ask / Reddit ideas (own cap of 5 cents, lib/keyword-ideas.ts), then
//              Google Trends peaks (own 90-day cadence). New ideas are tracked for free, up to MAX_TRACK_FROM_IDEAS.
//   3 ENRICH   Search Console numbers on every tracked phrase (free) and ONE batched DataForSEO volume lookup
//              for up to MAX_LOOKUP_PHRASES never-looked-up phrases, only when LOOKUP_MIN_BUDGET_USD is left.
//   4 CLUSTER  free, pure (lib/keyword-cluster.ts): topics, intent, funnel stage, opportunity labels.
//   5 PLAN     ONE Anthropic call, at most PLAN_SIZE topics, checked in plain code; skipped when the idea queue
//              already holds MAX_OPEN_IDEAS open ideas.
//   6 TRACK    free. Writes the verdict onto every research row and saves the new ideas as `suggested`.
// Everything is read tolerantly: before migration 0032 is applied nothing new is written, the older weekly
// research keeps running, and the run says "run migration 0032" instead of failing silently.
export const ENGINE_LAST_KEY = 'keyword_engine_last'
const ENGINE_LOCK_KEY = 'keyword_engine_running'
export const PLAN_SIZE = 6
export const MAX_OPEN_IDEAS = 12
export const MAX_TRACK_FROM_SEARCH_CONSOLE = 40
export const MAX_TRACK_FROM_IDEAS = 40
export const MAX_LOOKUP_PHRASES = 200
export const LOOKUP_MIN_BUDGET_USD = 0.1
export const IDEAS_MIN_BUDGET_USD = 0.05
export const TRENDS_MIN_BUDGET_USD = 0.05
const PLAN_MAX_TOKENS = 3000 // callAnthropic raises any smaller cap to its own floor
/** The slow optional paid lookups (autocomplete / questions / trends) are skipped once a run is this old, so a
 * run always leaves room for the plan and stays well inside the 300 second route limit. */
export const ENGINE_SOFT_LIMIT_MS = 80_000
const LOCK_STALE_MS = 10 * 60_000
const WRITE_CHUNK = 10
const BRAND_QUERY = /travel\s*fun\s*biz|travelfunbiz/i
const COUNTRY = SITE_ID as KeywordCountry
const EPOCH_MS = 0

export type EngineStageName = 'SEEDS' | 'EXPAND' | 'ENRICH' | 'CLUSTER' | 'PLAN' | 'TRACK'

export interface EngineStage {
  stage: EngineStageName
  ok: boolean
  note: string
  spentUsd: number
}

export interface EngineRun {
  at: string
  trigger: 'schedule' | 'button'
  ok: boolean
  /** One plain sentence for the pipeline log and the page. */
  note: string
  stages: EngineStage[]
  spentUsd: number
  ideasAdded: number
  needsMigration: boolean
}

const MIGRATION_NOTE = 'Run migration 0032 (supabase/migrations/0032_keyword_intel.sql) in the Supabase SQL editor. Until then the keyword engine cannot save its results.'

const errMsg = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback)
const roundUsd = (n: number) => Math.round(n * 1e4) / 1e4
const spentIn = (note: string | null) => Number(/spent about \$([0-9.]+)/.exec(note ?? '')?.[1] ?? 0) || 0

// ---- state ---------------------------------------------------------------------------------------------

export async function readEngineRun(admin: SupabaseClient): Promise<EngineRun | null> {
  try {
    const v = JSON.parse((await getSetting(admin, ENGINE_LAST_KEY)) ?? 'null')
    return v && typeof v === 'object' && typeof v.at === 'string' ? (v as EngineRun) : null
  } catch {
    return null
  }
}

/** Once migration 0032 is applied, a saved "run the migration" note is stale: forget it, so the Needs attention
 * item clears and the engine may run this week. Call only after migrationReady() passed. */
async function clearStaleMigrationNote(admin: SupabaseClient, last: EngineRun | null): Promise<EngineRun | null> {
  if (!last?.needsMigration) return last
  await admin.from('app_settings').delete().eq('key', ENGINE_LAST_KEY)
  return null
}

async function saveEngineRun(admin: SupabaseClient, run: EngineRun): Promise<void> {
  try {
    await setSetting(admin, ENGINE_LAST_KEY, JSON.stringify(run))
  } catch {
    // the page just shows no "last run"
  }
}

/** Is migration 0032 applied? Reads one row of each table with the new columns. */
export async function migrationReady(admin: SupabaseClient): Promise<{ ready: boolean; detail?: string }> {
  const a = await admin.from('keyword_research').select('cluster_id, intent, opportunity, score, score_reasons, engine_updated_at').limit(1)
  if (a.error) return { ready: false, detail: a.error.message }
  const b = await admin.from('blog_topic_queue').select('keywords, cluster_id, title_idea, score').limit(1)
  if (b.error) return { ready: false, detail: b.error.message }
  return { ready: true }
}

/** One engine run at a time: an insert-or-take-over-if-stale lock, so the button and the schedule cannot overlap. */
async function acquireRunLock(admin: SupabaseClient): Promise<boolean> {
  const now = new Date()
  const iso = now.toISOString()
  const { error } = await admin.from('app_settings').insert({ key: ENGINE_LOCK_KEY, value: iso })
  if (!error) return true
  if ((error as { code?: string }).code !== '23505') return false
  const cutoff = new Date(now.getTime() - LOCK_STALE_MS).toISOString()
  const { data } = await admin.from('app_settings').update({ value: iso, updated_at: iso }).eq('key', ENGINE_LOCK_KEY).lt('value', cutoff).select('key')
  return !!data?.length
}

async function releaseRunLock(admin: SupabaseClient): Promise<void> {
  await admin.from('app_settings').delete().eq('key', ENGINE_LOCK_KEY)
}

// ---- search console on tracked rows (moved here from the search-data route; Google only) ---------------

/** Writes the last 28 days of Search Console numbers onto every tracked phrase. */
export async function refreshSearchConsoleRows(admin: SupabaseClient): Promise<{ tracked: number; updated: number; errors: string[] }> {
  const tracked = await listKeywords()
  const errors: string[] = []
  let updated = 0
  const now = new Date().toISOString()
  try {
    const byQuery = new Map((await getSearchConsoleQueries(28)).map((r) => [r.query, r]))
    for (let i = 0; i < tracked.length; i += WRITE_CHUNK) {
      await Promise.all(
        tracked.slice(i, i + WRITE_CHUNK).map(async (k) => {
          const r = byQuery.get(k.keyword)
          const { error } = await admin
            .from('keyword_research')
            .update({ gsc_clicks: r?.clicks ?? 0, gsc_impressions: r?.impressions ?? 0, gsc_position: r ? Math.round(r.position * 10) / 10 : null, gsc_fetched_at: now, updated_at: now })
            .eq('id', k.id)
          if (error) errors.push(`Search Console save for "${k.keyword}": ${error.message}`)
          else updated += 1
        }),
      )
    }
  } catch (e) {
    errors.push(errMsg(e, 'Search Console failed'))
  }
  return { tracked: tracked.length, updated, errors }
}

/** Starts tracking phrases for free (no lookup, no spend). Existing phrases are left untouched. */
async function trackPhrases(admin: SupabaseClient, phrases: string[]): Promise<number> {
  if (!phrases.length) return 0
  const now = new Date().toISOString()
  const rows = phrases.map((keyword) => ({ keyword, country: COUNTRY, fetched_at: new Date(EPOCH_MS).toISOString(), updated_at: now }))
  const { data, error } = await admin.from('keyword_research').upsert(rows, { onConflict: 'keyword,country', ignoreDuplicates: true }).select('keyword')
  if (error) throw new Error(error.message)
  return data?.length ?? 0
}

// ---- the plan: one AI call -----------------------------------------------------------------------------

interface PackageInfo {
  slug: string
  name: string
  destination: string | null
  category: string | null
  short_description: string | null
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()

function planPrompt(chosen: KeywordCluster[], volumes: Map<string, number | null>, packages: Map<string, PackageInfo>): string {
  const blocks = chosen.map((c, i) => {
    const pkg = c.packageSlug ? packages.get(c.packageSlug) : undefined
    const vol = volumes.get(c.primary)
    return [
      `${i + 1}. Main phrase: "${c.primary}"`,
      `   Other phrases of the same topic (copy exactly): ${c.secondary.length ? c.secondary.map((s) => `"${s}"`).join(', ') : '(none)'}`,
      `   What the searcher wants: ${c.intent}`,
      `   Google searches a month for the main phrase: ${vol != null && vol > 0 ? vol : 'not reported'}`,
      `   Real package we sell that matches: ${pkg ? `slug "${pkg.slug}", ${pkg.name}${pkg.destination ? `, ${pkg.destination}` : ''}${pkg.category ? ` (${pkg.category})` : ''}${pkg.short_description ? `. ${pkg.short_description}` : ''}` : 'none'}`,
    ].join('\n')
  })
  return `You plan blog posts for a travel agency's site (hosted group trips, river and ocean cruises, singles getaways). Below are topics people search for on Google. Write ONE blog post idea for EACH topic.

${blocks.join('\n\n')}

Rules:
- Never claim personal experience or a past trip. Never state a price, a date, availability, a count, a distance or a statistic. Do not put digits in any field unless the digits are already in the phrases or the package text above.
- primary_keyword must be the main phrase, copied exactly.
- secondary_keywords: 3 to 6 phrases, chosen ONLY from the "other phrases" of that same topic, copied exactly. If a topic lists fewer than 3, use all it lists.
- package_slug: the slug shown for that topic, or null when it says none. Never invent a slug.
- title_idea: a clear working headline, 10 to 100 characters, for a real person deciding whether and which trip to book. angle: one sentence (20 to 300 characters) saying what the post covers and what it helps the reader decide. who_for: who the post is for, under 120 characters.
- Never use the long dash character; use commas or full stops.

Return ONLY minified JSON of this exact shape, nothing else:
{"ideas":[{"primary_keyword":"...","title_idea":"...","angle":"...","secondary_keywords":["..."],"who_for":"...","package_slug":null}]}`
}

/** Asks for the ideas (one call) and checks each one in plain code. A topic whose idea is missing or fails a
 * check still becomes an idea, written without the AI, so a good topic is never lost to a model slip. */
async function writePlan(chosen: KeywordCluster[], volumes: Map<string, number | null>, packages: Map<string, PackageInfo>): Promise<{ items: { cluster: KeywordCluster; draft: PlanDraft; byAi: boolean }[]; notes: string[] }> {
  const notes: string[] = []
  const validSlugs = new Set(packages.keys())
  const answers = new Map<string, unknown>()
  if (!chosen.length) return { items: [], notes }
  if (!isAiConfigured()) {
    notes.push('the AI key is not set, so the ideas were written without the AI')
  } else {
    try {
      const r = await callAnthropic({ max_tokens: PLAN_MAX_TOKENS, messages: [{ role: 'user', content: planPrompt(chosen, volumes, packages) }] }, { timeoutMs: 60_000 })
      if (!r || !r.res.ok) {
        notes.push(`the AI call failed${r ? ` (status ${r.res.status})` : ''}, so the ideas were written without the AI`)
      } else {
        const data = await r.res.json()
        if ((data as { stop_reason?: string })?.stop_reason === 'max_tokens') notes.push('the AI answer was cut off, so the ideas were written without the AI')
        else {
          const parsed = parseModelJson<{ ideas?: unknown[] }>(anthropicText(data))
          if (!parsed || !Array.isArray(parsed.ideas)) notes.push('the AI answer was not usable, so the ideas were written without the AI')
          else
            for (const idea of parsed.ideas) {
              const key = norm(typeof (idea as { primary_keyword?: unknown })?.primary_keyword === 'string' ? (idea as { primary_keyword: string }).primary_keyword : '')
              if (key && !answers.has(key)) answers.set(key, idea)
            }
        }
      }
    } catch (e) {
      notes.push(`the AI call failed (${errMsg(e, 'error')}), so the ideas were written without the AI`)
    }
  }
  const items = chosen.map((cluster) => {
    const raw = answers.get(norm(cluster.primary))
    if (raw) {
      const pkg = cluster.packageSlug ? packages.get(cluster.packageSlug) : undefined
      const packageText = pkg ? `${pkg.name} ${pkg.destination ?? ''} ${pkg.short_description ?? ''}` : ''
      const checked = validatePlanItem(raw, cluster, validSlugs, packageText)
      if (checked.ok) return { cluster, draft: checked.item, byAi: true }
      notes.push(`"${cluster.primary}": ${checked.problems.join('; ')}, so that idea was written without the AI`)
    }
    return { cluster, draft: mechanicalPlanItem(cluster), byAi: false }
  })
  return { items, notes }
}

// ---- the run -------------------------------------------------------------------------------------------

async function guideSeeds(admin: SupabaseClient): Promise<string[]> {
  const { data, error } = await admin.from('guides').select('kind, name').eq('status', 'published').limit(60)
  if (error) return []
  const seeds = new Set<string>()
  for (const g of (data ?? []) as { kind: string; name: string | null }[]) {
    const name = g.name?.trim().toLowerCase()
    if (name) seeds.add(`${name} ${['cruise-lines', 'ships', 'river-cruises', 'yachts'].includes(g.kind) ? 'cruise' : 'group trip'}`)
  }
  return [...seeds].sort()
}

/** The whole engine, once. `force` (the button) ignores the weekly cadence and cooldown but never the dollar
 * budget. The weekly claim, if any, is made by the caller (runKeywordEngineIfDue). */
export async function runKeywordEngine(admin: SupabaseClient, opts: { force?: boolean; claimKey?: string } = {}): Promise<EngineRun> {
  const trigger = opts.force ? 'button' : 'schedule'
  const run: EngineRun = { at: new Date().toISOString(), trigger, ok: true, note: '', stages: [], spentUsd: 0, ideasAdded: 0, needsMigration: false }
  const stage = (name: EngineStageName, ok: boolean, note: string, spentUsd = 0) => {
    run.stages.push({ stage: name, ok, note, spentUsd: roundUsd(spentUsd) })
    run.spentUsd = roundUsd(run.spentUsd + spentUsd)
    if (!ok) run.ok = false
  }

  const mig = await migrationReady(admin)
  if (!mig.ready) {
    run.ok = false
    run.needsMigration = true
    run.note = `${MIGRATION_NOTE} (${mig.detail ?? 'columns missing'}) Nothing was spent.`
    if (opts.claimKey) await releaseKeywordWeek(admin, opts.claimKey)
    await saveEngineRun(admin, run)
    return run
  }
  if (!(await acquireRunLock(admin))) {
    run.ok = false
    run.note = 'The keyword engine is already running. Wait a few minutes and look again.'
    if (opts.claimKey) await releaseKeywordWeek(admin, opts.claimKey)
    return run
  }

  const researchedSeeds: string[] = []
  let addedKeywords = 0
  try {
    const budget = await getKeywordBudget(admin)
    const before = spentLastWeek((await readKeywordRefreshInfo(admin)).log)
    let remaining = Math.max(0, budget - before)
    const dataforseo = isKeywordDataConfigured()
    const searchConsole = isSearchConsoleConfigured()
    // Every paid stage writes its own spend-log line the moment it finishes, so a kill or a throw later in
    // the run can never hide spend from the next press of the button.
    const logSpend = async (usd: number, added: number, seeds: string[]) => {
      if (usd > 0 || added > 0 || seeds.length) await logKeywordSpend(admin, { at: new Date().toISOString(), spentUsd: roundUsd(usd), added, seeds })
    }
    const startedAt = Date.now()
    const late = () => Date.now() - startedAt > ENGINE_SOFT_LIMIT_MS
    const canSpend = () => dataforseo && remaining > 0
    const spend = (usd: number) => {
      remaining = Math.max(0, remaining - usd)
    }

    // 1 SEEDS
    let seedPool: string[] = []
    let gscCandidates: string[] = []
    try {
      const [tripSeeds, guides] = await Promise.all([seedPhrases(admin), guideSeeds(admin)])
      seedPool = [...new Set([...tripSeeds, ...guides])].sort()
      if (searchConsole) {
        const { data: have } = await admin.from('keyword_research').select('keyword').eq('country', COUNTRY)
        const known = new Set((have ?? []).map((r: { keyword: string }) => r.keyword))
        gscCandidates = (await getSearchConsoleQueries(28))
          .filter((q) => q.impressions > 0 && !known.has(q.query) && !BRAND_QUERY.test(q.query) && q.query.split(' ').length >= 2)
          .sort((a, b) => b.impressions - a.impressions)
          .slice(0, MAX_TRACK_FROM_SEARCH_CONSOLE)
          .map((q) => q.query)
        await trackPhrases(admin, gscCandidates)
      }
      stage('SEEDS', true, `${seedPool.length} seed phrase${seedPool.length === 1 ? '' : 's'} from trips, customer questions and guides; ${searchConsole ? `${gscCandidates.length} new phrase${gscCandidates.length === 1 ? '' : 's'} Google already shows us for` : 'Search Console is not connected'}`)
    } catch (e) {
      stage('SEEDS', false, errMsg(e, 'seeds failed'))
    }

    // 2 EXPAND
    {
      const notes: string[] = []
      let spent = 0
      let ok = true
      if (!dataforseo) notes.push('DataForSEO is not connected, so no paid research')
      else if (remaining <= 0) notes.push(budget <= 0 ? 'the weekly budget is $0, so no paid research' : 'this week\'s budget is used up, so no paid research')
      else {
        try {
          const r = await runKeywordResearch(admin, { budgetLeftUsd: remaining, seedPool })
          spent += r.spent
          spend(r.spent)
          await logSpend(r.spent, r.added, r.seeds)
          addedKeywords += r.added
          researchedSeeds.push(...r.seeds)
          notes.push(`keyword ideas for ${r.seeds.length} seed${r.seeds.length === 1 ? '' : 's'}, ${r.added} new phrase${r.added === 1 ? '' : 's'}`)
          if (r.error) {
            ok = false
            notes.push(`research stopped: ${r.error}`)
          }
        } catch (e) {
          ok = false
          notes.push(`research failed: ${errMsg(e, 'error')}`)
        }
        if (late()) notes.push('autocomplete and question ideas wait for the next run (this one is running long)')
        else if (remaining >= IDEAS_MIN_BUDGET_USD) {
          try {
            const note = await collectIdeas(admin, { force: true })
            const cost = spentIn(note)
            spent += cost
            spend(cost)
            await logSpend(cost, 0, [])
            if (note) notes.push(note)
          } catch (e) {
            ok = false
            notes.push(`ideas failed: ${errMsg(e, 'error')}`)
          }
        } else notes.push('not enough budget left for autocomplete and question ideas')
        if (!late() && remaining >= TRENDS_MIN_BUDGET_USD) {
          try {
            const note = await refreshTrendPeaksIfDue(admin, { budgetUsd: remaining })
            const cost = spentIn(note)
            spent += cost
            spend(cost)
            await logSpend(cost, 0, [])
            if (note) notes.push(note)
          } catch (e) {
            ok = false
            notes.push(`trends failed: ${errMsg(e, 'error')}`)
          }
        }
      }
      // Ideas become tracked phrases for free; they are looked up in one batch below.
      try {
        const ideas = (await readIdeas(admin)).slice(0, MAX_TRACK_FROM_IDEAS)
        if (ideas.length) {
          const tracked = await trackPhrases(admin, ideas.map((i) => i.phrase))
          const taken = new Set(ideas.map((i) => i.phrase))
          await setSetting(admin, IDEAS_KEY, JSON.stringify((await readIdeas(admin)).filter((i) => !taken.has(i.phrase))))
          notes.push(`${tracked} idea${tracked === 1 ? '' : 's'} added to the list`)
        }
      } catch (e) {
        ok = false
        notes.push(`could not add ideas to the list: ${errMsg(e, 'error')}`)
      }
      stage('EXPAND', ok, notes.join('; ') || 'nothing to expand', spent)
    }

    // 3 ENRICH
    {
      const notes: string[] = []
      let spent = 0
      let ok = true
      if (searchConsole) {
        try {
          const r = await refreshSearchConsoleRows(admin)
          notes.push(`Search Console numbers updated on ${r.updated} of ${r.tracked} phrases`)
          if (r.errors.length) {
            ok = false
            notes.push(r.errors.slice(0, 2).join(' | '))
          }
        } catch (e) {
          ok = false
          notes.push(`Search Console failed: ${errMsg(e, 'error')}`)
        }
      } else notes.push('Search Console is not connected')
      if (canSpend() && remaining >= LOOKUP_MIN_BUDGET_USD) {
        try {
          const { data } = await admin.from('keyword_research').select('keyword, volume, fetched_at').eq('country', COUNTRY).is('volume', null)
          const never = ((data ?? []) as { keyword: string; fetched_at: string }[]).filter((r) => new Date(r.fetched_at).getTime() === EPOCH_MS).map((r) => r.keyword).slice(0, MAX_LOOKUP_PHRASES)
          if (never.length) {
            const res = await lookupKeywords(never, COUNTRY)
            spent += res.costUsd
            spend(res.costUsd)
            await logSpend(res.costUsd, 0, [])
            notes.push(`Google volume looked up for ${res.fetched} phrase${res.fetched === 1 ? '' : 's'} in one batch${res.skipped?.length ? ` (${res.skipped.length} too long for Google Ads, left out)` : ''}`)
            // A phrase Google Ads will never price is marked so the engine stops offering it for lookup.
            if (res.skipped?.length) {
              await admin.from('keyword_research').update({ fetched_at: new Date().toISOString(), note: 'not accepted for a Google volume lookup (over 10 words, or a symbol in the phrase)' }).eq('country', COUNTRY).in('keyword', res.skipped).is('volume', null)
            }
          } else notes.push('every phrase already has its Google volume')
        } catch (e) {
          ok = false
          notes.push(`volume lookup failed: ${errMsg(e, 'error')}`)
        }
      } else if (dataforseo) notes.push('not enough budget left for a volume lookup')
      stage('ENRICH', ok, notes.join('; '), spent)
    }

    // 4 CLUSTER
    let rows: KeywordRow[] = []
    let clusters: KeywordCluster[] = []
    let classified: ClassifiedKeyword[] = []
    let packages: PackageInfo[] = []
    try {
      const [{ data: pk }, peaks, all] = await Promise.all([
        admin.from('travel_packages').select('slug, name, destination, category, short_description, available_from, available_to').eq('status', 'published'),
        readTrendPeaks(admin),
        listKeywords(),
      ])
      rows = all.filter((r) => r.country === COUNTRY)
      packages = ((pk ?? []) as (PackageInfo & { available_from: string | null; available_to: string | null })[]).filter((p) => !!p.slug)
      const built = buildClusters(rows, (pk ?? []) as ScorePackage[], new Date(), peaks)
      clusters = built.clusters
      classified = built.keywords
      const count = (o: Opportunity) => clusters.filter((c) => c.opportunity === o).length
      stage('CLUSTER', true, `${rows.length} phrases in ${clusters.length} topics: ${count('RANKING')} ranking, ${count('ALMOST')} almost, ${count('SHOOT_FOR')} to shoot for, ${count('TARGETED')} with a page, ${count('SKIP')} skipped`)
    } catch (e) {
      stage('CLUSTER', false, errMsg(e, 'clustering failed'))
    }

    // 5 PLAN
    let planned: { cluster: KeywordCluster; draft: PlanDraft; byAi: boolean }[] = []
    if (clusters.length) {
      try {
        const [postsRes, queueRes] = await Promise.all([
          admin.from('posts').select('title, primary_keyword, secondary_keywords').limit(400),
          admin.from('blog_topic_queue').select('keyword, keywords, cluster_id, status').limit(500),
        ])
        const posts = postsRes.error ? (((await admin.from('posts').select('title').limit(400)).data ?? []) as { title: string }[]) : ((postsRes.data ?? []) as { title: string; primary_keyword: string | null; secondary_keywords: string[] | null }[])
        const queue = (queueRes.data ?? []) as { keyword: string; keywords: string[] | null; cluster_id: string | null; status: string }[]
        const open = queue.filter((q) => q.status === 'suggested' || q.status === 'approved').length
        const room = MAX_OPEN_IDEAS - open
        if (room <= 0) stage('PLAN', true, `the idea queue already holds ${open} open ideas (the limit is ${MAX_OPEN_IDEAS}); approve or reject some and run again`)
        else {
          const { chosen, skipped } = chooseClustersToPlan(clusters, { posts, queue }, Math.min(PLAN_SIZE, room))
          const volumes = new Map(rows.map((r) => [r.keyword, r.volume]))
          const bySlug = new Map(packages.map((p) => [p.slug, p]))
          const written = await writePlan(chosen, volumes, bySlug)
          planned = written.items
          const aiCount = planned.filter((p) => p.byAi).length
          stage('PLAN', true, `${planned.length} idea${planned.length === 1 ? '' : 's'} planned (${aiCount} written with one AI call, ${planned.length - aiCount} without)${skipped.length ? `; ${skipped.length} topic${skipped.length === 1 ? '' : 's'} left out as duplicates` : ''}${written.notes.length ? `; ${written.notes.slice(0, 3).join('; ')}` : ''}`)
        }
      } catch (e) {
        stage('PLAN', false, errMsg(e, 'planning failed'))
      }
    } else stage('PLAN', true, 'no topics to plan from')

    // 6 TRACK
    try {
      const now = new Date().toISOString()
      const byKeyword = new Map(classified.map((c) => [c.keyword, c]))
      const stale = rows.filter((r) => {
        const c = byKeyword.get(r.keyword)
        if (!c) return false
        const x = r as KeywordRow & { cluster_id?: string | null; intent?: string | null; opportunity?: string | null; score?: number | null; score_reasons?: string[] | null; engine_updated_at?: string | null }
        return !x.engine_updated_at || x.cluster_id !== c.clusterId || x.intent !== c.intent || x.opportunity !== c.opportunity || x.score !== c.score || JSON.stringify(x.score_reasons ?? []) !== JSON.stringify([c.reason, ...c.reasons.filter((s) => s !== c.reason)])
      })
      let written = 0
      let failed = 0
      for (let i = 0; i < stale.length; i += WRITE_CHUNK) {
        await Promise.all(
          stale.slice(i, i + WRITE_CHUNK).map(async (r) => {
            const c = byKeyword.get(r.keyword) as ClassifiedKeyword
            const { error } = await admin
              .from('keyword_research')
              .update({ cluster_id: c.clusterId, intent: c.intent, opportunity: c.opportunity, score: c.score, score_reasons: [c.reason, ...c.reasons.filter((s) => s !== c.reason)], engine_updated_at: now })
              .eq('id', r.id)
            if (error) failed++
            else written++
          }),
        )
      }
      let queued = 0
      let duplicates = 0
      for (const p of planned) {
        const keywords = [p.draft.primary_keyword, ...p.draft.secondary_keywords]
        const pkg = p.draft.package_slug ? packages.find((x) => x.slug === p.draft.package_slug) : undefined
        const volume = rows.find((r) => r.keyword === p.cluster.primary)?.volume
        const why = `Topic score ${p.cluster.score}/100${volume ? `, ${volume} Google searches a month for the main phrase` : ''}${p.draft.who_for ? `. For: ${p.draft.who_for}` : ''}${pkg ? `. Sells: ${pkg.name}` : ''}`
        const { error } = await admin.from('blog_topic_queue').insert({
          angle: p.draft.angle,
          keyword: p.draft.primary_keyword,
          why,
          source: p.byAi ? 'keyword engine' : 'keyword engine (no AI)',
          status: 'suggested',
          keywords,
          cluster_id: p.cluster.id,
          title_idea: p.draft.title_idea,
          score: p.cluster.score,
        })
        if (!error) queued++
        else if ((error as { code?: string }).code === '23505') duplicates++
        else throw new Error(`could not save an idea: ${error.message}`)
      }
      run.ideasAdded = queued
      stage('TRACK', failed === 0, `${written} of ${rows.length} phrases updated${failed ? `, ${failed} failed` : ''}; ${queued} new blog idea${queued === 1 ? '' : 's'} saved${duplicates ? ` (${duplicates} already queued)` : ''}`)
    } catch (e) {
      stage('TRACK', false, errMsg(e, 'saving failed'))
    }

    // Spend was already logged stage by stage. "Last ran" is only a stamp: it never goes into the spend log.
    await setSetting(admin, KEYWORD_LAST_RUN_KEY, new Date().toISOString())
    const failedStages = run.stages.filter((s) => !s.ok)
    run.note = failedStages.length
      ? `Keyword engine finished with ${failedStages.length} problem${failedStages.length === 1 ? '' : 's'}: ${failedStages.map((s) => `${s.stage}: ${s.note}`).slice(0, 2).join(' | ')}`
      : `Keyword engine ran: ${run.stages.find((s) => s.stage === 'CLUSTER')?.note ?? ''}. ${run.ideasAdded} new blog idea${run.ideasAdded === 1 ? '' : 's'}. Spent about $${run.spentUsd.toFixed(2)} of $${budget}/week.`
  } catch (e) {
    run.ok = false
    run.note = `Keyword engine stopped: ${errMsg(e, 'unknown error')}`
    // Nothing was spent and it never got going: give the week back so the next pass can try again.
    if (opts.claimKey && run.spentUsd === 0) await releaseKeywordWeek(admin, opts.claimKey)
  } finally {
    await releaseRunLock(admin)
  }
  await saveEngineRun(admin, run)
  return run
}

/** Called on every pipeline pass; does something at most once a week. Returns null when nothing was due
 * (so quiet passes add no noise), otherwise the run. The week is claimed atomically BEFORE any spend. */
export async function runKeywordEngineIfDue(admin: SupabaseClient): Promise<EngineRun | null> {
  const budget = await getKeywordBudget(admin)
  if (budget <= 0) return null // a $0 budget turns the weekly engine off, as it always turned the weekly research off
  const mig = await migrationReady(admin)
  if (!mig.ready) {
    // Keep the older weekly research and ideas running, and say loudly that the migration is missing.
    // Only the older budgeted weekly research keeps running. Autocomplete/question ideas and trends are skipped
    // until 0032 is applied: they sit outside the spend log, so running them unattended every 15 minutes is not safe.
    const notes = [await refreshKeywordsIfDue(admin).catch(() => null)].filter(Boolean)
    const run: EngineRun = { at: new Date().toISOString(), trigger: 'schedule', ok: false, needsMigration: true, spentUsd: 0, ideasAdded: 0, stages: [], note: `${MIGRATION_NOTE} (${mig.detail ?? 'columns missing'})${notes.length ? ` Meanwhile the older weekly research ran: ${notes.join(' | ')}` : ''}` }
    const previous = await readEngineRun(admin)
    if (!previous || previous.note !== run.note) await saveEngineRun(admin, run)
    return run
  }
  const last = await clearStaleMigrationNote(admin, await readEngineRun(admin))
  const lastAt = last ? Date.parse(last.at) : NaN
  // Independent of the week claim: never again within ENGINE_MIN_GAP_DAYS of the last finished run.
  if (Number.isFinite(lastAt) && last && !last.needsMigration && last.stages.length > 0 && Date.now() - lastAt < ENGINE_MIN_GAP_DAYS * 86_400_000) return null
  const logged = (await readKeywordRefreshInfo(admin)).log
  if (spentLastWeek(logged) >= budget) return null
  const claim = await claimKeywordWeek(admin, isoWeekKey(new Date()))
  if (claim === 'taken') return null
  if (claim === 'error') return { at: new Date().toISOString(), trigger: 'schedule', ok: false, needsMigration: false, spentUsd: 0, ideasAdded: 0, stages: [], note: 'Keyword engine could not claim its week, so it did not run (nothing was spent).' }
  return runKeywordEngine(admin, { force: false, claimKey: claim.key })
}

// ---- ranking progress ----------------------------------------------------------------------------------

const HISTORY_DAYS = 40
const HISTORY_CHUNK = 20 // 20 phrases x 40 days stays under the 1000-row page limit

/** Current Google position, the change vs about 7 and 28 days ago, and clicks, per phrase, from the daily
 * ranking snapshots (gsc_rankings, one row per busy query per day). Phrases the snapshots never saw are
 * simply absent from the map; the caller falls back to the research row's own Search Console numbers. */
export async function positionHistory(admin: SupabaseClient, keywords: string[]): Promise<Map<string, PositionSummary>> {
  const out = new Map<string, PositionSummary>()
  const unique = [...new Set(keywords.map((k) => k.toLowerCase()))]
  const since = new Date(Date.now() - HISTORY_DAYS * 86_400_000).toISOString().slice(0, 10)
  for (let i = 0; i < unique.length; i += HISTORY_CHUNK) {
    const chunk = unique.slice(i, i + HISTORY_CHUNK)
    const { data, error } = await admin.from('gsc_rankings').select('day, key, position, clicks, impressions').eq('kind', 'query').in('key', chunk).gte('day', since).order('day').limit(1000)
    if (error) continue
    const by = new Map<string, RankHistoryPoint[]>()
    for (const r of (data ?? []) as { day: string; key: string; position: number; clicks: number; impressions: number }[]) {
      const list = by.get(r.key.toLowerCase())
      const point = { day: r.day, position: Number(r.position), clicks: Number(r.clicks) || 0, impressions: Number(r.impressions) || 0 }
      if (list) list.push(point)
      else by.set(r.key.toLowerCase(), [point])
    }
    for (const [k, points] of by) out.set(k, summarizeHistory(points))
  }
  return out
}

export interface KeywordProgress {
  keyword: string
  role: 'primary' | 'secondary'
  position: number | null
  change7: number | null
  change28: number | null
  clicks: number | null
  impressions: number | null
}

export interface IdeaProgress {
  id: string
  title: string
  status: BlogTopicQueueRow['status']
  usedSlug: string | null
  keywords: KeywordProgress[]
}

/** For every blog idea or post with a keyword set (suggested, approved or used): each phrase's current
 * Google position, its change vs 7 and 28 days ago, and clicks. */
export async function keywordProgress(admin: SupabaseClient, preloaded: { queue?: BlogTopicQueueRow[]; rows?: KeywordRow[]; history?: Map<string, PositionSummary> } = {}): Promise<IdeaProgress[]> {
  const queue = preloaded.queue ?? (((await admin.from('blog_topic_queue').select('*').in('status', ['suggested', 'approved', 'used']).order('created_at', { ascending: false }).limit(60)).data ?? []) as BlogTopicQueueRow[])
  const ideas = queue.filter((q) => q.status === 'suggested' || q.status === 'approved' || q.status === 'used')
  const sets = ideas.map((q) => keywordSetOf(q))
  const history = preloaded.history ?? (await positionHistory(admin, sets.flat()))
  const rowOf = new Map((preloaded.rows ?? (await listKeywords())).map((r) => [r.keyword.toLowerCase(), r]))
  return ideas.map((q, i) => ({
    id: q.id,
    title: q.title_idea || q.angle,
    status: q.status,
    usedSlug: q.used_slug,
    keywords: sets[i].map((keyword, k) => progressOf(keyword, k === 0 ? 'primary' : 'secondary', history, rowOf)),
  }))
}

export function progressOf(keyword: string, role: 'primary' | 'secondary', history: Map<string, PositionSummary>, rowOf: Map<string, KeywordRow>): KeywordProgress {
  const h = history.get(keyword.toLowerCase())
  if (h && h.position != null) return { keyword, role, position: h.position, change7: h.change7, change28: h.change28, clicks: h.clicks, impressions: h.impressions }
  const r = rowOf.get(keyword.toLowerCase())
  return { keyword, role, position: r?.gsc_position ?? null, change7: null, change28: null, clicks: r?.gsc_clicks ?? null, impressions: r?.gsc_impressions ?? null }
}

// ---- everything the page needs, in one read ------------------------------------------------------------

export interface IntelKeyword {
  row: KeywordRow
  clusterId: string | null
  clusterPrimary: string | null
  clusterSize: number
  intent: string | null
  funnel: string | null
  opportunity: Opportunity | null
  reason: string | null
  score: number | null
  reasons: string[]
  rankedOn: string | null
}

export interface IntelRankRow {
  keyword: string
  position: number | null
  change7: number | null
  change28: number | null
  impressions: number | null
  clicks: number | null
  page: string | null
  opportunity: Opportunity
}

export interface IntelShootRow {
  clusterId: string
  primary: string
  secondaryCount: number
  secondary: string[]
  volume: number | null
  competition: number | null
  intent: string
  funnel: string
  score: number
  reason: string
  packageName: string | null
}

export interface IntelPayload {
  /** The country this site researches for (new phrases from the page are saved under it). */
  country: KeywordCountry
  keywords: IntelKeyword[]
  rankFor: IntelRankRow[]
  shootFor: IntelShootRow[]
  ideas: (BlogTopicQueueRow & { keywordSet: string[]; packageName: string | null })[]
  progress: IdeaProgress[]
  pages: SitePage[]
  engine: {
    needsMigration: boolean
    lastRun: EngineRun | null
    nextRunAt: string | null
    budgetUsd: number
    spentThisWeekUsd: number
    budgetLeftUsd: number
    balanceUsd: number | null
    aiConfigured: boolean
  }
  sources: { dataforseo: boolean; searchConsole: boolean; autocomplete: boolean; peopleAlsoAsk: boolean; reddit: boolean; trends: boolean; trendsKnown: number }
}

export async function buildKeywordIntel(admin: SupabaseClient): Promise<IntelPayload> {
  let [rows, pages, ranked, migration, last, budget, info, peaks, balanceUsd, pkRes, queueRes] = await Promise.all([
    listKeywords(),
    listSitePages(admin),
    rankedPageByKeyword(),
    migrationReady(admin),
    readEngineRun(admin),
    getKeywordBudget(admin),
    readKeywordRefreshInfo(admin),
    readTrendPeaks(admin),
    isKeywordDataConfigured() ? getAccountBalance() : Promise.resolve(null),
    admin.from('travel_packages').select('slug, name, destination, available_from, available_to').eq('status', 'published'),
    admin.from('blog_topic_queue').select('*').order('created_at', { ascending: false }).limit(200),
  ])
  const queue = (queueRes.data ?? []) as BlogTopicQueueRow[]
  if (migration.ready) last = await clearStaleMigrationNote(admin, last)
  const mine = rows.filter((r) => r.country === COUNTRY)
  const built = buildClusters(mine, (pkRes.data ?? []) as ScorePackage[], new Date(), peaks)
  const classOf = new Map(built.keywords.map((c) => [c.keyword, c]))
  const clusterOf = new Map(built.clusters.map((c) => [c.id, c]))

  // One history read for everything shown with a change column.
  const rankingRows = mine.filter((r) => {
    const o = classOf.get(r.keyword)?.opportunity
    return o === 'RANKING' || o === 'ALMOST'
  })
  const shownIdeas = queue.filter((q) => q.status === 'suggested' || q.status === 'approved' || q.status === 'used').slice(0, 60)
  const history = await positionHistory(admin, [...rankingRows.map((r) => r.keyword), ...shownIdeas.flatMap((q) => keywordSetOf(q))])
  const rowOf = new Map(rows.map((r) => [r.keyword.toLowerCase(), r]))

  const keywords: IntelKeyword[] = rows.map((row) => {
    const c = row.country === COUNTRY ? classOf.get(row.keyword) : undefined
    const cluster = c ? clusterOf.get(c.clusterId) : undefined
    return {
      row,
      clusterId: c?.clusterId ?? null,
      clusterPrimary: c?.primary ?? null,
      clusterSize: cluster?.members.length ?? 0,
      intent: c?.intent ?? null,
      funnel: c?.funnel ?? null,
      opportunity: c?.opportunity ?? null,
      reason: c?.reason ?? null,
      score: c?.score ?? null,
      reasons: c?.reasons ?? [],
      rankedOn: ranked.get(row.keyword.toLowerCase()) ?? row.target_path ?? null,
    }
  })

  const rankFor: IntelRankRow[] = rankingRows
    .map((r) => {
      const p = progressOf(r.keyword, 'primary', history, rowOf)
      return {
        keyword: r.keyword,
        position: p.position,
        change7: p.change7,
        change28: p.change28,
        impressions: r.gsc_impressions ?? p.impressions,
        clicks: r.gsc_clicks ?? p.clicks,
        page: ranked.get(r.keyword.toLowerCase()) ?? r.target_path ?? null,
        opportunity: classOf.get(r.keyword)?.opportunity as Opportunity,
      }
    })
    .sort((a, b) => (b.impressions ?? 0) - (a.impressions ?? 0))

  const shootFor: IntelShootRow[] = built.clusters
    .filter((c) => c.opportunity === 'SHOOT_FOR')
    .sort((a, b) => (b.volume ?? -1) - (a.volume ?? -1) || b.score - a.score)
    .map((c) => ({ clusterId: c.id, primary: c.primary, secondaryCount: c.secondary.length, secondary: c.secondary, volume: c.volume, competition: c.competition, intent: c.intent, funnel: c.funnel, score: c.score, reason: c.reason, packageName: c.packageName }))

  const pkgBySlug = new Map(((pkRes.data ?? []) as { slug: string; name: string }[]).map((p) => [p.slug, p.name]))
  const ideas = queue
    .filter((q) => q.status === 'suggested' || q.status === 'approved')
    .map((q) => {
      const cluster = q.cluster_id ? clusterOf.get(q.cluster_id) : undefined
      return { ...q, keywordSet: keywordSetOf(q), packageName: cluster?.packageSlug ? (pkgBySlug.get(cluster.packageSlug) ?? cluster.packageName) : (cluster?.packageName ?? null) }
    })
    .sort((a, b) => Number(b.status === 'approved') - Number(a.status === 'approved') || (b.score ?? 0) - (a.score ?? 0))

  const progress = await keywordProgress(admin, { queue: shownIdeas, rows, history })
  const spent = spentLastWeek(info.log)
  const reddit = !!process.env.REDDIT_CLIENT_ID?.trim() && !!process.env.REDDIT_CLIENT_SECRET?.trim()
  const dfs = isKeywordDataConfigured()
  return {
    country: COUNTRY,
    keywords,
    rankFor,
    shootFor,
    ideas,
    progress,
    pages,
    engine: {
      needsMigration: !migration.ready,
      lastRun: last,
      nextRunAt: nextEngineRunAt(last ? new Date(last.at) : null).toISOString(),
      budgetUsd: budget,
      spentThisWeekUsd: roundUsd(spent),
      budgetLeftUsd: roundUsd(Math.max(0, budget - spent)),
      balanceUsd,
      aiConfigured: isAiConfigured(),
    },
    sources: { dataforseo: dfs, searchConsole: isSearchConsoleConfigured(), autocomplete: dfs, peopleAlsoAsk: dfs, reddit, trends: dfs, trendsKnown: Object.keys(peaks).length },
  }
}
