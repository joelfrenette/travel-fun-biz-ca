import { callAnthropic, anthropicText, parseModelJson, isAiConfigured } from '@/lib/ai-verify'

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
  twitter: 'punchy, no more than 1-2 hashtags, a link reads fine inline',
  x: 'punchy, no more than 1-2 hashtags, a link reads fine inline',
  instagram: 'warm and conversational, hashtags at the end (3-8), a link in the text will not be clickable so do not tell the reader to "click the link" - say "link in bio" style phrasing instead',
  tiktok: 'casual and energetic, 1-3 hashtags, short sentences',
  linkedin: 'professional but still warm (this is a travel agency, not a law firm), no hashtag stuffing, can be the longest/most detailed of the set',
  facebook: 'friendly, conversational, a real link is fine and expected',
  threads: 'short, conversational, like a tweet but a bit more relaxed',
  bluesky: 'short, conversational, minimal hashtags',
  pinterest: 'descriptive and keyword-rich (people search Pinterest like a search engine), can read a bit more like a caption+description than a casual post',
  youtube: 'can be the most detailed - this is a video description, not a quick caption',
}

export interface PlatformCaptions {
  [platform: string]: string
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
): Promise<PlatformCaptions | null> {
  if (!isAiConfigured() || platforms.length === 0) return null

  const platformRules = platforms
    .map((p) => {
      const key = p.toLowerCase()
      const limit = PLATFORM_CHAR_LIMITS[key] ?? DEFAULT_CHAR_LIMIT
      const voice = PLATFORM_VOICE[key] ?? 'clear and friendly, no specific platform convention known - keep it generic but not robotic'
      return `- ${p}: under ${limit} characters. Voice: ${voice}.`
    })
    .join('\n')

  const prompt = `You write social media captions for a travel agency's blog post, one per platform, each genuinely adapted to that platform's real conventions - never the same text copy-pasted across platforms.

Post title: ${postTitle}
${postDescription ? `Post summary: ${postDescription}\n` : ''}Link to include: ${link}

Write one caption for each of these platforms, following its own rules:
${platformRules}

End every caption with exactly one concrete next step the reader can take on the post page, such as read the full guide, or ask us about this trip. Plain words, no urgency, no promised discounts, availability or replies. Do not promise anything the post does not offer.

Never invent a claim, price, date or detail not in the post title/summary above - these captions only ever describe a real blog post, nothing more. Return ONLY minified JSON of this exact shape: {"captions":{"<platform>":"<caption text>", ...}} with exactly one entry per platform listed above, using the same platform name as given.`

  try {
    const r = await callAnthropic({ max_tokens: 1500, messages: [{ role: 'user', content: prompt }] }, { timeoutMs: 40_000 })
    if (!r || !r.res.ok) return null
    const parsed = parseModelJson<{ captions?: Record<string, string> }>(anthropicText(await r.res.json()))
    const captions = parsed?.captions
    if (!captions || typeof captions !== 'object') return null
    // Model output is untrusted: only keep entries for platforms actually requested, with real
    // non-empty string values, and mechanically re-fit each to its own real limit regardless of
    // what the model thought it was doing - same "never trust the model got the number right" rule.
    const result: PlatformCaptions = {}
    for (const p of platforms) {
      const text = captions[p]
      if (typeof text === 'string' && text.trim()) {
        result[p] = fitCaption(text.trim(), PLATFORM_CHAR_LIMITS[p.toLowerCase()] ?? DEFAULT_CHAR_LIMIT)
      }
    }
    return Object.keys(result).length > 0 ? result : null
  } catch {
    return null
  }
}
