import { supabaseAdmin } from '@/lib/supabase-admin'

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
  created_at: string
  updated_at: string
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

export async function getCreditBalance(): Promise<number | null> {
  try {
    const res = await fetch(`${API_BASE}/account/credits`, {
      headers: { Authorization: `Bearer ${apiKey()}`, Accept: 'application/json' },
      cache: 'no-store',
    })
    if (!res.ok) return null
    const body = await res.json()
    return Array.isArray(body) && typeof body[0] === 'number' ? body[0] : null
  } catch {
    return null
  }
}

export async function listKeywords(): Promise<KeywordRow[]> {
  const { data, error } = await supabaseAdmin
    .from('keyword_research')
    .select('*')
    .order('volume', { ascending: false, nullsFirst: false })
    .order('keyword')
  if (error) throw new Error(error.message)
  return data || []
}

export async function lookupKeywords(keywords: string[], country: KeywordCountry, force = false): Promise<LookupResult> {
  const { data: existing, error } = await supabaseAdmin
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

    const upserts = (body.data || []).map((d: any) => ({
      keyword: String(d.keyword).trim().toLowerCase(),
      country,
      volume: Number.isFinite(Number(d.vol)) ? Number(d.vol) : null,
      cpc: d.cpc?.value != null && Number.isFinite(Number(d.cpc.value)) ? Number(d.cpc.value) : null,
      cpc_currency: d.cpc?.currency || null,
      competition: Number.isFinite(Number(d.competition)) ? Number(d.competition) : null,
      trend: Array.isArray(d.trend) ? d.trend : [],
      data_source: 'gkp',
      fetched_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }))
    if (upserts.length > 0) {
      const { data: saved, error: upsertError } = await supabaseAdmin
        .from('keyword_research')
        .upsert(upserts, { onConflict: 'keyword,country' })
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
  const { data, error } = await supabaseAdmin
    .from('keyword_research')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single()
  if (error) throw new Error(error.message)
  return data
}

export async function deleteKeyword(id: string): Promise<void> {
  const { error } = await supabaseAdmin.from('keyword_research').delete().eq('id', id)
  if (error) throw new Error(error.message)
}
