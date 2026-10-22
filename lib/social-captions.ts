import { callAnthropic, anthropicText, parseModelJson, isAiConfigured } from '@/lib/ai-verify'
import { captionShapeProblems, captionFormatRules } from '@/lib/hook-rules'
import { firstLineProblems, wantsCommentPrompt, HOOK_LINE_MAX_CHARS } from '@/lib/caption-plan'
import { HOOK_STYLE_PROMPTS, CTA_STYLE_PROMPTS, HASHTAG_RULES, hashtagCapFor, normaliseHashtags, ungroundedNumbers, repairDashes, type HookStyle, type CtaStyle } from '@/lib/hook-styles'

// Per-platform caption generation + mechanical limit enforcement (factory spec: "one model call
// writes every network's caption at once, each tailored to that network's actual constraints" +
// "a second, mechanical enforcement pass re-checks whatever the model returned against hard
// limits in plain code, not trusting it to have gotten every number exactly right"). The character
// limits below are each platform's own published limit - public facts, not invented.
//
// Scope note: Upload-Post's confirmed API (lib/upload-post.ts) takes ONE caption per call that
// applies to every platform named in that call - there is no per-platform text field. Real voice
// tailoring therefore means one Upload-Post call PER PLATFORM (each with its own generated+fitted
// text), not one call for the whole list - lib/distribution.ts does this. That multiplies
// Upload-Post's metered "uploads used this period" quota by however many platforms are
// configured; distribution_mode is off by default, so this has no live effect until Joel turns it
// on, and he'll see this exact tradeoff documented here and in the admin UI before he does.
export const PLATFORM_CHAR_LIMITS: Record<string, number> = {
  twitter: 280,
  x: 280,
  bluesky: 300,
  threads: 500,
  pinterest: 500,
  tiktok: 2200,
  instagram: 2200,
  facebook: 63206,
  linkedin: 3000,
  youtube: 5000,
}
/** Conservative fallback for a platform not in the table above - better to truncate a bit early
 * than to silently exceed an unlisted network's real limit. */
const DEFAULT_CHAR_LIMIT = 280

/** The tightest limit among the platforms a caption is about to go out to - the caption has to
 * fit all of them in one shared call, so it's bounded by whichever is most restrictive. */
export function tightestLimit(platforms: string[]): number {
  if (platforms.length === 0) return DEFAULT_CHAR_LIMIT
  return Math.min(...platforms.map((p) => PLATFORM_CHAR_LIMITS[p.toLowerCase()] ?? DEFAULT_CHAR_LIMIT))
}

/** Trims text to fit `limit`, cutting at the last whole word that still fits and appending an
 * ellipsis - never a mid-word or mid-URL cut, and never silently over the real limit. */
export function fitCaption(text: string, limit: number): string {
  if (text.length <= limit) return text
  const ELLIPSIS = '…'
  const budget = limit - ELLIPSIS.length
  if (budget <= 0) return text.slice(0, Math.max(limit, 0))
  const cut = text.slice(0, budget)
  const lastSpace = cut.lastIndexOf(' ')
  const trimmed = lastSpace > budget * 0.6 ? cut.slice(0, lastSpace) : cut
  return `${trimmed.trimEnd()}${ELLIPSIS}`
}

/** Fits `body` plus a trailing link into `limit`, cutting only the body, so the link is never trimmed
 * (a half-cut URL is worse than a shorter caption). The link alone if there is no room for any text. */
export function fitCaptionWithLink(body: string, link: string, limit: number): string {
  const whole = [body, link].filter(Boolean).join('\n\n')
  if (whole.length <= limit) return whole
  const room = limit - link.length - 2
  if (room < 40) return link
  return `${fitCaption(body, room)}\n\n${link}`
}

/** Platform-specific voice notes - not just a character limit, real conventions that make a
 * caption feel native to the network instead of a generic blurb pasted everywhere. Kept as data,
 * not scattered through the prompt string, so adding a network is one line. */
const PLATFORM_VOICE: Record<string, string> = {
  twitter: 'punchy, a link reads fine inline',
  x: 'punchy, a link reads fine inline',
  instagram: 'warm and conversational, a link in the text will not be clickable so do not tell the reader to "click the link", say "link in bio" style phrasing instead',
  tiktok: 'casual and energetic, short sentences',
  linkedin: 'professional but still warm (this is a travel agency, not a law firm), no hashtag stuffing, can be the longest/most detailed of the set',
  facebook: 'friendly, conversational, a real link is fine and expected',
  threads: 'short, conversational, like a tweet but a bit more relaxed',
  bluesky: 'short, conversational',
  pinterest: 'descriptive and keyword-rich (people search Pinterest like a search engine), can read a bit more like a caption+description than a casual post',
  youtube: 'can be the most detailed - this is a video description, not a quick caption',
}

export interface PlatformCaptions {
  [platform: string]: string
}

/** Optional per-network steering for generatePlatformCaptions. Every field is optional and keyed by
 * the exact platform string passed in `platforms`; a network with no entry is written exactly as it
 * was before this existed. */
export interface CaptionOpts {
  hookStyles?: Record<string, HookStyle>
  ctaStyles?: Record<string, CtaStyle>
  /** The link to put in each network's caption (already UTM-tagged for that network). Falls back to
   * the shared `link` argument for a network with no entry. */
  links?: Record<string, string>
  /** The post's FAQ and key takeaways as plain text. Only used so numbers in them count as real. */
  grounding?: string
  /** Networks whose first line must end with a question mark (at least half of them, see lib/caption-plan.ts). */
  questionFirstLine?: Record<string, boolean>
  /** One comment prompt line (a question that invites a reply) for the networks that carry one: Instagram, Facebook, Threads. */
  commentPrompts?: Record<string, string>
  /** The post's primary keyword: the first line should contain it when that reads naturally (asked in the prompt, not enforced). */
  keyword?: string | null
}

/** The long dash character, built from its code so this file never contains one itself. */
const EM_DASH = String.fromCharCode(8212)

/** Networks whose caption link is plain text, not clickable, so a missing link is not a defect. */
const LINK_NOT_CLICKABLE = ['instagram', 'tiktok']
export const networkSupportsLinks = (network: string) => !LINK_NOT_CLICKABLE.includes(network.toLowerCase())

/** "link in bio", "link in our bio", "link in my bio" and "link in the bio" all count. */
const BIO_PHRASE = /\blink\s+in\s+(?:our|my|the)?\s*bio\b/i
/** A line that tells the reader what to do next (a plain verb or a "full guide" pointer). */
const CTA_LINE = /\b(?:read|see|plan|get|book|find|start|learn|compare|check|visit|tap|full (?:guide|update)|details|more)\b/i

/** True when the caption has a call to action. Bio networks (Instagram, TikTok) need the "link in bio" words; every other
 * network needs a line after the hook that is not the link or the hashtags and reads as a next step. */
export function hasCallToAction(caption: string, network: string, sharedLink?: string): boolean {
  // A bio network that shares one caption with a clickable network (a mixed carousel send) may carry the tagged link instead.
  if (!networkSupportsLinks(network) && !(sharedLink && caption.includes(sharedLink) && hasCallToAction(caption, 'facebook'))) return BIO_PHRASE.test(caption)
  const lines = caption.split('\n').map((l) => l.trim()).filter(Boolean)
  return lines.slice(1).some((l) => !/^https?:\/\//i.test(l) && !/^(?:#\S+\s*)+$/.test(l) && CTA_LINE.test(l.replace(/https?:\/\/\S+/gi, '')))
}

const stripUrls = (text: string) => text.replace(/https?:\/\/\S+/gi, ' ')
const normaliseLine = (s: string) =>
  s
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

/** Plain-code quality gate for one network's caption (never trusts the model). Returns a list of
 * problems, empty when the caption is fine to send:
 *  - longer than the network's real character limit
 *  - the first line is just the post title again (no hook)
 *  - a number that is not in the post title, summary or grounding text (links are ignored)
 *  - no link on a network where links are clickable
 *  - an em dash anywhere
 *  - the shape rules in lib/hook-rules.ts (weak opener, missing hook line, more than 2 emojis, more than 10
 *    hashtags, a line in capitals, a paragraph wall) */
export function captionProblems(
  caption: string,
  ctx: { title: string; summary: string | null; network: string; link: string; grounding?: string | null },
): string[] {
  const problems: string[] = []
  const limit = PLATFORM_CHAR_LIMITS[ctx.network.toLowerCase()] ?? DEFAULT_CHAR_LIMIT
  if (caption.length > limit) problems.push(`over the ${limit} character limit (${caption.length})`)

  const firstLine = caption.split('\n').find((l) => l.trim()) ?? ''
  const firstNorm = normaliseLine(firstLine)
  const titleNorm = normaliseLine(ctx.title)
  if (firstNorm && titleNorm && (firstNorm === titleNorm || firstNorm.startsWith(titleNorm))) problems.push('opening line is the post title again')

  const stray = ungroundedNumbers(caption, `${ctx.title} ${ctx.summary ?? ''} ${ctx.grounding ?? ''}`)
  if (stray.length) problems.push(`number not in the post: ${stray.join(', ')}`)

  // After the link and hashtags are removed there must be real words left (a trimmed caption can end up as just the link).
  if (stripUrls(caption).replace(/#\S+/g, '').trim().length < 25) problems.push('no text besides the link')

  if (ctx.link && networkSupportsLinks(ctx.network) && !caption.includes(ctx.link)) problems.push('link is missing')
  // Call to action: the bio networks must say "link in bio"; every other network needs a plain-words next step line.
  if (!hasCallToAction(caption, ctx.network, ctx.link)) problems.push('call to action is missing')
  if (caption.includes(EM_DASH)) problems.push('contains an em dash')
  // Hooks-in-content shape rules: weak opener, missing hook line, emoji and hashtag ceilings, shouting, paragraph walls.
  problems.push(...captionShapeProblems(caption, ctx.network))
  return problems
}

/** The short line people can remember and say out loud, for the networks where a link cannot be tapped. */
export const WORD_OF_MOUTH_LINE = 'Easy to remember: travelfunbiz.ca'

/** One reel caption goes to Instagram, TikTok, YouTube and Facebook in a single send, so its call to action names both ways in:
 * the bio link (Instagram, TikTok) and the tagged link right under it (YouTube, Facebook). */
export const VIDEO_CTA_LINE = 'Plan your trip: link in bio, or tap here:'

/** The shared reel caption: title, description, call to action, the UTM link, hashtags last. Only the text is ever cut; the CTA and link stay. */
export function buildVideoCaption(parts: { title: string; description?: string; hashtags?: string[] }, link: string, limit: number): string {
  const body = [parts.title, parts.description].map((s) => (s ?? '').trim()).filter(Boolean).join('\n\n')
  const tags = (parts.hashtags ?? []).join(' ').trim()
  const tail = `${VIDEO_CTA_LINE}\n${link}`
  const withTags = tags ? `${tail}\n\n${tags}` : tail
  const chosen = withTags.length + 2 + Math.min(body.length, 40) <= limit ? withTags : tail
  return fitCaptionWithLink(body, chosen, limit)
}

/** Splits trailing hashtag-only lines off a caption so a call to action can go in before them. */
function splitTrailingHashtags(caption: string): { body: string; tags: string } {
  const lines = caption.trimEnd().split('\n')
  let i = lines.length
  while (i > 0 && (!lines[i - 1].trim() || /^(?:#[\p{L}\p{N}_]+\s*)+$/u.test(lines[i - 1].trim()))) i--
  return { body: lines.slice(0, i).join('\n').trimEnd(), tags: lines.slice(i).join('\n').trim() }
}

/** Deterministic repair of a caption that has no call to action or no link: appends the standard CTA line (and the link on
 * networks where it is clickable, or "link in bio" plus the word-of-mouth line on Instagram and TikTok) before the hashtags,
 * then fits the limit without cutting the CTA or the link. The post is repaired, never dropped for this. Idempotent. */
export function repairCaptionCta(caption: string, ctx: { network: string; link: string; kind?: 'news' | null; limit?: number }): string {
  const limit = ctx.limit ?? PLATFORM_CHAR_LIMITS[ctx.network.toLowerCase()] ?? DEFAULT_CHAR_LIMIT
  const text = caption.trim()
  if (!networkSupportsLinks(ctx.network)) {
    const { body, tags } = splitTrailingHashtags(text)
    const hasBio = BIO_PHRASE.test(text)
    const hasName = /travelfunbiz\.ca/i.test(text.replace(/https?:\/\/\S+/gi, ''))
    if (hasBio && hasName) return text
    const bioLine = ctx.kind === 'news' ? NEWS_BIO_CTA_LINE : BIO_CTA_LINE
    const block = [hasBio ? '' : bioLine, hasName ? '' : WORD_OF_MOUTH_LINE].filter(Boolean).join('\n')
    const tail = [block, tags].filter(Boolean).join('\n\n')
    const whole = [body, tail].filter(Boolean).join('\n\n')
    if (whole.length <= limit) return whole
    const shortTail = block
    return fitCaptionWithLink(body, shortTail, limit)
  }
  const link = ctx.link.trim()
  if (!link) return text
  const ctaLine = ctx.kind === 'news' ? NEWS_CTA_LINE : FALLBACK_CTA_LINE
  let out = text
  if (!out.includes(link)) {
    const { body, tags } = splitTrailingHashtags(out)
    const withCta = hasCallToAction(body, ctx.network) ? body : `${body}\n\n${ctaLine}`
    out = [withCta, link, tags].filter(Boolean).join('\n\n').replace(`${ctaLine}\n\n${link}`, `${ctaLine}\n${link}`)
  } else if (!hasCallToAction(out, ctx.network)) {
    out = out.replace(link, `${ctaLine}\n${link}`)
  }
  return fitKeepingLink(out, link, limit)
}

/** Stored facts the no-AI fallback caption is built from. Nothing here is invented: every field is read from the post or guide. */
export interface FallbackCaptionFacts {
  title: string
  metaDescription: string | null | undefined
  faqQuestions?: ReadonlyArray<unknown> | null
  keyTakeaways?: ReadonlyArray<unknown> | null
  tags?: ReadonlyArray<unknown> | null
  category?: string | null
  /** 'news' for a travel news post: its caption is always the deterministic one, with the news call to action below. */
  kind?: 'news' | null
}

/** The fixed plain-words call to action on line 3 of a fallback caption. */
export const FALLBACK_CTA_LINE = 'Read the full guide:'
/** The call to action for Instagram and TikTok, where a caption link is plain text and cannot be tapped. */
export const BIO_CTA_LINE = 'Full guide: link in our bio.'
/** The same two lines for travel news posts, which point at a short update and the official source, not a guide. */
export const NEWS_CTA_LINE = 'Read the full update and the official source:'
export const NEWS_BIO_CTA_LINE = 'Full update and the official source: link in our bio.'

/** Picks the fallback call to action. Bio wording (no URL in the text) only when every target network has a
 * non-clickable caption link; any clickable network in the list keeps the link wording so the link is never lost. */
export function fallbackCtaFor(networks: ReadonlyArray<string>, kind?: 'news' | null): { line: string; includeLink: boolean } {
  const bio = networks.length > 0 && networks.every((n) => !networkSupportsLinks(n))
  if (kind === 'news') return bio ? { line: NEWS_BIO_CTA_LINE, includeLink: false } : { line: NEWS_CTA_LINE, includeLink: true }
  return bio ? { line: BIO_CTA_LINE, includeLink: false } : { line: FALLBACK_CTA_LINE, includeLink: true }
}
const HOOK_MAX = 140

const cleanLine = (s: unknown): string => (typeof s === 'string' ? repairDashes(s).replace(/\s+/g, ' ').trim() : '')

/** A caption with no AI call: line 1 is the first stored FAQ question (else the first key takeaway) as the hook,
 * line 2 one short line from the meta description, line 3 a fixed call to action, then the link, then 0 to 3
 * hashtags from the stored category and tags. Returns null when there is no usable hook, or the result fails
 * captionProblems, or it cannot fit `limit` with the link intact; the caller then uses its old text. */
export function buildFallbackCaption(
  facts: FallbackCaptionFacts,
  network: string,
  link: string,
  opts: { limit?: number; hashtagCap?: number; networks?: ReadonlyArray<string>; commentPrompt?: string | null } = {},
): string | null {
  const limit = opts.limit ?? PLATFORM_CHAR_LIMITS[network.toLowerCase()] ?? DEFAULT_CHAR_LIMIT
  const questions = (facts.faqQuestions ?? []).map(cleanLine).filter((q) => q && q.length <= HOOK_MAX)
  const takeaways = (facts.keyTakeaways ?? []).map(cleanLine).filter((t) => t && t.length <= HOOK_MAX)
  // The first line is read in the feed preview, so a short stored question (80 characters) is preferred over a longer one.
  const hook = questions.find((q) => q.length <= HOOK_LINE_MAX_CHARS) ?? questions[0] ?? takeaways.find((t) => t.length <= HOOK_LINE_MAX_CHARS) ?? takeaways[0]
  const link0 = link.trim()
  if (!hook || !link0) return null

  const description = cleanLine(facts.metaDescription)
  const bodyFull = description && description !== hook ? description : ''
  const cap = Math.min(opts.hashtagCap ?? hashtagCapFor(network), 3)
  const tags = normaliseHashtags([facts.category, ...(facts.tags ?? [])], cap).join(' ')

  const cta = fallbackCtaFor(opts.networks?.length ? opts.networks : [network], facts.kind)
  // One comment prompt line (Instagram, Facebook, Threads) is its own block between the hook block and the call to action, so no block
  // is more than 3 lines. It is the first thing dropped when the caption does not fit.
  const prompt = (opts.commentPrompt ?? '').trim()
  const build = (body: string, hashtags: string, withPrompt = !!prompt) => {
    const head = withPrompt ? [[hook, body].filter(Boolean).join('\n'), prompt, cta.line].join('\n\n') : [hook, body, cta.line].filter(Boolean).join('\n')
    return cta.includeLink ? [head, `${link0}${hashtags ? `\n\n${hashtags}` : ''}`].join('\n\n') : [head, WORD_OF_MOUTH_LINE, hashtags].filter(Boolean).join('\n\n')
  }
  let caption = build(bodyFull, tags)
  if (caption.length > limit) caption = build(bodyFull, '')
  if (caption.length > limit && prompt) caption = build(bodyFull, '', false)
  if (caption.length > limit && bodyFull) {
    const room = limit - build('', '', false).length - 1
    caption = room >= 30 ? build(fitCaption(bodyFull, room), '', false) : build('', '', false)
  }
  if (caption.length > limit) return null

  const grounding = [facts.faqQuestions?.join(' '), facts.keyTakeaways?.join(' ')].filter(Boolean).join(' ')
  const problems = captionProblems(caption, { title: facts.title, summary: facts.metaDescription ?? null, network, link: link0, grounding })
  return problems.length === 0 ? caption : null
}

/** Groups networks that can safely share one send: same character limit, same hashtag cap and same link
 * clickability. Pure; never returns more groups than networks, and keeps the input order. */
export function groupNetworksForSend(platforms: ReadonlyArray<string>): string[][] {
  const groups = new Map<string, string[]>()
  for (const p of platforms) {
    const key = `${PLATFORM_CHAR_LIMITS[p.toLowerCase()] ?? DEFAULT_CHAR_LIMIT}|${hashtagCapFor(p)}|${networkSupportsLinks(p)}`
    const list = groups.get(key)
    if (list) list.push(p)
    else groups.set(key, [p])
  }
  return [...groups.values()]
}

/** One caption per network, each built at that network's own limit and hashtag cap with that network's own
 * link. No AI. A network whose no-AI caption cannot be built gets the old title + description + link text,
 * trimmed to its limit with the link kept. */
export function buildNetworkFallbacks(
  facts: FallbackCaptionFacts,
  platforms: ReadonlyArray<string>,
  linkFor: (network: string) => string,
  commentPromptFor?: (network: string) => string | null | undefined,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const p of platforms) {
    const limit = PLATFORM_CHAR_LIMITS[p.toLowerCase()] ?? DEFAULT_CHAR_LIMIT
    const link = linkFor(p)
    const built = buildFallbackCaption(facts, p, link, { networks: [p], limit, hashtagCap: hashtagCapFor(p), commentPrompt: wantsCommentPrompt(p) ? commentPromptFor?.(p) : null })
    if (built) {
      out[p] = built
      continue
    }
    const body = [facts.title, facts.metaDescription].filter(Boolean).join('\n\n')
    // Last resort still carries the platform's call to action: "link in bio" plus the short line, or the UTM link.
    out[p] = repairCaptionCta(networkSupportsLinks(p) ? fitCaptionWithLink(body, link, limit) : body, { network: p, link, kind: facts.kind, limit })
  }
  return out
}

/** Cuts a too-long caption down without ever cutting the link (see fitCaptionWithLink). */
function fitKeepingLink(text: string, link: string, limit: number): string {
  if (text.length <= limit) return text
  if (link && text.includes(link)) {
    const body = text.replace(link, '').replace(/\n{3,}/g, '\n\n').trim()
    return fitCaptionWithLink(body, link, limit)
  }
  return fitCaption(text, limit)
}

/** The prompt for the caption writer. Pure, so scripts/check-hooks-in-content.ts can assert on its content offline. */
export function buildCaptionPrompt(
  postTitle: string,
  postDescription: string | null,
  link: string,
  platforms: string[],
  opts: CaptionOpts = {},
): string {
  const linkFor = (p: string) => opts.links?.[p] || link
  const platformRules = platforms
    .map((p) => {
      const key = p.toLowerCase()
      const limit = PLATFORM_CHAR_LIMITS[key] ?? DEFAULT_CHAR_LIMIT
      const voice = PLATFORM_VOICE[key] ?? 'clear and friendly, no specific platform convention known - keep it generic but not robotic'
      const hook = opts.hookStyles?.[p]
      const cta = opts.ctaStyles?.[p]
      const hashtags = HASHTAG_RULES[key]
      const commentPrompt = opts.commentPrompts?.[p]
      return [
        `- ${p}: under ${limit} characters. Voice: ${voice}.`,
        hook ? `  Hook style (first line): ${hook}, meaning ${HOOK_STYLE_PROMPTS[hook]}.` : '',
        `  First line: at most ${HOOK_LINE_MAX_CHARS} characters${opts.keyword ? `, and it contains the phrase "${opts.keyword}" when that reads naturally` : ''}${opts.questionFirstLine?.[p] ? ', and it ENDS WITH A QUESTION MARK' : ''}.`,
        commentPrompt ? `  Body: include this comment prompt as its own short block, word for word: ${commentPrompt}` : '',
        cta ? `  Call to action style: ${cta}, meaning ${CTA_STYLE_PROMPTS[cta]}.` : '',
        hashtags ? `  Hashtags: ${hashtags}.` : '',
        `  Link to include for ${p}, copied exactly as written: ${linkFor(p)}`,
      ]
        .filter(Boolean)
        .join('\n')
    })
    .join('\n')

  const prompt = `You write social media captions for a travel agency's blog post, one per platform, each genuinely adapted to that platform's real conventions - never the same text copy-pasted across platforms.

Post title: ${postTitle}
${postDescription ? `Post summary: ${postDescription}\n` : ''}${opts.grounding ? `Facts from the post you may rely on:\n${opts.grounding}\n` : ''}
Write one caption for each of these platforms, following its own rules:
${platformRules}

Structure of every caption: a hook line first (in the hook style named for that platform when one is given, and never just the post title repeated), then a short body adapted to the network, then one call to action line, then that platform's link on its own line, then hashtags last if the platform uses any.

${captionFormatRules()}

The call to action is exactly one concrete next step the reader can take on the post page, in plain words, with no urgency, no promised discounts, availability or replies. Do not promise anything the post does not offer.

Never use an em dash (the long dash character); use a comma or a full stop instead. Never write a number that is not in the post title, summary or facts above. Never invent a claim, price, date or detail not given above, and never claim to have visited, tried or booked anything - these captions only ever describe a real blog post, nothing more. Return ONLY minified JSON of this exact shape: {"captions":{"<platform>":"<caption text>", ...}} with exactly one entry per platform listed above, using the same platform name as given.`
  return prompt
}

/** One model call writes every requested platform's caption at once (same post, same facts, each
 * voice genuinely adapted to its network) - never the same string copy-pasted everywhere. Returns
 * null when the AI is unconfigured or the call fails; caller falls back to the one shared generic
 * caption, same "never block the post over this" rule as every other AI step in this project. */
export async function generatePlatformCaptions(
  postTitle: string,
  postDescription: string | null,
  link: string,
  platforms: string[],
  opts: CaptionOpts = {},
): Promise<PlatformCaptions | null> {
  if (!isAiConfigured() || platforms.length === 0) return null

  const linkFor = (p: string) => opts.links?.[p] || link
  const prompt = buildCaptionPrompt(postTitle, postDescription, link, platforms, opts)

  try {
    const r = await callAnthropic({ max_tokens: 1500, messages: [{ role: 'user', content: prompt }] }, { timeoutMs: 40_000, feature: 'social-captions' })
    if (!r || !r.res.ok) return null
    const parsed = parseModelJson<{ captions?: Record<string, string> }>(anthropicText(await r.res.json()))
    const captions = parsed?.captions
    if (!captions || typeof captions !== 'object') return null
    // Model output is untrusted: only keep entries for platforms actually requested, with real
    // non-empty string values, and mechanically re-fit each to its own real limit regardless of
    // what the model thought it was doing - same "never trust the model got the number right" rule.
    // A caption that then fails the plain-code gate (captionProblems) is left out of the result, so
    // that network falls back to the shared generic caption in lib/distribution.ts: the post still
    // goes out, only with the safer text.
    const result: PlatformCaptions = {}
    for (const p of platforms) {
      const raw = captions[p]
      if (typeof raw !== 'string' || !raw.trim()) continue
      const limit = PLATFORM_CHAR_LIMITS[p.toLowerCase()] ?? DEFAULT_CHAR_LIMIT
      // An em dash is repaired rather than failed: swapping it for a comma changes no fact.
      const cleaned = repairDashes(raw.trim())
      let fitted = fitKeepingLink(cleaned, linkFor(p), limit)
      const ctx = { title: postTitle, summary: postDescription, network: p, link: linkFor(p), grounding: opts.grounding }
      // A missing link or call to action is repaired with the standard CTA line (never a reason to drop the caption).
      if (captionProblems(fitted, ctx).some((x) => x === 'link is missing' || x === 'call to action is missing')) {
        fitted = repairCaptionCta(fitted, { network: p, link: linkFor(p), limit })
      }
      // A comment prompt line the writer left out is added as its own block after the first block, when it still fits the limit.
      const wanted = opts.commentPrompts?.[p]
      if (wanted && wantsCommentPrompt(p) && !fitted.includes(wanted)) {
        const blocks = fitted.split('\n\n')
        const withPrompt = [blocks[0], wanted, ...blocks.slice(1)].join('\n\n')
        if (blocks.length > 1 && withPrompt.length <= limit) fitted = withPrompt
      }
      const problems = [...captionProblems(fitted, ctx), ...firstLineProblems(fitted, { requireQuestion: !!opts.questionFirstLine?.[p] })]
      if (problems.length === 0) result[p] = fitted
      else console.warn(`[social-captions] ${p} caption dropped, using the shared caption: ${problems.join('; ')}`)
    }
    return Object.keys(result).length > 0 ? result : null
  } catch {
    return null
  }
}
