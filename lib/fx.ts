// fx.ts - fetch and cache USD -> target exchange rates using Alpha Vantage
const DEFAULT_RATES: Record<string, number> = {
  cad: 1.36,
  aud: 1.50,
  eur: 0.92,
}
const CACHE_TTL = 1000 * 60 * 60 // 1 hour
const ENDPOINT = 'https://www.alphavantage.co/query'

const cache: Record<string, { rate: number; last: number }> = {}

export async function getUsdToRate(toCurrency: string): Promise<number> {
  const key = toCurrency.toLowerCase()
  const now = Date.now()

  if (cache[key] && now - cache[key].last < CACHE_TTL) {
    return cache[key].rate
  }

  // default fallback
  const defaultRate = DEFAULT_RATES[key] ?? 1

  const apiKey = process.env.ALPHA_VANTAGE_API_KEY
  if (!apiKey) {
    console.warn('[fx] Missing ALPHA_VANTAGE_API_KEY env variable, using default rate for', key)
    cache[key] = { rate: defaultRate, last: now }
    return defaultRate
  }

  try {
    const url = `${ENDPOINT}?function=CURRENCY_EXCHANGE_RATE&from_currency=USD&to_currency=${key.toUpperCase()}&apikey=${apiKey}`
    const response = await fetch(url, { next: { revalidate: 60 * 60 } })
    if (!response.ok) throw new Error(`Alpha Vantage error: ${response.statusText}`)
    const data = await response.json()
    const rateString = data?.['Realtime Currency Exchange Rate']?.['5. Exchange Rate']
    const parsed = typeof rateString === 'string' ? Number.parseFloat(rateString) : undefined
    if (!parsed || !Number.isFinite(parsed)) throw new Error('Invalid rate from Alpha Vantage')
    cache[key] = { rate: parsed, last: now }
    return parsed
  } catch (err) {
    console.error('[fx] Failed to fetch exchange rate for', key, err)
    cache[key] = { rate: defaultRate, last: now }
    return defaultRate
  }
}