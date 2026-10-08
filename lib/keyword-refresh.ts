import type { SupabaseClient } from '@supabase/supabase-js'
import { getSetting, setSetting } from '@/lib/app-settings'
import { SITE_ID } from '@/lib/site'
import { isKeywordDataConfigured, suggestKeywords, saveSuggestedKeyword, type KeywordCountry } from '@/lib/keywords'

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

async function seedPhrases(admin: SupabaseClient): Promise<string[]> {
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
  return seeds.sort()
}

/** Runs at most once a week, only when configured and under budget. Returns a one-line note when it
 * ran, or null when there was nothing to do (so quiet passes add no noise to the pipeline log). */
export async function refreshKeywordsIfDue(admin: SupabaseClient): Promise<string | null> {
  if (!isKeywordDataConfigured()) return null
  const budget = await getKeywordBudget(admin)
  if (budget <= 0) return null
  const last = Date.parse((await getSetting(admin, KEYWORD_LAST_RUN_KEY)) ?? '')
  if (Number.isFinite(last) && Date.now() - last < REFRESH_EVERY_MS) return null
  // Second, independent check against the spend log: the 2026-10-08 first run spent on six passes
  // in a row (about $0.20) despite the guard above, so a stamp read that comes back stale must not
  // be the only thing standing between a pass and a paid call.
  const logged = (await readKeywordRefreshInfo(admin)).log
  const lastLogged = Date.parse(logged[0]?.at ?? '')
  if (Number.isFinite(lastLogged) && Date.now() - lastLogged < REFRESH_EVERY_MS) return null
  // The weekly cap counts what was really spent in the last 7 days, not just this run.
  const spentThisWeek = logged.filter((e) => Date.now() - Date.parse(e.at) < REFRESH_EVERY_MS).reduce((sum, e) => sum + (e.spentUsd || 0), 0)
  if (spentThisWeek >= budget) return null

  const seeds = await seedPhrases(admin)
  if (!seeds.length) return null

  // Atomic claim: only the one pass whose conditional write succeeds may spend. The stamp is an ISO
  // string, so comparing it to a cutoff string is a correct date comparison.
  const nowIso = new Date().toISOString()
  const cutoff = new Date(Date.now() - REFRESH_EVERY_MS).toISOString()
  const { data: claimedRows } = await admin.from('app_settings').update({ value: nowIso, updated_at: nowIso }).eq('key', KEYWORD_LAST_RUN_KEY).lt('value', cutoff).select('key')
  if (!claimedRows?.length) {
    // No stale stamp to take over: either one is fresh (someone else holds it) or none exists yet.
    const { data: inserted } = await admin.from('app_settings').upsert({ key: KEYWORD_LAST_RUN_KEY, value: nowIso, updated_at: nowIso }, { onConflict: 'key', ignoreDuplicates: true }).select('key')
    if (!inserted?.length) return null
  }
  // Rotate through the seed list week by week so different destinations get researched over time.
  const weekIndex = Math.floor(Date.now() / REFRESH_EVERY_MS)
  const chosen = Array.from({ length: Math.min(SEEDS_PER_RUN, seeds.length) }, (_, i) => seeds[(weekIndex * SEEDS_PER_RUN + i) % seeds.length])

  const country = SITE_ID as KeywordCountry
  const { data: existingRows } = await admin.from('keyword_research').select('keyword').eq('country', country)
  const have = new Set((existingRows ?? []).map((r: { keyword: string }) => r.keyword))

  let spent = 0
  let added = 0
  const used: string[] = []
  // The stamp was written by the claim above, before any spend, so a failure partway through
  // cannot re-spend the budget on the next pass.
  for (const seed of chosen) {
    if (spentThisWeek + spent >= budget) break
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
    } catch {
      break
    }
  }
  const info = await readKeywordRefreshInfo(admin)
  const entry = { at: new Date().toISOString(), spentUsd: Math.round(spent * 1e4) / 1e4, added, seeds: used }
  await setSetting(admin, KEYWORD_SPEND_LOG_KEY, JSON.stringify([entry, ...info.log].slice(0, 12)))
  return `researched ${used.length} topic${used.length === 1 ? '' : 's'}, added ${added} keyword${added === 1 ? '' : 's'}, spent about $${entry.spentUsd.toFixed(2)} of $${budget}/week`
}
