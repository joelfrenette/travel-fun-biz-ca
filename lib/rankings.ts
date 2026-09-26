// Ported from Nomad Escape Plan's modules/marketing/rankings.ts (Factory Phase 5: SEO/indexing),
// verbatim - genuinely subject-agnostic ("the pure part", per its own header). A lower position
// number is better, so a page "moves up" when its number falls.
export interface RankDayRow {
  day: string
  top10: number
  top50: number
  top100: number
  queries: number
  clicks: number
  impressions: number
}

export interface RankRow {
  day: string
  key: string
  position: number
  clicks: number
  impressions: number
}

/** How many keywords sit in the top 10, 50 and 100 (cumulative: a top-10 keyword counts in all three). */
export function bucketCounts(positions: number[]): { top10: number; top50: number; top100: number } {
  let top10 = 0
  let top50 = 0
  let top100 = 0
  for (const p of positions) {
    if (!(p >= 1)) continue
    if (p <= 10) top10++
    if (p <= 50) top50++
    if (p <= 100) top100++
  }
  return { top10, top50, top100 }
}

/** "/blog/some-post" from a full page URL, or null for anything that isn't a blog post. Also
 * matches this site's /packages/[slug] pages, since those are worth tracking rankings for too. */
export function trackedPathOf(pageUrl: string): string | null {
  let path: string
  try {
    path = new URL(pageUrl).pathname
  } catch {
    path = pageUrl.startsWith('/') ? pageUrl : ''
  }
  path = path.replace(/\/+$/, '')
  return /^\/(blog|packages)\/[^/]+$/.test(path) ? path : null
}

export interface RankPoint {
  day: string
  position: number
}

/** A tracked page or keyword compared between its first and latest snapshot. */
export interface Mover {
  key: string
  first: number
  latest: number
  /** Positive = moved up (the position number fell). */
  change: number
  clicks: number
  impressions: number
  series: RankPoint[]
}

/** Group snapshot rows by key and compare each key's first day with its latest. Biggest change first. */
export function buildMovers(rows: RankRow[]): Mover[] {
  const byKey = new Map<string, RankRow[]>()
  for (const r of rows) {
    const list = byKey.get(r.key)
    if (list) list.push(r)
    else byKey.set(r.key, [r])
  }
  const movers: Mover[] = []
  for (const [key, list] of byKey) {
    list.sort((a, b) => a.day.localeCompare(b.day))
    const first = list[0]
    const latest = list[list.length - 1]
    movers.push({
      key,
      first: first.position,
      latest: latest.position,
      change: Math.round((first.position - latest.position) * 10) / 10,
      clicks: latest.clicks,
      impressions: latest.impressions,
      series: list.map((r) => ({ day: r.day, position: r.position })),
    })
  }
  return movers.sort((a, b) => Math.abs(b.change) - Math.abs(a.change) || b.impressions - a.impressions)
}

/** SVG polyline points for a series, best position at the top. Empty for fewer than two points. */
export function sparkPoints(series: RankPoint[], width: number, height: number): string {
  if (series.length < 2) return ''
  const values = series.map((p) => p.position)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  return series
    .map((p, i) => {
      const x = (i / (series.length - 1)) * width
      const y = ((p.position - min) / span) * (height - 2) + 1
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
}
