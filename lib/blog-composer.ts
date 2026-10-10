import { callAnthropic, anthropicText, parseModelJson, isAiConfigured, todayEt } from '@/lib/ai-verify'
import { slugify } from '@/lib/content-dedupe'
import { type ContentStyle } from '@/lib/content-styles'

// Ported from Nomad Escape Plan's modules/marketing/blog-composer.ts (Factory Phase 2:
// blog/autoblog). Trimmed: dropped the paid-keyword-volume lookup and Google-autocomplete
// enrichment step (an AI-only keyword list is enough for v1 - wiring in real search-volume data
// is a real follow-up against lib/keywords.ts, not something to bolt on here) and dropped the
// `facts` fact-check parameter entirely (that was Nomad's visa/passport grounding; this site's
// posts aren't making country-entry-rule claims that need a source to check against). Kept: the
// pipeline (keywords -> idea -> body -> title), the no-invented-experience instructions,
// and the publish quality gate - all subject-agnostic and directly reusable.
//
// Growth loop WP1 added: a writing style (lib/content-styles.ts), internal links limited to a list
// of real pages the caller passes in, and one extra "enrich" step that writes the FAQ, key
// takeaways, social share text and keyword fields. The gate below checks all of it in plain code.
//
// Never writes to the database itself - a pure function. The caller (lib/autoblog-run.ts)
// decides draft vs published and does the dedupe check (lib/content-dedupe.ts), per PARITY-SPEC's
// "every content path dedupes" and "no approval gates, only quality gates" owner rules.
export interface FaqItem {
  q: string
  a: string
}

export interface ComposedPost {
  title: string
  slug: string
  body: string
  seo_title: string
  seo_description: string
  tags: string[]
  faq: FaqItem[]
  key_takeaways: string[]
  og_title: string
  og_description: string
  primary_keyword: string
  secondary_keywords: string[]
  content_style: string
  /** True when the enrich step (FAQ, takeaways, social text) was skipped for lack of time. */
  skipped_enrich?: boolean
}

export interface AllowedLink {
  /** A real site path such as /packages/some-trip. */
  path: string
  /** What the page is, so the writer can word the link naturally. */
  label: string
}

export interface ComposeOptions {
  style?: ContentStyle
  allowedLinks?: AllowedLink[]
  /** Absolute time (Date.now() scale) by which composing should be wrapping up. The function that
   * calls this has a hard limit, so optional steps are skipped when the time left is short. */
  deadlineMs?: number
}

/** Optional steps are skipped when fewer than this many ms remain before the caller's deadline. */
export const ENRICH_MIN_MS = 50_000
export const REPAIR_MIN_MS = 70_000

type Step = 'keywords' | 'idea' | 'body' | 'title' | 'enrich'

interface ComposerContext {
  angle: string
  keywords: string[]
  /** Supporting phrases from the topic's keyword set that the post must work in (empty for a single-phrase seed). */
  seedSecondary: string[]
  idea: string
  description: string
  style?: ContentStyle
  allowedLinks: AllowedLink[]
  body: string
  title: string
}

const NO_FABRICATION = `Never claim personal experience, a specific past trip, a named traveler, a specific date, or a price - you are a marketing writer, not someone who has been on this trip. Write from general travel-planning knowledge and what a first-time visitor would want to know.`

const EM_DASH = String.fromCharCode(0x2014)
const EN_DASH = String.fromCharCode(0x2013)

function linkInstructions(links: AllowedLink[]): string {
  if (links.length === 0) return 'Do not include any links in the post (the site adds its own).'
  const list = links.map((l) => `- ${l.path} (${l.label})`).join('\n')
  return `Internal links: include one or two natural markdown links in the body text (never in headings and never in the final paragraph), using ONLY these exact paths, written as [descriptive link text](/path):\n${list}\nDo not link to any other page, do not invent a path, and do not use full web addresses.`
}

function composerPrompt(step: Step, ctx: ComposerContext): string {
  switch (step) {
    case 'keywords':
      return `You are planning a blog post for a travel agency (hosted group trips, river and ocean cruises, singles getaways).\n\nPost angle: ${ctx.angle}\n\nSuggest 8 long-tail SEO keyword phrases (3-6 words each) this post could realistically rank for. Favour phrases from someone deciding whether and which trip to book (for example group trip for singles, river cruise for first timers, what is included) over pure trivia phrases. Return ONLY minified JSON: {"keywords":["...", ...]}`
    case 'idea':
      return `Post angle: ${ctx.angle}\nTarget keywords: ${ctx.keywords.join(', ')}\n\n${NO_FABRICATION}\n\nWrite one specific blog post idea (a concrete headline concept, not a restatement of the angle) and a two-sentence description of what it covers. Say who this post is for and what they are trying to decide. Return ONLY minified JSON: {"idea":"...","description":"..."}`
    case 'body': {
      const wordRange = ctx.style ? `${ctx.style.minWords}-${ctx.style.maxWords}` : '700-900'
      const styleBlock = ctx.style ? `\n\n${ctx.style.prompt}` : ''
      return `Write a blog post of roughly ${wordRange} words, in markdown, for a travel agency's blog.\n\nIdea: ${ctx.idea}\nDescription: ${ctx.description}\nTarget keywords (work them in naturally, don't stuff): ${ctx.keywords.join(', ')}\nPrimary keyword: ${ctx.keywords[0] ?? ''}${ctx.seedSecondary.length ? `\nThis post is also shooting for these supporting phrases; work them in naturally where they fit, and skip any that would read forced: ${ctx.seedSecondary.slice(0, 3).join(', ')}` : ''}${styleBlock}\n\n${NO_FABRICATION}\n\nFormat rules: the opening sentence must directly answer the core question a reader searching the primary keyword actually has - plain, complete, quotable on its own by a search engine or AI answer box, not a scene-setting lead-in. Follow it with the rest of the hook paragraph (no heading before it). Straight after that opening paragraph, add one separate short paragraph that starts with the bold words "**Quick answer:**" followed by a one or two sentence summary that adds who the trip or advice suits, rather than restating the opening sentence. Within the first two sections, include one short definition sentence for the main concept of the post in the form "X is ..." that an AI answer engine could quote. Use 4-6 "##" section headings and work the primary keyword into the first one naturally (never forced or unnatural-sounding). Use a "###" sub-heading under the longest section where it fits (optional for list and checklist styles). Use a short bullet list somewhere it helps scanability, write in a warm and practical tone, and do not include a title heading (the title is generated separately) or a call-to-action link (the site adds its own).\n\n${linkInstructions(ctx.allowedLinks)}\n\nFinish with a short final paragraph (2-3 sentences, no heading, no link) that names the one question the reader should settle next (for example who they would travel with, or which month works) and says our team can help them work that out. State no prices, dates, availability or urgency, and no exact statistics, distances or counts you were not given: stay at the level of general guidebook knowledge. Never use the long dash character; use commas or full stops instead. Output raw markdown only, no commentary before or after it.`
    }
    case 'title':
      return `Idea: ${ctx.idea}\nDescription: ${ctx.description}\n\nWrite: a clear post title (under 65 characters), an SEO title (under 60 characters, can equal the title), and an SEO meta description (under 155 characters). The title and seo_title must contain the primary keyword (${ctx.keywords[0] ?? ''}) and tell the reader who the trip or advice is for or what decision it helps with. No fake urgency, superlatives about price, and no digits or numbers of any kind in the title, SEO title or meta description. Never use the long dash character. Return ONLY minified JSON: {"title":"...","seo_title":"...","seo_description":"..."}`
    case 'enrich':
      return `Post title: ${ctx.title}\nPrimary keyword: ${ctx.keywords[0] ?? ''}\nTarget keywords: ${ctx.keywords.join(', ')}\n\nHere is the finished post:\n\n${ctx.body}\n\n${NO_FABRICATION}\n\nWrite the extra search and social fields for this post:\n- faq: 3 to 5 objects {"q","a"}. Each q is a real question a searcher would type before booking this kind of trip, written the way a person would ask it. Each a answers it directly in one to three plain sentences, using only what the post says or general travel knowledge. No prices, dates, availability, digits, number words or counts of any kind, and no links (answers are plain text).\n- key_takeaways: 3 to 5 one-line takeaways (under 120 characters each) that summarise the post. No digits, number words or counts.\n- og_title: a social share title, 60 characters or fewer, more curious than the SEO title but still honest and still about this post. No digits or numbers.\n- og_description: a social share description, 110 characters or fewer. No digits or numbers.\n- primary_keyword: the one search phrase (3-6 words) this post targets; use the primary keyword above unless it is clearly unusable.\n- secondary_keywords: 3 to 6 supporting search phrases taken from or close to the target keywords.${ctx.seedSecondary.length ? ` Start with these exact phrases, which the post was written for: ${ctx.seedSecondary.join(', ')}.` : ''}\nNever use the long dash character. Return ONLY minified JSON: {"faq":[{"q":"...","a":"..."}],"key_takeaways":["..."],"og_title":"...","og_description":"...","primary_keyword":"...","secondary_keywords":["..."]}`
  }
}

async function runComposerStep<T>(step: Step, ctx: ComposerContext): Promise<T | string | null> {
  const prompt = composerPrompt(step, ctx)
  const r = await callAnthropic(
    { max_tokens: step === 'body' ? 8000 : 4000, messages: [{ role: 'user', content: prompt }] },
    { timeoutMs: step === 'body' ? 170_000 : 40_000 },
  )
  if (!r || !r.res.ok) return null
  const payload = await r.res.json()
  if ((payload as { stop_reason?: string })?.stop_reason === 'max_tokens') return null
  const text = anthropicText(payload)
  if (step === 'body') return text || null
  return parseModelJson<T>(text)
}

interface EnrichResult {
  faq?: unknown
  key_takeaways?: unknown
  og_title?: unknown
  og_description?: unknown
  primary_keyword?: unknown
  secondary_keywords?: unknown
}

const asText = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
const asTextList = (v: unknown, max: number): string[] =>
  Array.isArray(v) ? v.map(asText).filter(Boolean).slice(0, max) : []

function asFaq(v: unknown): FaqItem[] {
  if (!Array.isArray(v)) return []
  const out: FaqItem[] = []
  for (const item of v) {
    if (!item || typeof item !== 'object') continue
    const q = asText((item as { q?: unknown }).q)
    const a = asText((item as { a?: unknown }).a)
    if (q && a) out.push({ q, a })
  }
  return out.slice(0, 5)
}

/** Turn a topic angle into a full draft post. Returns null when the AI is unconfigured, any step
 * fails, or a step's output didn't parse - the caller falls back to the static topic cluster on
 * the next run rather than publishing a half-written post. The one exception is the final
 * "enrich" step: if it fails the post is still returned, with empty FAQ and takeaways, and the
 * quality gate (autoPublishBlockers) keeps it from auto-publishing. */
export async function composeFullPost(angle: string, seedKeywords?: string | string[], opts: ComposeOptions = {}): Promise<ComposedPost | null> {
  if (!isAiConfigured()) return null
  // One phrase (the old call) or the topic's whole keyword set: the first is the primary keyword, the rest
  // are the secondary phrases the post must work in (they come from the keyword engine's topic cluster).
  const seeds = [...new Set((Array.isArray(seedKeywords) ? seedKeywords : seedKeywords ? [seedKeywords] : []).map((k) => k.trim()).filter(Boolean))]
  const seedKeyword = seeds[0]
  const ctx: ComposerContext = {
    angle,
    keywords: [...seeds],
    seedSecondary: seeds.slice(1, 7),
    idea: '',
    description: '',
    style: opts.style,
    allowedLinks: opts.allowedLinks ?? [],
    body: '',
    title: '',
  }

  const keywordsResult = await runComposerStep<{ keywords?: string[] }>('keywords', ctx)
  const aiKeywords = keywordsResult && typeof keywordsResult === 'object' ? keywordsResult.keywords ?? [] : []
  ctx.keywords = [...new Set([...seeds, ...aiKeywords])].filter(Boolean)
  if (ctx.keywords.length === 0) return null

  const ideaResult = await runComposerStep<{ idea?: string; description?: string }>('idea', ctx)
  if (!ideaResult || typeof ideaResult !== 'object' || !ideaResult.idea) return null
  ctx.idea = ideaResult.idea
  ctx.description = ideaResult.description ?? ''

  const body = await runComposerStep<never>('body', ctx)
  if (!body || typeof body !== 'string') return null
  ctx.body = body

  const titleResult = await runComposerStep<{ title?: string; seo_title?: string; seo_description?: string }>('title', ctx)
  if (!titleResult || typeof titleResult !== 'object' || !titleResult.title) return null
  ctx.title = titleResult.title

  // Optional when time is short: the post is still returned (as a draft, see analyse) rather than
  // risking the whole function being killed mid-call and losing the body.
  const skipEnrich = opts.deadlineMs !== undefined && opts.deadlineMs - Date.now() < ENRICH_MIN_MS
  const enrich = skipEnrich ? null : await runComposerStep<EnrichResult>('enrich', ctx)
  const extra: EnrichResult = enrich && typeof enrich === 'object' ? enrich : {}
  const seoTitle = titleResult.seo_title ?? titleResult.title
  // The post targets the keyword set it was given: the chosen primary stays the primary, and the topic's
  // secondary phrases lead the secondary list (the model's own extras only fill the remaining places).
  const aiSecondary = asTextList(extra.secondary_keywords, 6)
  const secondary = seeds.length > 1 ? [...new Set([...ctx.seedSecondary, ...aiSecondary])].slice(0, 6) : aiSecondary

  return normalizePost({
    title: titleResult.title,
    slug: slugify(titleResult.title),
    body,
    seo_title: seoTitle,
    seo_description: titleResult.seo_description ?? '',
    tags: ctx.keywords.slice(0, 5),
    faq: asFaq(extra.faq),
    key_takeaways: asTextList(extra.key_takeaways, 5),
    og_title: asText(extra.og_title),
    og_description: asText(extra.og_description),
    // A single seed keeps the old behaviour (the model may refine it); a keyword set keeps its chosen primary.
    primary_keyword: seeds.length > 1 ? seedKeyword : asText(extra.primary_keyword) || seedKeyword || ctx.keywords[0],
    secondary_keywords: secondary.length ? secondary : ctx.keywords.slice(1, 5),
    content_style: opts.style?.id ?? '',
    ...(skipEnrich ? { skipped_enrich: true } : {}),
  })
}

/** Cut text to at most `max` characters at a word boundary (never mid-word), dropping trailing
 * punctuation left dangling by the cut. */
export function cutAtWord(text: string, max: number): string {
  const s = text.trim()
  if (s.length <= max) return s
  const window = s.slice(0, max + 1)
  const space = window.lastIndexOf(' ')
  const cut = space > 0 ? window.slice(0, space) : s.slice(0, max)
  return cut.replace(/[\s,;:\-]+$/, '')
}

/** Long dashes read as machine-written. A dash used as a break becomes a comma; one between two
 * digits (a range) becomes "to". Spaces and tabs only, so line breaks in markdown survive. */
export function fixDashes(text: string): string {
  const dash = `[${EM_DASH}${EN_DASH}]`
  return text
    .replace(new RegExp(`(\\d)${EN_DASH}(\\d)`, 'g'), '$1 to $2')
    // A dash that starts a line is just dropped; one that ends a line leaves no dangling comma.
    .replace(new RegExp(`^[ \\t]*${dash}[ \\t]*`, 'gm'), '')
    .replace(new RegExp(`[ \\t]*${dash}[ \\t]*$`, 'gm'), '')
    .replace(new RegExp(`[ \\t]*${dash}[ \\t]*`, 'g'), ', ')
}

/** Mechanical clean-up of the model's output, so a cosmetic slip never blocks a publish: dashes
 * are replaced in every text field, and the social share text is forced to its length limits at a
 * word boundary (falling back to the SEO title / description when the model's own is too long). */
export function normalizePost(post: ComposedPost): ComposedPost {
  const f = fixDashes
  const seoTitle = f(post.seo_title)
  const seoDescription = f(post.seo_description)
  let ogTitle = f(post.og_title || '')
  if (!ogTitle || ogTitle.length > 60) ogTitle = cutAtWord(seoTitle || f(post.title), 60)
  let ogDescription = f(post.og_description || '')
  if (!ogDescription) ogDescription = seoDescription
  if (ogDescription.length > 110) ogDescription = cutAtWord(ogDescription, 110)
  return {
    ...post,
    title: f(post.title),
    seo_title: seoTitle,
    seo_description: seoDescription,
    body: f(post.body),
    tags: post.tags.map(f),
    faq: post.faq.map((x) => ({ q: f(x.q), a: f(x.a) })),
    key_takeaways: post.key_takeaways.map(f),
    og_title: ogTitle,
    og_description: ogDescription,
    primary_keyword: f(post.primary_keyword),
    secondary_keywords: post.secondary_keywords.map(f),
  }
}

const PLACEHOLDER_PATTERNS = [/\[.*?\]/, /lorem ipsum/i, /todo/i, /insert .* here/i]
const REFUSAL_PATTERNS = [/i (cannot|can't|won'?t) (write|generate|help|comply)/i, /as an ai( language model)?/i]
const EXPERIENCE_CLAIM_PATTERNS = [
  /\bwhen i (visited|went|traveled|stayed)\b/i,
  /\bmy (trip|visit|stay|experience) to\b/i,
  /\bi (recently|personally) (visited|went)\b/i,
  /\bour team has (sailed|been|stayed)\b/i,
  /\bour guests (love|loved)\b/i,
  /\baward-winning\b/i,
]

// The placeholder pattern above flags any "[...]" in the body, which would flag every markdown link.
// Links are checked on their own below, so for that one pattern a link is blanked out first.
const MARKDOWN_LINK = /\[([^\]]*)\]\(([^)\s]*)(?:\s+"[^"]*")?\)/g
const LINK_TARGET = /\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g

const normNum = (s: string): string => {
  const n = Number(s.replace(/,/g, ''))
  return Number.isFinite(n) ? String(n) : s
}

/** Every number in a piece of text, normalised so "1,200", "1200" and "03" compare equal to
 * "1200" and "3". */
export function numbersIn(text: string): string[] {
  return (text.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map(normNum)
}

const WORD_NUMBERS: Record<string, number> = {
  two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, hundred: 100, thousand: 1000,
}
const WORD_NUMBER_RE =
  /\b(two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|forty|fifty|hundred|thousand)[- ](night|day|week|hour|star|passenger|guest|port|stop|country|ship|mile|km|minute)s?\b/gi

/** Number words attached to a unit ("three nights", "two-hour"), the way a made-up count usually
 * sounds. */
export function wordNumbersIn(text: string): { phrase: string; value: string; unit: string }[] {
  return [...text.matchAll(WORD_NUMBER_RE)].map((m) => ({ phrase: m[0].toLowerCase(), value: String(WORD_NUMBERS[m[1].toLowerCase()]), unit: m[2].toLowerCase() }))
}

/** Numbers in a body line that are real content (not link addresses, list numbering or "Step 2"
 * style labels, which are structure and not claims). */
function bodyNumbers(text: string): string[] {
  const stripped = text
    .replace(/\]\([^)]*\)/g, ']')
    .replace(/^\s*\d+[.)]\s/gm, '')
    .replace(/^#{1,6}\s*\d+[.):]?\s/gm, '## ')
    .replace(/\b(step|tip|reason|mistake|myth|question|item|option)\s+\d+/gi, '$1')
  return numbersIn(stripped)
}

export interface PublishGateContext {
  /** Real internal paths the post may link to (exact, no query or hash), for example /packages/x. */
  allowedPaths?: string[]
  /** The facts the writer was given (the grounded angle, the seed keyword, the package text). A
   * number may only appear in the post if it appears here. The AI's own title, tags and keywords
   * do NOT count as a source. */
  groundingText?: string
  /** Absolute time (Date.now() scale) the caller must finish by; the repair call is skipped when
   * fewer than REPAIR_MIN_MS remain. */
  deadlineMs?: number
}

interface Grounding {
  numbers: Set<string>
  lower: string
  paths: Set<string>
}

function groundingFrom(ctx: PublishGateContext): Grounding {
  return {
    numbers: new Set(numbersIn(ctx.groundingText ?? '')),
    lower: (ctx.groundingText ?? '').toLowerCase(),
    paths: new Set((ctx.allowedPaths ?? []).map((p) => p.replace(/[?#].*$/, '').replace(/\/+$/, ''))),
  }
}

type LinkKind = 'ok' | 'dead' | 'external'

/** Site-relative links must be the home page, the contact section or a confirmed path. Links to
 * our own domain are treated as paths. Any other web or email link is not allowed. */
function classifyLink(target: string, paths: Set<string>): LinkKind {
  let t = target
  if (/^https?:\/\//i.test(t)) {
    try {
      const u = new URL(t)
      if (!/^(www\.)?travelfunbiz\.ca$/i.test(u.hostname)) return 'external'
      t = u.pathname || '/'
    } catch {
      return 'external'
    }
  } else if (t.startsWith('#')) {
    return 'ok'
  } else if (!t.startsWith('/')) {
    return 'external'
  }
  const path = t.replace(/[?#].*$/, '').replace(/\/+$/, '')
  if (path === '') return 'ok'
  return paths.has(path) ? 'ok' : 'dead'
}

interface Problems {
  numbers: string[]
  wordNums: string[]
  dead: string[]
  external: string[]
}

const noProblems = (p: Problems) => !p.numbers.length && !p.wordNums.length && !p.dead.length && !p.external.length

function unitProblems(text: string, g: Grounding, structural: boolean): Problems {
  const nums = (structural ? bodyNumbers(text) : numbersIn(text.replace(/\]\([^)]*\)/g, ']'))).filter((n) => !g.numbers.has(n))
  const wordNums = wordNumbersIn(text)
    // Grounded only if the facts say it in words, or give the same number next to the same unit
    // ("3 nights"). A stray 3 elsewhere (a date) does not excuse "three nights".
    .filter((w) => !g.lower.includes(w.phrase) && !new RegExp(`\\b${w.value}[- ]${w.unit}`, 'i').test(g.lower))
    .map((w) => w.phrase)
  const dead: string[] = []
  const external: string[] = []
  for (const m of text.matchAll(LINK_TARGET)) {
    const kind = classifyLink(m[1], g.paths)
    if (kind === 'dead') dead.push(m[1])
    else if (kind === 'external') external.push(m[1])
  }
  return { numbers: [...new Set(nums)], wordNums: [...new Set(wordNums)], dead, external }
}

export type OffenderField = 'body' | 'title' | 'seo_title' | 'seo_description' | 'og_title' | 'og_description' | 'faq_q' | 'faq_a' | 'takeaway'

export interface Offender {
  field: OffenderField
  index?: number
  /** The exact text to rewrite (a sentence for the body, the whole value for the other fields). */
  text: string
  why: string
  /** List or heading marker at the start of the text ("- ", "1. ", "## "), kept out of the repair
   * prompt and put back on the rewrite. Empty for everything but body sentences. */
  prefix: string
}

const LEADING_MARKER = /^\s*(?:[-*]\s+|\d+[.)]\s+|#{1,6}\s+)/

function whyText(p: Problems, faqLink = false): string {
  const parts: string[] = []
  if (p.numbers.length) parts.push(`remove the numbers ${p.numbers.join(', ')}`)
  if (p.wordNums.length) parts.push(`remove the counts "${p.wordNums.join('", "')}"`)
  if (p.dead.length) parts.push(`remove the link(s) ${p.dead.join(', ')} (keep the words, drop the link)`)
  if (p.external.length || faqLink) parts.push(`remove the link(s) ${p.external.join(', ') || 'in this text'} (keep the words, drop the link)`)
  return parts.join('; ')
}

interface Analysis {
  blockers: string[]
  offenders: Offender[]
}

/** The full gate. `blockers` is what autoPublishBlockers returns; `offenders` are the exact
 * sentences/fields behind the number and link blockers, for the single automatic repair. */
function analyse(post: ComposedPost, now: Date, ctx: PublishGateContext): Analysis {
  const blockers: string[] = []
  const offenders: Offender[] = []
  const g = groundingFrom(ctx)

  const wordCount = post.body.trim().split(/\s+/).filter(Boolean).length
  if (wordCount < 450) blockers.push(`too short (${wordCount} words)`)
  if (!/^##\s/m.test(post.body)) blockers.push('no section headings')
  if (PLACEHOLDER_PATTERNS.some((p) => p.test(post.body.replace(MARKDOWN_LINK, '$1')) || p.test(post.title))) blockers.push('placeholder text')
  if (REFUSAL_PATTERNS.some((p) => p.test(post.body))) blockers.push('model refusal in body')
  if (EXPERIENCE_CLAIM_PATTERNS.some((p) => p.test(post.body))) blockers.push('fabricated personal experience claim')
  const staleYear = post.title.match(/\b(20\d{2})\b/)
  if (staleYear && staleYear[1] !== todayEt(now).slice(0, 4)) blockers.push(`stale year in title (${staleYear[1]})`)

  const faq = post.faq ?? []
  const takeaways = post.key_takeaways ?? []
  if (post.skipped_enrich) {
    blockers.push('ran out of time for FAQ')
  } else {
    if (faq.length < 3) blockers.push('missing FAQ (needs at least 3 questions)')
    if (takeaways.length < 3) blockers.push('missing key takeaways (needs at least 3)')
  }

  const numbers = new Set<string>()
  const wordNums = new Set<string>()
  const dead = new Set<string>()
  const external = new Set<string>()
  let faqLink = false
  const collect = (p: Problems) => {
    p.numbers.forEach((x) => numbers.add(x))
    p.wordNums.forEach((x) => wordNums.add(x))
    p.dead.forEach((x) => dead.add(x))
    p.external.forEach((x) => external.add(x))
  }

  const simple: [OffenderField, string, number | undefined][] = [
    ['title', post.title, undefined],
    ['seo_title', post.seo_title, undefined],
    ['seo_description', post.seo_description, undefined],
    ['og_title', post.og_title ?? '', undefined],
    ['og_description', post.og_description ?? '', undefined],
    ...faq.flatMap((f, i): [OffenderField, string, number | undefined][] => [['faq_q', f.q, i], ['faq_a', f.a, i]]),
    ...takeaways.map((t, i): [OffenderField, string, number | undefined] => ['takeaway', t, i]),
  ]
  for (const [field, text, index] of simple) {
    if (!text) continue
    const p = unitProblems(text, g, false)
    // FAQ text is rendered as plain text, so any link in it would show as raw markdown.
    const hasLink = (field === 'faq_q' || field === 'faq_a') && /\]\([^)]*\)/.test(text)
    if (hasLink) faqLink = true
    if (!noProblems(p) || hasLink) {
      collect(p)
      offenders.push({ field, index, text, why: whyText(p, hasLink), prefix: '' })
    }
  }

  for (const line of post.body.split('\n')) {
    const lineP = unitProblems(line, g, true)
    if (noProblems(lineP)) continue
    collect(lineP)
    const sentences = line.split(/(?<=[a-zA-Z)"'][.!?])\s+/)
    let flagged = false
    for (const s of sentences) {
      const sp = unitProblems(s, g, true)
      if (!noProblems(sp)) {
        flagged = true
        offenders.push({ field: 'body', text: s, why: whyText(sp), prefix: s.match(LEADING_MARKER)?.[0] ?? '' })
      }
    }
    if (!flagged) offenders.push({ field: 'body', text: line, why: whyText(lineP), prefix: line.match(LEADING_MARKER)?.[0] ?? '' })
  }

  if (numbers.size) blockers.push(`number not in the source facts (${[...numbers].join(', ')})`)
  if (wordNums.size) blockers.push(`word number not in the source facts (${[...wordNums].join(', ')})`)
  if (dead.size) blockers.push(`link to a page that was not confirmed to exist (${[...dead].join(', ')})`)
  if (external.size) blockers.push(`external or email link (${[...external].join(', ')})`)
  if (faqLink) blockers.push('link inside a FAQ question or answer')

  const allText = [post.title, post.seo_title, post.seo_description, post.body, ...faq.map((f) => `${f.q} ${f.a}`), ...takeaways, post.og_title ?? '', post.og_description ?? ''].join('\n')
  if (allText.includes(EM_DASH)) blockers.push('contains a long dash character')

  // Backstop only: normalizePost already repairs these, so this fires only for a post built by hand.
  if ((post.og_title ?? '').length > 60) blockers.push(`social title too long (${post.og_title.length} characters)`)
  if ((post.og_description ?? '').length > 110) blockers.push(`social description too long (${post.og_description.length} characters)`)
  return { blockers, offenders }
}

/** Reasons a composed post must not auto-publish. Empty means it's clean. This is the quality
 * gate PARITY-SPEC's owner rules call for ("no approval gates, only quality gates") - it runs
 * whether or not a human ever looks at the draft. */
export function autoPublishBlockers(post: ComposedPost, now: Date = new Date(), ctx: PublishGateContext = {}): string[] {
  return analyse(post, now, ctx).blockers
}

/** The sentences and fields behind any number or link blockers. */
export function findOffenders(post: ComposedPost, ctx: PublishGateContext = {}, now: Date = new Date()): Offender[] {
  return analyse(post, now, ctx).offenders
}

/** Put model rewrites back where the offenders came from. Unusable rewrites (empty, not text) are
 * ignored, so the offending text simply stays and the gate blocks it again. */
export function applyRewrites(post: ComposedPost, offenders: Offender[], rewrites: { id: number; text: string }[]): ComposedPost {
  const next: ComposedPost = { ...post, faq: post.faq.map((f) => ({ ...f })), key_takeaways: [...post.key_takeaways] }
  for (const r of rewrites) {
    const o = offenders[r.id]
    // The model saw the sentence without its list/heading marker. If it still added one, drop it
    // before re-attaching the original, so the marker is never doubled.
    const raw = typeof r.text === 'string' ? r.text.trim() : ''
    const text = o?.prefix ? raw.replace(LEADING_MARKER, '').trim() : raw
    if (!o || !text) continue
    switch (o.field) {
      case 'body': {
        const at = next.body.indexOf(o.text)
        if (at !== -1) next.body = next.body.slice(0, at) + o.prefix + text + next.body.slice(at + o.text.length)
        break
      }
      case 'faq_q': if (o.index !== undefined && next.faq[o.index]) next.faq[o.index].q = text; break
      case 'faq_a': if (o.index !== undefined && next.faq[o.index]) next.faq[o.index].a = text; break
      case 'takeaway': if (o.index !== undefined) next.key_takeaways[o.index] = text; break
      default: next[o.field] = text
    }
  }
  return next
}

const REPAIRABLE = /^(number not in|word number not in|link to a page|external or email link|link inside a FAQ)/
const MAX_REPAIR_SENTENCES = 12

/** The quality gate plus ONE automatic repair. When the only blockers are numbers or links the
 * model was not allowed to use, one extra model call rewrites just the offending sentences, then
 * the gate runs once more. Never more than one retry; a post still blocked is saved as a draft. */
export async function gateWithRepair(
  post: ComposedPost,
  now: Date,
  ctx: PublishGateContext,
): Promise<{ post: ComposedPost; blockers: string[]; repaired: boolean }> {
  const first = analyse(post, now, ctx)
  if (first.blockers.length === 0) return { post, blockers: [], repaired: false }
  const offenders = first.offenders.slice(0, MAX_REPAIR_SENTENCES)
  const onlyRepairable = first.blockers.every((b) => REPAIRABLE.test(b))
  if (!onlyRepairable || offenders.length === 0 || first.offenders.length > MAX_REPAIR_SENTENCES || !isAiConfigured()) {
    return { post, blockers: first.blockers, repaired: false }
  }

  // Not enough time left before the caller's deadline: keep the draft rather than risk a killed run.
  if (ctx.deadlineMs !== undefined && ctx.deadlineMs - Date.now() < REPAIR_MIN_MS) {
    return { post, blockers: first.blockers, repaired: false }
  }

  const list = offenders.map((o, i) => `${i}. [${o.why}] ${o.text.slice(o.prefix.length)}`).join('\n')
  const prompt = `Rewrite each numbered text below so it no longer has the problem named in the square brackets. Keep the meaning, tone, markdown formatting and length as close as you can. Do not add any number, count, number word, date, price or link. Where a number or count is removed, say it in general terms instead (for example "a few", "several", "most"). Never use the long dash character.\n\n${list}\n\nReturn ONLY minified JSON with the rewritten text for every number: {"rewrites":[{"id":0,"text":"..."}]}`
  let rewrites: { id: number; text: string }[] = []
  try {
    const r = await callAnthropic({ max_tokens: 4000, messages: [{ role: 'user', content: prompt }] }, { timeoutMs: 60_000 })
    if (r && r.res.ok) {
      const payload = await r.res.json()
      if ((payload as { stop_reason?: string })?.stop_reason !== 'max_tokens') {
        const parsed = parseModelJson<{ rewrites?: { id: number; text: string }[] }>(anthropicText(payload))
        if (parsed && Array.isArray(parsed.rewrites)) rewrites = parsed.rewrites
      }
    }
  } catch (err) {
    console.error('[blog-composer] repair call failed:', err instanceof Error ? err.message : err)
  }
  if (rewrites.length === 0) return { post, blockers: first.blockers, repaired: false }

  const rewritten = normalizePost(applyRewrites(post, offenders, rewrites))
  // The slug follows the final title (a rewritten title must not keep a slug with its old digits).
  const fixed = rewritten.title !== post.title ? { ...rewritten, slug: slugify(rewritten.title) || post.slug } : rewritten
  return { post: fixed, blockers: analyse(fixed, now, ctx).blockers, repaired: true }
}
