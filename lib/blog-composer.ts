import { callAnthropic, anthropicText, parseModelJson, isAiConfigured, todayEt } from '@/lib/ai-verify'
import { slugify } from '@/lib/content-dedupe'

// Ported from Nomad Escape Plan's modules/marketing/blog-composer.ts (Factory Phase 2:
// blog/autoblog). Trimmed: dropped the paid-keyword-volume lookup and Google-autocomplete
// enrichment step (an AI-only keyword list is enough for v1 - wiring in real search-volume data
// is a real follow-up against lib/keywords.ts, not something to bolt on here) and dropped the
// `facts` fact-check parameter entirely (that was Nomad's visa/passport grounding; this site's
// posts aren't making country-entry-rule claims that need a source to check against). Kept: the
// four-step pipeline (keywords -> idea -> body -> title), the no-invented-experience instructions,
// and the publish quality gate - all subject-agnostic and directly reusable.
//
// Never writes to the database itself - a pure function. The caller (lib/autoblog-run.ts)
// decides draft vs published and does the dedupe check (lib/content-dedupe.ts), per PARITY-SPEC's
// "every content path dedupes" and "no approval gates, only quality gates" owner rules.
export interface ComposedPost {
  title: string
  slug: string
  body: string
  excerpt: string
  seo_title: string
  seo_description: string
  tags: string[]
}

type Step = 'keywords' | 'idea' | 'body' | 'title'

interface ComposerContext {
  angle: string
  keywords: string[]
  idea: string
  description: string
}

const NO_FABRICATION = `Never claim personal experience, a specific past trip, a named traveler, a specific date, or a price - you are a marketing writer, not someone who has been on this trip. Write from general travel-planning knowledge and what a first-time visitor would want to know.`

function composerPrompt(step: Step, ctx: ComposerContext): string {
  switch (step) {
    case 'keywords':
      return `You are planning a blog post for a travel agency (hosted group trips, river and ocean cruises, singles getaways).\n\nPost angle: ${ctx.angle}\n\nSuggest 8 long-tail SEO keyword phrases (3-6 words each) this post could realistically rank for. Return ONLY minified JSON: {"keywords":["...", ...]}`
    case 'idea':
      return `Post angle: ${ctx.angle}\nTarget keywords: ${ctx.keywords.join(', ')}\n\n${NO_FABRICATION}\n\nWrite one specific blog post idea (a concrete headline concept, not a restatement of the angle) and a two-sentence description of what it covers. Return ONLY minified JSON: {"idea":"...","description":"..."}`
    case 'body':
      return `Write a blog post of roughly 700-900 words, in markdown, for a travel agency's blog.\n\nIdea: ${ctx.idea}\nDescription: ${ctx.description}\nTarget keywords (work them in naturally, don't stuff): ${ctx.keywords.join(', ')}\n\n${NO_FABRICATION}\n\nFormat rules: start with a one-paragraph hook (no heading before it), use 3-5 "##" section headings, use a short bullet list somewhere it helps scanability, write in a warm and practical tone, and do not include a title heading (the title is generated separately) or a call-to-action link (the site adds its own). Output raw markdown only, no commentary before or after it.`
    case 'title':
      return `Idea: ${ctx.idea}\nDescription: ${ctx.description}\n\nWrite: a punchy post title (under 65 characters), an SEO title (under 60 characters, can equal the title), an SEO meta description (under 155 characters), and a one-sentence excerpt for a blog card. Return ONLY minified JSON: {"title":"...","seo_title":"...","seo_description":"...","excerpt":"..."}`
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

/** Turn a topic angle into a full draft post. Returns null when the AI is unconfigured, any step
 * fails, or a step's output didn't parse - the caller falls back to the static topic cluster on
 * the next run rather than publishing a half-written post. */
export async function composeFullPost(angle: string, seedKeyword?: string): Promise<ComposedPost | null> {
  if (!isAiConfigured()) return null
  const ctx: ComposerContext = { angle, keywords: seedKeyword ? [seedKeyword] : [], idea: '', description: '' }

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

  const titleResult = await runComposerStep<{ title?: string; seo_title?: string; seo_description?: string; excerpt?: string }>('title', ctx)
  if (!titleResult || typeof titleResult !== 'object' || !titleResult.title) return null

  return {
    title: titleResult.title,
    slug: slugify(titleResult.title),
    body,
    excerpt: titleResult.excerpt ?? '',
    seo_title: titleResult.seo_title ?? titleResult.title,
    seo_description: titleResult.seo_description ?? '',
    tags: ctx.keywords.slice(0, 5),
  }
}

const PLACEHOLDER_PATTERNS = [/\[.*?\]/, /lorem ipsum/i, /todo/i, /insert .* here/i]
const REFUSAL_PATTERNS = [/i (cannot|can't|won'?t) (write|generate|help|comply)/i, /as an ai( language model)?/i]
const EXPERIENCE_CLAIM_PATTERNS = [/\bwhen i (visited|went|traveled|stayed)\b/i, /\bmy (trip|visit|stay|experience) to\b/i, /\bi (recently|personally) (visited|went)\b/i]

/** Reasons a composed post must not auto-publish. Empty means it's clean. This is the quality
 * gate PARITY-SPEC's owner rules call for ("no approval gates, only quality gates") - it runs
 * whether or not a human ever looks at the draft. */
export function autoPublishBlockers(post: ComposedPost, now: Date = new Date()): string[] {
  const blockers: string[] = []
  const wordCount = post.body.trim().split(/\s+/).filter(Boolean).length
  if (wordCount < 450) blockers.push(`too short (${wordCount} words)`)
  if (!/^##\s/m.test(post.body)) blockers.push('no section headings')
  if (PLACEHOLDER_PATTERNS.some((p) => p.test(post.body) || p.test(post.title))) blockers.push('placeholder text')
  if (REFUSAL_PATTERNS.some((p) => p.test(post.body))) blockers.push('model refusal in body')
  if (EXPERIENCE_CLAIM_PATTERNS.some((p) => p.test(post.body))) blockers.push('fabricated personal experience claim')
  const staleYear = post.title.match(/\b(20\d{2})\b/)
  if (staleYear && staleYear[1] !== todayEt(now).slice(0, 4)) blockers.push(`stale year in title (${staleYear[1]})`)
  return blockers
}
