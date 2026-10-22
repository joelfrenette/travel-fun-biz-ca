import { weakOpenerOf } from '@/lib/hook-rules'

// Questions built from a post's own words: the reel hook fallback, the comment-bait question before the end card, and the
// one comment prompt line in Instagram, Facebook and Threads captions. Pure and deterministic (no model, no network), and
// nothing is invented: every word comes from the post title or its primary keyword, and no number is ever added.

export interface PostIdea {
  title: string
  /** posts.primary_keyword, the one search phrase the post is written for. */
  keyword?: string | null
  /** A place the post is about, when known. */
  destination?: string | null
}

const LEFT_STOP = new Set(['is', 'are', 'a', 'an', 'the', 'should', 'which', 'what', 'how', 'why', 'do', 'does', 'can', 'will', 'best', 'top', 'your', 'our', 'my', 'to', 'for', 'in', 'on', 'of', 'and'])
const RIGHT_STOP = new Set(['better', 'best', 'worth', 'it', 'for', 'in', 'on', 'at', 'to', 'of', 'the', 'a', 'an', 'is', 'are', 'which', 'one', 'you', 'should', 'we', 'pick', 'choose', 'right', 'good', 'and'])

const clean = (s: string) => s.replace(/[^\p{L}\p{N}'’ -]/gu, ' ').replace(/\s+/g, ' ').trim()
const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s)
const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7)

/** "X or Y" (or "X vs Y") taken from the first text that has one, as two short phrases, or null. "Boat or boots: which one are you?"
 * gives ["Boat", "boots"]; "Is a Rhine cruise or a Croatia cruise better?" gives ["Rhine cruise", "Croatia cruise"]. */
export function extractContrast(...texts: Array<string | null | undefined>): [string, string] | null {
  for (const raw of texts) {
    if (!raw) continue
    const m = raw.match(/^(.*?)\s+(?:or|vs\.?|versus)\s+(.*)$/i)
    if (!m) continue
    // Only the clause the contrast sits in: stop the right side at the first colon, question mark, comma or full stop.
    const left = clean(m[1].split(/[:?,.;!|]/).pop() ?? '').split(' ').filter(Boolean)
    const right = clean(m[2].split(/[:?,.;!|]/)[0] ?? '').split(' ').filter(Boolean)
    while (left.length && LEFT_STOP.has(left[0].toLowerCase())) left.shift()
    while (right.length && LEFT_STOP.has(right[0].toLowerCase())) right.shift()
    while (right.length && RIGHT_STOP.has(right[right.length - 1].toLowerCase())) right.pop()
    const a = left.slice(-3).join(' ')
    const b = right.slice(0, 3).join(' ')
    if (a.length >= 2 && b.length >= 2 && a.length <= 30 && b.length <= 30 && a.toLowerCase() !== b.toLowerCase()) return [a, b]
  }
  return null
}

/** The shortest honest name for the post's subject: the primary keyword (at most 6 words), else the title up to its first colon, bar or dash (at most 7 words). */
function subjectOf(idea: PostIdea): string {
  const kw = clean(idea.keyword ?? '').split(' ').filter(Boolean)
  if (kw.length >= 1 && kw.length <= 6) return kw.join(' ')
  const head = (idea.title ?? '').split(/[:|]| - /)[0]
  return clean(head).split(' ').filter(Boolean).slice(0, 7).join(' ')
}

/** A place name pulled from a keyword such as "river cruise in Croatia" ("Croatia"), or the given destination. Null when neither says one. */
export function inferDestination(idea: PostIdea): string | null {
  if (idea.destination && idea.destination.trim()) return clean(idea.destination)
  const m = (idea.keyword ?? '').match(/\b(?:in|to|of|for)\s+([A-Z][\p{L}'’-]+(?:\s+[A-Z][\p{L}'’-]+){0,2})\s*$/u)
  return m ? m[1] : null
}

/** The reel hook used when no model hook passes the checks: always a question built from the post's keyword, destination or title.
 * Examples: "Rhine or Croatia: which one are you?", "River cruise for solo travellers: worth it or not for you?". */
export function templatedHookQuestion(idea: PostIdea): string {
  const pair = extractContrast(idea.keyword, idea.title)
  if (pair) return `${cap(pair[0])} or ${pair[1]}: which one are you?`
  const subject = subjectOf(idea)
  const seed = hash(`${idea.keyword ?? ''}|${idea.title ?? ''}`)
  if (subject) {
    const k = cap(subject)
    const options = [`${k}: worth it or not for you?`, `Is ${subject.toLowerCase() === subject ? subject : k} really for you?`, `${k}: would you do it?`]
    return options[seed % options.length]
  }
  const place = inferDestination(idea)
  return place ? `${cap(place)}: your next trip, yes or no?` : 'Is this your kind of trip?'
}

/** The last beat before the end card: one short question that comes from the post and that people want to answer in the comments.
 * `voiceover` is spoken (it ends with a question mark); `onScreen` is the 7 words or fewer shown on the frame. */
export function commentBaitQuestion(idea: PostIdea): { voiceover: string; onScreen: string } {
  const pair = extractContrast(idea.keyword, idea.title)
  if (pair) return { voiceover: `Which one are you: ${pair[0]} or ${pair[1]}?`, onScreen: 'Which one are you?' }
  const subject = subjectOf(idea)
  if (subject) return { voiceover: `Would you try ${subject.toLowerCase()}, yes or no?`, onScreen: 'Yes or no?' }
  const place = inferDestination(idea)
  if (place) return { voiceover: `Would you go to ${place}, yes or no?`, onScreen: 'Yes or no?' }
  return { voiceover: 'Is this your kind of trip, yes or no?', onScreen: 'Yes or no?' }
}

/** One comment prompt line for the body of an Instagram, Facebook or Threads caption. A question, ends with a call to answer. */
export function commentPromptLine(idea: PostIdea): string {
  const pair = extractContrast(idea.keyword, idea.title)
  if (pair) return `Which one are you: ${pair[0]} or ${pair[1]}? Tell us below.`
  const subject = subjectOf(idea)
  if (subject) return `Would you try ${subject.toLowerCase()}? Tell us below.`
  return 'What would you ask us about this trip? Tell us below.'
}

const CONTRAST_IN_HOOK = /\S+\s+(?:or|vs\.?|versus)\s+\S+/i
const SECOND_PERSON_OPENER = /^(?:you|your|yours|you're|you’re|you'll|you’ll|you've|you’ve|youre)\b/i

/** True when a reel hook is good enough to keep: any sentence with a question mark, a contrast "X or Y", or a second-person
 * opener of 3 to 9 words. Brochure openers ("Have you ever wondered") never pass. The ungrounded-number check is separate
 * (ungroundedNumbers in lib/hook-styles.ts) and still applies. */
export function isAcceptableHook(hook: string): boolean {
  const text = hook.trim()
  if (!text) return false
  const words = text.split(/\s+/).filter(Boolean)
  if (weakOpenerOf(text)) return false
  if (text.includes('?')) return words.length <= 16
  if (CONTRAST_IN_HOOK.test(text) && words.length <= 14) return true
  return words.length >= 3 && words.length <= 9 && SECOND_PERSON_OPENER.test(text)
}
