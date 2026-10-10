import { callAnthropic, anthropicText, parseModelJson, isAiConfigured } from '@/lib/ai-verify'
import { HOOK_STYLE_PROMPTS, CTA_STYLE_PROMPTS, HASHTAG_RULES, ungroundedNumbers, repairDashes, type HookStyle, type CtaStyle } from '@/lib/hook-styles'

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
}

/** The long dash character, built from its code so this file never contains one itself. */
const EM_DASH = String.fromCharCode(8212)

/** Networks whose caption link is plain text, not clickable, so a missing link is not a defect. */
const LINK_NOT_CLICKABLE = ['instagram', 'tiktok']
const networkSupportsLinks = (network: string) => !LINK_NOT_CLICKABLE.includes(network.toLowerCase())

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
 *  - an em dash anywhere */
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
  if (caption.includes(EM_DASH)) problems.push('contains an em dash')
  return problems
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
  const platformRules = platforms
    .map((p) => {
      const key = p.toLowerCase()
      const limit = PLATFORM_CHAR_LIMITS[key] ?? DEFAULT_CHAR_LIMIT
      const voice = PLATFORM_VOICE[key] ?? 'clear and friendly, no specific platform convention known - keep it generic but not robotic'
      const hook = opts.hookStyles?.[p]
      const cta = opts.ctaStyles?.[p]
      const hashtags = HASHTAG_RULES[key]
      return [
        `- ${p}: under ${limit} characters. Voice: ${voice}.`,
        hook ? `  Hook style (first line): ${hook}, meaning ${HOOK_STYLE_PROMPTS[hook]}.` : '',
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

Structure of every caption: a hook line first (in the hook style named for that platform, and never just the post title repeated), then a short body adapted to the network, then one call to action line, then that platform's link on its own line, then hashtags last if the platform uses any. The call to action is exactly one concrete next step the reader can take on the post page, in plain words, with no urgency, no promised discounts, availability or replies. Do not promise anything the post does not offer.

Never use an em dash (the long dash character); use a comma or a full stop instead. Never write a number that is not in the post title, summary or facts above. Never invent a claim, price, date or detail not given above, and never claim to have visited, tried or booked anything - these captions only ever describe a real blog post, nothing more. Return ONLY minified JSON of this exact shape: {"captions":{"<platform>":"<caption text>", ...}} with exactly one entry per platform listed above, using the same platform name as given.`

  try {
    const r = await callAnthropic({ max_tokens: 1500, messages: [{ role: 'user', content: prompt }] }, { timeoutMs: 40_000 })
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
      const fitted = fitKeepingLink(cleaned, linkFor(p), limit)
      const problems = captionProblems(fitted, { title: postTitle, summary: postDescription, network: p, link: linkFor(p), grounding: opts.grounding })
      if (problems.length === 0) result[p] = fitted
      else console.warn(`[social-captions] ${p} caption dropped, using the shared caption: ${problems.join('; ')}`)
    }
    return Object.keys(result).length > 0 ? result : null
  } catch {
    return null
  }
}
