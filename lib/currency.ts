// currency.ts - helpers for formatting and converting prices
export type Currency = 'usd' | 'cad'

const USD_TO_CAD_RATE = 1.36

export function parseUsdPrice(value?: string): number | undefined {
  if (!value) return undefined
  const cleaned = value.replace(/[^0-9.,]/g, '').replace(',', '')
  const parsed = Number.parseFloat(cleaned)
  return Number.isFinite(parsed) ? parsed : undefined
}

export function convertUsd(amount: number, currency: Currency): number {
  if (currency === 'cad') {
    return amount * USD_TO_CAD_RATE
  }
  return amount
}

export function formatPrice(amountUsd: number, currency: Currency): string {
  const converted = convertUsd(amountUsd, currency)
  const formatter = new Intl.NumberFormat(currency === 'cad' ? 'fr-CA' : 'en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
    maximumFractionDigits: 0,
  })
  return formatter.format(converted)
}