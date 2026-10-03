import { getSupabaseAdmin } from '@/lib/supabase-admin'

// Keywords Everywhere API. Every keyword returned costs one credit, so results are
// cached in keyword_research and only re-fetched when older than CACHE_DAYS or forced.
const API_BASE = 'https://api.keywordseverywhere.com/v1'
const CACHE_DAYS = 30
const MAX_PER_REQUEST = 100

export type KeywordCountry = 'ca' | 'us'

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

/** Track a phrase without spending a Keywords Everywhere credit (e.g. one found in Search Console). */
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
  creditsConsumed: number
  credits: number | null
}

function apiKey(): string {
  const key = process.env.KEYWORD_DATA_API_KEY
  if (!key) throw new Error('KEYWORD_DATA_API_KEY is not set')
  return key
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

/** Pulls a credit count out of whichever shape the real response turns out to use - Keywords
 * Everywhere's docs show a bare `[500]`, but an API response reshaping itself over time to
 * `[{credits_available: 500}]` or `{credits: 500}` is exactly the kind of thing that used to
 * come back here as a silent `null`, indistinguishable from the call having actually failed. */
function parseCreditBalance(body: unknown): number | null {
  if (Array.isArray(body)) {
    const first = body[0]
    if (typeof first === 'number') return first
    if (first && typeof first === 'object') {
      for (const key of ['credits_available', 'credits', 'balance']) {
        const v = (first as Record<string, unknown>)[key]
        if (typeof v === 'number') return v
      }
    }
    return null
  }
  if (body && typeof body === 'object') {
    for (const key of ['credits_available', 'credits', 'balance']) {
      const v = (body as Record<string, unknown>)[key]
      if (typeof v === 'number') return v
    }
  }
  return null
}

export async function getCreditBalance(): Promise<number | null> {
  try {
    const res = await fetch(`${API_BASE}/account/credits`, {
      headers: { Authorization: `Bearer ${apiKey()}`, Accept: 'application/json' },
      cache: 'no-store',
    })
    if (!res.ok) {
      console.warn('[keywords] getCreditBalance: HTTP', res.status)
      return null
    }
    const body = await res.json()
    const parsed = parseCreditBalance(body)
    // Distinguishes "the call worked but the response shape changed" from "the call failed" -
    // both used to collapse to the same silent null, which made a real API-shape change
    // invisible until someone noticed the credits display was permanently blank.
    if (parsed === null) console.warn('[keywords] getCreditBalance: unrecognized response shape', JSON.stringify(body).slice(0, 300))
    return parsed
  } catch (err) {
    console.warn('[keywords] getCreditBalance: fetch failed', err instanceof Error ? err.message : err)
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

  let creditsConsumed = 0
  let credits: number | null = null
  const fetchedRows: KeywordRow[] = []

  for (let i = 0; i < toFetch.length; i += MAX_PER_REQUEST) {
    const chunk = toFetch.slice(i, i + MAX_PER_REQUEST)
    const res = await fetch(`${API_BASE}/get_keyword_data`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey()}`, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ kw: chunk, country, currency: country === 'ca' ? 'cad' : 'usd', dataSource: 'gkp' }),
      cache: 'no-store',
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
      const reason = body?.message || `HTTP ${res.status}`
      if (res.status === 402) throw new Error(`Keywords Everywhere: out of credits (${reason})`)
      if (res.status === 401) throw new Error('Keywords Everywhere rejected the API key')
      throw new Error(`Keywords Everywhere error: ${reason}`)
    }
    creditsConsumed += Number(body.credits_consumed) || 0
    if (typeof body.credits === 'number') credits = body.credits

    const items = (Array.isArray(body.data) ? body.data : []).filter(
      (d: any) => typeof d?.keyword === 'string' && d.keyword.trim().length > 0,
    )
    const now = new Date().toISOString()
    const upserts = items.map((d: any) => ({
      keyword: d.keyword.trim().toLowerCase(),
      country,
      volume: Number.isFinite(Number(d.vol)) ? Number(d.vol) : null,
      cpc: d.cpc?.value != null && Number.isFinite(Number(d.cpc.value)) ? Number(d.cpc.value) : null,
      cpc_currency: d.cpc?.currency || null,
      competition: Number.isFinite(Number(d.competition)) ? Number(d.competition) : null,
      trend: Array.isArray(d.trend) ? d.trend : [],
      data_source: 'gkp',
      fetched_at: now,
      updated_at: now,
    }))

    // Keywords Everywhere bills for every requested keyword in the chunk (creditsConsumed above),
    // but its response can simply omit one with no data available (an unsupported phrase, a typo,
    // etc.). Without a row for it, it's never "fresh" and lands back in toFetch on every future
    // call - a keyword with genuinely no data gets re-billed forever. A sentinel row (no volume
    // data, but a real fetched_at) makes "looked up, nothing there" cacheable like everything
    // else, respecting the same CACHE_DAYS TTL - `force` still re-checks it like any other row.
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
        data_source: 'gkp',
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

  return {
    rows: [...fresh.values(), ...fetchedRows],
    requested: keywords.length,
    fetched: fetchedRows.length,
    cached: fresh.size,
    creditsConsumed,
    credits,
  }
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
