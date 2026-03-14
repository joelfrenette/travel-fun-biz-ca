// fx.ts - fetch and cache USD/CAD exchange rate from Alpha Vantage
const DEFAULT_RATE = 1.36
const CACHE_TTL = 1000 * 60 * 60 // 1 hour
const ENDPOINT = 'https://www.alphavantage.co/query'

let cachedRate = DEFAULT_RATE
let lastFetched = 0

export async function getUsdToCadRate(): Promise<number> {
  const now = Date.now()
  if (now - lastFetched < CACHE_TTL) {
    return cachedRate
  }

  const apiKey = process.env.ALPHA_VANTAGE_API_KEY
  if (!apiKey) {
    console.warn('[fx] Missing ALPHA_VANTAGE_API_KEY env variable, using default rate')
    return cachedRate
  }

  try {
    const url = `${ENDPOINT}?function=CURRENCY_EXCHANGE_RATE&from_currency=USD&to_currency=CAD&apikey=${apiKey}`
    const response = await fetch(url, {
      next: { revalidate: 60 * 60 },
    })

    if (!response.ok) {
      throw new Error(`Alpha Vantage error: ${response.statusText}`)
    }

    const data = await response.json()
    const rateString = data?.['Realtime Currency Exchange Rate']?.['5. Exchange Rate']
    const parsed = typeof rateString === 'string' ? Number.parseFloat(rateString) : undefined

    if (!parsed || !Number.isFinite(parsed)) {
      throw new Error('Alpha Vantage response missing exchange rate')
    }

    cachedRate = parsed
    lastFetched = now
    return cachedRate
  } catch (error) {
    console.error('[fx] Falling back to cached USD/CAD rate', error)
    return cachedRate
  }
}
