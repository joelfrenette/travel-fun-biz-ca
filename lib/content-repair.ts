import { callAnthropic, anthropicText, parseModelJson, isAiConfigured } from '@/lib/ai-verify'
import { cutAtWord } from '@/lib/blog-composer'
import {
  agencyClaims,
  COUNT_CLAIM,
  namedThingsNotInBrief,
  numbersIn,
  proseOf,
  RECENCY_PATTERNS,
  removeDashes,
  SCHEDULE_PATTERN,
  SUPERLATIVE_PATTERNS,
  ungroundedWordCounts as guideWordCounts,
  WORD_NUMBER_PATTERNS,
} from '@/lib/guide-composer'
import { COMPARATIVE, unexcusedWeatherWords, ungroundedWordCounts as copyWordCounts, VAGUE_QUANTITY, VERDICT } from '@/lib/page-copy-composer'
import { hasDash } from '@/lib/seo-score'

// Self-healing content (growth loop WP10), the shared core. Given a page that the quality gate held back, it
// rewords or removes the offending sentences, runs the plain-code fixers, runs the gate again, and tells the caller
// what changed. The model is never trusted: it may only SHORTEN or DELETE (a rewrite longer than the original, or
// one that adds a number, name or link, is thrown away), the gate decides at the end, and anything on the HARD list
// is left exactly as it was for a person to decide.
//
// This file is pure apart from the model call (injectable, so the offline check runs without a network) and has no
// database access: lib/content-edits.ts holds the audit log, the daily slots and revert, and
// lib/content-repair-adapters.ts connects it to posts, guides and page copy.

export type ContentType = 'post' | 'guide' | 'page_copy'
export type EditField = 'body' | 'title' | 'meta_title' | 'meta_description' | 'og_title' | 'og_description' | 'faq' | 'key_takeaways' | 'links'
export type EditMethod = 'ai' | 'delete' | 'fixer' | 'links' | 'generate'
/** The fields a repair can touch. `links` is not one of them: it is how a body edit made only of links is labelled. */
type LogicalField = Exclude<EditField, 'links'>

export interface FaqPair {
  q: string
  a: string
}

/** The text of one page, in one shape for every kind. A post has a title; a guide has a summary (the opening
 * paragraph, kept apart from the sections); page copy has neither (its `body` is the intro). */
export interface RepairFields {
  title?: string
  summary?: string
  body: string
  meta_title: string
  meta_description: string
  og_title: string
  og_description: string
  faq: FaqPair[]
  key_takeaways: string[]
}

export interface RepairLimits {
  faqMin: number
  faqMax: number
  takeMin: number
  takeMax: number
  metaTitleMax: number
  metaDescMax: number
  ogTitleMax: number
  ogDescMax: number
  /** Page copy allows at most this many links in its intro. */
  maxBodyLinks?: number
}

export interface ContentEdit {
  content_type: ContentType
  content_id: string | null
  path: string
  field: EditField
  reason: string
  before: string
  after: string
  method: EditMethod
  published_after: boolean
  cost_usd: number
}

export const EST_COST_USD_PER_CALL = 0.05
export const MAX_REPAIR_SENTENCES = 12
/** A model call only starts when at least this long is left before the caller's deadline. */
export const MIN_MS_PER_CALL = 50_000
const CALL_TIMEOUT_MS = 45_000

// ---------------------------------------------------------------------------------------------------
// REPAIRABLE or HARD: every blocker the three gates can produce, as data (so QA can read it)
// ---------------------------------------------------------------------------------------------------

export type BlockerClass = 'repairable' | 'hard'

export interface BlockerRule {
  id: string
  /** Matched against the start of a blocker string from guideBlockers, pageCopyBlockers or autoPublishBlockers. */
  pattern: RegExp
  klass: BlockerClass
  /** How a repairable blocker is mended: a plain-code fixer, a generated replacement, or a reword/delete. */
  how: 'fixer' | 'generate' | 'rewrite' | 'person'
  note: string
}

/** First match wins. A blocker no rule matches is HARD (a new gate rule is a person's decision until classified). */
export const BLOCKER_RULES: BlockerRule[] = [
  // HARD: never auto-published, stays a draft with the reasons.
  { id: 'too-short', pattern: /^(intro )?too short/, klass: 'hard', how: 'person', note: 'body under the minimum length' },
  { id: 'too-long', pattern: /^(intro )?too long/, klass: 'hard', how: 'person', note: 'body over the maximum length' },
  { id: 'section-count', pattern: /sections, expected/, klass: 'hard', how: 'person', note: 'wrong number of sections' },
  { id: 'no-sections', pattern: /^no section headings/, klass: 'hard', how: 'person', note: 'no headings' },
  { id: 'intro-shape', pattern: /^the intro (has a heading|is empty|does not name)|^the first sentence is (a question|too long)/, klass: 'hard', how: 'person', note: 'the intro is the wrong shape' },
  { id: 'no-keyword', pattern: /^no primary keyword/, klass: 'hard', how: 'person', note: 'no primary keyword' },
  { id: 'opening-names-subject', pattern: /^the opening paragraph does not name/, klass: 'hard', how: 'person', note: 'the opening does not name the subject' },
  { id: 'placeholder', pattern: /^placeholder text/, klass: 'hard', how: 'person', note: 'placeholder text' },
  { id: 'refusal', pattern: /^model refusal/, klass: 'hard', how: 'person', note: 'the model refused or apologised' },
  { id: 'experience', pattern: /experience claim/, klass: 'hard', how: 'person', note: 'a first-person experience claim' },
  { id: 'stale-year', pattern: /^stale year/, klass: 'hard', how: 'person', note: 'an old year in the title' },
  { id: 'web-address', pattern: /^web address in text/, klass: 'hard', how: 'person', note: 'a web address typed into the text (not a link whose words can stay)' },
  { id: 'person-needed', pattern: /^needs a person:/, klass: 'hard', how: 'person', note: 'a named person, or a price or exact date that cannot be deleted (its paragraph would drop under 2 sentences) or that the facts give' },
  // REPAIRABLE: reword or remove, then re-gate.
  { id: 'dashes', pattern: /dash (present|character)|contains a long dash/, klass: 'repairable', how: 'fixer', note: 'a long dash' },
  { id: 'length', pattern: /^(social (title|description) too long|meta (title|description) over|OG (title|description) over)/, klass: 'repairable', how: 'fixer', note: 'meta or share text too long' },
  { id: 'missing-extras', pattern: /^(missing FAQ|missing key takeaways|ran out of time for FAQ|missing meta title or description|\d+ FAQ questions, need|\d+ key takeaways, need)/, klass: 'repairable', how: 'generate', note: 'missing FAQ, takeaways or meta text (regenerated from the body only)' },
  { id: 'numbers', pattern: /^number not in/, klass: 'repairable', how: 'rewrite', note: 'a number that is not in the source facts' },
  { id: 'word-numbers', pattern: /^(word number not in|a size, count or date written in words|a count written in words)/, klass: 'repairable', how: 'rewrite', note: 'a count written in words that is not in the source facts' },
  { id: 'superlative', pattern: /^superlative or rating claim/, klass: 'repairable', how: 'rewrite', note: 'a superlative or reputation word' },
  { id: 'recency', pattern: /^unverifiable recency claim/, klass: 'repairable', how: 'rewrite', note: 'a recency claim' },
  { id: 'amenity-count', pattern: /^amenity or capacity count/, klass: 'repairable', how: 'rewrite', note: 'an amenity or capacity count' },
  { id: 'schedule', pattern: /^itinerary or schedule stated as fact/, klass: 'repairable', how: 'rewrite', note: 'a schedule stated as fact' },
  { id: 'agency', pattern: /^claim about what the agency/, klass: 'repairable', how: 'rewrite', note: 'an agency claim' },
  { id: 'venue', pattern: /^named venue or person not in brief/, klass: 'repairable', how: 'rewrite', note: 'a named venue not in the brief (a sentence that looks like a named person is HARD, see isNamedPersonLike)' },
  { id: 'weather', pattern: /^weather, crowd or season word/, klass: 'repairable', how: 'rewrite', note: 'a weather, crowd or season word (page copy)' },
  { id: 'verdict', pattern: /^(says which destination is better|the first sentence compares)/, klass: 'repairable', how: 'rewrite', note: 'verdict phrasing (compare pages)' },
  { id: 'ext-link', pattern: /^(external or email link|link that is not an internal path)/, klass: 'repairable', how: 'fixer', note: 'a link to another website or an email address (the link goes, the words stay)' },
  { id: 'dead-link', pattern: /^(dead internal link|link to a page that was not confirmed)/, klass: 'repairable', how: 'fixer', note: 'a link to a page that does not exist (the link goes, the words stay)' },
  { id: 'faq-link', pattern: /^(link inside FAQ, takeaways or meta text|link inside a FAQ)/, klass: 'repairable', how: 'fixer', note: 'a link inside FAQ, takeaways or meta text' },
  { id: 'no-link', pattern: /^no internal link/, klass: 'repairable', how: 'fixer', note: 'no internal link (a real page is added)' },
  { id: 'too-many-links', pattern: /links in the intro, at most/, klass: 'repairable', how: 'fixer', note: 'too many links in the intro' },
]

export function ruleFor(blocker: string): BlockerRule | null {
  return BLOCKER_RULES.find((r) => r.pattern.test(blocker)) ?? null
}

/** Splits gate blockers into REPAIRABLE and HARD. An unrecognised blocker is HARD. */
export function classifyBlockers(blockers: string[]): { repairable: string[]; hard: string[] } {
  const repairable: string[] = []
  const hard: string[] = []
  for (const b of blockers) (ruleFor(b)?.klass === 'repairable' ? repairable : hard).push(b)
  return { repairable, hard }
}

/** The rule ids behind some blockers (unrecognised ones count as 'unknown'). */
export function blockerKinds(blockers: string[]): Set<string> {
  return new Set(blockers.map((b) => ruleFor(b)?.id ?? 'unknown'))
}

// ---------------------------------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------------------------------

const LEADING_MARKER = /^\s*(?:[-*]\s+|\d+[.)]\s+|#{1,6}\s+)/
const MD_LINK = /(!?)\[([^\]]*)\]\(([^)\s]*)(?:\s+"[^"]*")?\)/g

const wordsOf = (s: string) => s.split(/\s+/).filter(Boolean).length

/** The sentences of a body, one entry per sentence, with the heading flag and the list marker kept apart. */
export function bodySentences(text: string): { text: string; prefix: string; heading: boolean }[] {
  const out: { text: string; prefix: string; heading: boolean }[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    const marker = line.match(LEADING_MARKER)?.[0] ?? ''
    if (/^\s*#{1,6}\s/.test(line)) {
      out.push({ text: line.trim(), prefix: marker.trim() ? marker.trimStart() : '', heading: true })
      continue
    }
    const sentences = line.split(/(?<=[a-zA-Z)"'][.!?])\s+/)
    sentences.forEach((s, i) => {
      if (!s.trim()) return
      // A sentence keeps its own list marker only when it starts the line.
      out.push({ text: s, prefix: i === 0 ? marker : '', heading: false })
    })
  }
  return out
}

/** Markdown link targets that are internal paths, normalised; null for anything else. */
function internalPath(href: string): string | null {
  let t = href
  if (/^https?:\/\//i.test(t)) {
    try {
      const u = new URL(t)
      if (!/^(www\.)?travelfunbiz\.ca$/i.test(u.hostname)) return null
      t = u.pathname || '/'
    } catch {
      return null
    }
  }
  if (!t.startsWith('/')) return null
  const path = t.split('#')[0].split('?')[0]
  return path === '' ? '/' : path.length > 1 ? path.replace(/\/+$/, '') : path
}

/** Removes markdown links for which `shouldStrip(href)` is true, keeping the anchor text. */
export function stripLinks(text: string, shouldStrip: (href: string) => boolean): string {
  return text.replace(MD_LINK, (all, bang: string, label: string, href: string) => (bang ? all : shouldStrip(href) ? label : all))
}

/** Links to another website or an email address lose the link and keep their words. */
export function stripExternalLinks(text: string): string {
  return stripLinks(text, (href) => /^(?:https?:\/\/|mailto:|www\.)/i.test(href) && internalPath(href) === null)
}

export function stripAllLinks(text: string): string {
  return stripLinks(text, () => true)
}

/** Links to internal pages that are not in `allowed` (the home page and #anchors are always fine). */
export function stripDeadLinks(text: string, allowed: Set<string>): string {
  return stripLinks(text, (href) => {
    if (href.startsWith('#')) return false
    const p = internalPath(href)
    if (p === null) return false // an external link is HARD, never stripped silently
    return p !== '/' && !allowed.has(p)
  })
}

/** Keeps the first `max` links, removes the rest (anchor text stays). */
export function keepFirstLinks(text: string, max: number): string {
  let n = 0
  return text.replace(MD_LINK, (all, bang: string, label: string) => {
    if (bang) return all
    n++
    return n <= max ? all : label
  })
}

export function internalLinksOfText(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(MD_LINK)) {
    if (m[1]) continue
    const p = internalPath(m[3])
    if (p) out.push(p)
  }
  return out
}

/** Appends one "Related" line linking a real page that is not linked yet. The words are the page's own label,
 * so nothing is claimed. Null when every offered page is already linked (or none is offered). */
export function addInternalLink(body: string, links: { path: string; label: string }[], already: string[] = internalLinksOfText(body)): string | null {
  const have = new Set(already)
  const pick = links.find((l) => !have.has(l.path === '/#contact' ? '/' : l.path) && l.path !== '/#contact') ?? links.find((l) => !have.has(l.path === '/#contact' ? '/' : l.path))
  if (!pick) return null
  const label = pick.label.replace(/[[\]]/g, '').trim()
  if (!label) return null
  return `${body.replace(/\s+$/, '')}\n\nRelated: [${label}](${pick.path}).`
}

// ---------------------------------------------------------------------------------------------------
// HARD guards on the text itself: a price, a date or a named person is a person's call
// ---------------------------------------------------------------------------------------------------

const MONTH = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)'

/** A price or an exact date in a sentence (a figure that belongs to a package row, not to the copy). */
export function isPriceOrDate(text: string): boolean {
  return (
    /[$€£]\s?\d/.test(text) ||
    /\b\d[\d,.]*\s?(?:dollars?|cad|usd|eur|euros?)\b/i.test(text) ||
    /\b(?:cad|usd)\s?\$?\d/i.test(text) ||
    /\bper (?:person|night|couple|cabin|adult|traveller|traveler)\b/i.test(text) && /\d/.test(text) ||
    new RegExp(`\\b${MONTH}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?\\b`, 'i').test(text) ||
    new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH}\\b`, 'i').test(text) ||
    /\b(?:19|20)\d{2}-\d{2}-\d{2}\b/.test(text) ||
    /\b\d{1,2}\/\d{1,2}\/(?:19|20)?\d{2}\b/.test(text)
  )
}

/** A sentence that looks like it is about a named person (an honorific or role before a capitalised name, or a
 * "<Name> <Name> said/founded/..." shape). A heuristic: it errs toward asking a person. */
export function isNamedPersonLike(text: string): boolean {
  return (
    /\b(?:Mr|Mrs|Ms|Mx|Dr|Sir|Dame|Captain|Capt|Chef)\.?\s+[A-Z][\p{L}'’-]+/u.test(text) ||
    /\b[A-Z][\p{L}'’-]+\s+[A-Z][\p{L}'’-]+\s+(?:said|says|founded|designed|owns|owned|wrote|was born|opened)\b/u.test(text) ||
    /\b(?:founded|designed|owned|built|created|named after|run) by\s+[A-Z][\p{L}'’-]+/u.test(text)
  )
}

// ---------------------------------------------------------------------------------------------------
// Finding the sentences behind a blocker
// ---------------------------------------------------------------------------------------------------

export type OffenderField = 'title' | 'summary' | 'body' | 'meta_title' | 'meta_description' | 'og_title' | 'og_description' | 'faq_q' | 'faq_a' | 'takeaway'

export interface Offender {
  field: OffenderField
  index?: number
  /** The exact text to rewrite (a sentence for the body, the whole value for the other fields). Includes any list marker. */
  text: string
  why: string
  /** List marker at the start of the text ("- ", "1. "), kept out of the prompt and put back on the rewrite. */
  prefix: string
}

export interface DetectCtx {
  type: ContentType
  /** The facts the writer was given: the only place a number may come from. */
  grounding: string
  /** Everything a name may come from (grounding, the subject, link labels). */
  allowedText: string
  groundNums: Set<string>
  /** Posts: the post gate only checks numbers and links, so a reword is judged on numbers alone (the gate decides the rest). */
}

export function makeDetectCtx(type: ContentType, grounding: string, names: string[] = []): DetectCtx {
  return { type, grounding, allowedText: [grounding, ...names].join(' '), groundNums: new Set(numbersIn(grounding)) }
}

/** Why a sentence would trip the gate (the same lists the gates use), as short instructions. Empty means clean.
 * `meta` is true for titles, meta and share text: the gates do not run the name and agency checks on those. */
export function sentenceProblems(sentence: string, ctx: DetectCtx, meta = false): string[] {
  const why: string[] = []
  const prose = proseOf(sentence)
  const nums = [...new Set(numbersIn(prose).filter((n) => !ctx.groundNums.has(n)))]
  if (nums.length) why.push(`contains the number ${nums.join(', ')}, which is not in the source facts; say it in general terms or leave it out`)
  const wordCounts = ctx.type === 'page_copy' ? copyWordCounts(prose, ctx.grounding) : guideWordCounts(prose, ctx.grounding)
  if (wordCounts.length || WORD_NUMBER_PATTERNS.some((p) => p.test(prose)) || (ctx.type === 'page_copy' && VAGUE_QUANTITY.test(prose))) why.push('contains a count or size written in words; leave it out or say it in general terms')
  for (const [pattern, label] of SUPERLATIVE_PATTERNS) if (pattern.test(prose)) why.push(`contains a superlative or reputation claim (${label}); remove it`)
  if (RECENCY_PATTERNS.some((p) => p.test(sentence))) why.push('claims something is new or recently changed; remove it')
  if (COUNT_CLAIM.test(sentence)) why.push('states how many rooms, cabins, decks or similar there are; remove it')
  if (SCHEDULE_PATTERN.test(sentence)) why.push('states a schedule as fact; remove it')
  if (!meta && agencyClaims(sentence).length) why.push('says what the agency has done or does; the agency may only offer help ("we can help you plan")')
  if (!meta && namedThingsNotInBrief(sentence, ctx.allowedText).length) why.push('names a place, venue or person that is not in the source facts; remove the name')
  if (ctx.type === 'page_copy') {
    const weather = unexcusedWeatherWords(prose, ctx.grounding)
    if (weather.length) why.push(`mentions weather, crowds or seasons ("${weather[0]}"); remove it`)
    if (VERDICT.test(prose)) why.push('says one destination is better than another; describe the difference without a verdict')
  }
  return why
}

/** Every sentence or field that trips a rule. Pure. Used for the model prompt, the HARD guard and the fallback. */
export function detectOffenders(f: RepairFields, ctx: DetectCtx, blockers: string[] = []): Offender[] {
  const out: Offender[] = []
  const whole = (field: OffenderField, text: string | undefined, index?: number) => {
    if (!text || !text.trim()) return
    const why = sentenceProblems(text, ctx, field === 'title' || field.startsWith('meta_') || field.startsWith('og_'))
    if (why.length) out.push({ field, index, text, why: why.join('; '), prefix: '' })
  }
  whole('title', f.title)
  for (const field of ['summary', 'body'] as const) {
    const text = f[field]
    if (!text) continue
    for (const s of bodySentences(text)) {
      if (s.heading) {
        const why = sentenceProblems(s.text.replace(/^#{1,6}\s+/, ''), ctx)
        if (why.length) out.push({ field, text: s.text, why: why.join('; '), prefix: s.text.match(/^#{1,6}\s+/)?.[0] ?? '' })
        continue
      }
      const why = sentenceProblems(s.text, ctx)
      if (why.length) out.push({ field, text: s.text, why: why.join('; '), prefix: s.prefix })
    }
  }
  whole('meta_title', f.meta_title)
  whole('meta_description', f.meta_description)
  whole('og_title', f.og_title)
  whole('og_description', f.og_description)
  f.faq.forEach((p, i) => {
    whole('faq_q', p.q, i)
    whole('faq_a', p.a, i)
  })
  f.key_takeaways.forEach((t, i) => whole('takeaway', t, i))
  // The page-copy gate also flags a first sentence that compares one destination as better or more than another.
  if (ctx.type === 'page_copy' && blockers.some((b) => /^the first sentence compares/.test(b))) {
    const first = bodySentences(f.body).find((s) => !s.heading)
    if (first && COMPARATIVE.test(first.text) && !out.some((o) => o.field === 'body' && o.text === first.text)) {
      out.push({ field: 'body', text: first.text, why: 'compares a destination as better, more or less than another; describe the difference without a verdict', prefix: first.prefix })
    }
  }
  return out
}

// ---------------------------------------------------------------------------------------------------
// Applying a reword or a delete
// ---------------------------------------------------------------------------------------------------

export function cloneFields(f: RepairFields): RepairFields {
  return { ...f, faq: f.faq.map((p) => ({ ...p })), key_takeaways: [...f.key_takeaways] }
}

/** Puts `replacement` where the offender was, or deletes it when `replacement` is null. Returns the same object
 * (unchanged) when the offender cannot be found or cannot be deleted (a heading, a meta field). Pure. */
export function replaceUnit(f: RepairFields, o: Offender, replacement: string | null): RepairFields {
  const next = cloneFields(f)
  switch (o.field) {
    case 'body':
    case 'summary': {
      const text = next[o.field] ?? ''
      const at = text.indexOf(o.text)
      if (at === -1) return f
      if (replacement === null) {
        if (/^\s*#{1,6}\s/.test(o.text)) return f
        const before = text.slice(0, at)
        let after = text.slice(at + o.text.length)
        // Remove the gap the sentence leaves, and the whole line when nothing else is on it.
        after = after.replace(/^[ \t]+/, '')
        let joined = before + after
        joined = joined.replace(/^[ \t]*(?:[-*]|\d+[.)])?[ \t]*$/gm, '').replace(/\n{3,}/g, '\n\n').replace(/[ \t]+$/gm, '')
        next[o.field] = joined.replace(/^\n+/, '')
      } else {
        next[o.field] = text.slice(0, at) + o.prefix + replacement + text.slice(at + o.text.length)
      }
      return next
    }
    case 'faq_q':
    case 'faq_a': {
      if (o.index === undefined || !next.faq[o.index]) return f
      if (replacement === null) next.faq.splice(o.index, 1)
      else if (o.field === 'faq_q') next.faq[o.index].q = replacement
      else next.faq[o.index].a = replacement
      return next
    }
    case 'takeaway': {
      if (o.index === undefined || next.key_takeaways[o.index] === undefined) return f
      if (replacement === null) next.key_takeaways.splice(o.index, 1)
      else next.key_takeaways[o.index] = replacement
      return next
    }
    default: {
      if (replacement === null) return f
      ;(next as unknown as Record<string, string>)[o.field] = replacement
      return next
    }
  }
}

// Words a rewrite may always use (they carry no claim of their own). Everything else must come from the original.
const NEUTRAL_WORDS = new Set(['well', 'known', 'popular', 'many', 'some', 'often', 'can', 'may', 'several', 'a', 'an', 'the', 'and', 'or', 'with', 'for', 'to', 'of', 'in', 'on', 'at', 'is', 'are', 'it', 'this', 'that', 'trip', 'visit', 'visitors', 'travellers', 'guests', 'area', 'place'])
// Function words dropped before comparing (no content of their own).
const STOP_WORDS = new Set(['be', 'been', 'was', 'were', 'am', 'has', 'have', 'had', 'will', 'would', 'by', 'from', 'but', 'if', 'so', 'than', 'then', 'there', 'these', 'those', 'which', 'who', 'what', 'when', 'where', 'while', 'into', 'over', 'under', 'up', 'out', 'about', 'as', 'you', 'your', 'he', 'she', 'they', 'their', 'his', 'her', 'its', 'do', 'does', 'one'])

const stem = (w: string) => (w.length > 4 ? w.replace(/(?:ingly|edly|ing|ied|ies|ed|es|ly|s)$/, '') : w.length > 3 ? w.replace(/s$/, '') : w)

/** The content words of a text, lowercased and stemmed, with function words and the neutral allowlist dropped.
 * Link syntax is reduced to its anchor text. */
export function contentStems(text: string): string[] {
  const plain = text.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').toLowerCase()
  const words = plain.match(/[\p{L}\p{N}]+/gu) ?? []
  return words.filter((w) => !NEUTRAL_WORDS.has(w) && !STOP_WORDS.has(w)).map(stem)
}

/** Why a model rewrite must be thrown away, or null when it is acceptable. A rewrite may only shorten: it must not
 * be longer than the original, add a number, a name, a link, a price or a date, or keep the problem. */
export function validateRewrite(original: string, rewrite: string, ctx: DetectCtx): string | null {
  const text = rewrite.trim()
  if (!text) return 'empty'
  const cleanOriginal = original.replace(LEADING_MARKER, '')
  if (wordsOf(text) > wordsOf(cleanOriginal) + 2) return 'longer than the original'
  const origNums = new Set(numbersIn(proseOf(original)))
  if (numbersIn(proseOf(text)).some((n) => !origNums.has(n) && !ctx.groundNums.has(n))) return 'adds a number'
  if (/https?:\/\/|\bwww\./i.test(text)) return 'adds a web address'
  const origLinks = new Set(internalLinksOfText(original))
  if (internalLinksOfText(text).some((l) => !origLinks.has(l))) return 'adds a link'
  if (isPriceOrDate(text) && !isPriceOrDate(original)) return 'adds a price or date'
  // Subset guard: a rewrite may only reuse the words the original already had (plus a few neutral ones). This is what
  // stops the model slipping in a new claim ("wheelchair accessible", "free to enter", "we guarantee") that no list catches.
  const known = new Set(contentStems(original))
  const extra = contentStems(text).find((w) => !known.has(w))
  if (extra) return `uses a word the original did not have (${extra})`
  if (namedThingsNotInBrief(text, `${original} ${ctx.allowedText}`).length) return 'adds a name'
  if (sentenceProblems(text, ctx).length) return 'still has the problem'
  return null
}

// ---------------------------------------------------------------------------------------------------
// Plain-code fixers (no model): dashes, lengths, links
// ---------------------------------------------------------------------------------------------------

/** Maps every text field through `fn`. */
export function mapFields(f: RepairFields, fn: (text: string) => string): RepairFields {
  return {
    ...f,
    ...(f.title !== undefined ? { title: fn(f.title) } : {}),
    ...(f.summary !== undefined ? { summary: fn(f.summary) } : {}),
    body: fn(f.body),
    meta_title: fn(f.meta_title),
    meta_description: fn(f.meta_description),
    og_title: fn(f.og_title),
    og_description: fn(f.og_description),
    faq: f.faq.map((p) => ({ q: fn(p.q), a: fn(p.a) })),
    key_takeaways: f.key_takeaways.map(fn),
  }
}

export function fixAllDashes(f: RepairFields): RepairFields {
  return mapFields(f, removeDashes)
}

export function clampLengths(f: RepairFields, limits: RepairLimits): RepairFields {
  const cut = (s: string, max: number) => (s.length > max ? cutAtWord(s, max) : s)
  const next = cloneFields(f)
  next.meta_title = cut(f.meta_title, limits.metaTitleMax)
  next.meta_description = cut(f.meta_description, limits.metaDescMax)
  next.og_title = cut(f.og_title, limits.ogTitleMax)
  next.og_description = cut(f.og_description, limits.ogDescMax)
  return next
}

export const sameFields = (a: RepairFields, b: RepairFields) => JSON.stringify(a) === JSON.stringify(b)

// ---------------------------------------------------------------------------------------------------
// Generating what is missing (FAQ, takeaways, meta and share text) from the BODY only
// ---------------------------------------------------------------------------------------------------

export type GenKey = 'faq' | 'key_takeaways' | 'meta_title' | 'meta_description' | 'og_title' | 'og_description'

export function missingExtras(f: RepairFields, limits: RepairLimits): GenKey[] {
  const out: GenKey[] = []
  if (f.faq.length < limits.faqMin) out.push('faq')
  if (f.key_takeaways.length < limits.takeMin) out.push('key_takeaways')
  if (!f.meta_title.trim()) out.push('meta_title')
  if (!f.meta_description.trim()) out.push('meta_description')
  if (!f.og_title.trim()) out.push('og_title')
  if (!f.og_description.trim()) out.push('og_description')
  return out
}

/** The body as plain words for a prompt: link syntax reduced to its anchor text, cut to a safe length. */
export function plainForPrompt(f: RepairFields): string {
  const text = [f.title, f.summary, f.body].filter(Boolean).join('\n\n').replace(MD_LINK, (_all, bang: string, label: string) => (bang ? '' : label))
  return text.length > 14_000 ? text.slice(0, 14_000) : text
}

function generationPrompt(f: RepairFields, keys: GenKey[], limits: RepairLimits, keyword: string | null): string {
  const spec: Record<GenKey, string> = {
    faq: `- faq: ${limits.faqMin} to ${limits.faqMax} objects {"q","a"}. Each q is a real question a searcher would type about this page's topic. Each a answers it directly in one to three plain sentences using only what the text says. No links.`,
    key_takeaways: `- key_takeaways: ${limits.takeMin} to ${limits.takeMax} one-line takeaways (each under 120 characters) that summarise the text. No links.`,
    meta_title: `- meta_title: ${limits.metaTitleMax} characters or fewer${keyword ? `, containing the phrase "${keyword}" if the text supports it` : ''}, saying what the page is for.`,
    meta_description: `- meta_description: between 70 and ${limits.metaDescMax} characters, honest, no fake urgency.`,
    og_title: `- og_title: ${limits.ogTitleMax} characters or fewer, a social share title, honest and about this page.`,
    og_description: `- og_description: ${limits.ogDescMax} characters or fewer, a social share description.`,
  }
  const shape = `{${keys.map((k) => (k === 'faq' ? '"faq":[{"q":"...","a":"..."}]' : k === 'key_takeaways' ? '"key_takeaways":["..."]' : `"${k}":"..."`)).join(',')}}`
  return `Below is the finished text of a page on a Canadian travel agency website. Write ONLY the fields listed after it, using ONLY what the text says. Never add a fact, name, number, date, price, count or claim that is not in the text. Use no digits unless the same number appears in the text. No links. No superlatives or reputation words (best, famous, award-winning, top-rated, luxury, finest, world-class, iconic). Say nothing about what the agency has done or does. Never use the long dash character. Plain English, Canadian spelling.\n\nTEXT:\n${plainForPrompt(f)}\n\nFields to write:\n${keys.map((k) => spec[k]).join('\n')}\n\nReturn ONLY minified JSON: ${shape}`
}

const asText = (v: unknown, max: number): string => (typeof v === 'string' ? cutAtWord(removeDashes(stripAllLinks(v)).replace(/\s+/g, ' ').trim(), max) : '')

/** Cleans and filters the model's generated fields: dashes and links removed, lengths cut, numbers only if the body
 * has them, and every sentence run through the same rule lists as the gates. Returns only what survives. Pure. */
export function acceptGenerated(raw: unknown, keys: GenKey[], limits: RepairLimits, bodyCtx: DetectCtx): Partial<Pick<RepairFields, GenKey>> {
  const out: Partial<Pick<RepairFields, GenKey>> = {}
  if (!raw || typeof raw !== 'object') return out
  const r = raw as Record<string, unknown>
  const clean = (text: string) => !!text && !hasDash(text) && bodySentences(text).every((s) => !sentenceProblems(s.text, bodyCtx).length) && !isPriceOrDate(text)
  for (const key of keys) {
    if (key === 'faq') {
      const pairs: FaqPair[] = []
      for (const item of Array.isArray(r.faq) ? r.faq : []) {
        const q = asText((item as { q?: unknown })?.q, 200)
        const a = asText((item as { a?: unknown })?.a, 600)
        if (q && a && clean(q) && clean(a)) pairs.push({ q, a })
      }
      if (pairs.length >= limits.faqMin) out.faq = pairs.slice(0, limits.faqMax)
    } else if (key === 'key_takeaways') {
      const list = (Array.isArray(r.key_takeaways) ? r.key_takeaways : []).map((t) => asText(t, 140)).filter((t) => t && clean(t))
      if (list.length >= limits.takeMin) out.key_takeaways = list.slice(0, limits.takeMax)
    } else {
      const max = key === 'meta_title' ? limits.metaTitleMax : key === 'meta_description' ? limits.metaDescMax : key === 'og_title' ? limits.ogTitleMax : limits.ogDescMax
      const text = asText(r[key], max)
      if (text && clean(text)) out[key] = text
    }
  }
  return out
}

// ---------------------------------------------------------------------------------------------------
// The model call (injectable)
// ---------------------------------------------------------------------------------------------------

export type ModelCall = (prompt: string, maxTokens: number, timeoutMs: number) => Promise<string | null>

export const callModelText: ModelCall = async (prompt, maxTokens, timeoutMs) => {
  try {
    const r = await callAnthropic({ max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }, { timeoutMs })
    if (!r || !r.res.ok) return null
    const payload = await r.res.json().catch(() => null)
    if ((payload as { stop_reason?: string } | null)?.stop_reason === 'max_tokens') return null
    return anthropicText(payload) || null
  } catch (err) {
    console.error('[content-repair] model call failed:', err instanceof Error ? err.message : err)
    return null
  }
}

/** One model call that writes the requested missing fields from the page text. Returns what survived the filters. */
export async function generateExtras(model: ModelCall, f: RepairFields, keys: GenKey[], limits: RepairLimits, keyword: string | null, bodyCtx: DetectCtx, timeoutMs = CALL_TIMEOUT_MS): Promise<Partial<Pick<RepairFields, GenKey>>> {
  if (keys.length === 0) return {}
  const text = await model(generationPrompt(f, keys, limits, keyword), 3000, timeoutMs)
  if (!text) return {}
  return acceptGenerated(parseModelJson<Record<string, unknown>>(text), keys, limits, bodyCtx)
}

// ---------------------------------------------------------------------------------------------------
// Deterministic fallback: delete the sentence or the clause after the flagged word
// ---------------------------------------------------------------------------------------------------

/** Where in a sentence the first flagged word starts, or -1. */
function firstProblemIndex(sentence: string, ctx: DetectCtx): number {
  const idx: number[] = []
  const prose = proseOf(sentence)
  const push = (i: number | undefined) => {
    if (i !== undefined && i >= 0) idx.push(i)
  }
  for (const [p] of SUPERLATIVE_PATTERNS) push(p.exec(prose)?.index)
  for (const p of RECENCY_PATTERNS) push(p.exec(sentence)?.index)
  push(COUNT_CLAIM.exec(sentence)?.index)
  push(SCHEDULE_PATTERN.exec(sentence)?.index)
  for (const p of WORD_NUMBER_PATTERNS) push(p.exec(prose)?.index)
  if (ctx.type === 'page_copy') {
    push(VAGUE_QUANTITY.exec(prose)?.index)
    push(VERDICT.exec(prose)?.index)
    const w = unexcusedWeatherWords(prose, ctx.grounding)[0]
    if (w) push(prose.toLowerCase().indexOf(w))
  }
  for (const n of numbersIn(prose).filter((x) => !ctx.groundNums.has(x))) push(prose.indexOf(n))
  const venue = namedThingsNotInBrief(sentence, ctx.allowedText)[0]
  if (venue) push(sentence.indexOf(venue))
  const counts = (ctx.type === 'page_copy' ? copyWordCounts : guideWordCounts)(prose, ctx.grounding)[0]
  if (counts) push(prose.toLowerCase().indexOf(counts.toLowerCase()))
  return idx.length ? Math.min(...idx) : -1
}

/** Cuts the clause that holds the flagged word: from the last comma before it to the end, closing with the
 * sentence's own punctuation. Null when there is no such comma or too little would be left. */
export function trimClause(sentence: string, ctx: DetectCtx): string | null {
  const at = firstProblemIndex(sentence, ctx)
  if (at <= 0) return null
  const marker = sentence.match(LEADING_MARKER)?.[0] ?? ''
  const head = sentence.slice(0, at)
  const comma = Math.max(head.lastIndexOf(','), head.lastIndexOf(';'))
  if (comma <= marker.length) return null
  const stem = sentence.slice(0, comma).trimEnd()
  if (wordsOf(stem.replace(LEADING_MARKER, '')) < 4) return null
  const end = /[.!?]["')]*\s*$/.exec(sentence)?.[0].trim() ?? '.'
  const trimmed = `${stem}${end}`
  return sentenceProblems(trimmed, ctx).length ? null : trimmed
}

/** How many sentences or list items the paragraph holding `needle` has, counting only that block. */
function blockSentenceCount(text: string, needle: string): number {
  for (const block of text.split(/\n\s*\n/)) {
    if (block.includes(needle)) return bodySentences(block).filter((s) => !s.heading).length
  }
  return 0
}

/** Deletes one flagged sentence (nothing else), only where the deletion is allowed: a body sentence whose paragraph
 * keeps two or more sentences, a FAQ pair or takeaway when the list stays long enough. Never a heading, never meta
 * text. Null when not allowed. Never rewords. */
export function deleteSentenceOnly(f: RepairFields, o: Offender, limits: RepairLimits): RepairFields | null {
  if (o.field === 'body') {
    if (/^\s*#{1,6}\s/.test(o.text) || blockSentenceCount(f.body, o.text) - 1 < 2) return null
  } else if (o.field === 'faq_q' || o.field === 'faq_a') {
    if (f.faq.length - 1 < limits.faqMin) return null
  } else if (o.field === 'takeaway') {
    if (f.key_takeaways.length - 1 < limits.takeMin) return null
  } else return null
  const next = replaceUnit(f, o, null)
  return next === f ? null : next
}

/** One deterministic repair for one offender, or null if none is allowed. The clause after the flagged word may go;
 * a whole sentence may go only when its paragraph still keeps two or more sentences; a FAQ pair or a takeaway only
 * when the list stays long enough. Meta and share text can only be trimmed. */
export function deterministicFix(f: RepairFields, o: Offender, ctx: DetectCtx, limits: RepairLimits): RepairFields | null {
  if (o.field === 'body' || o.field === 'summary') {
    if (/^\s*#{1,6}\s/.test(o.text)) return null
    const clause = trimClause(o.text, ctx)
    if (clause) {
      const next = replaceUnit(f, { ...o, prefix: '' }, clause)
      if (next !== f) return next
    }
    if (o.field === 'summary') return null
    if (blockSentenceCount(f.body, o.text) - 1 < 2) return null
    const next = replaceUnit(f, o, null)
    return next === f ? null : next
  }
  if (o.field === 'faq_q' || o.field === 'faq_a') {
    if (f.faq.length - 1 < limits.faqMin) return null
    const next = replaceUnit(f, o, null)
    return next === f ? null : next
  }
  if (o.field === 'takeaway') {
    if (f.key_takeaways.length - 1 < limits.takeMin) return null
    const next = replaceUnit(f, o, null)
    return next === f ? null : next
  }
  const clause = trimClause(o.text, ctx)
  if (!clause) return null
  const next = replaceUnit(f, o, clause)
  return next === f ? null : next
}

// ---------------------------------------------------------------------------------------------------
// The repair itself
// ---------------------------------------------------------------------------------------------------

export interface RepairItem {
  type: ContentType
  /** Null for a page not saved yet; the caller attaches the id when it logs the edits. */
  id: string | null
  path: string
  fields: RepairFields
  /** The facts the writer was given: the only place a number may come from. */
  grounding: string
  /** Names allowed besides the grounding (the subject, link labels). */
  names?: string[]
  /** Paths that exist on the site (for the dead-link fixer). */
  allowedPaths: Set<string>
  /** Real pages the "no internal link" fixer may point at. */
  links?: { path: string; label: string }[]
  /** The primary keyword, to steer generated meta text. */
  keyword?: string | null
  limits: RepairLimits
  /** The kind's quality gate over the current fields. */
  gate: (fields: RepairFields) => string[]
  /** Type-specific sentence finder (posts use the post gate's own); defaults to detectOffenders. */
  detect?: (fields: RepairFields, blockers: string[]) => Offender[]
  /** Maps a field's logged text to what is stored (a post's body gets a call-to-action appended on save). */
  storedText?: (field: LogicalField, text: string) => string
  published?: boolean
}

export interface RepairOptions {
  /** Most model calls for this item. Posts 1, everything else 2. */
  maxCalls?: number
  /** Absolute time (Date.now() scale) the caller must be done by; no model call starts with less than MIN_MS_PER_CALL left. */
  deadlineMs?: number
  /** False to run only the plain-code fixers and the deterministic fallback. */
  ai?: boolean
  model?: ModelCall
}

export interface RepairResult {
  fields: RepairFields
  /** The gate's verdict on `fields`. */
  blockers: string[]
  /** HARD blockers that stopped the repair (the fields are then exactly as they came in). */
  hard: string[]
  edits: ContentEdit[]
  calls: number
  /** Why nothing was tried, when that is the case. */
  note: string
}

function logicalOf(field: OffenderField): LogicalField {
  if (field === 'summary' || field === 'body') return 'body'
  if (field === 'faq_q' || field === 'faq_a') return 'faq'
  if (field === 'takeaway') return 'key_takeaways'
  return field
}

/** Numbered list lines ("1. Plan early") become bullets: the guide gate counts list numbers as numbers. */
export function bulletNumberedLists(text: string): string {
  return text.replace(/^([ \t]*)\d{1,2}[.)][ \t]+/gm, '$1- ')
}

export class Tracker {
  reasons = new Map<LogicalField, Set<string>>()
  methods = new Map<LogicalField, Set<EditMethod>>()
  touch(field: LogicalField, method: EditMethod, reason: string) {
    if (!this.reasons.has(field)) this.reasons.set(field, new Set())
    if (!this.methods.has(field)) this.methods.set(field, new Set())
    this.reasons.get(field)!.add(reason)
    this.methods.get(field)!.add(method)
  }
}

const LOGICAL: LogicalField[] = ['title', 'body', 'meta_title', 'meta_description', 'og_title', 'og_description', 'faq', 'key_takeaways']

/** The text of one field as the audit log stores it (a guide's body is its summary followed by the sections). */
export function serializeField(type: ContentType, f: RepairFields, field: LogicalField): string {
  switch (field) {
    case 'body':
      return type === 'guide' ? `${f.summary ?? ''}\n\n${f.body}` : f.body
    case 'faq':
      return JSON.stringify(f.faq)
    case 'key_takeaways':
      return JSON.stringify(f.key_takeaways)
    default:
      return f[field] ?? ''
  }
}

const METHOD_ORDER: EditMethod[] = ['ai', 'generate', 'delete', 'links', 'fixer']

/** The audit rows for what changed between `before` and `after`. One row per changed field. Pure. */
export function buildEdits(item: Pick<RepairItem, 'type' | 'id' | 'path' | 'storedText' | 'published'>, before: RepairFields, after: RepairFields, tracker: Tracker, calls: number): ContentEdit[] {
  const edits: ContentEdit[] = []
  for (const field of LOGICAL) {
    const b = serializeField(item.type, before, field)
    const a = serializeField(item.type, after, field)
    if (a === b) continue
    const methods = tracker.methods.get(field) ?? new Set<EditMethod>(['fixer'])
    const method = METHOD_ORDER.find((m) => methods.has(m)) ?? 'fixer'
    const linksOnly = field === 'body' && methods.size === 1 && methods.has('links')
    const reasons = [...(tracker.reasons.get(field) ?? [])].join('; ').slice(0, 480)
    edits.push({
      content_type: item.type,
      content_id: item.id,
      path: item.path,
      field: linksOnly ? 'links' : field,
      reason: reasons || 'automatic clean-up',
      before: item.storedText ? item.storedText(field, b) : b,
      after: item.storedText ? item.storedText(field, a) : a,
      method,
      published_after: !!item.published,
      cost_usd: 0,
    })
  }
  const per = edits.length ? Math.round(((calls * EST_COST_USD_PER_CALL) / edits.length) * 10000) / 10000 : 0
  return edits.map((e) => ({ ...e, cost_usd: e.method === 'ai' || e.method === 'generate' ? per : 0 }))
}

/** Applies the plain-code fixers that match the blockers. Returns the new fields (the same object when nothing applied). */
function applyFixers(f: RepairFields, blockers: string[], item: RepairItem, t: Tracker): RepairFields {
  const kinds = blockerKinds(blockers)
  let cur = f
  const set = (next: RepairFields, field: LogicalField | LogicalField[], method: EditMethod, reason: string) => {
    if (sameFields(next, cur)) return
    for (const fld of Array.isArray(field) ? field : [field]) t.touch(fld, method, reason)
    cur = next
  }
  if (kinds.has('dashes')) {
    const next = fixAllDashes(cur)
    // Touch only the fields that really change.
    const changed = LOGICAL.filter((fld) => serializeField(item.type, next, fld) !== serializeField(item.type, cur, fld))
    set(next, changed, 'fixer', 'removed a long dash')
  }
  if (kinds.has('length')) {
    const next = clampLengths(cur, item.limits)
    const changed = LOGICAL.filter((fld) => serializeField(item.type, next, fld) !== serializeField(item.type, cur, fld))
    set(next, changed, 'fixer', 'cut meta or share text to its length limit')
  }
  // The guide and page-copy gates count a list number as a number; the post gate ignores list numbering.
  if (kinds.has('numbers') && item.type !== 'post') {
    const next = { ...cur, ...(cur.summary !== undefined ? { summary: bulletNumberedLists(cur.summary) } : {}), body: bulletNumberedLists(cur.body) }
    set(next, 'body', 'fixer', 'numbered list changed to bullets (list numbers count as numbers)')
  }
  if (kinds.has('dead-link')) {
    const next = mapFields(cur, (s) => stripDeadLinks(s, item.allowedPaths))
    const changed = LOGICAL.filter((fld) => serializeField(item.type, next, fld) !== serializeField(item.type, cur, fld))
    set(next, changed, 'fixer', 'removed a link to a page that does not exist (the words stay)')
  }
  if (kinds.has('faq-link')) {
    const next: RepairFields = {
      ...cur,
      meta_title: stripAllLinks(cur.meta_title),
      meta_description: stripAllLinks(cur.meta_description),
      og_title: stripAllLinks(cur.og_title),
      og_description: stripAllLinks(cur.og_description),
      faq: cur.faq.map((p) => ({ q: stripAllLinks(p.q), a: stripAllLinks(p.a) })),
      key_takeaways: cur.key_takeaways.map(stripAllLinks),
    }
    const changed = LOGICAL.filter((fld) => serializeField(item.type, next, fld) !== serializeField(item.type, cur, fld))
    set(next, changed, 'fixer', 'removed a link from FAQ, takeaways or meta text (the words stay)')
  }
  if (kinds.has('too-many-links') && item.limits.maxBodyLinks) {
    set({ ...cur, body: keepFirstLinks(cur.body, item.limits.maxBodyLinks) }, 'body', 'fixer', `kept the first ${item.limits.maxBodyLinks} links`)
  }
  // A missing share title or description borrows the page's own meta text (words already on the page).
  if (!cur.og_title.trim() && cur.meta_title.trim() && kinds.has('missing-extras')) set({ ...cur, og_title: cutAtWord(cur.meta_title, item.limits.ogTitleMax) }, 'og_title', 'fixer', 'share title copied from the meta title')
  if (!cur.og_description.trim() && cur.meta_description.trim() && kinds.has('missing-extras')) set({ ...cur, og_description: cutAtWord(cur.meta_description, item.limits.ogDescMax) }, 'og_description', 'fixer', 'share description copied from the meta description')
  if (kinds.has('missing-extras')) {
    if (cur.faq.length > item.limits.faqMax) set({ ...cur, faq: cur.faq.slice(0, item.limits.faqMax) }, 'faq', 'delete', 'dropped the extra FAQ questions')
    if (cur.key_takeaways.length > item.limits.takeMax) set({ ...cur, key_takeaways: cur.key_takeaways.slice(0, item.limits.takeMax) }, 'key_takeaways', 'delete', 'dropped the extra takeaways')
  }
  if (kinds.has('no-link') && item.links?.length) {
    const added = addInternalLink(cur.body, item.links.filter((l) => l.path === '/#contact' || item.allowedPaths.has(l.path.replace(/#.*$/, '') || '/') || l.path === '/'))
    if (added) set({ ...cur, body: added }, 'body', 'links', 'added a link to a real page')
  }
  return cur
}

/** Repairs one page. See the file comment for the rules. Never throws; a failing model call just means fewer edits. */
export async function repairContent(item: RepairItem, opts: RepairOptions = {}): Promise<RepairResult> {
  const original = cloneFields(item.fields)
  const tracker = new Tracker()
  const maxCalls = opts.maxCalls ?? 2
  const model = opts.model ?? callModelText
  const aiAllowed = opts.ai !== false && (opts.model !== undefined || isAiConfigured())
  let calls = 0
  const ctx = makeDetectCtx(item.type, item.grounding, item.names)
  const detect = (f: RepairFields, blockers: string[]) => (item.detect ? item.detect(f, blockers) : detectOffenders(f, ctx, blockers))

  const canCall = () => {
    if (!aiAllowed || calls >= maxCalls) return false
    return opts.deadlineMs === undefined || opts.deadlineMs - Date.now() >= MIN_MS_PER_CALL
  }
  const timeout = () => (opts.deadlineMs === undefined ? CALL_TIMEOUT_MS : Math.max(5_000, Math.min(CALL_TIMEOUT_MS, opts.deadlineMs - Date.now() - 3_000)))

  const untouched = (blockers: string[], hard: string[], note: string): RepairResult => ({ fields: original, blockers, hard, edits: [], calls, note })

  let blockers = item.gate(original)
  if (blockers.length === 0) return { fields: original, blockers: [], hard: [], edits: [], calls: 0, note: 'already clean' }

  // A link to another website loses the link and keeps its words (the gates also flag its address as "web address in
  // text", so this runs before the HARD check; a bare address typed into the text stays HARD).
  let cur = original
  if (blockers.some((b) => /^(external or email link|link that is not an internal path|web address in text)/.test(b))) {
    const stripped = mapFields(original, stripExternalLinks)
    if (!sameFields(stripped, original)) {
      for (const fld of LOGICAL) if (serializeField(item.type, stripped, fld) !== serializeField(item.type, original, fld)) tracker.touch(fld, 'fixer', 'removed a link to another website (the words stay)')
      cur = stripped
      blockers = item.gate(cur)
      if (blockers.length === 0) return { fields: cur, blockers: [], hard: [], edits: buildEdits(item, original, cur, tracker, 0), calls: 0, note: 'repaired' }
    }
  }
  const first = classifyBlockers(blockers)
  if (first.hard.length) return untouched(blockers, first.hard, 'a HARD blocker needs a person')

  // A flagged sentence about a named person is a person's call. A flagged sentence holding a price or an exact date
  // that the facts do not give is DELETED (never reworded, never added to), but only where its paragraph keeps two or
  // more sentences; where it cannot be deleted it is HARD. A price or date the facts do give is left to a person too.
  {
    const gcx = ctx.groundNums
    const sensitiveNow = () => detect(cur, blockers).filter((o) => isPriceOrDate(o.text) || isNamedPersonLike(o.text))
    const needsPerson = (o: Offender) => {
      const why = `needs a person: "${o.text.replace(LEADING_MARKER, '').slice(0, 80)}" holds a price, a date or a named person`
      return untouched([...blockers, why], [why], 'a price, date or named person is in the flagged text')
    }
    for (let guard = 0; guard < MAX_REPAIR_SENTENCES; guard++) {
      const found = sensitiveNow()
      if (found.length === 0) break
      const person = found.find((o) => isNamedPersonLike(o.text))
      if (person) return needsPerson(person)
      const o = found[0]
      const ungrounded = numbersIn(proseOf(o.text)).some((n) => !gcx.has(n))
      const next = ungrounded ? deleteSentenceOnly(cur, o, item.limits) : null
      if (!next) return needsPerson(o)
      tracker.touch(logicalOf(o.field), 'delete', 'ungrounded price or date')
      cur = next
    }
    if (sensitiveNow().length) return needsPerson(sensitiveNow()[0])
    blockers = item.gate(cur)
    if (blockers.length === 0) return { fields: cur, blockers: [], hard: [], edits: buildEdits(item, original, cur, tracker, 0), calls: 0, note: 'repaired' }
  }

  const finish = (): RepairResult => {
    const finalBlockers = item.gate(cur)
    const finalClass = classifyBlockers(finalBlockers)
    // A repair must never turn a fixable page into one with a HARD problem (for example by deleting the only sentence that named the subject).
    if (finalClass.hard.length && !first.hard.length) return untouched(blockers, finalClass.hard, 'the repair would have caused a HARD blocker, so it was undone')
    return { fields: cur, blockers: finalBlockers, hard: finalClass.hard, edits: buildEdits(item, original, cur, tracker, calls), calls, note: sameFields(cur, original) ? 'nothing could be repaired' : 'repaired' }
  }

  // 1. Plain-code fixers.
  cur = applyFixers(cur, blockers, item, tracker)
  blockers = item.gate(cur)
  if (blockers.length === 0) return finish()

  // 2. Generate what is missing, from the page's own text.
  const kindsNow = blockerKinds(blockers)
  if (kindsNow.has('missing-extras') && canCall()) {
    const keys = missingExtras(cur, item.limits)
    if (keys.length) {
      calls++
      const bodyCtx = makeDetectCtx(item.type, plainForPrompt(cur), [...(item.names ?? []), item.fields.title ?? '', item.keyword ?? ''])
      const got = await generateExtras(model, cur, keys, item.limits, item.keyword ?? null, bodyCtx, timeout())
      const gotKeys = Object.keys(got) as GenKey[]
      if (gotKeys.length) {
        const next: RepairFields = { ...cur, ...got }
        // Keep it only if it did not bring a HARD blocker with it.
        if (!classifyBlockers(item.gate(next)).hard.length) {
          for (const k of gotKeys) tracker.touch(k, 'generate', `${k === 'faq' ? 'FAQ' : k === 'key_takeaways' ? 'key takeaways' : k.replace('_', ' ')} was missing, written from the page text only`)
          cur = next
          cur = applyFixers(cur, item.gate(cur), item, tracker)
        }
      }
      blockers = item.gate(cur)
      if (blockers.length === 0) return finish()
    }
  }

  // 3. One model call that rewords or deletes the offending sentences.
  let offenders = classifyBlockers(blockers).repairable.length ? detect(cur, blockers) : []
  if (offenders.length && offenders.length <= MAX_REPAIR_SENTENCES && canCall()) {
    calls++
    const list = offenders.map((o, i) => `${i}. [${o.why}] ${o.text.slice(o.prefix.length)}`).join('\n')
    const prompt = `Each numbered text below is a sentence (or a short field) from a travel agency web page. Each has a problem named in the square brackets. Fix every one of them in one of two ways: (a) rewrite it so it no longer has the problem, or (b) delete it, when it cannot be fixed by rewording.\n\nRules: never add a fact, name, number, date, price, count, claim or link. The rewrite must not be longer than the original. Use only words that already appear in the sentence, plus plain joining words (a, the, and, with, well known, many, often); where a flagged word or number goes, drop it or leave the idea out. If that leaves nothing sensible, delete the sentence. Keep markdown formatting. Never use the long dash character.\n\n${list}\n\nReturn ONLY minified JSON: {"rewrites":[{"id":0,"text":"..."},{"id":1,"delete":true}]}`
    const answer = await model(prompt, 4000, timeout())
    const parsed = answer ? parseModelJson<{ rewrites?: { id?: number; text?: unknown; delete?: unknown }[] }>(answer) : null
    const rewrites = parsed && Array.isArray(parsed.rewrites) ? parsed.rewrites : []
    const deletions: Offender[] = []
    for (const r of rewrites) {
      const o = typeof r.id === 'number' ? offenders[r.id] : undefined
      if (!o) continue
      if (r.delete === true) {
        deletions.push(o)
        continue
      }
      if (typeof r.text !== 'string') continue
      const text = removeDashes(o.prefix ? r.text.trim().replace(LEADING_MARKER, '') : r.text.trim()).trim()
      if (validateRewrite(o.text, text, ctx)) continue
      const next = replaceUnit(cur, o, text)
      if (next !== cur) {
        tracker.touch(logicalOf(o.field), 'ai', o.why.split(';')[0].slice(0, 120))
        cur = next
      }
    }
    // Deletions the model asked for, only where the deterministic rules allow them (later items first, so indexes hold).
    for (const o of deletions.sort((a, b) => (b.index ?? 0) - (a.index ?? 0))) {
      const next = deterministicFix(cur, o, ctx, item.limits)
      if (next) {
        tracker.touch(logicalOf(o.field), 'ai', `the model removed it: ${o.why.split(';')[0].slice(0, 100)}`)
        cur = next
      }
    }
    cur = applyFixers(cur, item.gate(cur), item, tracker)
    blockers = item.gate(cur)
    if (blockers.length === 0) return finish()
  }

  // 4. Deterministic fallback: delete the sentence (or the clause after the flagged word) where the paragraph keeps 2+ sentences. Gate again.
  for (let pass = 0; pass < MAX_REPAIR_SENTENCES && classifyBlockers(blockers).repairable.length; pass++) {
    offenders = detect(cur, blockers)
    let progressed = false
    for (const o of offenders) {
      const next = deterministicFix(cur, o, ctx, item.limits)
      if (!next) continue
      tracker.touch(logicalOf(o.field), 'delete', `removed: ${o.why.split(';')[0].slice(0, 120)}`)
      cur = next
      progressed = true
      break // offsets and indexes moved: look again
    }
    if (!progressed) break
    cur = applyFixers(cur, item.gate(cur), item, tracker)
    blockers = item.gate(cur)
  }
  return finish()
}
