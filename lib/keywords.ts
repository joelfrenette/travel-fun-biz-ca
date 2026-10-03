import { getSupabaseAdmin } from '@/lib/supabase-admin'

// DataForSEO Keywords Data API (Google Ads search volume). Switched from Keywords Everywhere on
// 2026-10-03 (Joel's call) - this is a genuinely different provider, not a drop-in: auth is HTTP
// Basic (a login + password pair, not a single bearer key), billing is a real dollar cost per
// call (not a flat per-keyword credit count), and the request/response shapes are unrelated.
// Docs: https://docs.dataforseo.com/v3/keywords_data/google_ads/search_volume/live/
//
// Every lookup costs real money, so results are cached in keyword_research and only re-fetched
// when older than CACHE_DAYS or forced.
const API_BASE = 'https://api.dataforseo.com/v3'
const CACHE_DAYS = 30
const MAX_PER_REQUEST = 1000 // DataForSEO's own per-task keyword limit

export type KeywordCountry = 'ca' | 'us'

// Google Ads geo-target IDs (stable, documented at
// https://developers.google.com/google-ads/api/docs/targeting/location-targeting and mirrored by
// DataForSEO's own /v3/keywords_data/google_ads/locations - never invented).
const LOCATION_CODE: Record<KeywordCountry, number> = { ca: 2124, us: 2840 }
const LANGUAGE_CODE = 'en'
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export interface KeywordRow {
  id: string
  keyword: string
  country: KeywordCountry
  volume: number | null
  cpc: number | null
  cpc_currency: string | null
  competition: number | null
  trend: { month: string; year: number; value: number }[]
  data_source: string
  target_path: string | null
  note: string | null
  fetched_at: string
  gsc_clicks: number | null
  gsc_impressions: number | null
  gsc_position: number | null
  gsc_fetched_at: string | null
  bing_impressions: number | null
  bing_fetched_at: string | null
  created_at: string
  updated_at: string
}

/** Track a phrase without spending anything (e.g. one found in Search Console). */
export async function trackKeyword(keyword: string, country: KeywordCountry): Promise<KeywordRow> {
  const { data, error } = await getSupabaseAdmin()
    .from('keyword_research')
    .upsert({ keyword, country, fetched_at: new Date(0).toISOString(), updated_at: new Date().toISOString() }, { onConflict: 'keyword,country', ignoreDuplicates: true })
    .select()
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (data) return data
  const { data: existing, error: readError } = await getSupabaseAdmin().from('keyword_research').select('*').eq('keyword', keyword).eq('country', country).single()
  if (readError) throw new Error(readError.message)
  return existing
}

export interface LookupResult {
  rows: KeywordRow[]
  requested: number
  fetched: number
  cached: number
  /** Real dollars spent on this lookup (DataForSEO bills per call, not a flat per-keyword credit). */
  costUsd: number
  /** Real account balance in USD after this call, or null if it couldn't be read. */
  balanceUsd: number | null
}

export function isKeywordDataConfigured(): boolean {
  return !!process.env.DATAFORSEO_LOGIN && !!process.env.DATAFORSEO_PASSWORD
}

function authHeader(): string {
  const login = process.env.DATAFORSEO_LOGIN
  const password = process.env.DATAFORSEO_PASSWORD
  if (!login || !password) throw new Error('DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD are not set')
  return `Basic ${Buffer.from(`${login}:${password}`).toString('base64')}`
}

export function normalizeKeywords(input: string | string[]): string[] {
  const list = Array.isArray(input) ? input : input.split(/\r?\n|,/)
  const seen = new Set<string>()
  for (const raw of list) {
    const kw = raw.trim().toLowerCase().replace(/\s+/g, ' ')
    if (kw.length >= 2 && kw.length <= 120) seen.add(kw)
  }
  return Array.from(seen)
}

interface DataForSeoEnvelope<T> {
  status_code?: number
  status_message?: string
  tasks?: { status_code?: number; status_message?: string; result?: T[] | null }[]
}

async function dataForSeoRequest<T>(path: string, init: { method: 'GET' | 'POST'; body?: unknown }): Promise<DataForSeoEnvelope<T>> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: init.method,
    headers: {
      Authorization: authHeader(),
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
    cache: 'no-store',
  })
  const body = (await res.json().catch(() => ({}))) as DataForSeoEnvelope<T>
  // DataForSEO returns HTTP 200 for most request-level errors (bad field, empty body) and only
  // uses the HTTP status for auth (401) and billing (402) failures - the real result always has
  // to be read from status_code in the JSON body, never assumed from a 200. See
  // https://docs.dataforseo.com/v3/appendix/errors/
  if (res.status === 401) throw new Error('DataForSEO rejected the login/password')
  if (res.status === 402) throw new Error('DataForSEO: insufficient balance')
  if (!res.ok) throw new Error(`DataForSEO error: HTTP ${res.status}${body.status_message ? ` - ${body.status_message}` : ''}`)
  if (body.status_code != null && body.status_code !== 20000) {
    throw new Error(`DataForSEO error: ${body.status_message || `status ${body.status_code}`}`)
  }
  return body
}

interface UserDataResult {
  money?: { balance?: number }
}

export async function getAccountBalance(): Promise<number | null> {
  try {
    const body = await dataForSeoRequest<UserDataResult>('/appendix/user_data', { method: 'GET' })
    const balance = body.tasks?.[0]?.result?.[0]?.money?.balance
    if (typeof balance !== 'number') {
      console.warn('[keywords] getAccountBalance: unrecognized response shape', JSON.stringify(body).slice(0, 300))
      return null
    }
    return balance
  } catch (err) {
    console.warn('[keywords] getAccountBalance: failed', err instanceof Error ? err.message : err)
    return null
  }
}

export async function listKeywords(): Promise<KeywordRow[]> {
  const { data, error } = await getSupabaseAdmin()
    .from('keyword_research')
    .select('*')
    .order('volume', { ascending: false, nullsFirst: false })
    .order('keyword')
  if (error) throw new Error(error.message)
  return data || []
}

interface SearchVolumeResult {
  keyword?: string
  search_volume?: number | null
  cpc?: number | null
  competition_index?: number | null
  monthly_searches?: { year?: number; month?: number; search_volume?: number }[]
}

export async function lookupKeywords(keywords: string[], country: KeywordCountry, force = false): Promise<LookupResult> {
  const { data: existing, error } = await getSupabaseAdmin()
    .from('keyword_research')
    .select('*')
    .eq('country', country)
    .in('keyword', keywords)
  if (error) throw new Error(error.message)

  const freshSince = Date.now() - CACHE_DAYS * 864e5
  const fresh = new Map<string, KeywordRow>()
  for (const row of existing || []) {
    if (!force && new Date(row.fetched_at).getTime() > freshSince) fresh.set(row.keyword, row)
  }
  const toFetch = keywords.filter((kw) => !fresh.has(kw))

  let costUsd = 0
  let balanceUsd: number | null = null
  const fetchedRows: KeywordRow[] = []

  for (let i = 0; i < toFetch.length; i += MAX_PER_REQUEST) {
    const chunk = toFetch.slice(i, i + MAX_PER_REQUEST)
    const body = await dataForSeoRequest<SearchVolumeResult>('/keywords_data/google_ads/search_volume/live', {
      method: 'POST',
      body: [{ keywords: chunk, location_code: LOCATION_CODE[country], language_code: LANGUAGE_CODE }],
    })

    const task = body.tasks?.[0]
    costUsd += Number((task as { cost?: number } | undefined)?.cost) || 0
    if (task?.status_code != null && task.status_code !== 20000) {
      throw new Error(`DataForSEO task error: ${task.status_message || `status ${task.status_code}`}`)
    }

    const items = (Array.isArray(task?.result) ? task!.result : []).filter(
      (d): d is SearchVolumeResult & { keyword: string } => typeof d?.keyword === 'string' && d.keyword.trim().length > 0,
    )
    const now = new Date().toISOString()
    const upserts = items.map((d) => ({
      keyword: d.keyword.trim().toLowerCase(),
      country,
      volume: Number.isFinite(Number(d.search_volume)) ? Number(d.search_volume) : null,
      // DataForSEO's Google Ads cpc is always USD regardless of location - see
      // https://docs.dataforseo.com/v3/keywords_data/google_ads/search_volume/live/
      cpc: Number.isFinite(Number(d.cpc)) ? Number(d.cpc) : null,
      cpc_currency: d.cpc != null ? 'usd' : null,
      competition: Number.isFinite(Number(d.competition_index)) ? Number(d.competition_index) : null,
      trend: Array.isArray(d.monthly_searches)
        ? d.monthly_searches
            .filter((m) => typeof m.year === 'number' && typeof m.month === 'number' && m.month! >= 1 && m.month! <= 12)
            .map((m) => ({ year: m.year as number, month: MONTH_NAMES[(m.month as number) - 1], value: Number(m.search_volume) || 0 }))
        : [],
      data_source: 'dataforseo',
      fetched_at: now,
      updated_at: now,
    }))

    // Billed keywords can still come back with no result row (an unsupported phrase, a typo).
    // Without a row for it, it's never "fresh" and lands back in toFetch on every future call - a
    // keyword with genuinely no data gets re-billed forever. A sentinel row (no volume data, but
    // a real fetched_at) makes "looked up, nothing there" cacheable like everything else.
    const returnedKeywords = new Set(upserts.map((u: { keyword: string }) => u.keyword))
    const sentinels = chunk
      .filter((kw) => !returnedKeywords.has(kw))
      .map((kw) => ({
        keyword: kw,
        country,
        volume: null,
        cpc: null,
        cpc_currency: null,
        competition: null,
        trend: [],
        data_source: 'dataforseo',
        fetched_at: now,
        updated_at: now,
      }))

    const rowsToSave = [...upserts, ...sentinels]
    if (rowsToSave.length > 0) {
      const { data: saved, error: upsertError } = await getSupabaseAdmin()
        .from('keyword_research')
        .upsert(rowsToSave, { onConflict: 'keyword,country' })
        .select()
      if (upsertError) throw new Error(upsertError.message)
      fetchedRows.push(...(saved || []))
    }
  }

  if (toFetch.length > 0) balanceUsd = await getAccountBalance()

  return {
    rows: [...fresh.values(), ...fetchedRows],
    requested: keywords.length,
    fetched: fetchedRows.length,
    cached: fresh.size,
    costUsd: Math.round(costUsd * 1e6) / 1e6,
    balanceUsd,
  }
}

export interface KeywordSuggestion {
  keyword: string
  volume: number | null
  cpc: number | null
  /** 0-100 scale, normalized - see the comment on the mapping below for why. */
  competition: number | null
  trend: { month: string; year: number; value: number }[]
}

interface SuggestionItem {
  keyword?: string
  keyword_info?: {
    search_volume?: number | null
    cpc?: number | null
    competition?: number | null
    monthly_searches?: { year?: number; month?: number; search_volume?: number }[]
  }
}
interface SuggestionResult {
  items?: SuggestionItem[] | null
}

const MAX_SUGGESTIONS = 50 // keeps a single "get ideas" click to a few cents, not a few dollars

/** Real related-keyword ideas for a seed phrase, from DataForSEO Labs - genuinely new
 * opportunities, not a lookup of phrases you already typed. Never saved automatically: the admin
 * picks which ones are worth tracking (via trackKeyword/lookupKeywords), so a seed that returns 50
 * loosely-related phrases doesn't silently bloat the research list with noise.
 * Docs: https://docs.dataforseo.com/v3/dataforseo_labs-keyword_suggestions-live/ */
export async function suggestKeywords(seed: string, country: KeywordCountry, limit = MAX_SUGGESTIONS): Promise<{ suggestions: KeywordSuggestion[]; costUsd: number }> {
  const body = await dataForSeoRequest<SuggestionResult>('/dataforseo_labs/google/keyword_suggestions/live', {
    method: 'POST',
    body: [{ keyword: seed, location_code: LOCATION_CODE[country], language_code: LANGUAGE_CODE, limit: Math.min(limit, MAX_SUGGESTIONS) }],
  })

  const task = body.tasks?.[0]
  const costUsd = Number((task as { cost?: number } | undefined)?.cost) || 0
  if (task?.status_code != null && task.status_code !== 20000) {
    throw new Error(`DataForSEO task error: ${task.status_message || `status ${task.status_code}`}`)
  }

  const items = Array.isArray(task?.result) ? (task!.result[0]?.items ?? []) : []
  const suggestions = items
    .filter((item): item is SuggestionItem & { keyword: string } => typeof item?.keyword === 'string' && item.keyword.trim().length > 0)
    .map((item) => {
      const info = item.keyword_info
      return {
        keyword: item.keyword.trim().toLowerCase(),
        volume: Number.isFinite(Number(info?.search_volume)) ? Number(info!.search_volume) : null,
        cpc: Number.isFinite(Number(info?.cpc)) ? Number(info!.cpc) : null,
        // This endpoint's `competition` is a 0-1 float (old AdWords-style ratio), unlike
        // search_volume/live's `competition_index` (a 0-100 int) - scaled up to ×100 so the
        // shared `competition` column stays comparable regardless of which endpoint wrote it.
        // https://dataforseo.com/help-center/what-is-competition
        competition: Number.isFinite(Number(info?.competition)) ? Math.round(Number(info!.competition) * 100) : null,
        trend: Array.isArray(info?.monthly_searches)
          ? info!.monthly_searches!
              .filter((m) => typeof m.year === 'number' && typeof m.month === 'number' && m.month! >= 1 && m.month! <= 12)
              .map((m) => ({ year: m.year as number, month: MONTH_NAMES[(m.month as number) - 1], value: Number(m.search_volume) || 0 }))
          : [],
      }
    })

  return { suggestions, costUsd: Math.round(costUsd * 1e6) / 1e6 }
}

/** Save a suggestion the admin picked straight into the research list, using the data this
 * endpoint already returned - avoids a second, redundant (and separately billed) search_volume
 * call for data already in hand. */
export async function saveSuggestedKeyword(suggestion: KeywordSuggestion, country: KeywordCountry): Promise<KeywordRow> {
  const now = new Date().toISOString()
  const { data, error } = await getSupabaseAdmin()
    .from('keyword_research')
    .upsert(
      {
        keyword: suggestion.keyword,
        country,
        volume: suggestion.volume,
        cpc: suggestion.cpc,
        cpc_currency: suggestion.cpc != null ? 'usd' : null,
        competition: suggestion.competition,
        trend: suggestion.trend,
        data_source: 'dataforseo_suggestion',
        fetched_at: now,
        updated_at: now,
      },
      { onConflict: 'keyword,country' },
    )
    .select()
    .single()
  if (error) throw new Error(error.message)
  return data
}

export async function updateKeyword(id: string, patch: { target_path?: string | null; note?: string | null }): Promise<KeywordRow> {
  const { data, error } = await getSupabaseAdmin()
    .from('keyword_research')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single()
  if (error) throw new Error(error.message)
  return data
}

export async function deleteKeyword(id: string): Promise<void> {
  const { error } = await getSupabaseAdmin().from('keyword_research').delete().eq('id', id)
  if (error) throw new Error(error.message)
}
