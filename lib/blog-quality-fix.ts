import { applyRewrites, numbersIn, type ComposedPost, type Offender } from '@/lib/blog-composer'
import { appendStyledCta, CTA_STYLES } from '@/lib/content-styles'
import {
  MAX_FIRST_SENTENCE_WORDS,
  MIN_INTERNAL_LINKS,
  QUICK_ANSWER_MAX_WORDS,
  QUICK_ANSWER_MIN_WORDS,
  fitQuickAnswer,
  metaDuplicates,
  quickAnswerLengthIssue,
  quickAnswerParts,
  bannedPhraseHits,
  faqMetaHits,
  firstSentenceIssue,
  hasContactOrTripLink,
  hasQuickAnswer,
  internalHrefs,
  QUALITY_PREFIXES,
  titleYearIssues,
  ungroundedSuperlatives,
  type QualityCtx,
} from '@/lib/blog-quality'

// The repair side of the blog quality bar (loop-blog-quality). PURE. Used by the daily refresh of published posts
// (lib/blog-reheal.ts): plain-code fixes first (free, never change a fact), then the exact sentences that code cannot mend are
// handed to ONE bounded model pass, and the result is kept only if the gates say it is better.

export type FixField = 'title' | 'body' | 'faq' | 'key_takeaways' | 'meta_title' | 'meta_description' | 'og_title' | 'og_description'

export interface FixLink {
  path: string
  label: string
}

export interface FixCtx extends QualityCtx {
  /** The trip the post is about, for the closing call to action. */
  pkg?: { name: string; slug: string } | null
  /** Real pages the post may be given as related reading, best first (same-trip posts, the destination page, guides, other posts). */
  related?: FixLink[]
}

const capital = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s)

// ---------------------------------------------------------------------------------------------------
// Plain-code fixes
// ---------------------------------------------------------------------------------------------------

const keepCase = (match: string, replacement: string): string => (/^[A-Z]/.test(match) ? capital(replacement) : replacement)

const SWAPS: [RegExp, string][] = [
  [/\bthe ultimate\s+/gi, 'the '],
  [/\bultimate\s+/gi, ''],
  [/\bperfectly\b/gi, 'well'],
  [/\bperfect for\b/gi, 'well suited to'],
  [/\bthe perfect\b/gi, 'a good'],
  [/\bperfect\b/gi, 'good'],
  [/\bonce[\s-]+in[\s-]+a[\s-]+lifetime\b/gi, 'memorable'],
  [/\bplaybook\b/gi, 'plan'],
]

/** Removes the template labels and swaps the hype words, in one text. Never touches a link target. */
export function scrubFiller(text: string): string {
  let out = text
  // Labels: "The takeaway: X" and "**Why it matters:** X" keep X; "Before moving on, check" becomes "Check".
  out = out.replace(/(\*{0,2})(?:the takeaway|why it matters)\s*:(\*{0,2})\s*(\S)/gi, (_m, _a, _b, next: string) => capital(next))
  out = out.replace(/before moving on,?\s+(\S)/gi, (_m, next: string) => capital(next))
  // Hype words, outside the "(...)" part of a markdown link.
  out = out
    .split(/(\]\([^)]*\))/)
    .map((part) => (part.startsWith('](') ? part : SWAPS.reduce((acc, [re, rep]) => acc.replace(re, (m) => keepCase(m, rep)), part)))
    .join('')
  return out
}

/** Drops the stock closing paragraph ("The one thing worth settling next is...", "Our team is happy to help"), when it is short and has no link. */
export function dropTemplateCloser(body: string): string {
  const paras = body.split(/\n{2,}/)
  const kept = paras.filter((p) => !(/the one thing worth settling next|our team is happy to help/i.test(p) && !/\]\(/.test(p) && !/^#{1,6}\s/.test(p.trim()) && p.split(/\s+/).length < 80))
  return kept.length === paras.length || kept.length === 0 ? body : kept.join('\n\n')
}

/** Removes the sentences that make a place claim the facts do not state (body text: plain paragraphs and bullets). */
export function dropUnverifiedSentences(body: string, groundingText: string): string {
  const out: string[] = []
  for (const line of body.split('\n')) {
    if (/^#{1,6}\s/.test(line) || !line.trim()) {
      out.push(line)
      continue
    }
    if (ungroundedSuperlatives(line, groundingText).length === 0) {
      out.push(line)
      continue
    }
    const marker = line.match(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/)?.[0] ?? ''
    const sentences = line.slice(marker.length).split(/(?<=[.!?])\s+/)
    const keep = sentences.filter((s) => ungroundedSuperlatives(s, groundingText).length === 0)
    if (keep.length === 0) continue
    out.push(marker + keep.join(' '))
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n')
}

const META_LEAD = /^(?:the|this|that|our)\s+(?:text|post|article|blog(?:\s+post)?|piece|passage|content|page)\s+(?:also\s+)?(?:suggests?|says?|states?|mentions?|notes?|indicates?|implies|recommends?|highlights?)\s+(?:that\s+)?/i

/** "The text suggests thinking in terms of views." becomes "Thinking in terms of views." Only a sentence that STARTS with the lead is mended. */
export function stripFaqMeta(answer: string): string {
  return answer
    .split(/(?<=[.!?])\s+/)
    .map((s) => (META_LEAD.test(s) ? capital(s.replace(META_LEAD, '')) : s))
    .join(' ')
}

const yearsOf = (t: string): number[] => [...t.matchAll(/\b(20\d{2})\b/g)].map((m) => Number(m[1]))

/** Mends a year in a title or meta text: the trip's year when the trip travels in one year, otherwise the year is taken out. The slug never changes. */
export function fixYearIn(text: string, ctx: QualityCtx): string {
  if (!text || titleYearIssues(text, ctx.now, ctx.tripDates).length === 0) return text
  const from = /(\d{4})/.exec(ctx.tripDates?.from ?? '')?.[1]
  const to = /(\d{4})/.exec(ctx.tripDates?.to ?? '')?.[1] ?? from
  let out = text
  for (const y of new Set(yearsOf(text))) {
    if (titleYearIssues(String(y), ctx.now, ctx.tripDates).length === 0) continue
    out = from && from === to ? out.replace(new RegExp(`\\b${y}\\b`, 'g'), from) : out.replace(new RegExp(`\\s*[(,:]?\\s*(?:in\\s+)?\\b${y}\\b\\)?`, 'g'), '')
  }
  return out.replace(/\s+([,.;:!?])/g, '$1').replace(/[\s,:;-]+$/, '').replace(/\s{2,}/g, ' ').trim() || text
}

const LONG_DASH = new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`)
const LONG_DASH_G = new RegExp(LONG_DASH.source, 'g')

const fieldSafe = (s: string): string => s.replace(/[[\]()]/g, '').replace(LONG_DASH_G, '-').replace(/\s+/g, ' ').trim()

/** Adds a "Related reading" paragraph with up to `need` real links, before the closing rule when there is one. Idempotent: nothing is added for a link the body has. */
export function addRelatedLine(body: string, links: FixLink[], need: number): string {
  const have = new Set(internalHrefs(body))
  const picked = links.filter((l) => l.path && !have.has(l.path.replace(/\/+$/, '') || '/') && fieldSafe(l.label).length >= 2).slice(0, Math.max(0, need))
  if (picked.length === 0) return body
  const line = `Related reading: ${picked.map((l) => `[${fieldSafe(l.label)}](${l.path})`).join(', ')}.`
  const at = body.search(/\n\s*---\s*\n/)
  if (at === -1) return `${body.trimEnd()}\n\n${line}`
  return `${body.slice(0, at).trimEnd()}\n\n${line}${body.slice(at)}`
}

/** Adds a "**Quick answer:**" paragraph after the opening paragraph, written from a sentence the post already holds (its first key takeaway),
 * so nothing new is claimed. Unchanged when the body has one, or has no takeaway to use. Pure. */
export function insertQuickAnswer(body: string, takeaways: string[]): string {
  if (hasQuickAnswer(body)) return body
  const line = (takeaways.find((t) => t && t.trim().length >= 20) ?? '').trim().replace(/[\s.]+$/, '')
  if (!line) return body
  const paras = body.split(/\n{2,}/)
  const at = paras.findIndex((p) => p.trim() && !/^#{1,6}\s/.test(p.trim()) && !/^[-*_]{3,}$/.test(p.trim()))
  if (at === -1) return body
  paras.splice(at + 1, 0, `**Quick answer:** ${capital(line)}.`)
  return paras.join('\n\n')
}

const hashOf = (s: string): number => {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return h
}

export interface MechanicalResult {
  post: ComposedPost
  /** One plain-English line per kind of change made, for the audit log. */
  reasons: string[]
}

/** Every fix code can make without a model: filler words and labels, the stock closer, ungrounded place claims, FAQ meta-language, a stale
 * or conflicting year, a missing contact or trip link, and too few internal links. Never adds or changes a fact. Pure. */
export function mechanicalFix(post: ComposedPost, ctx: FixCtx): MechanicalResult {
  const reasons: string[] = []
  const grounding = ctx.groundingText ?? ''
  let next: ComposedPost = { ...post, faq: post.faq.map((f) => ({ ...f })), key_takeaways: [...post.key_takeaways] }
  const note = (r: string) => {
    if (!reasons.includes(r)) reasons.push(r)
  }

  // Filler words and labels everywhere except the title (a title is a person's call, see blog-reheal).
  const scrub = (t: string) => {
    const s = scrubFiller(t)
    if (s !== t) note('removed filler phrases and template labels')
    return s
  }
  next.body = scrub(next.body)
  next.seo_title = scrub(next.seo_title)
  next.seo_description = scrub(next.seo_description)
  next.og_title = scrub(next.og_title ?? '')
  next.og_description = scrub(next.og_description ?? '')
  next.faq = next.faq.map((f) => ({ q: scrub(f.q), a: scrub(f.a) }))
  next.key_takeaways = next.key_takeaways.map(scrub)

  const noCloser = dropTemplateCloser(next.body)
  if (noCloser !== next.body) {
    next.body = noCloser
    note('removed the stock closing paragraph')
  }

  const noClaims = dropUnverifiedSentences(next.body, grounding)
  if (noClaims !== next.body) {
    next.body = noClaims
    note('removed a place claim (only, first, best, most) that the facts do not state')
  }
  next.faq = next.faq.map((f) => {
    if (ungroundedSuperlatives(f.a, grounding).length === 0) return f
    const keep = f.a.split(/(?<=[.!?])\s+/).filter((s) => ungroundedSuperlatives(s, grounding).length === 0)
    if (keep.length === 0) return f
    note('removed a place claim (only, first, best, most) that the facts do not state')
    return { q: f.q, a: keep.join(' ') }
  })

  next.faq = next.faq.map((f) => {
    if (faqMetaHits([f]).length === 0) return f
    const a = stripFaqMeta(f.a)
    if (a !== f.a) note('rewrote an FAQ answer that talked about the text itself')
    return { q: f.q, a }
  })

  const t = fixYearIn(next.title, ctx)
  if (t !== next.title) {
    next.title = t
    note('fixed a year in the title')
  }
  for (const k of ['seo_title', 'og_title'] as const) {
    const y = fixYearIn(next[k] ?? '', ctx)
    if (y !== next[k]) next[k] = y
  }

  const withQuick = insertQuickAnswer(next.body, next.key_takeaways)
  if (withQuick !== next.body) {
    next.body = withQuick
    note('added a Quick answer line from the post\'s own first takeaway')
  }
  const fitted = fitQuickAnswer(next.body, next.key_takeaways)
  if (fitted !== next.body) {
    next.body = fitted
    note('brought the Quick answer to a quotable length using the post\'s own sentences')
  }

  // Links: a contact or trip link first, then related reading up to the minimum.
  if (!hasContactOrTripLink(next.body)) {
    const style = CTA_STYLES[hashOf(next.slug || next.title) % CTA_STYLES.length]
    next.body = appendStyledCta(next.body, style.id, ctx.pkg ?? null)
    note('added a contact link')
  }
  const missing = MIN_INTERNAL_LINKS - internalHrefs(next.body).length
  if (missing > 0 && ctx.related?.length) {
    const withRelated = addRelatedLine(next.body, ctx.related, missing)
    if (withRelated !== next.body) {
      next.body = withRelated
      note('added related reading links')
    }
  }
  return { post: next, reasons }
}

// ---------------------------------------------------------------------------------------------------
// The one bounded model pass: the exact sentences code could not mend
// ---------------------------------------------------------------------------------------------------

const rawFirstSentence = (body: string): string | null => {
  const line = body.split('\n').find((l) => l.trim() && !/^#{1,6}\s/.test(l.trim()) && !/^[-*_]{3,}$/.test(l.trim()))
  if (!line) return null
  const m = /^(.+?[.!?])(?=\s|$)/.exec(line.trim())
  return (m ? m[1] : line.trim()).trim()
}

export const MAX_QUALITY_OFFENDERS = 8

/** The sentences and answers that still fail a quality gate after the plain fixes, shaped like the writer's repair offenders. Pure. */
export function qualityOffenders(post: ComposedPost, ctx: QualityCtx): Offender[] {
  const out: Offender[] = []
  const grounding = ctx.groundingText ?? ''
  const issue = firstSentenceIssue(post.body, post.primary_keyword)
  const first = rawFirstSentence(post.body)
  if (issue && first && post.body.includes(first)) {
    out.push({ field: 'body', text: first, why: `${issue}: rewrite it as ONE plain sentence of at most ${MAX_FIRST_SENTENCE_WORDS} words that directly answers what a reader searching "${post.primary_keyword}" wants to know, not starting with Picture, Imagine or You`, prefix: '' })
  }
  // A Quick answer the plain fix could not bring into range: one rewrite of that paragraph, label kept.
  const qaIssue = quickAnswerLengthIssue(post.body)
  const qa = qaIssue ? quickAnswerParts(post.body) : null
  if (qaIssue && qa && post.body.includes(qa.paragraph)) {
    out.push({ field: 'body', text: qa.paragraph, why: `${qaIssue}: rewrite it as ONE or TWO plain sentences of ${QUICK_ANSWER_MIN_WORDS} to ${QUICK_ANSWER_MAX_WORDS} words in total, starting with the bold label ${qa.label}, using only what the post already says`, prefix: '' })
  }
  // Search text that repeats another page: rewrite just that text, say something different.
  if (ctx.otherMeta?.length) {
    const dup = metaDuplicates(post, ctx.otherMeta)
    if (dup.title && post.seo_title) out.push({ field: 'seo_title', text: post.seo_title, why: 'this search title repeats another page\'s; reword it so it is different, keeping the topic and under 60 characters', prefix: '' })
    if (dup.description && post.seo_description) out.push({ field: 'seo_description', text: post.seo_description, why: 'this search description repeats another page\'s; reword it so it is different, keeping the topic and under 155 characters', prefix: '' })
  }
  for (const line of post.body.split('\n')) {
    if (/^#{1,6}\s/.test(line)) continue
    for (const s of line.split(/(?<=[.!?])\s+/)) {
      if (out.some((o) => o.text === s) || !s.trim()) continue
      const banned = bannedPhraseHits(s)
      const claims = ungroundedSuperlatives(s, grounding)
      if (banned.length || claims.length) {
        out.push({ field: 'body', text: s, why: [banned.length ? `remove or reword the filler (${banned.join(', ')})` : '', claims.length ? 'remove the claim that something is the only, first, best or most of its kind' : ''].filter(Boolean).join('; '), prefix: s.match(/^\s*(?:[-*]\s+|\d+[.)]\s+)/)?.[0] ?? '' })
      }
    }
  }
  post.faq.forEach((f, i) => {
    if (faqMetaHits([f]).length || bannedPhraseHits(f.a).length || ungroundedSuperlatives(f.a, grounding).length) {
      out.push({ field: 'faq_a', index: i, text: f.a, why: 'answer the question directly as the travel agency would: no mention of "the text", "the post" or "the article", no filler, no claim that something is the only, first or best of its kind', prefix: '' })
    }
  })
  post.key_takeaways.forEach((k, i) => {
    if (bannedPhraseHits(k).length || ungroundedSuperlatives(k, grounding).length) out.push({ field: 'takeaway', index: i, text: k, why: 'remove the filler or the only, first, best or most claim', prefix: '' })
  })
  return out.slice(0, MAX_QUALITY_OFFENDERS)
}

export function qualityRewritePrompt(offenders: Offender[]): string {
  const list = offenders.map((o, i) => `${i}. [${o.why}] ${o.text.slice(o.prefix.length)}`).join('\n')
  return `Rewrite each numbered text below so it no longer has the problem named in the square brackets. Keep every fact, the meaning and the tone. Do not add any number, date, price, name, claim or link. Write plain sentences, no markdown links. Never use the long dash character. Never use the words perfect, ultimate, decoded or playbook.\n\n${list}\n\nReturn ONLY minified JSON with the rewritten text for every number: {"rewrites":[{"id":0,"text":"..."}]}`
}

/** Is a model rewrite safe to use? It must be plain text, add no number or link, stay about the same length, and not repeat the problem. Pure. */
export function acceptableRewrite(original: string, rewrite: string): boolean {
  const text = rewrite.trim()
  if (!text || /\]\(/.test(text) || LONG_DASH.test(text)) return false
  const had = new Set(numbersIn(original))
  if (numbersIn(text).some((n) => !had.has(n))) return false
  const words = (s: string) => s.split(/\s+/).filter(Boolean).length
  if (words(text) > Math.ceil(words(original) * 1.4) + 8) return false
  if (bannedPhraseHits(text).length || faqMetaHits([{ q: '', a: text }]).length) return false
  return true
}

/** Applies the usable rewrites. A rewrite that fails acceptableRewrite is skipped (the original stays). Pure. */
export function applyQualityRewrites(post: ComposedPost, offenders: Offender[], rewrites: { id: number; text: string }[]): ComposedPost {
  const usable = rewrites.filter((r) => r && Number.isInteger(r.id) && typeof r.text === 'string' && offenders[r.id] && acceptableRewrite(offenders[r.id].text, r.text))
  return applyRewrites(post, offenders, usable)
}

/** The kind of a gate message, so "too few internal links (1, ...)" and "(2, ...)" count as the same blocker. */
export function blockerKind(b: string): string {
  // Going from "no Quick answer" to "a Quick answer that is still a little short" is progress, not a new kind of problem.
  if (b.startsWith('Quick answer length')) return 'no Quick answer line'
  return QUALITY_PREFIXES.find((p) => b.startsWith(p)) ?? b.replace(/\s*\(.*$/, '').slice(0, 40)
}

/** True when `after` has fewer blockers than `before` and no kind of blocker that `before` did not already have. Pure. */
export function improves(before: string[], after: string[]): boolean {
  const kinds = new Set(before.map(blockerKind))
  return after.length < before.length && after.every((b) => kinds.has(blockerKind(b)))
}
