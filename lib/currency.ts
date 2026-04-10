// currency.ts - helpers for formatting and converting prices
export type Currency = 'usd' | 'cad' | 'aud' | 'eur'

const DEFAULT_RATES: Record<string, number> = {
  cad: 1.36,
  aud: 1.50,
  eur: 0.92,
}

export function parseUsdPrice(value?: string): number | undefined {
  if (!value) return undefined
  const cleaned = value.replace(/[^0-9.,]/g, '').replace(',', '')
  const parsed = Number.parseFloat(cleaned)
  return Number.isFinite(parsed) ? parsed : undefined
}

export function convertUsd(amount: number, currency: Currency, usdToTargetRate = 1): number {
  if (currency === 'usd') return amount
  return amount * usdToTargetRate
}

export function formatPrice(amountUsd: number, currency: Currency, usdToTargetRate = 1): string {
  const converted = convertUsd(amountUsd, currency, usdToTargetRate)
  const locale = currency === 'cad' ? 'fr-CA' : currency === 'aud' ? 'en-AU' : currency === 'eur' ? 'de-DE' : 'en-US'
  const formatter = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: currency.toUpperCase(),
    maximumFractionDigits: 0,
  })
  return formatter.format(converted)
}

export function getDefaultRateFor(currency: Currency): number {
  if (currency === 'usd') return 1
  return DEFAULT_RATES[currency] ?? 1
}
