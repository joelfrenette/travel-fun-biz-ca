import type { Currency, Language } from '@/lib/preferences'

const USD_TO_CAD = 1.35

function convertUsd(valueUsd: number, currency: Currency): number {
  if (currency === 'cad') {
    return valueUsd * USD_TO_CAD
  }
  return valueUsd
}

export function formatPrice(valueUsd: number, currency: Currency, language: Language) {
  const locale = language === 'fr' ? 'fr-CA' : currency === 'usd' ? 'en-US' : 'en-CA'
  const formatter = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: currency === 'usd' ? 'USD' : 'CAD',
    maximumFractionDigits: 0,
  })
  return formatter.format(convertUsd(valueUsd, currency))
}
