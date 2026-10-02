// fx.ts - fetch and cache USD -> target exchange rates using Alpha Vantage
//
// Why a DB-backed cache: this runs on Vercel's serverless Node.js runtime, where a
// module-level variable (the in-memory `cache` below) only survives for the lifetime of one
// warm lambda instance. Every cold start gets a fresh, empty `cache`, and Alpha Vantage's free
// tier is extremely limited (historically 25 requests/day, 1/second). Real traffic hitting
// cold starts can burn the whole daily quota in minutes, after which Alpha Vantage returns a
// 200 OK with an `Information`/`Note` field instead of a rate, which used to surface here as a
// generic "Invalid rate from Alpha Vantage". The `app_settings` table gives the fetched rate a
// place to live that actually survives across invocations, the same pattern lib/app-settings.ts
// uses for every other piece of state that needs to outlast a single request.
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { getSetting, setSetting } from '@/lib/app-settings'

const DEFAULT_RATES: Record<string, number> = {
  cad: 1.36,
  aud: 1.50,
  eur: 0.92,
}
const CACHE_TTL = 1000 * 60 * 60 // 1 hour
const ENDPOINT = 'https://www.alphavantage.co/query'

const cache: Record<string, { rate: number; last: number }> = {}

function settingKey(key: string): string {
  return `fx_rate_${key}`
}

async function readPersistedRate(key: string, now: number): Promise<number | null> {
  try {
    const raw = await getSetting(getSupabaseAdmin(), settingKey(key))
    if (!raw) return null
    const parsed = JSON.parse(raw) as { rate?: number; fetchedAt?: number }
    if (
      typeof parsed.rate === 'number' &&
      Number.isFinite(parsed.rate) &&
      typeof parsed.fetchedAt === 'number' &&
      now - parsed.fetchedAt < CACHE_TTL
    ) {
      return parsed.rate
    }
    return null
  } catch (err) {
    // Fails open: no app_settings row yet, service role key unset, or the DB is unreachable.
    // A broken cache layer must never be the thing that takes the FX rate down.
    console.warn('[fx] Could not read persisted rate for', key, err)
    return null
  }
}

async function persistRate(key: string, rate: number, now: number): Promise<void> {
  try {
    await setSetting(getSupabaseAdmin(), settingKey(key), JSON.stringify({ rate, fetchedAt: now }))
  } catch (err) {
    console.warn('[fx] Could not persist rate for', key, err)
  }
}

export async function getUsdToRate(toCurrency: string): Promise<number> {
  const key = toCurrency.toLowerCase()
  const now = Date.now()

  // Fast path: still-warm in-memory cache within the same lambda instance.
  if (cache[key] && now - cache[key].last < CACHE_TTL) {
    return cache[key].rate
  }

  // Next-fastest path: a rate another invocation already fetched and persisted to the DB.
  const persisted = await readPersistedRate(key, now)
  if (persisted !== null) {
    cache[key] = { rate: persisted, last: now }
    return persisted
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
    if (!parsed || !Number.isFinite(parsed)) {
      // Alpha Vantage returns 200 OK even when rate-limited, with an `Information` or `Note`
      // field in place of the rate data. Call that out explicitly so a 2am debugger doesn't
      // have to go re-derive it from a generic "invalid rate" message.
      const limitMessage = data?.Information ?? data?.Note
      if (limitMessage) {
        throw new Error(`Alpha Vantage rate-limited: ${limitMessage}`)
      }
      throw new Error(`Invalid rate from Alpha Vantage: ${JSON.stringify(data)}`)
    }
    cache[key] = { rate: parsed, last: now }
    await persistRate(key, parsed, now)
    return parsed
  } catch (err) {
    console.error('[fx] Failed to fetch exchange rate for', key, err)
    cache[key] = { rate: defaultRate, last: now }
    return defaultRate
  }
}