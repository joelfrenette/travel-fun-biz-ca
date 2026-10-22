// Pure scoring for stock-photo candidates (Instagram quality work). No network, no database, no sharp:
// lib/pexels.ts fetches candidates and measures colour, this file decides which one wins, so
// scripts/check-photo-score.ts can test every rule offline.
//
// Why it exists: the old code took Pexels' first hit blindly. First hits for a travel keyword are
// sometimes a laptop on a desk or a coffee cup, or the same photo a recent post already used.

/** Alt text that marks a photo as the wrong subject for a travel brand. A hit is a hard reject: such a photo is
 * never used, not even when nothing else matches. */
export const BANNED_ALT = /\b(laptop|desk|office worker|office|computer|business(?:man|woman|people)?|keyboard|notebook|spreadsheet)\b/i

/** Place or landmark phrases that contain a banned word but are real travel subjects ("Post office in Lisbon"). */
const ALLOWED_PHRASES = /\b(post office|office de tourisme|tourist office|coffee plantations?|meeting of the waters)\b/gi

/** True when the alt text marks the photo as the wrong subject. Allowed travel phrases are removed first. */
export function isBannedAlt(alt: string): boolean {
  return BANNED_ALT.test((alt || '').replace(ALLOWED_PHRASES, ' '))
}

/** Words that carry no place or topic meaning, so matching one proves nothing. */
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'into', 'near', 'best', 'top', 'guide', 'travel', 'trip', 'trips', 'tips', 'your', 'our', 'what', 'how', 'when', 'why', 'are', 'you', 'this', 'that', 'vacation', 'holiday', 'things', 'visit', 'visiting', 'photo', 'photos',
])

/** Lowercase words of 3+ letters from a search query or destination, without filler words. */
export function queryTokens(query: string): string[] {
  const words = (query || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w))
  return [...new Set(words)]
}

export interface PhotoCandidate {
  id: number
  url: string
  alt: string | null
  width: number
  height: number
  /** Optional colour stats from a downscaled copy (see vividnessOf). Missing = unknown, scored as neutral. */
  stats?: ColourStats | null
}

export interface ColourStats {
  /** Mean HSV saturation, 0..1. */
  meanSaturation: number
  /** Mean luminance, 0..1. */
  meanLuma: number
  /** Standard deviation of luminance, 0..1 (contrast). */
  lumaStd: number
}

export interface ScoreContext {
  tokens: string[]
  recentIds: ReadonlySet<number>
  /** Hard minimums; anything smaller is rejected. */
  minWidth: number
  minHeight: number
}

export const DEFAULT_MIN_WIDTH = 1200
export const DEFAULT_MIN_HEIGHT = 800
/** A 1080x1350 Instagram portrait cover is cropped from the photo; taller than this is sharp at that size. */
export const SHARP_HEIGHT = 1350

/** 0..1 "how lively is it": saturated, well exposed, with contrast. Near-black or washed-out photos score low.
 * Unknown stats are neutral (0.5) so a failed colour check never blocks a photo. */
export function vividnessOf(stats: ColourStats | null | undefined): number {
  if (!stats) return 0.5
  const { meanSaturation: s, meanLuma: l, lumaStd: c } = stats
  if (![s, l, c].every((n) => Number.isFinite(n))) return 0.5
  const sat = Math.min(1, s / 0.5) // 0.5 mean saturation is already very colourful
  const contrast = Math.min(1, c / 0.25)
  // Best exposure sits mid-range; both a dark and a blown-out photo lose points.
  const exposure = 1 - Math.min(1, Math.abs(l - 0.5) / 0.45)
  return Math.max(0, Math.min(1, sat * 0.55 + contrast * 0.2 + exposure * 0.25))
}

export type RejectReason = 'banned-subject' | 'too-small' | 'invalid'

export interface ScoredPhoto {
  photo: PhotoCandidate
  /** Higher is better. Meaningless when `rejected` is set. */
  score: number
  rejected: RejectReason | null
  /** True when the alt text mentions at least one query token. */
  relevant: boolean
  recent: boolean
}

/** Score one candidate. Rejections are hard (never picked); relevance and recency are soft (picked only when
 * nothing better exists, which is the "fail open" rule). */
export function scoreCandidate(c: PhotoCandidate, ctx: ScoreContext): ScoredPhoto {
  const base = { photo: c, score: 0, relevant: false, recent: ctx.recentIds.has(c.id) }
  if (!c || !c.url || !Number.isFinite(c.id)) return { ...base, rejected: 'invalid' }
  const alt = (c.alt ?? '').trim()
  if (isBannedAlt(alt)) return { ...base, rejected: 'banned-subject' }
  if (!(c.width >= ctx.minWidth) || !(c.height >= ctx.minHeight)) return { ...base, rejected: 'too-small' }

  const altLower = alt.toLowerCase()
  const hits = ctx.tokens.filter((t) => altLower.includes(t)).length
  const relevant = hits > 0
  let score = 0
  if (relevant) score += 4 + Math.min(2, hits - 1) // 4 for one matching word, up to 6 for three
  score += vividnessOf(c.stats) * 3
  if (c.height >= SHARP_HEIGHT) score += 0.5
  if (alt) score += 0.25 // a described photo is a little safer than an undescribed one
  if (base.recent) score -= 5
  return { ...base, score, relevant, rejected: null }
}

export interface RankResult {
  /** Best first. Rejected photos are not in this list. */
  ranked: ScoredPhoto[]
  rejectedCount: number
  /** True when no photo matched a query word, so the best remaining one is used anyway (callers log it). */
  failedOpen: boolean
}

/** Score and order candidates. A relevant, not-recent photo always beats an irrelevant one: relevance is a tier,
 * the score only orders inside a tier. */
export function rankCandidates(candidates: PhotoCandidate[], ctx: ScoreContext): RankResult {
  const scored = candidates.map((c) => scoreCandidate(c, ctx))
  const kept = scored.filter((s) => !s.rejected)
  const tier = (s: ScoredPhoto) => (s.relevant ? 0 : 1) + (s.recent ? 2 : 0)
  kept.sort((a, b) => tier(a) - tier(b) || b.score - a.score || a.photo.id - b.photo.id)
  const failedOpen = ctx.tokens.length > 0 && kept.length > 0 && !kept.some((s) => s.relevant)
  return { ranked: kept, rejectedCount: scored.length - kept.length, failedOpen }
}

/** The last-N list kept in app_settings: parse defensively, newest last, capped. */
export const RECENT_PHOTO_CAP = 30
export function parseRecentIds(raw: string | null | undefined): number[] {
  if (!raw) return []
  try {
    const v: unknown = JSON.parse(raw)
    if (!Array.isArray(v)) return []
    return v.filter((n): n is number => typeof n === 'number' && Number.isFinite(n)).slice(-RECENT_PHOTO_CAP)
  } catch {
    return []
  }
}
export function pushRecentId(list: number[], id: number): number[] {
  const next = list.filter((n) => n !== id)
  next.push(id)
  return next.slice(-RECENT_PHOTO_CAP)
}
