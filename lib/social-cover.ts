// Pure helpers for the titled single-image social cover (1080x1350 for Instagram), drawn by
// app/social-cover/[kind]/[slug]/route.tsx. No database, no network, no fonts: the headline shortener, the
// text fitting and the URL builder live here so scripts/check-social-cover.ts can test them offline.
//
// Why: blog, trip and guide posts went to Instagram as the bare cover photo (a grid tile with no words),
// and news posts had no image at all, which Instagram cannot take.

export const COVER_WIDTH = 1080
export const COVER_HEIGHT = 1350
/** Safe margins from the edges (Instagram crops the grid tile and overlays UI near the edges). */
export const COVER_SAFE_SIDE = 100
export const COVER_SAFE_VERTICAL = 90
/** The headline block is at most this wide (it is centred, so it never touches the side margins). */
export const COVER_BLOCK_MAX_WIDTH = 880
/** Horizontal padding inside the red block. */
export const COVER_BLOCK_PAD_X = 44
export const COVER_FONT_MAX = 120
export const COVER_FONT_MIN = 72
export const COVER_MAX_LINES = 3
export const COVER_TITLE_MAX_CHARS = 36
export const COVER_TITLE_MIN_WORDS = 3
export const COVER_TITLE_MAX_WORDS = 6
export const NEWS_MAX_WORDS = 14

/** A recap card's headline is a real FAQ question, at most this many words. */
export const RECAP_MAX_WORDS = 12
/** The small strip at the bottom of a recap card (every other card shows the bare site name). */
export const RECAP_STRIP_PREFIX = 'Read the answer: '

export const SOCIAL_COVER_KINDS = ['blog', 'trip', 'guide', 'news', 'recap'] as const
export type SocialCoverKind = (typeof SOCIAL_COVER_KINDS)[number]

export function isSocialCoverKind(v: string): v is SocialCoverKind {
  return (SOCIAL_COVER_KINDS as readonly string[]).includes(v)
}

/** Words a headline must not end on ("Best Time to" is not a phrase). */
const DANGLING = new Set([
  'a', 'an', 'the', 'to', 'of', 'in', 'on', 'at', 'for', 'and', 'or', 'but', 'with', 'from', 'by', 'as', 'into', 'onto', 'about', 'than', 'vs', 'versus',
  'your', 'our', 'my', 'is', 'are', 'was', 'were', 'be', 'near', 'over', 'under', 'between', 'through', 'during', 'this', 'that', 'these', 'those', 'its', 'their',
  'how', 'why', 'what', 'when', 'where', 'plus', 'via',
])

const words = (s: string) => s.split(/\s+/).filter(Boolean)

function stripDangling(ws: string[]): string[] {
  const out = [...ws]
  while (out.length > 1 && DANGLING.has(out[out.length - 1].toLowerCase().replace(/[^a-z']/g, ''))) out.pop()
  return out
}

/** Marketing filler at the start that costs headline room and says nothing ("The Ultimate Guide to ..."). */
const LEADING_FILLER = /^(?:(?:the|a|your)\s+)?(?:(?:ultimate|complete|definitive|essential|full|beginner'?s?|first[- ]timer'?s?|insider'?s?|perfect)\s+)+(?:travel\s+)?(?:guide|handbook|primer)\s+(?:to|for|on)\s+/i

function clean(raw: string, siteName = ''): string {
  let t = (raw || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/[‘’]/g, "'")
    .replace(/[“”"]/g, '')
    .replace(/[\u{1F000}-\u{1FFFF}☀-➿️]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (siteName) {
    const esc = siteName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    t = t.replace(new RegExp(`\\s*[|\\-\\u2013\\u2014:]\\s*${esc}\\s*$`, 'i'), '').trim()
  }
  t = t.replace(LEADING_FILLER, '').trim()
  return t
}

const fits = (ws: string[]) => ws.length <= COVER_TITLE_MAX_WORDS && ws.join(' ').length <= COVER_TITLE_MAX_CHARS

/**
 * A short headline for the cover: ALL CAPS, 3 to 6 words, at most 36 characters, never ending on a
 * preposition, article or conjunction. It prefers a WHOLE phrase from the title (the title itself, or one
 * side of a colon or dash) over cutting words off the end; only when no whole phrase fits does it trim a
 * phrase at a natural break (a comma) or word boundary. Deterministic. Returns '' for an empty title.
 */
export function shortenCoverTitle(title: string, siteName = ''): string {
  const t = clean(title, siteName)
  if (!t) return ''
  const segments = t.split(/\s*(?:[:|–—]|\s-\s)\s*/).map((s) => s.trim()).filter(Boolean)
  // Whole-phrase candidates, best first: the whole title, then each segment in order.
  const candidates = [t, ...segments].map((c) => stripDangling(words(c)))
  for (const ws of candidates) if (ws.length >= COVER_TITLE_MIN_WORDS && fits(ws)) return ws.join(' ').toUpperCase()
  // Two words ("Bali Itinerary") is acceptable when nothing longer fits whole; one word is only kept for a
  // stored one-word title (a place name), via the trim path below. No words are ever invented.
  for (const ws of candidates) if (ws.length >= 2 && fits(ws)) return ws.join(' ').toUpperCase()
  // A short lead segment ("Bali") plus the start of the next may still make a phrase: try joining two segments.
  if (segments.length >= 2) {
    const joined = stripDangling(words(`${segments[0]} ${segments[1]}`))
    if (joined.length >= COVER_TITLE_MIN_WORDS && fits(joined)) return joined.join(' ').toUpperCase()
  }
  // No whole phrase fits: take the first segment that has enough words (or the whole title) and trim it.
  const source = segments.find((s) => words(s).length >= COVER_TITLE_MIN_WORDS) ?? t
  // Prefer a comma break ("Santorini, Greece: a long subtitle" -> "Santorini, Greece").
  for (const part of source.split(/\s*,\s*/).reduce<string[]>((acc, p, i) => (i === 0 ? [p] : [...acc, `${acc[acc.length - 1]}, ${p}`]), []).reverse()) {
    const ws = stripDangling(words(part))
    if (ws.length >= COVER_TITLE_MIN_WORDS && fits(ws)) return ws.join(' ').toUpperCase().replace(/,$/, '')
  }
  let ws = words(source).slice(0, COVER_TITLE_MAX_WORDS)
  while (ws.length > 1 && ws.join(' ').length > COVER_TITLE_MAX_CHARS) ws.pop()
  ws = stripDangling(ws)
  let out = ws.join(' ').replace(/[,;:.\-]+$/, '')
  if (out.length > COVER_TITLE_MAX_CHARS) out = out.slice(0, COVER_TITLE_MAX_CHARS).replace(/\s+\S*$/, '')
  return out.toUpperCase()
}

/** The cover headline: a stored hook headline (already validated by the caller, see lib/cover-headline-store.ts) in capitals
 * when there is one, else the shortened title as always. */
export function coverHeadlineFor(stored: string | null | undefined, title: string, siteName = ''): string {
  const s = (stored ?? '').trim()
  return s ? s.toUpperCase() : shortenCoverTitle(title, siteName)
}

/** A news headline for the text card: at most 14 words, cut at a word boundary, never ending on a
 * dangling word. The headline itself (not a summary) so it stays tied to the checked brief. */
export function shortenNewsHeadline(headline: string, maxWords: number = NEWS_MAX_WORDS): string {
  const t = clean(headline)
  if (!t) return ''
  const ws = words(t)
  if (ws.length <= maxWords) return t
  const cut = stripDangling(ws.slice(0, maxWords))
  return cut.join(' ').replace(/[,;:\-]+$/, '')
}

/** How many extra tries the quality gate may ask the cover route for (`?alt=1`, `?alt=2`). */
export const COVER_ALT_MAX = 2
/** Words a retried headline is cut to: the first retry keeps 4, the second 3 (never ending on a dangling word). */
export const COVER_ALT_WORDS = [Infinity, 4, 3] as const
/** News retry word caps: the first retry keeps 10 words, the second 7. */
export const NEWS_ALT_WORDS = [NEWS_MAX_WORDS, 10, 7] as const

/** A retry (alt 1 or 2) headline: the same headline cut to fewer whole words, never ending on a dangling word. */
export function shorterCoverHeadline(headline: string, alt: number): string {
  const cap = COVER_ALT_WORDS[Math.min(Math.max(0, alt), COVER_ALT_MAX)]
  const ws = words(headline)
  if (ws.length <= cap) return headline
  const cut = stripDangling(ws.slice(0, cap)).join(' ').replace(/[,;:.\-]+$/, '')
  return cut || headline
}

/** The `?alt=` value of a cover request: 1 or 2, else 0 (the plain cover). */
export function parseAlt(search: string): number {
  const m = /^\?alt=([12])$/.exec(search)
  return m ? Number(m[1]) : 0
}

/** The Pexels photo id inside a Pexels image address, or null (other hosts, uploads). */
export function photoIdOf(url: string | null | undefined): string | null {
  if (!url) return null
  const m = /pexels\.com\/photos\/(\d+)\//.exec(url) ?? /pexels-photo-(\d+)/.exec(url)
  return m ? m[1] : null
}

export interface FittedText {
  lines: string[]
  fontSize: number
  /** False only when even the smallest size cannot show every word within the line limit. */
  complete: boolean
}

/** Rough advance width of one bold sans-serif capital, as a share of the font size. Inter Bold capitals average
 * about 0.66; 0.70 keeps a safety margin so the text never overflows the block. Mixed case uses 0.60. */
export const CAPS_WIDTH_RATIO = 0.7
export const MIXED_WIDTH_RATIO = 0.6

function wrap(text: string, maxChars: number): string[] | null {
  const lines: string[] = []
  let line = ''
  for (const w of words(text)) {
    if (w.length > maxChars) return null // a single word wider than the block
    const next = line ? `${line} ${w}` : w
    if (next.length <= maxChars) line = next
    else {
      lines.push(line)
      line = w
    }
  }
  if (line) lines.push(line)
  return lines
}

/** Largest font size from `maxSize` down to `minSize` (step 4) at which `text` wraps into at most `maxLines`
 * lines inside `innerWidth` pixels. */
export function fitText(text: string, opts: { innerWidth: number; maxSize: number; minSize: number; maxLines: number; widthRatio: number }): FittedText {
  for (let size = opts.maxSize; size >= opts.minSize; size -= 4) {
    const maxChars = Math.floor(opts.innerWidth / (size * opts.widthRatio))
    const lines = maxChars > 0 ? wrap(text, maxChars) : null
    if (lines && lines.length <= opts.maxLines) return { lines, fontSize: size, complete: true }
  }
  const size = opts.minSize
  const maxChars = Math.max(1, Math.floor(opts.innerWidth / (size * opts.widthRatio)))
  const wrapped = wrap(text, maxChars)
  const lines = wrapped ?? words(text).map((w) => w.slice(0, maxChars))
  return { lines: lines.slice(0, opts.maxLines), fontSize: size, complete: wrapped !== null && lines.length <= opts.maxLines }
}

/** Headline layout for the red block: 120px down to 72px, at most 3 lines. */
export function fitCoverTitle(title: string): FittedText {
  return fitText(title, {
    innerWidth: COVER_BLOCK_MAX_WIDTH - COVER_BLOCK_PAD_X * 2,
    maxSize: COVER_FONT_MAX,
    minSize: COVER_FONT_MIN,
    maxLines: COVER_MAX_LINES,
    widthRatio: CAPS_WIDTH_RATIO,
  })
}

/** Headline layout for the news text card: wider area (the safe margins), 96px down to 52px, at most 6 lines. */
export function fitNewsText(headline: string): FittedText {
  return fitText(headline, {
    innerWidth: COVER_WIDTH - COVER_SAFE_SIDE * 2,
    maxSize: 96,
    minSize: 52,
    maxLines: 6,
    widthRatio: MIXED_WIDTH_RATIO + 0.04,
  })
}

/**
 * The FAQ question a recap card shows as its headline, in capitals. Only questions that fit the red block whole (120px down to 72px, at
 * most 3 lines) count. The first such question of at most 12 words wins; when every fitting question is longer, the shortest whole
 * one is taken. Null when no question fits (the card then uses the post title headline instead). Pure, nothing is cut or invented.
 */
export function pickRecapQuestion(questions: ReadonlyArray<unknown>): string | null {
  const fitting = questions
    .map((q) => (typeof q === 'string' ? q.replace(/\s+/g, ' ').trim() : ''))
    .filter((q) => q !== '' && fitCoverTitle(q.toUpperCase()).complete)
  if (fitting.length === 0) return null
  const short = fitting.find((q) => words(q).length <= RECAP_MAX_WORDS)
  if (short) return short
  return fitting.reduce((best, q) => (words(q).length < words(best).length ? q : best))
}

const SLUG_RE =/^[a-z0-9][a-z0-9._-]{0,159}$/i
export function isValidCoverSlug(slug: string): boolean {
  return SLUG_RE.test(slug) && !slug.includes('..')
}

/** Address of the composed cover for a post. `base` is the site origin (SITE_URL). */
export function socialCoverUrl(base: string, kind: SocialCoverKind, slug: string, alt = 0): string {
  const url = `${base.replace(/\/$/, '')}/social-cover/${kind}/${encodeURIComponent(slug)}`
  return alt >= 1 && alt <= COVER_ALT_MAX ? `${url}?alt=${alt}` : url
}

/** Fetches the composed cover once before it is sent, so a broken route never fails an Instagram post (the
 * network would reject an unreachable image). The request also warms the CDN copy the network then downloads.
 * True only for a 200 PNG/JPEG with a body; never throws. */
export const VERIFY_TIMEOUT_MS = 12_000

export async function verifyCoverUrl(url: string, fetchImpl: typeof fetch = fetch, timeoutMs: number = VERIFY_TIMEOUT_MS): Promise<boolean> {
  try {
    const res = await fetchImpl(url, { cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) })
    const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
    if (!res.ok || (type !== 'image/png' && type !== 'image/jpeg')) {
      await res.body?.cancel().catch(() => {})
      return false
    }
    return (await res.arrayBuffer()).byteLength > 1000
  } catch {
    return false
  }
}

/** Which image a post goes out with. The gate: when the post has a title and a composable slug, the composed
 * cover is always sent, never the bare photo. The raw photo is only a fallback when composing is impossible
 * (no title or an unusable slug); with neither photo nor composable title the post has no image (text). */
export function pickPostImage(input: { base: string; kind: SocialCoverKind; slug: string; title: string | null | undefined; coverUrl: string | null | undefined }): { url: string | null; composed: boolean } {
  const title = (input.title ?? '').trim()
  const cover = (input.coverUrl ?? '').trim()
  if (title && isValidCoverSlug(input.slug) && shortenCoverTitle(title) !== '') {
    return { url: socialCoverUrl(input.base, input.kind, input.slug), composed: true }
  }
  return { url: cover || null, composed: false }
}
