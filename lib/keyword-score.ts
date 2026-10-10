// Which keyword should the next blog post be about? A score from 0 to 100 plus a "can we use it at all"
// gate, built for a NEW site with little authority, where raw search volume is the wrong guide:
//   40%  Winnability  low competition, a specific (3+ word) phrase, and a bonus when Google already shows
//                     us for it just off page one (the cheapest win there is)
//   25%  Demand       volume on a diminishing scale; 0 means "Google does not report small numbers", so it
//                     is treated as unknown, never as "nobody searches"
//   20%  Intent       words of someone planning to book (trip, tour, cruise, group, singles, from Canada,
//                     a year) plus the cost-per-click as a stand-in for commercial value
//   15%  Timing       is the trip's departure far enough ahead to publish now (3 to 12 months is best)
// GATE (a phrase that fails any is never chosen): it is about a trip we really sell that has not already
// left, no page targets it yet, nothing in its group of near-duplicate phrases is covered or already
// ranks on page one, and it was not skipped before. Near-duplicates are grouped into ONE topic with one
// main phrase and the rest as secondary phrases, so seven Rhine phrases cannot become seven Rhine posts.
// Pure functions: no database, no network. Every number comes from recorded research or Search Console.

export interface ScoreKeyword {
  keyword: string
  volume: number | null
  cpc: number | null
  /** Google Ads competition index, 0 to 100 (a 0 to 1 value is also accepted). */
  competition: number | null
  gsc_impressions: number | null
  gsc_position: number | null
  target_path: string | null
  note: string | null
}

export interface ScorePackage {
  slug?: string
  name: string
  destination: string | null
  available_from: string | null
  available_to: string | null
}

export interface KeywordScore {
  keyword: string
  score: number
  parts: { winnability: number; demand: number; intent: number; timing: number }
  eligible: boolean
  /** Plain-English reasons: why it scored as it did, or why it cannot be used. */
  reasons: string[]
  /** The package it is about, when one matches. */
  packageName: string | null
  packageSlug: string | null
  /** The main phrase of its group, and the other phrases in the group. */
  primary: string
  secondary: string[]
}

const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'in', 'on', 'to', 'for', 'from', 'with', 'by', 'at', 'is', 'are', 'how', 'what', 'near', 'me', 'cheap', 'best'])
const INTENT = new Set(['trip', 'trips', 'tour', 'tours', 'cruise', 'cruises', 'package', 'packages', 'book', 'price', 'cost', 'itinerary', 'group', 'singles', 'women', "women's", 'girls', 'getaway', 'vacation', 'vacations', 'canada', 'yacht', 'sailing', 'river', 'women', 'girl', 'week'])

const tokens = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s'-]/g, ' ').split(/[\s]+/).filter((w) => w.length > 1 && !STOP.has(w))
// The trailing-e strip makes "cruise" and "cruises" the same stem (both "cruis"), so singular and plural
// phrases land in one group.
const stem = (w: string) => w.replace(/'s$/, '').replace(/(es|s)$/, '').replace(/e$/, '')
export const stems = (s: string) => new Set(tokens(s).map(stem).filter((w) => w.length > 2))

export function jaccard(a: Set<string>, b: Set<string>): number {
  let inter = 0
  for (const x of a) if (b.has(x)) inter++
  const union = a.size + b.size - inter
  return union ? inter / union : 0
}

/** Two phrases whose meaningful words overlap by at least this much (Jaccard) are one topic. */
export const GROUP_SIMILARITY = 0.5

/** Groups items whose phrases are near-duplicates. The first item of each group is its seed, so pass the
 * items best first. This is THE grouping used by rankKeywords and by lib/keyword-cluster.ts. */
export function groupBySimilarity<T>(items: T[], phraseOf: (item: T) => string): T[][] {
  const groups: { members: T[]; sig: Set<string> }[] = []
  for (const item of items) {
    const sig = stems(phraseOf(item))
    const home = groups.find((g) => jaccard(g.sig, sig) >= GROUP_SIMILARITY)
    if (home) home.members.push(item)
    else groups.push({ members: [item], sig })
  }
  return groups.map((g) => g.members)
}

function monthsUntil(date: string | null, now: Date): number | null {
  if (!date) return null
  const t = Date.parse(date)
  return Number.isFinite(t) ? (t - now.getTime()) / (30.44 * 86_400_000) : null
}

/** Only the words that name a PLACE or a specific trip: generic travel words (trip, cruise, group, a year...)
 * match every package and would match a phrase to the wrong one ("tahiti cruise" to a Croatia cruise). */
const distinct = (s: string) => new Set(tokens(s).filter((w) => !INTENT.has(w) && !/^20\d\d$/.test(w) && w !== 'travel').map(stem).filter((w) => w.length > 2))

/** The package a keyword is about: the one sharing the most place-or-trip words with its name or destination.
 * A phrase with no such word (for example "group trips for singles") is about no specific trip. */
function matchPackage(keyword: string, packages: ScorePackage[]): ScorePackage | null {
  const kw = distinct(keyword)
  let best: { p: ScorePackage; n: number } | null = null
  for (const p of packages) {
    const hay = distinct(`${p.name} ${p.destination ?? ''}`)
    let n = 0
    for (const w of kw) if (hay.has(w)) n++
    if (n && (!best || n > best.n)) best = { p, n }
  }
  return best?.p ?? null
}

function scoreOne(k: ScoreKeyword, packages: ScorePackage[], now: Date, peaks: Record<string, { peak: number }>): Omit<KeywordScore, 'primary' | 'secondary'> {
  const reasons: string[] = []
  const words = tokens(k.keyword)
  const pkg = matchPackage(k.keyword, packages)

  // Winnability
  const comp = k.competition == null ? null : k.competition <= 1 ? k.competition * 100 : k.competition
  let win = comp == null ? 0.5 : 1 - comp / 100
  if (words.length >= 4) win += 0.15
  else if (words.length === 3) win += 0.05
  const nearMiss = k.gsc_position != null && k.gsc_position > 7 && k.gsc_position <= 30 && (k.gsc_impressions ?? 0) > 0
  if (nearMiss) {
    win += 0.3
    reasons.push(`Google already shows us for it at position ${Math.round(k.gsc_position as number)}: a small push could reach page one`)
  }
  win = Math.max(0, Math.min(1, win))

  // Demand
  const vol = k.volume ?? 0
  const demand = vol >= 10 ? Math.min(1, Math.log10(vol) / Math.log10(300)) : 0.25
  reasons.push(vol >= 10 ? `${vol} searches a month` : 'Google does not report a volume this small, so demand is unknown (not zero)')

  // Intent
  let intent = Math.min(1, words.filter((w) => INTENT.has(w) || /^20\d\d$/.test(w)).length * 0.2)
  if ((k.cpc ?? 0) >= 1) intent = Math.min(1, intent + 0.2)

  // Timing
  const m = monthsUntil(pkg?.available_from ?? null, now)
  // An end date earlier than the start date is a data typo (seen on a trip ending "2026-01-04" that starts
  // 2026-12-28): ignore it and use the start date, rather than calling a future trip past.
  const endOk = pkg?.available_to && pkg.available_from && pkg.available_to >= pkg.available_from ? pkg.available_to : null
  const left = monthsUntil(endOk ?? pkg?.available_from ?? null, now)
  let timing = 0.4
  if (m != null) timing = m >= 3 && m <= 12 ? 1 : m > 12 && m <= 24 ? 0.6 : m > 24 ? 0.35 : m >= 0 ? 0.7 : 0
  if (pkg && left != null && left < 0) timing = 0
  // Google Trends: when this destination is searched most. Publishing 1 to 4 months BEFORE that peak gives
  // the page time to be found; being in the peak month already is late.
  const peak = pkg?.destination ? peaks[pkg.destination.trim().toLowerCase()]?.peak : undefined
  if (peak && timing > 0) {
    const toPeak = (peak - (now.getUTCMonth() + 1) + 12) % 12
    if (toPeak >= 1 && toPeak <= 4) {
      timing = 1
      reasons.push(`Interest in ${pkg?.destination} peaks in about ${toPeak} month${toPeak === 1 ? '' : 's'}: a good time to publish`)
    } else if (toPeak === 0) timing = Math.min(timing, 0.5)
  }

  // Gate
  let eligible = true
  if (!pkg) {
    eligible = false
    reasons.push('Not about a specific trip we sell (a general phrase: better as a destination or guide page)')
  } else if (left != null && left < 0) {
    eligible = false
    reasons.push(`The trip "${pkg.name}" has already left`)
  }
  if (k.target_path) {
    eligible = false
    reasons.push(`Already targeted by ${k.target_path}`)
  }
  if (k.gsc_position != null && k.gsc_position <= 7 && (k.gsc_impressions ?? 0) > 0) {
    eligible = false
    reasons.push('Already on page one of Google')
  }
  if (/^skipped/i.test(k.note ?? '')) {
    eligible = false
    reasons.push(`Skipped before (${k.note})`)
  }

  const score = Math.round(100 * (0.4 * win + 0.25 * demand + 0.2 * intent + 0.15 * timing))
  return { keyword: k.keyword, score, parts: { winnability: Math.round(win * 100), demand: Math.round(demand * 100), intent: Math.round(intent * 100), timing: Math.round(timing * 100) }, eligible, reasons, packageName: pkg?.name ?? null, packageSlug: pkg?.slug ?? null }
}

/** Scores every keyword, groups near-duplicates (a group is covered if ANY phrase in it is), and returns
 * them best first, one entry per keyword with its group's main phrase. */
export function rankKeywords(rows: ScoreKeyword[], packages: ScorePackage[], now = new Date(), peaks: Record<string, { peak: number }> = {}): KeywordScore[] {
  const scored = rows.map((r) => scoreOne(r, packages, now, peaks)).sort((a, b) => b.score - a.score)
  const byKeyword = new Map<string, KeywordScore>()
  for (const members of groupBySimilarity(scored, (s) => s.keyword)) {
    const covered = members.some((m) => m.reasons.some((r) => /^Already (targeted|on page one)/.test(r)))
    const primary = members.find((m) => m.eligible) ?? members[0]
    for (const m of members) {
      const reasons = [...m.reasons]
      const eligible = m.eligible && !covered
      if (m.eligible && covered) reasons.push('A near-duplicate phrase in its group is already covered')
      byKeyword.set(m.keyword, { ...m, reasons, eligible, primary: primary.keyword, secondary: members.filter((x) => x.keyword !== primary.keyword).map((x) => x.keyword) })
    }
  }
  return scored.map((s) => byKeyword.get(s.keyword) as KeywordScore)
}

/** The topics to write next: the best usable phrase of each group, best first. */
export function nextUp(ranked: KeywordScore[], limit = 5): KeywordScore[] {
  return ranked.filter((r) => r.eligible && r.keyword === r.primary).slice(0, limit)
}
