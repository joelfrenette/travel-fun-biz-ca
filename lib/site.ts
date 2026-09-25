// Site-wide identity. The .com replica overrides these through env vars, not a fork.
export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL || 'https://travelfunbiz.ca').replace(/\/$/, '')
export const SITE_NAME = process.env.NEXT_PUBLIC_SITE_NAME || 'TravelFunBiz.ca'
export const SITE_LOCALE = process.env.NEXT_PUBLIC_SITE_LOCALE || 'en_CA'
export const DEFAULT_OG_IMAGE = `${SITE_URL}/group-of-friends-having-fun-on-tropical-beach-vaca.jpg`

export function absoluteUrl(path: string): string {
  return path.startsWith('http') ? path : `${SITE_URL}${path.startsWith('/') ? path : `/${path}`}`
}

/** "2026-09-03" + "2026-09-16" -> "Sep 3 – 16, 2026"; single date -> "Sep 3, 2026". */
export function formatDateRange(from: string | null, to: string | null): string | null {
  const parse = (s: string | null) => {
    if (!s) return null
    const d = new Date(`${s}T00:00:00`)
    return Number.isNaN(d.getTime()) ? null : d
  }
  const a = parse(from), b = parse(to)
  if (!a && !b) return null
  const fmt = (d: Date, opts: Intl.DateTimeFormatOptions) => d.toLocaleDateString('en-CA', opts)
  if (a && b) {
    if (a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth()) {
      return `${fmt(a, { month: 'short', day: 'numeric' })} – ${b.getDate()}, ${b.getFullYear()}`
    }
    if (a.getFullYear() === b.getFullYear()) {
      return `${fmt(a, { month: 'short', day: 'numeric' })} – ${fmt(b, { month: 'short', day: 'numeric' })}, ${b.getFullYear()}`
    }
    return `${fmt(a, { month: 'short', day: 'numeric', year: 'numeric' })} – ${fmt(b, { month: 'short', day: 'numeric', year: 'numeric' })}`
  }
  return fmt((a || b) as Date, { month: 'short', day: 'numeric', year: 'numeric' })
}
