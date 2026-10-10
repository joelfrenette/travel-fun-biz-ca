// SEO score for one published page (growth loop WP10). PURE: no database, no AI, no network, so it can be tested
// with a plain script and run over every page for free. The daily heal-content step (lib/content-heal-run.ts)
// scores every published post, guide and page copy with this, stores the number, and fixes the cheap reasons.
//
// The score is earned points over possible points (a check that does not apply to a kind of page, for example
// headings on a compare intro, is left out of both), so a compare page is not punished for having no H2s.
// Each reason is plain English and says what to change. `failed` carries the check ids for the heal step.

export type SeoCheckId =
  | 'title'
  | 'title-keyword'
  | 'meta-description'
  | 'og'
  | 'h1'
  | 'keyword-early'
  | 'h2-count'
  | 'word-count'
  | 'faq'
  | 'takeaways'
  | 'internal-link'
  | 'dead-links'
  | 'image-alt'
  | 'jsonld'
  | 'dashes'
  | 'readability'

/** Which cheap repair can lift a failed check, or null when only a person (or a new article) can. */
export type SeoFix = 'meta' | 'og' | 'faq' | 'takeaways' | 'links' | 'dashes' | null

export const SEO_FIX: Record<SeoCheckId, SeoFix> = {
  title: 'meta',
  'title-keyword': null,
  'meta-description': 'meta',
  og: 'og',
  h1: null,
  'keyword-early': null,
  'h2-count': null,
  'word-count': null,
  faq: 'faq',
  takeaways: 'takeaways',
  'internal-link': 'links',
  'dead-links': 'links',
  'image-alt': null,
  jsonld: 'faq',
  dashes: 'dashes',
  readability: null,
}

const WEIGHT: Record<SeoCheckId, number> = {
  title: 6,
  'title-keyword': 6,
  'meta-description': 8,
  og: 6,
  h1: 4,
  'keyword-early': 8,
  'h2-count': 6,
  'word-count': 10,
  faq: 8,
  takeaways: 6,
  'internal-link': 6,
  'dead-links': 6,
  'image-alt': 6,
  jsonld: 8,
  dashes: 4,
  readability: 6,
}

export const SEO_PASS_SCORE = 70

export interface SeoInput {
  /** The title Google would show: the meta title when there is one, else the page title. */
  title: string
  metaDescription: string
  ogTitle: string
  ogDescription: string
  /** Markdown of the page text (for a guide: the opening summary followed by the sections). */
  body: string
  faq: { q: string; a: string }[]
  takeaways: string[]
  primaryKeyword: string | null
  /** The word count this kind of page aims for. */
  targetWords: { min: number; max: number }
  /** Whether the page has a picture with alt text. Ignored when `imageApplies` is false. */
  hasImageAlt: boolean
  imageApplies?: boolean
  /** Internal link paths found in the page text. Leave out to read them from the body. */
  internalLinks?: string[]
  /** Paths that exist on the site right now (so a link to a missing page is spotted). */
  existingPaths: Iterable<string>
  /** schema.org types the page would emit today. */
  jsonLdTypes: string[]
  /** The types a good page of this kind emits. Default Article, FAQPage, BreadcrumbList. */
  jsonLdExpected?: string[]
  /** True when the page template draws the H1 from the title (all of ours do). A body H1 would make two. */
  h1FromTemplate?: boolean
  /** False for the compare and best-time intros, which have no headings by design. */
  expectH2?: boolean
  /** Allowed title length. Default 30 to 60. Page copy titles are shorter (the site name is added). */
  titleRange?: [number, number]
}

export interface SeoResult {
  score: number
  reasons: string[]
  failed: SeoCheckId[]
  earned: number
  possible: number
}

// ---------------------------------------------------------------------------------------------------
// Small pure helpers (also used by the heal step and the offline check)
// ---------------------------------------------------------------------------------------------------

const EM = String.fromCharCode(0x2014)
const EN = String.fromCharCode(0x2013)

export function hasDash(text: string): boolean {
  return text.includes(EM) || text.includes(EN) || /\s--\s/.test(text)
}

/** Internal link paths in markdown, normalised (no query, hash or trailing slash; "/" for the home page or "/#contact"). */
export function internalLinkPathsOf(markdown: string): string[] {
  const out: string[] = []
  for (const m of markdown.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const href = m[1]
    if (!href.startsWith('/')) continue
    const path = href.split('#')[0].split('?')[0]
    out.push(path === '' ? '/' : path.length > 1 ? path.replace(/\/+$/, '') : path)
  }
  return out
}

/** Markdown reduced to plain words: link syntax becomes its anchor text, headings and list markers go. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s*#{1,6}\s+.*$/gm, ' ')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '')
    .replace(/[*_`>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function wordCount(markdown: string): number {
  return markdown.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length
}

/** Average words per sentence over the prose (headings and list markers left out). */
export function averageSentenceWords(markdown: string): number {
  const sentences = plainText(markdown).split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => /[\p{L}]/u.test(s))
  if (sentences.length === 0) return 0
  const words = sentences.reduce((n, s) => n + s.split(/\s+/).filter(Boolean).length, 0)
  return words / sentences.length
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

/** True when every meaningful word of the keyword appears in the text (so "santorini travel guide" matches
 * "A travel guide to Santorini"). A one-word keyword needs that word. */
export function containsKeyword(text: string, keyword: string): boolean {
  const k = norm(keyword).split(' ').filter(Boolean)
  if (k.length === 0) return false
  const hay = ` ${norm(text)} `
  const phrase = ` ${k.join(' ')} `
  if (hay.includes(phrase)) return true
  return k.every((w) => hay.includes(` ${w} `) || (w.length > 3 && hay.includes(` ${w}s `)))
}

function headingsOf(markdown: string): { level: number; text: string }[] {
  const out: { level: number; text: string }[] = []
  for (const line of markdown.split('\n')) {
    const m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
    if (m) out.push({ level: m[1].length, text: m[2].replace(/[*_`]/g, '') })
  }
  return out
}

const pluralize = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

// ---------------------------------------------------------------------------------------------------
// The score
// ---------------------------------------------------------------------------------------------------

export function seoScore(input: SeoInput): SeoResult {
  const results: { id: SeoCheckId; earned: number; reason?: string; applies: boolean }[] = []
  const add = (id: SeoCheckId, fraction: number, reason?: string, applies = true) => results.push({ id, earned: applies ? WEIGHT[id] * Math.max(0, Math.min(1, fraction)) : 0, reason: fraction >= 1 ? undefined : reason, applies })

  const [titleMin, titleMax] = input.titleRange ?? [30, 60]
  const title = input.title.trim()
  const keyword = (input.primaryKeyword ?? '').trim()
  const body = input.body ?? ''
  const headings = headingsOf(body)
  const h2s = headings.filter((h) => h.level === 2)

  // Title
  if (!title) add('title', 0, 'There is no title. Write a title between 30 and 60 characters.')
  else if (title.length < titleMin || title.length > titleMax) add('title', 0.5, `The title is ${title.length} characters; aim for ${titleMin} to ${titleMax}.`)
  else add('title', 1)

  // Primary keyword in the title
  if (!keyword) add('title-keyword', 0, 'No primary keyword is set, so the title cannot be checked against it.')
  else if (!containsKeyword(title, keyword)) add('title-keyword', 0, `The title does not contain the primary keyword "${keyword}".`)
  else add('title-keyword', 1)

  // Meta description 70 to 155
  const meta = (input.metaDescription ?? '').trim()
  if (!meta) add('meta-description', 0, 'There is no meta description. Write one between 70 and 155 characters.')
  else if (meta.length < 70 || meta.length > 155) add('meta-description', 0.5, `The meta description is ${meta.length} characters; aim for 70 to 155.`)
  else add('meta-description', 1)

  // Social share text
  const ogHas = (input.ogTitle ?? '').trim() ? 1 : 0
  const ogDesc = (input.ogDescription ?? '').trim() ? 1 : 0
  if (ogHas + ogDesc < 2) add('og', (ogHas + ogDesc) / 2, `The social share ${!ogHas && !ogDesc ? 'title and description are' : !ogHas ? 'title is' : 'description is'} missing.`)
  else add('og', 1)

  // One H1: the template draws it from the title, so the body must not add another.
  const bodyH1 = headings.filter((h) => h.level === 1).length
  const h1Total = bodyH1 + (input.h1FromTemplate === false ? 0 : 1)
  if (h1Total !== 1) add('h1', 0, h1Total === 0 ? 'The page has no H1 heading.' : `The page has ${h1Total} H1 headings; keep exactly one (the body should not start with "# ").`)
  else add('h1', 1)

  // Keyword in the first H2 or the first 100 words
  if (!keyword) add('keyword-early', 0, 'No primary keyword is set, so it cannot be checked near the top of the page.')
  else {
    const first100 = plainText(body).split(/\s+/).slice(0, 100).join(' ')
    const ok = containsKeyword(first100, keyword) || (h2s[0] ? containsKeyword(h2s[0].text, keyword) : false)
    add('keyword-early', ok ? 1 : 0, `The primary keyword "${keyword}" is not in the first 100 words or the first H2 heading.`)
  }

  // Three or more H2s
  const expectH2 = input.expectH2 !== false
  if (expectH2) add('h2-count', Math.min(1, h2s.length / 3), `The page has ${pluralize(h2s.length, 'H2 section heading')}; use at least 3.`)
  else add('h2-count', 1, undefined, false)

  // Length against the kind's target
  const words = wordCount(body)
  const { min, max } = input.targetWords
  if (words >= min && words <= max) add('word-count', 1)
  else if (words >= min * 0.7 && words <= max * 1.3) add('word-count', 0.5, `The page is ${words} words; this kind of page aims for ${min} to ${max}.`)
  else add('word-count', 0, `The page is ${words} words; this kind of page aims for ${min} to ${max}.`)

  // FAQ and takeaways
  const faqCount = input.faq.filter((f) => f.q?.trim() && f.a?.trim()).length
  add('faq', Math.min(1, faqCount / 3), `The FAQ has ${pluralize(faqCount, 'question')}; use at least 3.`)
  const takeCount = input.takeaways.filter((t) => t?.trim()).length
  add('takeaways', Math.min(1, takeCount / 3), `There ${takeCount === 1 ? 'is' : 'are'} ${pluralize(takeCount, 'key takeaway')}; use at least 3.`)

  // Internal links
  const links = input.internalLinks ?? internalLinkPathsOf(body)
  const existing = new Set([...input.existingPaths].map((p) => (p.length > 1 ? p.replace(/\/+$/, '') : p)))
  existing.add('/')
  add('internal-link', links.length > 0 ? 1 : 0, 'The page has no link to another page on this site.')
  const dead = [...new Set(links.filter((l) => !existing.has(l)))]
  add('dead-links', dead.length === 0 ? 1 : 0, `The page links to ${pluralize(dead.length, 'page')} that does not exist: ${dead.slice(0, 3).join(', ')}.`)

  // Image with alt text
  const imageApplies = input.imageApplies !== false
  add('image-alt', input.hasImageAlt ? 1 : 0, 'The page has no picture with alt text.', imageApplies)

  // Structured data
  const expected = input.jsonLdExpected ?? ['Article', 'FAQPage', 'BreadcrumbList']
  const emitted = new Set(input.jsonLdTypes)
  const missing = expected.filter((t) => !emitted.has(t))
  add('jsonld', expected.length === 0 ? 1 : (expected.length - missing.length) / expected.length, `The page does not emit these structured data types: ${missing.join(', ')}.`)

  // House style: no long dashes anywhere
  const allText = [title, meta, input.ogTitle, input.ogDescription, body, ...input.faq.map((f) => `${f.q} ${f.a}`), ...input.takeaways].join('\n')
  add('dashes', hasDash(allText) ? 0 : 1, 'The text contains a long dash; use a comma or a full stop.')

  // Readability
  const avg = averageSentenceWords(body)
  add('readability', avg === 0 || avg <= 22 ? 1 : avg <= 28 ? 0.5 : 0, `Sentences average ${Math.round(avg)} words; aim for under 22.`)

  const applicable = results.filter((r) => r.applies)
  const possible = applicable.reduce((n, r) => n + WEIGHT[r.id], 0)
  const earned = applicable.reduce((n, r) => n + r.earned, 0)
  return {
    score: possible === 0 ? 100 : Math.round((earned / possible) * 100),
    reasons: applicable.filter((r) => r.reason).map((r) => r.reason as string),
    failed: applicable.filter((r) => r.earned < WEIGHT[r.id]).map((r) => r.id),
    earned,
    possible,
  }
}
