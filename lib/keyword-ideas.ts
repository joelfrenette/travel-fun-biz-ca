import type { SupabaseClient } from '@supabase/supabase-js'
import { getSetting, setSetting } from '@/lib/app-settings'
import { SITE_ID } from '@/lib/site'

// More places to find keywords than the one volume tool, all REAL data and all capped:
//   Google autocomplete   what people actually type as they search (DataForSEO, about $0.002 a seed)
//   People Also Ask       the real questions Google shows under a search (DataForSEO, about $0.002 a seed)
//   Reddit questions      how real travellers word their worries (Reddit's own API; needs a free app, see
//                         .env.example; dormant until REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET are set)
//   Google Trends         WHEN interest in a destination peaks, so a post is published months ahead of it
//                         (DataForSEO, about $0.01 a request, refreshed every 90 days)
// Ideas are only suggestions saved for you to track (never auto-added and never looked up for money).
// Everything runs at most once a week and under a hard weekly dollar cap.
const API = 'https://api.dataforseo.com/v3'
const CANADA = 2124
export const IDEAS_KEY = 'keyword_ideas'
const IDEAS_LAST_KEY = 'keyword_ideas_last_run'
export const TRENDS_KEY = 'trends_peaks'
const TRENDS_LAST_KEY = 'trends_last_run'
const SEEDS_PER_RUN = 3
const WEEK_MS = 7 * 86_400_000
const TRENDS_MS = 90 * 86_400_000
/** The most one weekly run of ideas may spend, in dollars (it normally spends about 2 cents). */
const IDEAS_CAP_USD = 0.05
const MAX_IDEAS = 300

export interface KeywordIdea {
  phrase: string
  source: 'autocomplete' | 'question' | 'reddit'
  seed: string
  at: string
}

function authHeader(): string | null {
  const login = process.env.DATAFORSEO_LOGIN?.trim()
  const pass = process.env.DATAFORSEO_PASSWORD?.trim()
  return login && pass ? `Basic ${Buffer.from(`${login}:${pass}`).toString('base64')}` : null
}

async function dfs(path: string, body: unknown): Promise<{ cost: number; result: any }> {
  const auth = authHeader()
  if (!auth) throw new Error('DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD are not set')
  const res = await fetch(`${API}${path}`, { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store', signal: AbortSignal.timeout(40_000) })
  const json = (await res.json().catch(() => ({}))) as { cost?: number; tasks?: { status_code?: number; status_message?: string; result?: unknown[] }[] }
  if (res.status === 402) throw new Error('DataForSEO: insufficient balance')
  if (!res.ok) throw new Error(`DataForSEO HTTP ${res.status}`)
  const task = json.tasks?.[0]
  // "No Search Results" just means this search has nothing to report: an empty answer, not an error.
  if (task?.status_code === 40102 || /no search results/i.test(task?.status_message ?? '')) return { cost: Number(json.cost) || 0, result: undefined }
  if (task?.status_code != null && task.status_code !== 20000) throw new Error(`DataForSEO: ${task.status_message ?? task.status_code}`)
  return { cost: Number(json.cost) || 0, result: task?.result?.[0] }
}

export async function readIdeas(admin: SupabaseClient): Promise<KeywordIdea[]> {
  try {
    const list = JSON.parse((await getSetting(admin, IDEAS_KEY)) ?? '[]')
    return Array.isArray(list) ? (list as KeywordIdea[]) : []
  } catch {
    return []
  }
}

const JUNK = /\b(jobs?|salary|salaries|hiring|career|missile|war|wiki|free|login|phone number|stock|lawsuit|accident|died|death|crappiest|worst|wife|husband|flamingo|secret word|one word|meaning|means|song|movie|game|games|india|chat names)\b|\bmean on\b/i

/** An idea is kept only when it still mentions the place the seed was about and is not about something
 * unrelated to booking a trip (jobs, news, trivia). A cheap filter, so junk never reaches your list. */
export function isRelevantIdea(phrase: string, seed: string): boolean {
  const place = seed.toLowerCase().replace(/\b(cruise|group trip)\b/g, '').trim().split(/\s+/)[0]
  return !!place && phrase.includes(place) && !JUNK.test(phrase)
}

const clean = (s: string) => s.toLowerCase().replace(/[?!.]+$/g, '').replace(/\s+/g, ' ').trim()
const wordCount = (s: string) => s.split(' ').length

async function autocompleteFor(seed: string): Promise<{ phrases: string[]; cost: number }> {
  const { cost, result } = await dfs('/serp/google/autocomplete/live/advanced', [{ keyword: seed, location_code: CANADA, language_code: 'en' }])
  return { phrases: ((result?.items ?? []) as { suggestion?: string }[]).map((i) => i.suggestion ?? '').filter(Boolean), cost }
}

async function questionsFor(seed: string): Promise<{ phrases: string[]; cost: number }> {
  const { cost, result } = await dfs('/serp/google/organic/live/advanced', [{ keyword: seed, location_code: CANADA, language_code: 'en', depth: 10, people_also_ask_click_depth: 1 }])
  const items = (result?.items ?? []) as { type?: string; items?: { title?: string }[] }[]
  const out: string[] = []
  for (const block of items.filter((i) => i.type === 'people_also_ask')) for (const q of block.items ?? []) if (q.title) out.push(q.title)
  return { phrases: out, cost }
}

/** Reddit question titles about a seed, via Reddit's official API, and a plain status for the note. Empty
 * (and free) until the two keys are set. */
async function redditQuestionsFor(seed: string): Promise<{ titles: string[]; status: 'off' | 'login-failed' | 'ok' }> {
  const id = process.env.REDDIT_CLIENT_ID?.trim()
  const secret = process.env.REDDIT_CLIENT_SECRET?.trim()
  if (!id || !secret) return { titles: [], status: 'off' }
  const agent = 'travelfunbiz-ca-research/1.0 (keyword ideas; contact: site owner)'
  const tokenRes = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: { Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': agent },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(15_000),
  })
  const token = ((await tokenRes.json().catch(() => ({}))) as { access_token?: string }).access_token
  if (!token) return { titles: [], status: 'login-failed' }
  const res = await fetch(`https://oauth.reddit.com/r/solotravel+cruise+travel+Cruise+TravelHacks/search?restrict_sr=1&sort=top&t=year&limit=25&q=${encodeURIComponent(seed)}`, { headers: { Authorization: `Bearer ${token}`, 'User-Agent': agent }, signal: AbortSignal.timeout(15_000) })
  const json = (await res.json().catch(() => ({}))) as { data?: { children?: { data?: { title?: string } }[] } }
  const titles = (json.data?.children ?? []).map((c) => c.data?.title ?? '').filter((t) => t.includes('?') && wordCount(clean(t)) <= 14)
  return { titles, status: 'ok' }
}

/** The seeds are the destination of each published trip plus "cruise" or "group trip", the same as the
 * weekly volume research, rotated so each week looks at different trips. */
async function seeds(admin: SupabaseClient): Promise<string[]> {
  const { data } = await admin.from('travel_packages').select('destination, category').eq('status', 'published')
  const out = new Set<string>()
  for (const p of (data ?? []) as { destination: string | null; category: string | null }[]) {
    const d = p.destination?.trim().toLowerCase()
    if (d) out.add(`${d} ${/cruise/i.test(p.category ?? '') ? 'cruise' : 'group trip'}`)
  }
  return [...out].sort()
}

/** Collects new keyword ideas once a week (or now with force), spending at most IDEAS_CAP_USD. Returns a
 * one-line note when it ran, null when nothing was due. */
export async function collectIdeas(admin: SupabaseClient, opts: { force?: boolean } = {}): Promise<string | null> {
  if (!authHeader()) return null
  const last = Date.parse((await getSetting(admin, IDEAS_LAST_KEY)) ?? '')
  if (!opts.force && Number.isFinite(last) && Date.now() - last < WEEK_MS) return null
  // Claim the week first so two overlapping passes cannot both spend.
  await setSetting(admin, IDEAS_LAST_KEY, new Date().toISOString())

  const all = await seeds(admin)
  if (!all.length) return null
  const week = Math.floor(Date.now() / WEEK_MS)
  const chosen = Array.from({ length: Math.min(SEEDS_PER_RUN, all.length) }, (_, i) => all[(week * SEEDS_PER_RUN + i) % all.length])

  const { data: tracked } = await admin.from('keyword_research').select('keyword').eq('country', SITE_ID)
  const known = new Set((tracked ?? []).map((r: { keyword: string }) => r.keyword.toLowerCase()))
  const existing = await readIdeas(admin)
  const have = new Set(existing.map((i) => i.phrase))
  const found: KeywordIdea[] = []
  let spent = 0
  const failures: string[] = []
  let redditStatus: 'off' | 'login-failed' | 'ok' = 'off'
  const at = new Date().toISOString()
  const add = (phrases: string[], source: KeywordIdea['source'], seed: string) => {
    for (const raw of phrases) {
      const phrase = clean(raw)
      if (wordCount(phrase) < 2 || wordCount(phrase) > 14 || known.has(phrase) || have.has(phrase) || !isRelevantIdea(phrase, seed)) continue
      have.add(phrase)
      found.push({ phrase, source, seed, at })
    }
  }
  for (const seed of chosen) {
    if (spent >= IDEAS_CAP_USD) break
    // Each source is tried on its own: one failing never stops the others or the next seed.
    try {
      const a = await autocompleteFor(seed)
      spent += a.cost
      add(a.phrases, 'autocomplete', seed)
    } catch (e) {
      failures.push(`autocomplete: ${e instanceof Error ? e.message : 'error'}`)
    }
    if (spent < IDEAS_CAP_USD) {
      try {
        const q = await questionsFor(seed)
        spent += q.cost
        add(q.phrases, 'question', seed)
      } catch (e) {
        failures.push(`questions: ${e instanceof Error ? e.message : 'error'}`)
      }
    }
    try {
      const rd = await redditQuestionsFor(seed)
      redditStatus = rd.status
      add(rd.titles, 'reddit', seed)
    } catch {
      redditStatus = 'login-failed'
    }
  }
  await setSetting(admin, IDEAS_KEY, JSON.stringify([...found, ...existing].slice(0, MAX_IDEAS)))
  const reddit = redditStatus === 'off' ? 'Reddit: not connected (keys not set)' : redditStatus === 'login-failed' ? 'Reddit: keys set but Reddit refused them (check both values, no spaces)' : `Reddit: connected, ${found.filter((f) => f.source === 'reddit').length} question ideas`
  return `${reddit}. ${found.length} new keyword ideas from ${chosen.join(', ')} (spent about $${spent.toFixed(3)})${failures.length ? `; ${failures.length} lookup${failures.length === 1 ? '' : 's'} had no result (${[...new Set(failures)].slice(0, 2).join('; ')})` : ''}`
}

/** Removes an idea from the list (after it is tracked, or when it is not wanted). */
export async function dropIdea(admin: SupabaseClient, phrase: string): Promise<void> {
  const list = await readIdeas(admin)
  await setSetting(admin, IDEAS_KEY, JSON.stringify(list.filter((i) => i.phrase !== phrase)))
}

// ---- Google Trends: the month interest peaks, per destination --------------------------------------

export type TrendPeaks = Record<string, { peak: number; curve: number[] }>

export async function readTrendPeaks(admin: SupabaseClient): Promise<TrendPeaks> {
  try {
    const v = JSON.parse((await getSetting(admin, TRENDS_KEY)) ?? '{}')
    return v && typeof v === 'object' ? (v as TrendPeaks) : {}
  } catch {
    return {}
  }
}

/** Once every 90 days, finds the calendar month each trip destination is searched most (5 years of Google
 * Trends, Canada), so the keyword score can favour publishing 1 to 4 months before that peak. */
export async function refreshTrendPeaksIfDue(admin: SupabaseClient, opts: { force?: boolean; budgetUsd?: number } = {}): Promise<string | null> {
  if (!authHeader()) return null
  const last = Date.parse((await getSetting(admin, TRENDS_LAST_KEY)) ?? '')
  if (!opts.force && Number.isFinite(last) && Date.now() - last < TRENDS_MS) return null
  // Stamped now so overlapping passes cannot both spend; un-stamped below if the budget cut the run short.
  await setSetting(admin, TRENDS_LAST_KEY, new Date().toISOString())
  const { data } = await admin.from('travel_packages').select('destination').eq('status', 'published')
  const dests = [...new Set(((data ?? []) as { destination: string | null }[]).map((p) => p.destination?.trim().toLowerCase()).filter((d): d is string => !!d))]
  const peaks: TrendPeaks = {}
  let spent = 0
  let stoppedForBudget = false
  for (let i = 0; i < dests.length; i += 5) {
    // Stop chunking once the caller's budget is used up; what was found so far is kept below.
    if (opts.budgetUsd != null && spent >= opts.budgetUsd) {
      stoppedForBudget = true
      break
    }
    const chunk = dests.slice(i, i + 5)
    try {
      const { cost, result } = await dfs('/keywords_data/google_trends/explore/live', [{ keywords: chunk, location_code: CANADA, language_code: 'en', time_range: 'past_5_years', item_types: ['google_trends_graph'] }])
      spent += cost
      const graph = ((result?.items ?? []) as { type?: string; data?: { date_from?: string; values?: (number | null)[] }[] }[]).find((x) => x.type === 'google_trends_graph')
      chunk.forEach((dest, k) => {
        const sum = new Array(12).fill(0)
        const n = new Array(12).fill(0)
        for (const pt of graph?.data ?? []) {
          const v = pt.values?.[k]
          const m = pt.date_from ? new Date(`${pt.date_from}T00:00:00Z`).getUTCMonth() : -1
          if (v != null && m >= 0) {
            sum[m] += v
            n[m]++
          }
        }
        if (n.reduce((a, b) => a + b, 0) < 24) return // too little data to call a peak
        const curve = sum.map((s, m) => (n[m] ? Math.round(s / n[m]) : 0))
        peaks[dest] = { peak: curve.indexOf(Math.max(...curve)) + 1, curve }
      })
    } catch (e) {
      // The cost so far is reported even on an error, so the caller can record it.
      return `trend refresh stopped: ${e instanceof Error ? e.message : 'error'} (spent about $${spent.toFixed(3)})`
    }
  }
  // A run cut short by the budget merges into the peaks already known instead of replacing them.
  const merged = stoppedForBudget ? { ...(await readTrendPeaks(admin)), ...peaks } : peaks
  await setSetting(admin, TRENDS_KEY, JSON.stringify(merged))
  // Cut short by the budget: forget the stamp so the skipped destinations are retried next week.
  if (stoppedForBudget) await admin.from('app_settings').delete().eq('key', TRENDS_LAST_KEY)
  return `search-interest peaks found for ${Object.keys(peaks).length} of ${dests.length} destinations${stoppedForBudget ? ' (stopped at the budget)' : ''} (spent about $${spent.toFixed(3)})`
}
