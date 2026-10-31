import type { ComposedPost } from '@/lib/blog-composer'
import { isGenericAlt } from '@/lib/image-quality'

// Blog quality bar (loop-blog-quality). PURE: no database, no AI, no network. One editor audit of the ten live posts scored
// them about 5 out of 10: the same template everywhere, no real trip facts, few links, no contact link, titles that promise
// more than the post holds. These are the deterministic gates behind that audit. They run in three places with the same code:
// the publish gate (lib/blog-composer.ts analyse), the daily refresh of already published posts (lib/blog-reheal.ts), and
// the admin count "Posts below quality bar" (app/api/admin/posts/automation/route.ts).
//
// Nothing here relaxes an older rule: these gates only add blockers. Every message starts with one of QUALITY_PREFIXES so a
// caller can tell a quality blocker from a number or link blocker.

/** Fewest distinct internal links a post body must hold (the closing call to action counts). */
export const MIN_INTERNAL_LINKS = 3
/** A first sentence longer than this is a scene-setter, not an answer. */
export const MAX_FIRST_SENTENCE_WORDS = 25
/** The stored seo_score of a thin post is held at or under this. */
export const THIN_POST_SCORE_CAP = 80

export const QUALITY_PREFIXES = [
  'too few internal links',
  'no contact or trip link',
  'opening sentence',
  'banned filler phrase',
  'FAQ talks about the text',
  'unverifiable claim',
  'title year',
  'title promises',
  'title names a brand',
  'no content style recorded',
  'no primary keyword recorded',
  'no Quick answer line',
  'Quick answer length',
  'meta title duplicates another page',
  'meta description duplicates another page',
  'cover image alt text',
] as const

const QUALITY_RE = new RegExp(`^(${QUALITY_PREFIXES.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`)

/** True when a gate message came from this file. Pure. */
export function isQualityBlocker(blocker: string): boolean {
  return QUALITY_RE.test(blocker)
}

// ---------------------------------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------------------------------

export type QualityPost = Pick<ComposedPost, 'title' | 'body' | 'faq' | 'primary_keyword' | 'content_style'> &
  Partial<Pick<ComposedPost, 'seo_title' | 'seo_description' | 'og_title' | 'og_description' | 'key_takeaways' | 'slug'>>

export interface TripDates {
  from?: string | null
  to?: string | null
}

/** The search-result text of another live page, for the "meta text must be unique" check. */
export interface OtherMeta {
  slug?: string | null
  title?: string | null
  description?: string | null
}

export interface QualityCtx {
  now: Date
  /** Search title and description of the OTHER live pages. Unset means "not known", and the uniqueness check is skipped (never a blocker). */
  otherMeta?: OtherMeta[]
  /** The cover picture and its alt text, when known. Unset means "not known" (the post is checked before its photo is attached) and the check is skipped. */
  cover?: { url?: string | null; alt?: string | null } | null
  /** The facts the writer had (angle, package text). A claim or brand in the post must be here to pass. */
  groundingText?: string
  /** The linked trip's travel dates, for the "year in the title matches the trip" check. */
  tripDates?: TripDates | null
  /** Maps the body the gate sees to the body that is saved (the autoblog appends its closing call to action on save). */
  storedBody?: (body: string) => string
}

/** Pages that always exist, offered to the writer after the topic-specific links so a post with no matching trip or guide can still
 * reach the 3 internal links the gate asks for (the contact section, the home page's trip list, the blog index). They sit beyond the
 * normal link cap on purpose and never take a place from a trip, guide or post link. */
export const SITE_LINKS: { path: string; label: string }[] = [
  { path: '/#contact', label: 'our contact section (a short "ask us" link)' },
  { path: '/', label: 'our trips on the home page' },
  { path: '/blog', label: 'our blog' },
]

export function withSiteLinks<T extends { path: string; label: string }>(links: T[]): { path: string; label: string }[] {
  const seen = new Set(links.map((l) => l.path))
  return [...links, ...SITE_LINKS.filter((l) => !seen.has(l.path))]
}

// ---------------------------------------------------------------------------------------------------
// Banned filler phrases
// ---------------------------------------------------------------------------------------------------

export interface BannedPhrase {
  id: string
  re: RegExp
}

/** The template and hype phrases the editor audit named, as data. Case-insensitive. */
export const BANNED_PHRASES: BannedPhrase[] = [
  { id: 'the takeaway:', re: /the takeaway\s*:/i },
  { id: 'before moving on', re: /before moving on/i },
  { id: 'why it matters:', re: /why it matters\s*:/i },
  { id: 'decoded', re: /\bdecod(?:ed|e|es|ing)\b/i },
  { id: 'playbook', re: /\bplaybook\b/i },
  { id: 'once-in-a-lifetime', re: /once[\s-]+in[\s-]+a[\s-]+lifetime/i },
  { id: 'perfect', re: /\bperfect(?:ly)?\b/i },
  { id: 'ultimate', re: /\bultimate\b/i },
  { id: 'picture/imagine opener', re: /(?:^|[.!?]\s+|\n\s*)(?:picture|imagine)\b/i },
  { id: 'the one thing worth settling next', re: /the one thing worth settling next/i },
  { id: 'our team is happy to help', re: /our team is happy to help/i },
]

/** Plain text with markdown link syntax reduced to the link words. */
export const unlink = (s: string): string => s.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')

/** Ids of every banned phrase found in the text. Pure. */
export function bannedPhraseHits(text: string): string[] {
  const t = unlink(text)
  return BANNED_PHRASES.filter((b) => b.re.test(t)).map((b) => b.id)
}

// ---------------------------------------------------------------------------------------------------
// FAQ meta-language
// ---------------------------------------------------------------------------------------------------

/** "The text suggests...", "this post says...": an FAQ answer must answer, not describe the page it sits on. */
export const FAQ_META_RE = /\b(?:the|this|that|our)\s+(?:text|post|article|blog(?:\s+post)?|piece|passage|content|page|write-?up)\b(?:\s+\w+){0,2}?\s+(?:suggests?|says?|states?|mentions?|notes?|indicates?|describes?|explains?|discusses?|implies|recommends?|highlights?|covers?)\b|\baccording to (?:the|this) (?:text|post|article|blog|piece)\b|\bas (?:mentioned|described|noted|discussed) (?:above|earlier|in the (?:text|post|article))\b|\bthe (?:text|post|article) (?:also )?(?:suggests?|says?)\b/i

/** Every FAQ question and answer that talks about the page itself. Pure. */
export function faqMetaHits(faq: { q: string; a: string }[]): string[] {
  const out: string[] = []
  for (const f of faq ?? []) {
    for (const t of [f.q, f.a]) {
      const m = FAQ_META_RE.exec(t ?? '')
      if (m) out.push(m[0].trim())
    }
  }
  return out
}

// ---------------------------------------------------------------------------------------------------
// Unverifiable superlatives (only, first, most + a place). "The best ..." is an opinion and is allowed.
// ---------------------------------------------------------------------------------------------------

const SUPER_MARKER = /\b(?:the only|only one|the first|the most [a-z]+|the (?:largest|longest|tallest|highest|oldest|biggest|smallest|fastest|steepest|deepest|newest))\b/gi
/** Words after the marker that make it ordinary advice, not a claim ("the best time", "the first step"). */
const SUPER_ORDINARY_NEXT = /^\s*(?:time|times|way|ways|thing|things|step|steps|tip|tips|day|days|night|nights|idea|ideas|question|questions|approach|bet|move|rule|sign|signs|mistake|mistakes|part|stage|choice|option|reason|point|place to start|season|month|months|week|weeks|common|important|useful|practical|helpful|obvious|likely|simple|easy|sensible|realistic|honest|real|big|key|main)\b/i
const SUPER_PLACE = /\b(?:in|of|on|across|throughout|within|around|along)\s+(?:the\s+)?(?:[A-Z][\p{L}'’-]+|world|region|country|island|city|continent|area|caribbean|mediterranean)/u

export interface SuperlativeHit {
  claim: string
  /** The two words after the marker, used to look the claim up in the facts. */
  key: string
}

/** Superlative place claims in one text (marker plus a place scope in the same sentence), skipping ordinary advice. Pure. */
export function superlativeHits(text: string): SuperlativeHit[] {
  const hits: SuperlativeHit[] = []
  const flat = unlink(text)
  for (const sentence of flat.split(/(?<=[.!?])\s+|\n+/)) {
    SUPER_MARKER.lastIndex = 0
    for (let m = SUPER_MARKER.exec(sentence); m; m = SUPER_MARKER.exec(sentence)) {
      const after = sentence.slice(m.index + m[0].length)
      if (SUPER_ORDINARY_NEXT.test(after)) continue
      const scope = after.slice(0, 90)
      if (!SUPER_PLACE.test(scope)) continue
      const next = (/^\s*([\p{L}'-]+)/u.exec(after)?.[1] ?? '').toLowerCase()
      hits.push({ claim: sentence.slice(m.index, m.index + m[0].length + Math.min(after.length, 60)).trim(), key: `${m[0].toLowerCase().replace(/^the /, '')} ${next}`.trim() })
    }
  }
  return hits
}

/** Superlative claims in a text that the facts do not state. Pure. */
export function ungroundedSuperlatives(text: string, groundingText: string): string[] {
  const g = groundingText.toLowerCase()
  return superlativeHits(text).filter((h) => !g.includes(h.key)).map((h) => h.claim)
}

// ---------------------------------------------------------------------------------------------------
// Title: year and promises
// ---------------------------------------------------------------------------------------------------

const yearOf = (s: string | null | undefined): number | null => {
  const m = /(\d{4})/.exec(s ?? '')
  return m ? Number(m[1]) : null
}

/** Years in a title that are outside the next 12 months, or that disagree with the linked trip's dates. Pure. */
export function titleYearIssues(title: string, now: Date, trip?: TripDates | null): string[] {
  const out: string[] = []
  const nextYear = new Date(now.getTime() + 365 * 86_400_000).getUTCFullYear()
  const thisYear = now.getUTCFullYear()
  const from = yearOf(trip?.from)
  const to = yearOf(trip?.to) ?? from
  for (const y of new Set([...title.matchAll(/\b(20\d{2})\b/g)].map((m) => Number(m[1])))) {
    if (y > nextYear) out.push(`title year outside the next 12 months (${y})`)
    else if (y < thisYear) out.push(`title year outside the next 12 months (${y})`)
    if (from !== null && to !== null && (y < from || y > to)) out.push(`title year conflicts with the trip date (${y}, trip travels ${from === to ? from : `${from} to ${to}`})`)
  }
  return out
}

const BRANDS = ['viking', 'amawaterways', 'ama waterways', 'princess', 'celebrity', 'carnival', 'royal caribbean', 'disney', 'holland america', 'msc', 'norwegian', 'windstar', 'uniworld', 'avalon', 'scenic', 'emerald', 'tauck', 'azamara', 'silversea', 'seabourn', 'oceania', 'regent', 'cunard', 'virgin voyages', 'ponant', 'lindblad', 'sandals', 'club med']

/** Brand names in a title that are not in the facts (a post about our own trip must not wear another company's name). Pure. */
export function titleBrandIssues(title: string, groundingText: string): string[] {
  const g = groundingText.toLowerCase()
  const t = ` ${title.toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `
  return BRANDS.filter((b) => t.includes(` ${b} `) && !g.includes(b))
}

const headingsOf = (body: string): string[] => body.split('\n').filter((l) => /^#{1,6}\s/.test(l)).map((l) => l.replace(/^#{1,6}\s+/, '').replace(/[*_`]/g, '').trim())

/** Things a title promises that the body has to deliver, by structure (a heading, a run of list lines), not by a passing mention. Pure. */
export function titlePromiseIssues(title: string, body: string): string[] {
  const t = title.toLowerCase()
  const heads = headingsOf(body)
  const headHas = (re: RegExp) => heads.some((h) => re.test(h))
  const out: string[] = []
  for (const word of ['forum', 'tripadvisor', 'reddit']) {
    if (new RegExp(`\\b${word}\\b`, 'i').test(t) && !headHas(new RegExp(word, 'i'))) out.push(word)
  }
  if (/\breviews?\b/.test(t) && !headHas(/review|verdict|pros|cons|rating/i)) out.push('review')
  if (/day[\s-]by[\s-]day/.test(t) && heads.filter((h) => /^(day\s*\d+|day\s+(one|two|three|four|five|six|seven)|morning|afternoon|evening)\b/i.test(h)).length < 3) out.push('day-by-day')
  if (/\bday in the life\b/.test(t) && heads.filter((h) => /^(morning|afternoon|evening|day\s*\d+)\b/i.test(h)).length < 2) out.push('day in the life')
  if (/\bchecklist\b/.test(t) && body.split('\n').filter((l) => /^\s*(?:[-*+]|\d+[.)])\s/.test(l)).length < 4) out.push('checklist')
  if (/\bstep[\s-]by[\s-]step\b/.test(t) && body.split('\n').filter((l) => /^\s*\d+[.)]\s/.test(l)).length < 3 && !headHas(/^step\s*\d/i)) out.push('step-by-step')
  return out
}

// ---------------------------------------------------------------------------------------------------
// Opening sentence
// ---------------------------------------------------------------------------------------------------

const SCENE_OPENER = /^(?:picture|imagine|envision|visuali[sz]e|close your eyes|think of|you\b|you['’]|have you ever|ever (?:wondered|dreamed|wished)|what if|there['’]?s something|from the moment|it['’]?s (?:the )?(?:feeling|moment|that))/i

const KEYWORD_STOP = new Set(['a', 'an', 'the', 'to', 'for', 'of', 'in', 'on', 'and', 'or', 'vs', 'with', 'what', 'how', 'is', 'are', 'do', 'does', 'your', 'you', 'tips', 'guide', 'best', 'my', 'our', 'from'])

/** Word stems of a phrase (first 5 letters, no stop words), so "travel" and "traveller" match. */
export function stemsOf(phrase: string): string[] {
  return [...new Set(phrase.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !KEYWORD_STOP.has(w)).map((w) => w.slice(0, 5)))]
}

/** The first sentence of the post body (headings and a leading rule skipped), as plain text. Pure. */
export function firstSentenceOf(body: string): string {
  const lines = body.split('\n').map((l) => l.trim())
  const first = lines.find((l) => l && !/^#{1,6}\s/.test(l) && !/^[-*_]{3,}$/.test(l))
  if (!first) return ''
  const plain = unlink(first).replace(/[*_`]/g, '').trim()
  const m = /^(.+?[.!?])(?:\s|$)/.exec(plain)
  return (m ? m[1] : plain).trim()
}

/** Why a first sentence is not an answer, or null when it is one: a question, a "Picture..." / "Imagine..." / "You..." lead-in,
 * over 25 words, or one that never touches the post's keyword. Pure. */
export function firstSentenceIssue(body: string, primaryKeyword: string | null | undefined): string | null {
  const s = firstSentenceOf(body)
  if (!s) return 'opening sentence is missing'
  const words = s.split(/\s+/).filter(Boolean).length
  if (SCENE_OPENER.test(s)) return `opening sentence is a scene-setter ("${s.split(/\s+/).slice(0, 4).join(' ')}...")`
  if (/\?$/.test(s)) return 'opening sentence is a question, not an answer'
  if (words > MAX_FIRST_SENTENCE_WORDS) return `opening sentence is ${words} words, over ${MAX_FIRST_SENTENCE_WORDS}, so it is not a quotable answer`
  const stems = stemsOf(primaryKeyword ?? '')
  if (stems.length >= 2) {
    const have = new Set(stemsOf(s))
    const shared = stems.filter((x) => have.has(x)).length
    if (shared / stems.length < 0.5) return 'opening sentence does not answer the keyword question'
  }
  return null
}

/** En and em dash, built from code points so no long dash appears in the source. */
const LONG_DASHES = String.fromCharCode(0x2013, 0x2014)

const DANGLING_END = new Set(['a', 'an', 'the', 'and', 'or', 'but', 'of', 'to', 'for', 'with', 'in', 'on', 'at', 'by', 'that', 'which', 'who', 'while', 'so', 'as', 'than', 'is', 'are', 'be', 'it', 'its', 'their', 'your', 'our', 'from', 'into', 'about'])

/**
 * Plain-code repair for "opening sentence is N words, over 25": cut the sentence at a clause boundary (comma, semicolon, colon, dash,
 * or just before "and / which / while / so / but") so what is left is 8 to 25 words, still names the keyword, and ends on a real word.
 * It only ever REMOVES the end of the sentence. All 4 drafts the heal rejected between 23 and 30 Oct failed on this rule (two on nothing
 * else), after the model had tried 1 to 3 rounds to shorten it. A cut is refused if it would split a link or bold marker, if the dropped end holds a link, or if the result
 * still fails the opening-sentence gate. Returns the new body, or null when no safe cut exists (the model then tries as before). Pure.
 */
export function shortenOpening(body: string, primaryKeyword: string | null | undefined): string | null {
  const issue = firstSentenceIssue(body, primaryKeyword)
  if (!issue || !/^opening sentence is \d+ words/.test(issue)) return null
  return cutFirstSentence(body, MAX_FIRST_SENTENCE_WORDS, (out) => firstSentenceIssue(out, primaryKeyword) === null)
}

/**
 * The shared cut: shorten the first sentence of the first paragraph to at most `maxWords` (8 or more) at a clause boundary, trying the
 * longest safe prefix first, and keep the first cut that `accept` says passes the caller's own gate. Words are only removed. Returns
 * the new text, or null when no safe cut exists. Pure.
 */
export function cutFirstSentence(body: string, maxWords: number, accept: (next: string) => boolean): string | null {
  const lines = body.split('\n')
  const idx = lines.findIndex((l) => l.trim() && !/^#{1,6}\s/.test(l.trim()) && !/^[-*_]{3,}$/.test(l.trim()))
  if (idx < 0) return null
  const line = lines[idx]
  const lead = /^\s*/.exec(line)?.[0] ?? ''
  const trimmed = line.trim()
  const m = /^(.+?[.!?])(?=\s|$)/.exec(trimmed)
  const sentence = m ? m[1] : trimmed
  if (!/[.!]$/.test(sentence)) return null
  const rest = trimmed.slice(sentence.length)
  const core = sentence.slice(0, -1)
  const positions = new Set<number>()
  for (const x of core.matchAll(new RegExp(`,|;|:|\\s[-${LONG_DASHES}]\\s`, 'g'))) positions.add(x.index as number)
  for (const x of core.matchAll(/\s(?:and|which|while|so|but|because|although)\s/gi)) positions.add(x.index as number)
  for (const pos of [...positions].sort((a, b) => b - a)) {
    const prefix = core.slice(0, pos).replace(new RegExp(`[\\s,;:\\-${LONG_DASHES}]+$`), '')
    const dropped = core.slice(pos)
    const words = prefix.split(/\s+/).filter(Boolean)
    if (words.length < 8 || words.length > maxWords) continue
    if (DANGLING_END.has(words[words.length - 1].toLowerCase().replace(/[^a-z]/g, ''))) continue
    if ((prefix.match(/\[/g) ?? []).length !== (prefix.match(/\]/g) ?? []).length || (prefix.match(/\(/g) ?? []).length !== (prefix.match(/\)/g) ?? []).length) continue
    if ((prefix.match(/\*\*/g) ?? []).length % 2 !== 0 || (prefix.match(/`/g) ?? []).length % 2 !== 0) continue
    if (/\[|\]\(/.test(dropped)) continue
    const next = [...lines]
    next[idx] = `${lead}${prefix}.${rest}`
    const out = next.join('\n')
    if (accept(out)) return out
  }
  return null
}

// ---------------------------------------------------------------------------------------------------
// Links, Quick answer
// ---------------------------------------------------------------------------------------------------

/** Distinct internal link targets in a markdown body ("/#contact" and "/" are different; query and trailing slash dropped). Pure. */
export function internalHrefs(body: string): string[] {
  const out = new Set<string>()
  for (const m of body.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    let href = m[1]
    const abs = /^https?:\/\/(?:www\.)?travelfunbiz\.ca(\/[^\s]*)?$/i.exec(href)
    if (abs) href = abs[1] || '/'
    if (!href.startsWith('/')) continue
    const [pathAndQuery, hash = ''] = href.split('#')
    const path = pathAndQuery.split('?')[0]
    const clean = path.length > 1 ? path.replace(/\/+$/, '') : path || '/'
    out.add(hash ? `${clean}#${hash}` : clean)
  }
  return [...out]
}

/** A contact link or a link to a trip page: the way a reader moves from the post to us. */
export function hasContactOrTripLink(body: string): boolean {
  return internalHrefs(body).some((h) => h === '/#contact' || h.startsWith('/#contact') || h === '/contact' || h.startsWith('/packages/') || h === '/submit-trip')
}

export const QUICK_ANSWER_RE = /^\s*\*\*quick answer:?\*\*/im
export const hasQuickAnswer = (body: string): boolean => QUICK_ANSWER_RE.test(body)

// Quick answer length. The writer's prompt asks for "a one or two sentence summary" after the label, and the opening-sentence gate caps one
// sentence at 25 words, so a well-formed answer is roughly 15 words (one short sentence) to 50 words (two full ones). 60 leaves headroom
// for a long second sentence. Below 15 words it is a fragment an answer box will not quote; above 60 it is a paragraph, not an answer.
// (Written from the prompt and the gate rules; run scripts/quick-answer-lengths.ts against the live posts to confirm the spread.)
export const QUICK_ANSWER_MIN_WORDS = 15
export const QUICK_ANSWER_MAX_WORDS = 60

const wordCountOf = (s: string): number => s.split(/\s+/).filter(Boolean).length

/** The Quick answer paragraph split into its label and its text, or null when the body has none. A paragraph runs to the next blank line. Pure. */
export function quickAnswerParts(body: string): { label: string; text: string; paragraph: string } | null {
  const m = QUICK_ANSWER_RE.exec(body)
  if (!m) return null
  const start = m.index + m[0].length - m[0].trimStart().length
  const rest = body.slice(start)
  const end = rest.search(/\n\s*\n/)
  const paragraph = end === -1 ? rest : rest.slice(0, end)
  const label = /^\*\*quick answer:?\*\*/i.exec(paragraph)?.[0] ?? '**Quick answer:**'
  return { label, text: paragraph.slice(label.length).trim(), paragraph }
}

/** Words in the Quick answer text (a link counts as its words). Null when there is no Quick answer. Pure. */
export function quickAnswerWords(body: string): number | null {
  const q = quickAnswerParts(body)
  return q ? wordCountOf(unlink(q.text)) : null
}

/** Why the Quick answer is the wrong length, or null when it is fine or absent (the absence has its own blocker). Pure. */
export function quickAnswerLengthIssue(body: string): string | null {
  const n = quickAnswerWords(body)
  if (n === null) return null
  if (n < QUICK_ANSWER_MIN_WORDS) return `Quick answer length: ${n} words is too short to quote, it needs ${QUICK_ANSWER_MIN_WORDS} to ${QUICK_ANSWER_MAX_WORDS}`
  if (n > QUICK_ANSWER_MAX_WORDS) return `Quick answer length: ${n} words is too long to quote, it needs ${QUICK_ANSWER_MIN_WORDS} to ${QUICK_ANSWER_MAX_WORDS}`
  return null
}

/** Brings a Quick answer inside the word range using only text the post already holds: a long one is cut back to whole sentences, a short one is
 * extended with the post's own takeaways. Unchanged when it is already fine, when no whole-sentence cut fits, or when the takeaways do not reach the
 * range (a model rewrite handles those, see qualityOffenders). Pure. */
export function fitQuickAnswer(body: string, takeaways: string[]): string {
  const q = quickAnswerParts(body)
  if (!q || !quickAnswerLengthIssue(body)) return body
  const sentences = q.text.split(/(?<=[.!?])\s+/).filter((s) => s.trim())
  const n = wordCountOf(unlink(q.text))
  let next: string | null = null
  if (n > QUICK_ANSWER_MAX_WORDS) {
    const kept: string[] = []
    for (const s of sentences) {
      if (wordCountOf(unlink([...kept, s].join(' '))) > QUICK_ANSWER_MAX_WORDS) break
      kept.push(s)
    }
    if (kept.length && wordCountOf(unlink(kept.join(' '))) >= QUICK_ANSWER_MIN_WORDS) next = kept.join(' ')
  } else {
    const lower = unlink(q.text).toLowerCase()
    const extra: string[] = []
    for (const t of takeaways) {
      const line = t.trim().replace(/[\s.]+$/, '')
      if (!line || lower.includes(line.toLowerCase()) || extra.some((e) => e.toLowerCase().includes(line.toLowerCase()))) continue
      const candidate = `${q.text.replace(/\s+$/, '')} ${[...extra, `${line[0].toUpperCase()}${line.slice(1)}.`].join(' ')}`
      if (wordCountOf(unlink(candidate)) > QUICK_ANSWER_MAX_WORDS) continue
      extra.push(`${line[0].toUpperCase()}${line.slice(1)}.`)
      if (wordCountOf(unlink(`${q.text} ${extra.join(' ')}`)) >= QUICK_ANSWER_MIN_WORDS) break
    }
    const joined = `${q.text.replace(/\s+$/, '')} ${extra.join(' ')}`.trim()
    if (extra.length && wordCountOf(unlink(joined)) >= QUICK_ANSWER_MIN_WORDS && wordCountOf(unlink(joined)) <= QUICK_ANSWER_MAX_WORDS) next = joined
  }
  if (!next) return body
  return body.replace(q.paragraph, `${q.label} ${next}`)
}

// ---------------------------------------------------------------------------------------------------
// Unique meta text, useful cover alt text
// ---------------------------------------------------------------------------------------------------

const normMeta = (s: string | null | undefined): string => (s ?? '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()
const tokensOf = (s: string): Set<string> => new Set(s.split(' ').filter((w) => w.length > 2))

/** A title or description counts as "the same as" another when it is equal after punctuation and case are ignored, or when it shares at least this
 * share of its words with it (words over two letters, both ways). */
export const META_SIMILARITY = 0.85
/** Texts shorter than this many words are only compared for equality (two short titles can share most of their few words by chance). */
const META_MIN_WORDS_FOR_SIMILARITY = 5

/** True when two search texts are equal or nearly equal. Pure. */
export function metaTextsClash(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = normMeta(a)
  const y = normMeta(b)
  if (!x || !y) return false
  if (x === y) return true
  const tx = tokensOf(x)
  const ty = tokensOf(y)
  if (tx.size < META_MIN_WORDS_FOR_SIMILARITY || ty.size < META_MIN_WORDS_FOR_SIMILARITY) return false
  let shared = 0
  for (const w of tx) if (ty.has(w)) shared++
  return shared / Math.max(tx.size, ty.size) >= META_SIMILARITY
}

/** Which of the post's search title and description repeat another live page's. Pure. */
export function metaDuplicates(post: Pick<QualityPost, 'seo_title' | 'seo_description' | 'slug'>, others: OtherMeta[] | undefined): { title: string | null; description: string | null } {
  const out = { title: null as string | null, description: null as string | null }
  for (const o of others ?? []) {
    if (post.slug && o.slug && o.slug === post.slug) continue
    if (!out.title && post.seo_title && metaTextsClash(post.seo_title, o.title)) out.title = o.title ?? null
    if (!out.description && post.seo_description && metaTextsClash(post.seo_description, o.description)) out.description = o.description ?? null
  }
  return out
}

/** Why a cover picture has no useful alt text, or null when it is fine or there is no cover (or it is not known yet). Pure. */
export function coverAltIssue(cover: { url?: string | null; alt?: string | null } | null | undefined): string | null {
  if (!cover || !(cover.url ?? '').trim()) return null
  return isGenericAlt(cover.alt) ? 'cover image alt text is missing or generic (a short description of the picture and the place is needed)' : null
}

// ---------------------------------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------------------------------

const textFieldsOf = (p: QualityPost): string[] => [p.title, p.seo_title ?? '', p.seo_description ?? '', p.og_title ?? '', p.og_description ?? '', ...(p.key_takeaways ?? [])]

/** All the quality blockers for a post, in a fixed order. Empty means it meets the bar. Pure. */
export function qualityBlockers(post: QualityPost, ctx: QualityCtx): string[] {
  const blockers: string[] = []
  const stored = ctx.storedBody ? ctx.storedBody(post.body) : post.body
  const grounding = ctx.groundingText ?? ''
  const faq = post.faq ?? []

  if (!(post.content_style ?? '').trim()) blockers.push('no content style recorded')
  if (!(post.primary_keyword ?? '').trim()) blockers.push('no primary keyword recorded')

  const links = internalHrefs(stored)
  if (links.length < MIN_INTERNAL_LINKS) blockers.push(`too few internal links (${links.length}, needs at least ${MIN_INTERNAL_LINKS})`)
  if (!hasContactOrTripLink(stored)) blockers.push('no contact or trip link')
  if (!hasQuickAnswer(post.body)) blockers.push('no Quick answer line')
  else {
    const lengthIssue = quickAnswerLengthIssue(post.body)
    if (lengthIssue) blockers.push(lengthIssue)
  }

  const dup = metaDuplicates(post, ctx.otherMeta)
  if (dup.title) blockers.push(`meta title duplicates another page ("${dup.title.slice(0, 70)}")`)
  if (dup.description) blockers.push(`meta description duplicates another page ("${dup.description.slice(0, 70)}")`)
  const altIssue = coverAltIssue(ctx.cover)
  if (altIssue) blockers.push(`cover image alt text: ${altIssue}`)

  const opening = firstSentenceIssue(post.body, post.primary_keyword)
  if (opening) blockers.push(opening)

  const banned = [...new Set([...bannedPhraseHits(stored), ...textFieldsOf(post).flatMap(bannedPhraseHits), ...faq.flatMap((f) => [...bannedPhraseHits(f.q), ...bannedPhraseHits(f.a)])])]
  if (banned.length) blockers.push(`banned filler phrase (${banned.join(', ')})`)

  const meta = faqMetaHits(faq)
  if (meta.length) blockers.push(`FAQ talks about the text itself ("${meta[0]}")`)

  const claims = [...new Set([stored, ...textFieldsOf(post), ...faq.map((f) => `${f.q}. ${f.a}`)].flatMap((t) => ungroundedSuperlatives(t, grounding)))]
  if (claims.length) blockers.push(`unverifiable claim (${claims.slice(0, 2).map((c) => `"${c}"`).join(', ')})`)

  for (const issue of titleYearIssues(post.title, ctx.now, ctx.tripDates)) blockers.push(issue)
  const promised = titlePromiseIssues(post.title, post.body)
  if (promised.length) blockers.push(`title promises something the post lacks (${promised.join(', ')})`)
  const brands = titleBrandIssues(post.title, grounding)
  if (brands.length) blockers.push(`title names a brand that is not the trip's (${brands.join(', ')})`)
  return blockers
}

/** Score for ordering: how many quality blockers a post has. Pure. */
export function qualityDebt(post: QualityPost, ctx: QualityCtx): number {
  return qualityBlockers(post, ctx).length
}

/** The cap rule for the stored seo_score: a post with fewer than 3 internal links or no Quick answer line cannot score above 80. Pure. */
export function isThinPost(body: string): boolean {
  return internalHrefs(body).length < MIN_INTERNAL_LINKS || !hasQuickAnswer(body)
}
