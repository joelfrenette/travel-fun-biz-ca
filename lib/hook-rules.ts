import { validateCoverHeadline } from '@/lib/cover-headline'

// Hooks in content: the patterns the owner's GOOD Instagram posts share, and the ones his BAD posts share, written
// down once so the blog title step, the caption writer, the topic suggester and their plain-code checks all agree.
// Pure data and pure functions: no network, no database, so scripts/check-hooks-in-content.ts can test them offline.
//
// GOOD: a question or a contrast ("Cultural or beach? Take the quiz", "Cancun or Tulum?"), a route ("Cologne to Basel
// by river"), a comma list ("Reef, outback, cities, fjords"), "X plus Y", "decoded", a grounded number ("US$3,900
// cheaper per year"), a short 3 to 6 word cover title, branded.
// BAD: brochure openers (Discover, Explore, Welcome, Ultimate guide, Everything you need), long generic sentences,
// walls of text, emoji and hashtag spam, shouting in capitals.

/** Openers that read as a brochure. A title, a caption first line or a cover headline should not begin with one. */
export const WEAK_OPENERS = [
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
  'are you ready',
  'get ready',
  'looking for',
  'dreaming of',
  'in this post',
  'in this guide',
  'check out',
  'we are excited',
  "we're excited",
  'today we',
] as const

/** The weak opener a line starts with (ignoring case, leading quotes, hashtags marks and emoji), or null. */
export function weakOpenerOf(line: string): string | null {
  const text = line
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
  for (const o of WEAK_OPENERS) {
    if (text === o || text.startsWith(`${o} `) || text.startsWith(`${o},`) || text.startsWith(`${o}:`)) return o
  }
  return null
}

const EMOJI_RE = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}]/gu

/** How many emoji are in `text` (a flag pair counts once per letter, which is fine for a ceiling check). */
export function countEmojis(text: string): number {
  return (text.match(EMOJI_RE) ?? []).length
}

export const CAPTION_MAX_EMOJIS = 2
export const CAPTION_MAX_HASHTAGS = 10
export const CAPTION_HOOK_MAX_CHARS = 80
/** The checker allows a longer hook line than the prompt asks for: the no-AI fallback uses a stored FAQ question (up to 140). */
export const CAPTION_HOOK_HARD_MAX = 140
export const CAPTION_MAX_PARAGRAPH_LINES = 3
export const CAPTION_MAX_LINE_CHARS = 350

/** Problems with the SHAPE of a caption (the plain-code part of the hooks-in-content rules). Empty when it is fine. */
export function captionShapeProblems(caption: string, network: string): string[] {
  const problems: string[] = []
  const lines = caption.split('\n')
  const firstLine = lines.find((l) => l.trim())?.trim() ?? ''

  const bare = firstLine.replace(/https?:\/\/\S+/gi, '').replace(/#\S+/g, '').trim()
  if (!firstLine || !bare) problems.push('missing hook line (the first line must be a hook, not a link or hashtags)')
  else if (firstLine.length > CAPTION_HOOK_HARD_MAX) problems.push(`hook line is too long (${firstLine.length} characters, keep it short)`)

  const opener = weakOpenerOf(firstLine)
  if (opener) problems.push(`weak opener "${opener}"`)

  if (firstLine && countEmojis(firstLine) > 0) problems.push('emoji in the hook line')

  const emojis = countEmojis(caption)
  if (emojis > CAPTION_MAX_EMOJIS) problems.push(`too many emojis (${emojis}, at most ${CAPTION_MAX_EMOJIS})`)

  const hashtags = (caption.match(/(^|\s)#[\p{L}\p{N}_]+/gu) ?? []).length
  if (hashtags > CAPTION_MAX_HASHTAGS) problems.push(`hashtag spam (${hashtags}, at most ${CAPTION_MAX_HASHTAGS})`)

  // A line of shouting: at least 8 letters, none of them lowercase (links, hashtags and mentions do not count).
  const shouting = lines.some((l) => {
    const t = l.replace(/https?:\/\/\S+/gi, ' ').replace(/[#@]\S+/g, ' ')
    const letters = t.match(/\p{L}/gu) ?? []
    return letters.length >= 8 && !/\p{Ll}/u.test(t)
  })
  if (shouting) problems.push('a line is in all capitals')

  // Paragraph wall: more than 3 lines in a row with no blank line, or one very long line.
  let run = 0
  let wall = false
  for (const l of lines) {
    if (l.trim()) {
      run++
      if (run > CAPTION_MAX_PARAGRAPH_LINES) wall = true
    } else run = 0
  }
  const longLine = lines.some((l) => l.replace(/https?:\/\/\S+/gi, '').trim().length > CAPTION_MAX_LINE_CHARS) && network.toLowerCase() !== 'youtube'
  if (wall || longLine) problems.push('paragraph wall (break the text into short lines with blank lines between blocks)')
  return problems
}

// ---- Prompt fragments ------------------------------------------------------------------------------------

/** The hook shapes the owner's best posts use, as one plain sentence list for any prompt. */
export const HOOK_SHAPES_TEXT =
  'a question ("Cancun or Tulum?"), a contrast with "or" ("Cultural or beach? Take the quiz"), a route ("Cologne to Basel by river"), a short comma list of places ("Reef, outback, cities, fjords"), two things joined with "plus", the word "decoded" ("Cruise cabins decoded"), or a number that is already given in the facts'

export const WEAK_OPENERS_TEXT = 'Discover, Explore, Welcome, Introducing, Ultimate guide, Everything you need, Tips for, Guide to'

/** What a caption must look like. Shown to the caption writer for every network. */
export function captionFormatRules(): string {
  return `Caption format for every network:
1. Line 1 is the hook: ${HOOK_SHAPES_TEXT}. At most ${CAPTION_HOOK_MAX_CHARS} characters, no emoji on it, and never the post title repeated. Never start with ${WEAK_OPENERS_TEXT}.
2. Then 2 to 4 short lines (one idea each, plain words at a grade 6 reading level), with a blank line between blocks and never more than ${CAPTION_MAX_PARAGRAPH_LINES} lines in a row.
3. Then one plain call to action line, then the link (or "link in bio" for Instagram and TikTok, where a link cannot be tapped).
4. Hashtags last, only for networks whose rule below says so. Never more than ${CAPTION_MAX_HASHTAGS}.
5. At most ${CAPTION_MAX_EMOJIS} emojis in the whole caption, none in line 1. No lines in all capitals. No superlatives you cannot back up from the facts (no "best", "perfect", "amazing", "unmissable"). No number that is not in the title, summary or facts.`
}

/** The instruction the blog title step adds so the post title and the cover headline use the winning hook shapes. */
export function titleHookInstruction(primaryKeyword: string): string {
  return `Title style: keep the primary keyword (${primaryKeyword}) first or very near the start, then, only when it stays honest, prefer a hook shape: a question, "X or Y", "A to B by C" for a route, or a short comma list. Never start the title or SEO title with ${WEAK_OPENERS_TEXT}.`
}

/** The extra field the title step asks for. */
export function coverHeadlineInstruction(): string {
  return `Also write cover_headline: the big text printed on the Instagram cover. 3 to 6 words, at most 36 characters, no word over 12 characters, no digits, no colon, no dash, no emoji, no full stop, and never ending on and, the, to, of, in, a, for, with, or, at or on. It must be exactly one of: a question ending in a question mark ("Cancun or Tulum?"), "X or Y", "X vs Y", "A to B by C" ("Cologne to Basel by river"), "X plus Y", a comma list of 3 or 4 places, a headline containing the word "decoded", or a quiz call to action ("Cultural or beach? Take the quiz"). It must be true to this post and must not start with ${WEAK_OPENERS_TEXT}.`
}

/** Topic angles that map to the winning patterns. Shown to the topic suggester. */
export const TOPIC_PATTERN_TEXT =
  'Prefer angles that fit a winning hook: a head-to-head comparison of two destinations, cruises or travel styles ("Cancun or Tulum", "river or ocean cruise"), a route or itinerary angle ("Cologne to Basel by river", "Miami to Cozumel by ship"), a short list of places in one region, a "decoded" explainer (cabin types, what is included), a quiz-style "which one suits you" angle, or a cost comparison. A cost or number angle may only use a figure that is written in the material above; otherwise leave the number out. Do not invent a fact to make an angle fit a pattern.'

// ---- Stored cover headline (post title step) -------------------------------------------------------------

export const coverHeadlineKey = (slug: string) => `cover_headline:${slug}`

/** The model's cover_headline, tidied and checked with the cover validator, or null (dropped silently on any failure). */
export function cleanCoverHeadline(raw: unknown, source: string): string | null {
  if (typeof raw !== 'string') return null
  const h = raw.replace(/\s+/g, ' ').replace(/^["'“‘]+|["'”’]+$/g, '').trim()
  if (!h) return null
  return validateCoverHeadline(h, source).ok ? h : null
}
