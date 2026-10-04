// Mechanical caption-limit enforcement (factory spec: "a second, mechanical enforcement pass
// re-checks whatever the model/template returned against hard limits in plain code, not trusting
// it to have gotten every number exactly right"). These are each platform's own published
// character limit - public facts, not invented - kept as one small table so a future network
// addition is one line here, not a guess scattered through the distribution code.
//
// Scope note: Upload-Post's confirmed API (lib/upload-post.ts) takes ONE caption per call that
// applies to every requested platform - there is no per-platform text field. Real per-platform
// VOICE (not just length) would mean either a new AI call per post or one Upload-Post call per
// platform (multiplying its metered "uploads used this period" quota) - a real cost/quota
// tradeoff, not a free win, so that's flagged for Joel rather than built blind. What this file
// does is the safe, zero-cost part: make sure the one shared caption Upload-Post receives can
// never silently exceed any target platform's hard limit.
export const PLATFORM_CHAR_LIMITS: Record<string, number> = {
  twitter: 280,
  x: 280,
  bluesky: 300,
  threads: 500,
  pinterest: 500,
  tiktok: 2200,
  instagram: 2200,
  facebook: 63206,
  linkedin: 3000,
  youtube: 5000,
}
/** Conservative fallback for a platform not in the table above - better to truncate a bit early
 * than to silently exceed an unlisted network's real limit. */
const DEFAULT_CHAR_LIMIT = 280

/** The tightest limit among the platforms a caption is about to go out to - the caption has to
 * fit all of them in one shared call, so it's bounded by whichever is most restrictive. */
export function tightestLimit(platforms: string[]): number {
  if (platforms.length === 0) return DEFAULT_CHAR_LIMIT
  return Math.min(...platforms.map((p) => PLATFORM_CHAR_LIMITS[p.toLowerCase()] ?? DEFAULT_CHAR_LIMIT))
}

/** Trims text to fit `limit`, cutting at the last whole word that still fits and appending an
 * ellipsis - never a mid-word or mid-URL cut, and never silently over the real limit. */
export function fitCaption(text: string, limit: number): string {
  if (text.length <= limit) return text
  const ELLIPSIS = '…'
  const budget = limit - ELLIPSIS.length
  if (budget <= 0) return text.slice(0, Math.max(limit, 0))
  const cut = text.slice(0, budget)
  const lastSpace = cut.lastIndexOf(' ')
  const trimmed = lastSpace > budget * 0.6 ? cut.slice(0, lastSpace) : cut
  return `${trimmed.trimEnd()}${ELLIPSIS}`
}
