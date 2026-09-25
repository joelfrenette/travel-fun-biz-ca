// Bing Webmaster Tools keyword research (free with a verified site and an API key).
// GetKeywordStats returns monthly impression history for a phrase on Bing.
const API = 'https://ssl.bing.com/webmaster/api.svc/json'

export function isBingConfigured(): boolean {
  return !!process.env.BING_WEBMASTER_API_KEY
}

export interface BingKeywordStats {
  monthlyImpressions: number | null
  months: number
}

export async function getBingKeywordStats(keyword: string, country: 'ca' | 'us'): Promise<BingKeywordStats> {
  const apiKey = process.env.BING_WEBMASTER_API_KEY
  if (!apiKey) throw new Error('BING_WEBMASTER_API_KEY is not set')

  const url = new URL(`${API}/GetKeywordStats`)
  url.searchParams.set('apikey', apiKey)
  url.searchParams.set('q', keyword)
  url.searchParams.set('country', country)
  url.searchParams.set('language', country === 'ca' ? 'en-CA' : 'en-US')

  const res = await fetch(url.toString(), { headers: { Accept: 'application/json' }, cache: 'no-store' })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`Bing keyword stats failed: ${body?.Message || body?.ErrorCode || res.status}`)

  // The API wraps results in {"d": [...]}; each entry has monthly Impressions. Field names are
  // read defensively because Microsoft's docs only publish the .NET signatures.
  const entries: any[] = Array.isArray(body?.d) ? body.d : Array.isArray(body) ? body : []
  const impressions = entries
    .map((e) => Number(e?.Impressions ?? e?.impressions))
    .filter((n) => Number.isFinite(n))
  if (impressions.length === 0) return { monthlyImpressions: null, months: 0 }
  // Latest month is the most useful single number; entries arrive oldest first.
  return { monthlyImpressions: impressions[impressions.length - 1], months: impressions.length }
}
