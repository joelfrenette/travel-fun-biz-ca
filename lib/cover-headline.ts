import { ungroundedNumbers } from '@/lib/hook-styles'

// Instagram cover headline rules (owner brief): short, bold, a real hook, never a fragment. Pure
// functions only, so scripts/check-cover-headline.ts can test them offline.

export const COVER_MIN_WORDS = 3
export const COVER_MAX_WORDS = 6
export const COVER_MAX_CHARS = 36
export const COVER_MAX_WORD_LENGTH = 12

/** A headline may not END on one of these (it reads as a cut-off sentence). */
export const BANNED_ENDINGS = ['and', 'the', 'to', 'of', 'in', 'a', 'for', 'with', 'or', 'at', 'on'] as const

/** A headline may not START with one of these (generic brochure openers). */
export const BANNED_OPENERS = [
  'discover',
  'explore',
  'welcome',
  'introducing',
  'ultimate guide',
  'everything you need',
  'tips for',
  'guide to',
  'why you should',
  'have you ever wondered',
] as const

export type HookPattern = 'question' | 'or' | 'vs' | 'a-to-b-by-c' | 'plus' | 'list' | 'decoded' | 'quiz' | 'number'

export interface CoverHeadlineResult {
  ok: boolean
  reasons: string[]
  /** Which allowed hook pattern matched, when one did. */
  pattern: HookPattern | null
}

const EMOJI_RE = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}‍️]/u
const NUMBER_WORD_RE = /\b(two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|dozen|hundred|thousand)\b/i

export function headlineWords(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean)
}

const bare = (w: string) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')

function listItems(text: string): number {
  const parts = text.replace(/[?!]+$/, '').split(/\s*,\s*(?:and\s+|&\s*)?/i).map((p) => p.trim()).filter(Boolean)
  return text.includes(',') ? parts.length : 0
}

/** Which allowed hook pattern the headline matches, or null. `source` is the post text that numbers must be traceable to. */
export function matchHookPattern(headline: string, source = ''): HookPattern | null {
  const h = headline.trim()
  const lower = h.toLowerCase()
  if (/\?$/.test(h)) return 'question'
  if (/\bdecoded\b/.test(lower)) return 'decoded'
  if (/\bquiz\b/.test(lower) || /^which\b.*\b(are you|suits you|fits you|is yours)\b/.test(lower) || /^(take|try) the\b/.test(lower)) return 'quiz'
  if (/\bvs\.?(?=\s)/.test(lower)) return 'vs'
  if (/^\S+.*\bto\s+\S+.*\bby\s+\S+/.test(lower)) return 'a-to-b-by-c'
  if (/\bplus\b/.test(lower)) return 'plus'
  const items = listItems(h)
  if (items >= 3 && items <= 4) return 'list'
  if (/\S\s+or\s+\S/.test(lower)) return 'or'
  if ((/\d/.test(h) || NUMBER_WORD_RE.test(h)) && ungroundedNumbers(h, source).length === 0) return 'number'
  return null
}

/** Checks a cover headline against every rule. `source` is the post title plus body, for the number check. */
export function validateCoverHeadline(headline: string, source = ''): CoverHeadlineResult {
  const reasons: string[] = []
  const h = (headline ?? '').trim()
  if (!h) return { ok: false, reasons: ['empty'], pattern: null }
  const words = headlineWords(h)
  const lower = h.toLowerCase()
  const lastWord = bare(words[words.length - 1] ?? '').toLowerCase()

  if (words.length < COVER_MIN_WORDS || words.length > COVER_MAX_WORDS) reasons.push(`needs ${COVER_MIN_WORDS} to ${COVER_MAX_WORDS} words, has ${words.length}`)
  if (h.length > COVER_MAX_CHARS) reasons.push(`over ${COVER_MAX_CHARS} characters (${h.length})`)
  const long = words.map(bare).find((w) => w.length > COVER_MAX_WORD_LENGTH)
  if (long) reasons.push(`word "${long}" is longer than ${COVER_MAX_WORD_LENGTH} characters`)
  if ((BANNED_ENDINGS as readonly string[]).includes(lastWord)) reasons.push(`ends on "${lastWord}"`)
  if (/[\u2014\u2013]|\s--\s/.test(h)) reasons.push('contains a dash character')
  if (EMOJI_RE.test(h)) reasons.push('contains an emoji')
  if (h.includes(':')) reasons.push('contains a colon subtitle')
  if (/\.\s*$/.test(h) || /…\s*$/.test(h)) reasons.push('ends with a period')
  const opener = BANNED_OPENERS.find((o) => lower === o || lower.startsWith(`${o} `) || lower.startsWith(`${o},`))
  if (opener) reasons.push(`starts with "${opener}"`)
  const stray = ungroundedNumbers(h, source)
  if (stray.length > 0) reasons.push(`number not in the post: ${stray.join(', ')}`)

  const pattern = matchHookPattern(h, source)
  if (!pattern) reasons.push('is not a hook (question, X or Y, X vs Y, A to B by C, X plus Y, list of places, decoded, quiz, or a real number)')

  return { ok: reasons.length === 0, reasons, pattern }
}

export function isValidCoverHeadline(headline: string, source = ''): boolean {
  return validateCoverHeadline(headline, source).ok
}

/** Prompt fragment for the retry: what failed, plus the banned lists, in plain words. */
export function coverRetryInstruction(badHeadline: string, reasons: readonly string[]): string {
  return `The cover headline "${badHeadline}" was rejected: ${reasons.join('; ')}. Write a SHORTER cover headline for slide 1: ${COVER_MIN_WORDS} to ${COVER_MAX_WORDS} words, at most ${COVER_MAX_CHARS} characters, no word over ${COVER_MAX_WORD_LENGTH} characters. It must be one of: a question ending in a question mark, "X or Y", "X vs Y", "A to B by C", "X plus Y", a comma list of 3 or 4 places, a headline containing the word "decoded", or a quiz call to action. Never end it with: ${BANNED_ENDINGS.join(', ')}. Never start it with: ${BANNED_OPENERS.join(', ')}. No colon, no dash, no emoji, no full stop at the end.`
}

// ---- Deterministic fallback ------------------------------------------------------------------------

/** Cleans one title phrase: collapses spaces, drops quotes and trailing punctuation. */
function tidy(phrase: string): string {
  return phrase.replace(/\s+/g, ' ').replace(/["“”]/g, '').replace(/[\s.,;:!\-]+$/, '').trim()
}

/** The title split at its natural breaks (colon, bar, dash, brackets, question mark), keeping whole phrases only. */
export function titlePhrases(postTitle: string): string[] {
  const text = postTitle.replace(/\s+/g, ' ').trim()
  const out: string[] = []
  const add = (p: string) => {
    const t = tidy(p)
    if (t && !out.includes(t)) out.push(t)
  }
  // Question titles keep their question mark.
  for (const m of text.match(/[^?]+\?/g) ?? []) add(m.replace(/^[\s:|\-\u2013\u2014]+/, ''))
  for (const seg of text.split(/\s*[:|\u2013\u2014]\s*|\s+-\s+|\s*[()]\s*/)) add(seg)
  add(text)
  return out
}

const CAPITAL_TOKEN = /^[\p{Lu}\p{N}]/u

/**
 * A cover headline built from a WHOLE short phrase of the post title, or null when none can be made
 * honestly. Tries each phrase as it is, then the phrase plus "decoded". Never cuts a phrase at a
 * word count, so it can never produce a fragment such as "PUERTO PLATA TRIP AND".
 */
export function fallbackCoverHeadline(postTitle: string, source = ''): string | null {
  const phrases = titlePhrases(postTitle)
  const src = source || postTitle
  for (const p of phrases) {
    if (isValidCoverHeadline(p, src)) return p
  }
  for (const p of phrases) {
    const words = headlineWords(p)
    // Only a label-like phrase gets "decoded" (not a sentence or a question).
    if (/\?$/.test(p) || words.length > COVER_MAX_WORDS - 1 || words.length < 2) continue
    if (!CAPITAL_TOKEN.test(words[0])) continue
    const cand = `${p} decoded`
    if (isValidCoverHeadline(cand, src)) return cand
  }
  return null
}

// ---- Reel cover (frame 0 of a short video) ------------------------------------------------------------------

/** A reel cover headline is shorter than a feed cover: at most 5 words. */
export const REEL_COVER_MAX_WORDS = 5

/** The cover rules plus the 5 word reel limit. `source` is the post text numbers must be traceable to. */
export function checkReelCoverTitle(title: string, source = ''): { ok: boolean; reasons: string[] } {
  const result = validateCoverHeadline(title, source)
  const reasons = [...result.reasons]
  const n = headlineWords(title ?? '').length
  if (n > REEL_COVER_MAX_WORDS) reasons.push(`a reel cover is at most ${REEL_COVER_MAX_WORDS} words, has ${n}`)
  return { ok: reasons.length === 0, reasons }
}

/**
 * The reel cover headline: the first candidate (the model's, then the caller's other choices) that passes the reel check,
 * else the post title's own whole phrases, then a phrase plus "decoded". `ok` is false only when nothing passes; `title` is
 * then the best candidate so the caller can show it, and the caller must not render the reel.
 */
export function pickReelCoverTitle(candidates: ReadonlyArray<string | null | undefined>, postTitle: string, source = ''): { title: string; ok: boolean; reasons: string[]; usedFallback: boolean } {
  const src = source || postTitle
  const tidyCand = (c: string) => c.replace(/\s+/g, ' ').trim()
  const given = candidates.map((c) => tidyCand(c ?? '')).filter(Boolean)
  let firstReasons: string[] = []
  for (const [i, c] of given.entries()) {
    const check = checkReelCoverTitle(c, src)
    if (i === 0) firstReasons = check.reasons
    if (check.ok) return { title: c, ok: true, reasons: [], usedFallback: i > 0 }
  }
  const fallbacks: string[] = [...titlePhrases(postTitle)]
  for (const p of titlePhrases(postTitle)) if (!/\?$/.test(p)) fallbacks.push(`${p} decoded`)
  for (const f of fallbacks) {
    if (checkReelCoverTitle(f, src).ok) return { title: f, ok: true, reasons: [], usedFallback: true }
  }
  return { title: given[0] ?? shortestWholePhrase(postTitle), ok: false, reasons: firstReasons.length ? firstReasons : ['no valid cover headline could be made from the title'], usedFallback: false }
}

/** Last resort for callers that must return text: the first phrase that is short enough whole, else ''. */
export function shortestWholePhrase(postTitle: string): string {
  const fits = titlePhrases(postTitle).filter((p) => p.length <= COVER_MAX_CHARS && !(BANNED_ENDINGS as readonly string[]).includes(bare(headlineWords(p).pop() ?? '').toLowerCase()))
  return fits.sort((a, b) => a.length - b.length)[0] ?? ''
}
