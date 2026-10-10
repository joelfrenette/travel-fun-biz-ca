import type { SupabaseClient } from '@supabase/supabase-js'
import { getSetting, setSetting } from '@/lib/app-settings'
import { SITE_ID } from '@/lib/site'
import { isKeywordDataConfigured, suggestKeywords, saveSuggestedKeyword, type KeywordCountry } from '@/lib/keywords'
import { isoWeekKey } from '@/lib/keyword-cluster'

// A capped weekly keyword refresh so topics follow real new search demand without a click. This is
// the one credit-costing step the pipeline takes on its own, so it is bounded three ways: a weekly
// dollar cap you control (default $1, 0 turns it off), at most a few seed phrases per run, and one
// run per week. Seeds come from your own published trips (destination plus "cruise" or "group trip"),
// so nothing is invented. New ideas land in the same keyword_research table the Keyword Research
// tool uses, and the topic picker already reads that table (lib/blog-topics.ts).
export const KEYWORD_BUDGET_KEY = 'autopilot_keyword_budget_usd'
export const KEYWORD_LAST_RUN_KEY = 'autopilot_keyword_last_run'
export const KEYWORD_SPEND_LOG_KEY = 'autopilot_keyword_spend_log'
export const DEFAULT_KEYWORD_BUDGET_USD = 1
const REFRESH_EVERY_MS = 7 * 24 * 60 * 60 * 1000
const SEEDS_PER_RUN = 3
const KEEP_PER_SEED = 8
const MIN_VOLUME = 10

const SEED_OFFSET_KEY = 'keyword_seed_offset'

/** `count` seeds starting at `offset`, wrapping round the list. Pure. */
export function pickSeeds(seeds: string[], offset: number, count: number): string[] {
  if (!seeds.length) return []
  return Array.from({ length: Math.min(count, seeds.length) }, (_, i) => seeds[(offset + i) % seeds.length])
}

export async function getKeywordBudget(admin: SupabaseClient): Promise<number> {
  const raw = await getSetting(admin, KEYWORD_BUDGET_KEY)
  const n = raw === null ? DEFAULT_KEYWORD_BUDGET_USD : Number(raw)
  return Number.isFinite(n) && n >= 0 && n <= 50 ? n : DEFAULT_KEYWORD_BUDGET_USD
}

export async function setKeywordBudget(admin: SupabaseClient, usd: number): Promise<{ error?: string }> {
  if (!Number.isFinite(usd) || usd < 0 || usd > 50) return { error: 'budget must be between 0 and 50 dollars a week' }
  return setSetting(admin, KEYWORD_BUDGET_KEY, String(usd))
}

export interface KeywordRefreshInfo {
  lastRunAt: string | null
  log: { at: string; spentUsd: number; added: number; seeds: string[] }[]
}

export async function readKeywordRefreshInfo(admin: SupabaseClient): Promise<KeywordRefreshInfo> {
  let log: KeywordRefreshInfo['log'] = []
  try {
    const parsed = JSON.parse((await getSetting(admin, KEYWORD_SPEND_LOG_KEY)) ?? '[]')
    if (Array.isArray(parsed)) log = parsed
  } catch {
    // unreadable log: show nothing rather than failing the page
  }
  return { lastRunAt: await getSetting(admin, KEYWORD_LAST_RUN_KEY), log }
}

export async function seedPhrases(admin: SupabaseClient): Promise<string[]> {
  const { data } = await admin.from('travel_packages').select('destination, category').eq('status', 'published')
  const seen = new Set<string>()
  const seeds: string[] = []
  for (const p of (data ?? []) as { destination: string | null; category: string | null }[]) {
    const dest = p.destination?.trim()
    if (!dest) continue
    const seed = `${dest} ${/cruise/i.test(p.category ?? '') ? 'cruise' : 'group trip'}`.toLowerCase()
    if (!seen.has(seed)) {
      seen.add(seed)
      seeds.push(seed)
    }
  }
  // What real customers ask about: when a lead's message names one of our destinations together with a
  // question topic (cost, itinerary, singles, payment plan...), that pairing becomes a seed phrase. Only
  // the destination and the topic word are kept, never the message, so nothing personal is ever copied.
  // Test leads are ignored. Dormant until real leads write messages.
  const dests = [...new Set(((data ?? []) as { destination: string | null }[]).map((p) => p.destination?.trim().toLowerCase()).filter((d): d is string => !!d))]
  const TOPICS = ['cost', 'price', 'itinerary', 'included', 'cabin', 'single supplement', 'solo', 'singles', 'couples', 'women', 'payment plan', 'insurance', 'visa', 'best time', 'excursions', 'flights']
  const { data: leads } = await admin.from('leads').select('message').eq('is_test', false).not('message', 'is', null).gte('created_at', new Date(Date.now() - 90 * 86_400_000).toISOString()).limit(200)
  for (const l of (leads ?? []) as { message: string | null }[]) {
    const text = (l.message ?? '').toLowerCase()
    for (const d of dests) {
      if (!text.includes(d)) continue
      for (const t of TOPICS) {
        if (!text.includes(t)) continue
        const seed = `${d} ${t}`
        if (!seen.has(seed)) {
          seen.add(seed)
          seeds.push(seed)
        }
      }
    }
  }
  return seeds.sort()
}

/** What was really spent on keyword research in the last 7 days (from the spend log). */
export function spentLastWeek(log: KeywordRefreshInfo['log'], now = Date.now()): number {
  return log.filter((e) => now - Date.parse(e.at) < REFRESH_EVERY_MS).reduce((sum, e) => sum + (e.spentUsd || 0), 0)
}

/** Adds one line to the spend log (newest first, 12 kept). Never throws. */
export async function logKeywordSpend(admin: SupabaseClient, entry: KeywordRefreshInfo['log'][number]): Promise<void> {
  try {
    const info = await readKeywordRefreshInfo(admin)
    await setSetting(admin, KEYWORD_SPEND_LOG_KEY, JSON.stringify([entry, ...info.log].slice(0, 30)))
    await setSetting(admin, KEYWORD_LAST_RUN_KEY, entry.at) // shown as "last ran" on the Autopilot page
  } catch {
    // a logging problem must never fail a run that already finished
  }
}

/** The atomic once-a-week claim, shared by the keyword engine and the older refresh below. It INSERTS the
 * key `keyword_engine_week:<ISO week>` into app_settings; app_settings.key is the primary key, so exactly
 * one caller per week can succeed and every other pass gets a unique-violation (23505) and stands down.
 * That is the same pattern the daily brief uses (`debrief_sent:<day>`), and unlike the old
 * "read the stamp, then update it" it has no gap between the check and the claim.
 * Returns the key when this caller owns the week, null when someone already does, and 'error' when the
 * claim itself could not be made (the caller must then NOT spend). */
export async function claimKeywordWeek(admin: SupabaseClient, week: string): Promise<{ key: string } | 'taken' | 'error'> {
  const key = `keyword_engine_week:${week}`
  const { error } = await admin.from('app_settings').insert({ key, value: new Date().toISOString() })
  if (!error) return { key }
  return (error as { code?: string }).code === '23505' ? 'taken' : 'error'
}

/** Gives a week's claim back (only when nothing was spent), so the next pass may try again. */
export async function releaseKeywordWeek(admin: SupabaseClient, key: string): Promise<void> {
  await admin.from('app_settings').delete().eq('key', key)
}

/** The paid research itself: DataForSEO keyword ideas for a few seed phrases, the best new phrases saved
 * into keyword_research. No cadence and no claim in here (the caller owns both); it stops as soon as
 * `budgetLeftUsd` is used up. */
export async function runKeywordResearch(admin: SupabaseClient, opts: { budgetLeftUsd: number; seedPool?: string[] }): Promise<{ spent: number; added: number; seeds: string[]; error?: string }> {
  const all = opts.seedPool ?? (await seedPhrases(admin))
  // Never repeat a seed researched in the last 7 days (the spend log records them), and advance a stored
  // offset on every run (not once a week), so repeated button presses walk through new seeds.
  const recent = new Set((await readKeywordRefreshInfo(admin)).log.filter((e) => Date.now() - Date.parse(e.at) < REFRESH_EVERY_MS).flatMap((e) => e.seeds))
  const seeds = all.filter((s) => !recent.has(s))
  if (!seeds.length) return { spent: 0, added: 0, seeds: [] }
  const offset = Number(await getSetting(admin, SEED_OFFSET_KEY)) || 0
  const chosen = pickSeeds(seeds, offset, SEEDS_PER_RUN)
  await setSetting(admin, SEED_OFFSET_KEY, String(offset + chosen.length))

  const country = SITE_ID as KeywordCountry
  const { data: existingRows } = await admin.from('keyword_research').select('keyword').eq('country', country)
  const have = new Set((existingRows ?? []).map((r: { keyword: string }) => r.keyword))

  let spent = 0
  let added = 0
  const used: string[] = []
  let error: string | undefined
  for (const seed of chosen) {
    if (spent >= opts.budgetLeftUsd) break
    try {
      const { suggestions, costUsd } = await suggestKeywords(seed, country, 30)
      spent += costUsd
      used.push(seed)
      const fresh = suggestions
        .filter((s) => (s.volume ?? 0) >= MIN_VOLUME && !have.has(s.keyword))
        .sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0))
        .slice(0, KEEP_PER_SEED)
      for (const s of fresh) {
        await saveSuggestedKeyword(s, country)
        have.add(s.keyword)
        added++
      }
    } catch (e) {
      error = e instanceof Error ? e.message : 'keyword research failed'
      break
    }
  }
  return { spent, added, seeds: used, error }
}

/** The older once-a-week refresh (research only). The pipeline now runs the whole keyword engine
 * (lib/keyword-intel.ts) instead; this stays for callers that only want the research, and uses the same
 * atomic weekly claim, so the two can never both spend in one week. Returns a one-line note when it ran,
 * or null when there was nothing to do. */
export async function refreshKeywordsIfDue(admin: SupabaseClient): Promise<string | null> {
  if (!isKeywordDataConfigured()) return null
  const budget = await getKeywordBudget(admin)
  if (budget <= 0) return null
  const logged = (await readKeywordRefreshInfo(admin)).log
  // A second, independent guard against the spend log: never within a week of the last logged run.
  const lastLogged = Date.parse(logged[0]?.at ?? '')
  if (Number.isFinite(lastLogged) && Date.now() - lastLogged < REFRESH_EVERY_MS) return null
  const spentThisWeek = spentLastWeek(logged)
  if (spentThisWeek >= budget) return null

  const seeds = await seedPhrases(admin)
  if (!seeds.length) return null
  const claim = await claimKeywordWeek(admin, isoWeekKey(new Date()))
  if (claim === 'taken' || claim === 'error') return null

  // The claim was made before any spend, so a failure partway through cannot re-spend on the next pass.
  const r = await runKeywordResearch(admin, { budgetLeftUsd: budget - spentThisWeek, seedPool: seeds })
  const entry = { at: new Date().toISOString(), spentUsd: Math.round(r.spent * 1e4) / 1e4, added: r.added, seeds: r.seeds }
  await logKeywordSpend(admin, entry)
  return `researched ${r.seeds.length} topic${r.seeds.length === 1 ? '' : 's'}, added ${r.added} keyword${r.added === 1 ? '' : 's'}, spent about $${entry.spentUsd.toFixed(2)} of $${budget}/week`
}
