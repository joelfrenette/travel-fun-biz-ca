import { HOOK_STYLES, rotateStyle, type HookStyle } from '@/lib/hook-styles'

// Caption planning for one post going to several networks: pure functions, no model, no network, no database.
//  - every network of the SAME post gets its own hook style (deterministic round-robin), so there is something to learn from;
//  - the "number" style is never used when the post has no number it could honestly quote;
//  - at least half of the networks get a hook that ends with a question;
//  - the hook line is short (80 characters), and the networks that invite replies get one comment prompt line;
//  - the final caption text and the style are logged (bounded), so the loop can audit and learn from what really went out.

/** The first line of a caption is read in the feed preview: it has to be over by here. */
export const HOOK_LINE_MAX_CHARS = 80
/** Networks whose caption body carries one line that asks people to reply (Instagram, Facebook, Threads). */
export const COMMENT_PROMPT_NETWORKS = ['instagram', 'facebook', 'threads'] as const
export const wantsCommentPrompt = (network: string): boolean => (COMMENT_PROMPT_NETWORKS as readonly string[]).includes(network.toLowerCase())

const NUMBER_WORD = /\b(?:two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|dozen|hundred|thousand)\b/i

/** True when the post text has a number a hook could honestly quote (a digit, or a spelled-out two..twelve, dozen, hundred, thousand).
 * Links are ignored. Without one, the "number" hook style is never chosen. */
export function hasGroundableNumber(sourceText: string): boolean {
  const text = (sourceText ?? '').replace(/https?:\/\/\S+/gi, ' ')
  return /\b\d+\b/.test(text) || NUMBER_WORD.test(text)
}

/** One style per network for ONE post. For each network in order: the least-recently-used style of that network's own history (rotateStyle),
 * chosen only from styles no earlier network of this post took, so no two networks share a style while there are enough styles
 * (7, or 6 without "number"). "number" is left out when `hasNumber` is false. Deterministic: same input, same output. */
export function assignHookStyles(
  networks: ReadonlyArray<string>,
  historyFor: (network: string) => readonly string[],
  opts: { hasNumber: boolean; offset?: number } = { hasNumber: true },
): Record<string, HookStyle> {
  const catalogue: HookStyle[] = HOOK_STYLES.filter((s) => opts.hasNumber || s !== 'number')
  const out: Record<string, HookStyle> = {}
  let free: HookStyle[] = [...catalogue]
  networks.forEach((n, i) => {
    if (free.length === 0) free = [...catalogue] // more networks than styles: start another lap
    const pick = rotateStyle(historyFor(n), free, i + (opts.offset ?? 0))
    out[n] = pick
    free = free.filter((s) => s !== pick)
  })
  return out
}

/** Styles whose hook line is naturally a question. */
const QUESTION_STYLES: readonly HookStyle[] = ['question', 'comparison']

/** Which networks must END their first line with a question mark: at least half of them (rounded up). Networks whose style is
 * already a question style come first, then the rest in order, so the requirement costs the least rewriting. */
export function questionNetworks(networks: ReadonlyArray<string>, styles: Record<string, HookStyle>): Record<string, boolean> {
  const need = Math.ceil(networks.length / 2)
  const out: Record<string, boolean> = Object.fromEntries(networks.map((n) => [n, false]))
  const ordered = [...networks.filter((n) => QUESTION_STYLES.includes(styles[n])), ...networks.filter((n) => !QUESTION_STYLES.includes(styles[n]))]
  for (const n of ordered.slice(0, need)) out[n] = true
  return out
}

/** Problems with the first line of a tailored caption (empty when fine): it must be over within 80 characters, and end with a
 * question mark when this network is one of those that must. */
export function firstLineProblems(caption: string, opts: { requireQuestion?: boolean } = {}): string[] {
  const first = caption.split('\n').find((l) => l.trim())?.trim() ?? ''
  const problems: string[] = []
  if (first.length > HOOK_LINE_MAX_CHARS) problems.push(`hook line is over ${HOOK_LINE_MAX_CHARS} characters (${first.length})`)
  if (opts.requireQuestion && !first.endsWith('?')) problems.push('hook line does not end with a question')
  return problems
}

// ---- the caption log: what was really sent, per network, bounded ----------------------------------------------------------

export const CAPTION_LOG_KEY = 'social_caption_log'
export const CAPTION_LOG_MAX = 200
export const CAPTION_TEXT_MAX = 900

export type CaptionFormat = 'post' | 'carousel' | 'video' | 'recap'

export interface CaptionLogEntry {
  /** ISO time the caption was handed to the provider. */
  at: string
  slug: string
  /** The network, or the networks that shared one send joined with "/" (carousel and video go out as one caption). */
  network: string
  format: CaptionFormat
  /** The hook style, or "fallback" when the caption was built without a style. */
  style: string
  /** The caption text exactly as sent (cut at 900 characters). */
  text: string
}

const cleanEntry = (e: Partial<CaptionLogEntry>): CaptionLogEntry | null =>
  e && typeof e.slug === 'string' && typeof e.network === 'string' && typeof e.text === 'string'
    ? { at: typeof e.at === 'string' ? e.at : new Date(0).toISOString(), slug: e.slug.slice(0, 160), network: e.network.slice(0, 80), format: e.format === 'carousel' || e.format === 'video' || e.format === 'recap' ? e.format : 'post', style: typeof e.style === 'string' && e.style ? e.style.slice(0, 40) : 'fallback', text: e.text.slice(0, CAPTION_TEXT_MAX) }
    : null

/** The stored log, newest first. Bad JSON or a non-array reads as empty. */
export function parseCaptionLog(raw: string | null | undefined): CaptionLogEntry[] {
  try {
    const v = raw ? JSON.parse(raw) : []
    return Array.isArray(v) ? (v.map((e) => cleanEntry(e as Partial<CaptionLogEntry>)).filter(Boolean) as CaptionLogEntry[]) : []
  } catch {
    return []
  }
}

/** The new stored value: `entries` (newest first) in front of what was there, cut to the last `max` (200). Pure. */
export function appendCaptionLog(raw: string | null | undefined, entries: ReadonlyArray<Partial<CaptionLogEntry>>, max = CAPTION_LOG_MAX): string {
  const fresh = entries.map(cleanEntry).filter(Boolean) as CaptionLogEntry[]
  return JSON.stringify([...fresh, ...parseCaptionLog(raw)].slice(0, Math.max(1, max)))
}

export interface RecentCaption {
  at: string
  slug: string
  network: string
  format: CaptionFormat
  style: string
  /** First 120 characters of the caption. */
  preview: string
}

/** The last `n` captions for the admin list: network, style and the first 120 characters. */
export function recentCaptions(raw: string | null | undefined, n = 10): RecentCaption[] {
  return parseCaptionLog(raw)
    .slice(0, n)
    .map((e) => ({ at: e.at, slug: e.slug, network: e.network, format: e.format, style: e.style, preview: e.text.replace(/\s+/g, ' ').trim().slice(0, 120) }))
}
