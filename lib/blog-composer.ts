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
}

type Step = 'keywords' | 'idea' | 'body' | 'title' | 'enrich'

interface ComposerContext {
  angle: string
  keywords: string[]
  idea: string
  description: string
  style?: ContentStyle
  allowedLinks: AllowedLink[]
  body: string
  title: string
}

const NO_FABRICATION = `Never claim personal experience, a specific past trip, a named traveler, a specific date, or a price - you are a marketing writer, not someone who has been on this trip. Write from general travel-planning knowledge and what a first-time visitor would want to know.`

const EM_DASH = '—'

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
      return `Write a blog post of roughly ${wordRange} words, in markdown, for a travel agency's blog.\n\nIdea: ${ctx.idea}\nDescription: ${ctx.description}\nTarget keywords (work them in naturally, don't stuff): ${ctx.keywords.join(', ')}\nPrimary keyword: ${ctx.keywords[0] ?? ''}${styleBlock}\n\n${NO_FABRICATION}\n\nFormat rules: the opening sentence must directly answer the core question a reader searching the primary keyword actually has - plain, complete, quotable on its own by a search engine or AI answer box, not a scene-setting lead-in. Follow it with the rest of the hook paragraph (no heading before it). Straight after that opening paragraph, add one separate short paragraph that starts with the bold words "**Quick answer:**" followed by a one or two sentence plain summary of the whole post. Within the first two sections, include one short definition sentence for the main concept of the post in the form "X is ..." that an AI answer engine could quote. Use 4-6 "##" section headings and work the primary keyword into the first one naturally (never forced or unnatural-sounding). Use at least one "###" sub-heading under the longest section. Use a short bullet list somewhere it helps scanability, write in a warm and practical tone, and do not include a title heading (the title is generated separately) or a call-to-action link (the site adds its own).\n\n${linkInstructions(ctx.allowedLinks)}\n\nFinish with a short final paragraph (2-3 sentences, no heading, no link) that names the one question the reader should settle next (for example who they would travel with, or which month works) and says our team can help them work that out. State no prices, dates, availability or urgency, and no exact statistics, distances or counts you were not given: stay at the level of general guidebook knowledge. Never use the long dash character; use commas or full stops instead. Output raw markdown only, no commentary before or after it.`
    }
    case 'title':
      return `Idea: ${ctx.idea}\nDescription: ${ctx.description}\n\nWrite: a clear post title (under 65 characters), an SEO title (under 60 characters, can equal the title), and an SEO meta description (under 155 characters). The title and seo_title must contain the primary keyword (${ctx.keywords[0] ?? ''}) and tell the reader who the trip or advice is for or what decision it helps with. No fake urgency, superlatives about price, or numbers you were not given. Never use the long dash character. Return ONLY minified JSON: {"title":"...","seo_title":"...","seo_description":"..."}`
    case 'enrich':
      return `Post title: ${ctx.title}\nPrimary keyword: ${ctx.keywords[0] ?? ''}\nTarget keywords: ${ctx.keywords.join(', ')}\n\nHere is the finished post:\n\n${ctx.body}\n\n${NO_FABRICATION}\n\nWrite the extra search and social fields for this post:\n- faq: 3 to 5 objects {"q","a"}. Each q is a real question a searcher would type before booking this kind of trip, written the way a person would ask it. Each a answers it directly in one to three plain sentences, using only what the post says or general travel knowledge. No prices, dates, availability or digits; write any small count as a word.\n- key_takeaways: 3 to 5 one-line takeaways (under 120 characters each) that summarise the post. No digits.\n- og_title: a social share title, 60 characters or fewer, more curious than the SEO title but still honest and still about this post.\n- og_description: a social share description, 110 characters or fewer.\n- primary_keyword: the one search phrase (3-6 words) this post targets; use the primary keyword above unless it is clearly unusable.\n- secondary_keywords: 3 to 6 supporting search phrases taken from or close to the target keywords.\nNever use the long dash character. Return ONLY minified JSON: {"faq":[{"q":"...","a":"..."}],"key_takeaways":["..."],"og_title":"...","og_description":"...","primary_keyword":"...","secondary_keywords":["..."]}`
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
export async function composeFullPost(angle: string, seedKeyword?: string, opts: ComposeOptions = {}): Promise<ComposedPost | null> {
  if (!isAiConfigured()) return null
  const ctx: ComposerContext = {
    angle,
    keywords: seedKeyword ? [seedKeyword] : [],
    idea: '',
    description: '',
    style: opts.style,
    allowedLinks: opts.allowedLinks ?? [],
    body: '',
    title: '',
  }

  const keywordsResult = await runComposerStep<{ keywords?: string[] }>('keywords', ctx)
  const aiKeywords = keywordsResult && typeof keywordsResult === 'object' ? keywordsResult.keywords ?? [] : []
  ctx.keywords = [...new Set([...(seedKeyword ? [seedKeyword] : []), ...aiKeywords])].filter(Boolean)
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

  const enrich = await runComposerStep<EnrichResult>('enrich', ctx)
  const extra: EnrichResult = enrich && typeof enrich === 'object' ? enrich : {}
  const seoTitle = titleResult.seo_title ?? titleResult.title
  const secondary = asTextList(extra.secondary_keywords, 6)

  return {
    title: titleResult.title,
    slug: slugify(titleResult.title),
    body,
    seo_title: seoTitle,
    seo_description: titleResult.seo_description ?? '',
    tags: ctx.keywords.slice(0, 5),
    faq: asFaq(extra.faq),
    key_takeaways: asTextList(extra.key_takeaways, 5),
    og_title: asText(extra.og_title) || seoTitle,
    og_description: asText(extra.og_description) || (titleResult.seo_description ?? '').slice(0, 110),
    primary_keyword: asText(extra.primary_keyword) || ctx.keywords[0],
    secondary_keywords: secondary.length ? secondary : ctx.keywords.slice(1, 5),
    content_style: opts.style?.id ?? '',
  }
}

const PLACEHOLDER_PATTERNS = [/\[.*?\]/, /lorem ipsum/i, /todo/i, /insert .* here/i]
const REFUSAL_PATTERNS = [/i (cannot|can't|won'?t) (write|generate|help|comply)/i, /as an ai( language model)?/i]
const EXPERIENCE_CLAIM_PATTERNS = [/\bwhen i (visited|went|traveled|stayed)\b/i, /\bmy (trip|visit|stay|experience) to\b/i, /\bi (recently|personally) (visited|went)\b/i]

// The placeholder pattern above flags any "[...]" in the body, which would flag every markdown link.
// Links are checked on their own below, so for that one pattern a link is blanked out first.
const MARKDOWN_LINK = /\[([^\]]*)\]\(([^)\s]*)\)/g

const normNum = (s: string): string => {
  const n = Number(s.replace(/,/g, ''))
  return Number.isFinite(n) ? String(n) : s
}

/** Every number in a piece of text, normalised so "1,200", "1200" and "03" compare equal to
 * "1200" and "3". */
export function numbersIn(text: string): string[] {
  return (text.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map(normNum)
}

/** Numbers in a body that are real content (not link addresses, list numbering or "Step 2"
 * style labels, which are structure and not claims). */
function bodyNumbers(body: string): string[] {
  const stripped = body
    .replace(/\]\([^)]*\)/g, ']')
    .replace(/^\s*\d+[.)]\s/gm, '')
    .replace(/^#{1,6}\s*\d+[.):]?\s/gm, '## ')
    .replace(/\b(step|tip|reason|mistake|myth|question|item|option)\s+\d+/gi, '$1')
  return numbersIn(stripped)
}

export interface PublishGateContext {
  /** Real internal paths the post may link to (exact, no query or hash), for example /packages/x. */
  allowedPaths?: string[]
  /** The facts the writer was given (the grounded angle). A number must appear here, in the
   * keywords or in the title to be allowed in the FAQ, takeaways or body. */
  groundingText?: string
}

function linkTargets(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/\]\((\/[^)\s]*)\)/g)) out.push(m[1])
  return out
}

/** Reasons a composed post must not auto-publish. Empty means it's clean. This is the quality
 * gate PARITY-SPEC's owner rules call for ("no approval gates, only quality gates") - it runs
 * whether or not a human ever looks at the draft. */
export function autoPublishBlockers(post: ComposedPost, now: Date = new Date(), ctx: PublishGateContext = {}): string[] {
  const blockers: string[] = []
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
  if (faq.length < 3) blockers.push('missing FAQ (needs at least 3 questions)')
  if (takeaways.length < 3) blockers.push('missing key takeaways (needs at least 3)')

  const faqText = faq.map((f) => `${f.q} ${f.a}`).join(' ')
  const takeawayText = takeaways.join(' ')

  // Numbers: nothing numeric may appear that the writer was not given.
  const allowedNumbers = new Set(
    numbersIn(
      [ctx.groundingText ?? '', post.title, post.seo_title, post.tags.join(' '), post.primary_keyword ?? '', (post.secondary_keywords ?? []).join(' ')].join(' '),
    ),
  )
  const foreign = (nums: string[]) => [...new Set(nums.filter((n) => !allowedNumbers.has(n)))]
  const foreignFaq = foreign(numbersIn(`${faqText} ${takeawayText}`))
  if (foreignFaq.length) blockers.push(`number not in the source facts in FAQ or takeaways (${foreignFaq.join(', ')})`)
  const foreignBody = foreign(bodyNumbers(post.body))
  if (foreignBody.length) blockers.push(`number not in the source facts in the body (${foreignBody.join(', ')})`)

  // Internal links: every site-relative link must be the home page, the contact section, or a path
  // the caller confirmed exists.
  const allowedPaths = new Set((ctx.allowedPaths ?? []).map((p) => p.replace(/[?#].*$/, '').replace(/\/+$/, '')))
  const dead = new Set<string>()
  for (const target of linkTargets(`${post.body}\n${faq.map((f) => f.a).join('\n')}`)) {
    const path = target.replace(/[?#].*$/, '').replace(/\/+$/, '')
    if (path === '') continue
    if (!allowedPaths.has(path)) dead.add(target)
  }
  if (dead.size) blockers.push(`link to a page that was not confirmed to exist (${[...dead].join(', ')})`)

  const allText = [post.title, post.seo_title, post.seo_description, post.body, faqText, takeawayText, post.og_title ?? '', post.og_description ?? ''].join('\n')
  if (allText.includes(EM_DASH)) blockers.push('contains a long dash character')

  if ((post.og_title ?? '').length > 60) blockers.push(`social title too long (${post.og_title.length} characters)`)
  if ((post.og_description ?? '').length > 110) blockers.push(`social description too long (${post.og_description.length} characters)`)
  return blockers
}
