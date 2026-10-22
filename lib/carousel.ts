import type { SupabaseClient } from '@supabase/supabase-js'
import { getSetting, setSetting } from '@/lib/app-settings'
import { tagVariant } from '@/lib/content-variants'
import { callAnthropic, anthropicText, parseModelJson, isAiConfigured } from '@/lib/ai-verify'
import { findPortraitPhoto } from '@/lib/pexels'
import { COVER_HOOK_STYLES, CTA_STYLES, HOOK_STYLE_PROMPTS, CTA_STYLE_PROMPTS, rotateStyle, readRecentVariantValues, ungroundedNumbers, type HookStyle, type CtaStyle } from '@/lib/hook-styles'
import { normaliseSlides, finalizeCoverHeadline, resolveSlideType, type CarouselSlide } from '@/lib/carousel-slide'
import { fallbackCoverHeadline, headlineWords } from '@/lib/cover-headline'
import { shorterCoverHeadline, photoIdOf, COVER_ALT_MAX } from '@/lib/social-cover'
import { gateRenderedUrl } from '@/lib/visual-gate'

export type { CarouselSlide, SlideType } from '@/lib/carousel-slide'

// Carousels (factory item 4/6): the "missing middle" of the social funnel - reels build reach,
// carousels build trust (saves/shares are the strongest engagement signal Instagram/LinkedIn
// give). Cheap to generate from content that already exists: a published post turned into a
// fixed-length slide deck, each slide a headline + short body GENERATED from the post, not
// copy-pasted paragraphs.
const SLIDE_COUNT = 7 // enough to develop an idea, short enough to finish

/** Which hook style slide 1 uses and which call-to-action style the last slide uses. Both optional:
 * with neither, the prompt is the one it always was. */
export interface CarouselStyles {
  hookStyle?: HookStyle
  ctaStyle?: CtaStyle
}

function carouselPrompt(postTitle: string, postBody: string, styles: CarouselStyles = {}): string {
  const hookLine = styles.hookStyle ? `Slide 1's headline must use this hook style: ${styles.hookStyle}, meaning ${HOOK_STYLE_PROMPTS[styles.hookStyle]}. It is the cover headline, so keep it to 3 to 6 words and at most 36 characters, and still true to the post.${styles.hookStyle === 'number' || styles.hookStyle === 'comparison' ? ' Reuse only numbers already in the post body above; if it has none, do not use a number at all.' : ''}` : ''
  const ctaLine = styles.ctaStyle ? `The last slide's call to action must use this style: ${styles.ctaStyle}, meaning ${CTA_STYLE_PROMPTS[styles.ctaStyle]}. The slide is a picture, so never print a web address or say "click"; refer to the full post instead.` : ''
  return `Turn this blog post into a ${SLIDE_COUNT}-slide Instagram/LinkedIn carousel. Each slide needs a type, a headline and a short body (under 24 words) - write them fresh, summarizing and developing the post's real points, never copy-pasting whole paragraphs verbatim.

Slide types:
- Slide 1 is type "cover". Its headline is printed huge on the cover picture: 3 to 6 words, at most 36 characters, no word over 12 characters, never ending on and, the, to, of, in, a, for, with, or, at or on. It must be a hook of one of these kinds: a question ending in a question mark; "X or Y"; "X vs Y"; "A to B by C"; "X plus Y"; a comma list of 3 or 4 places; a headline containing the word "decoded"; a quiz call to action; or a number that is already in the post. No colon, no dash, no emoji, no full stop at the end. Never start with Discover, Explore, Welcome, Introducing, Ultimate guide, Everything you need, Tips for, Guide to, Why you should or Have you ever wondered. The cover body is not shown on the picture.
- Use type "fact" for 1 or 2 of slides 2 to 6, and only when the post states a concrete fact or number. A fact slide's headline is ONE claim of at most 14 words, printed very large on a plain teal card (for example a price gap or a number of days taken straight from the post). Its body is a one-line source note, kept short.
- Every other slide is type "photo": a photo with a short headline (under 8 words) and a body under 24 words.

Post title: ${postTitle}

Post body:
${postBody}

Slide 1 should hook with the post's core promise. The last slide should be a soft call-to-action to read the full post or get in touch - never invent a specific price, date or offer not already in the post body above.${hookLine ? `\n${hookLine}` : ''}${ctaLine ? `\n${ctaLine}` : ''}
Never use an em dash (the long dash character) on any slide; use a comma or a full stop.

Every fact, number or claim on any slide must be traceable back to something actually stated in the post body above - never add a statistic, price or date that isn't already there.

Also give every slide imageQuery: 2 to 4 English words for a stock-photo search that visually fits that slide (a place, activity or mood such as "puerto plata beach" or "cruise ship deck at sunset"; never a person's name). It is only used to find a picture and is never shown.

Return ONLY minified JSON of this exact shape: {"slides":[{"type":"cover","headline":"...","body":"...","imageQuery":"..."},...]} with exactly ${SLIDE_COUNT} entries.`
}

/** Every number appearing on a slide must appear in the source post too - same hard gate the
 * admin's FAQ generator and the autoblog composer already enforce, applied here. Returns the
 * slides unchanged if none fail, or null if ANY slide can't be grounded (the whole carousel
 * either passes together or doesn't ship, not a partial deck). */
function enforceNumberGrounding(slides: CarouselSlide[], sourceText: string): CarouselSlide[] | null {
  // Digits and spelled-out numbers (two..twelve, dozen, hundred, thousand) both have to be in the post.
  for (const slide of slides) {
    if (ungroundedNumbers(`${slide.headline} ${slide.body}`, sourceText).length > 0) return null
  }
  return slides
}

/** The one retry for a cover headline that failed the rules: a small model call that returns only a headline. */
async function askShorterHeadline(instruction: string): Promise<string | null> {
  const r = await callAnthropic({ max_tokens: 200, messages: [{ role: 'user', content: `${instruction}\n\nReturn ONLY minified JSON of this exact shape: {"headline":"..."}` }] }, { timeoutMs: 20_000, feature: 'carousel' })
  if (!r || !r.res.ok) return null
  const parsed = parseModelJson<{ headline?: unknown }>(anthropicText(await r.res.json()))
  return typeof parsed?.headline === 'string' ? parsed.headline : null
}

type DeckAttempt ={ slides: CarouselSlide[] } | 'gate' | null

async function attemptDeck(postTitle: string, postBody: string, styles: CarouselStyles): Promise<DeckAttempt> {
  try {
    const r = await callAnthropic({ max_tokens: 2000, messages: [{ role: 'user', content: carouselPrompt(postTitle, postBody, styles) }] }, { timeoutMs: 40_000, feature: 'carousel' })
    if (!r || !r.res.ok) return null
    const parsed = parseModelJson<{ slides?: CarouselSlide[] }>(anthropicText(await r.res.json()))
    // Long dashes are swapped for a comma (no fact changes); the number gate below still runs on the result.
    const valid = normaliseSlides(parsed?.slides)
    if (valid.length === 0) return null
    // Slide 1 must carry a valid cover headline: one retry for a shorter one, then a whole phrase of the post title.
    const withCover = await finalizeCoverHeadline(valid, postTitle, postBody, askShorterHeadline)
    if (!withCover) return null
    const grounded = enforceNumberGrounding(withCover, `${postTitle} ${postBody}`)
    return grounded ? { slides: grounded } : 'gate'
  } catch {
    return null
  }
}

/** Generates a grounded carousel from a real post, or null if AI is unconfigured, the call fails,
 * or any slide fails the numeric-grounding gate (never ships a partially-fabricated deck). If the
 * number gate rejects a deck that was asked for a number or comparison hook, ONE retry is made with
 * the question hook (which needs no number) before giving up. Returns the hook style actually used. */
export async function generateCarouselDeck(postTitle: string, postBody: string, styles: CarouselStyles = {}): Promise<{ slides: CarouselSlide[]; hookStyle?: HookStyle } | null> {
  if (!isAiConfigured()) return null
  const first = await attemptDeck(postTitle, postBody, styles)
  if (first && first !== 'gate') return { slides: first.slides, hookStyle: styles.hookStyle }
  if (first === 'gate' && styles.hookStyle && styles.hookStyle !== 'question') {
    const retry = await attemptDeck(postTitle, postBody, { ...styles, hookStyle: 'question' })
    if (retry && retry !== 'gate') return { slides: retry.slides, hookStyle: 'question' }
  }
  return null
}

export async function generateCarouselSlides(postTitle: string, postBody: string, styles: CarouselStyles = {}): Promise<CarouselSlide[] | null> {
  return (await generateCarouselDeck(postTitle, postBody, styles))?.slides ?? null
}

export const carouselKey = (slug: string) => `carousel:${slug}`

// ---- Visual quality gate (lib/visual-gate.ts) ----------------------------------------------------------------------

export interface CarouselGateOutcome {
  /** pass: post it. skip: slide 1 failed its checks after 2 retries, never post. deferred: the check could not run (fetch or
   * decode failed), try again next tick. budget: out of time, try again next tick. */
  status: 'pass' | 'skip' | 'deferred' | 'budget'
  retries: number
  reasons: string[]
  /** Teal fact cards that failed their check and were redrawn as photo slides. */
  demotedFacts: number
  /** Whether the deck has a fact card (the teal-fact template is in use). */
  hasFact: boolean
  photoId: string | null
}

export interface CarouselGateInput {
  /** Site origin the slide route is fetched from. */
  base: string
  hasTime: () => boolean
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

/** The cover headline for a retry: a whole valid phrase of the post title when one exists and differs, else the same headline
 * cut to 4 words (first retry) or 3 words (second). Deterministic, no AI call. */
export function retryCoverHeadline(current: string, postTitle: string, attempt: number): string {
  if (attempt <= 1) {
    const phrase = fallbackCoverHeadline(postTitle)
    if (phrase && phrase.toLowerCase() !== current.toLowerCase() && headlineWords(phrase).length < headlineWords(current).length) return phrase
  }
  return shorterCoverHeadline(current, attempt)
}

/**
 * Renders slide 1 (and every teal fact card) through the public slide route and checks the pixels. A failing slide 1 is
 * retried twice with the next photo and a shorter headline (the stored deck is updated each time, no AI call), then the
 * carousel is reported as `skip`. A failing fact card is redrawn as a photo slide. A check that cannot run is `deferred`.
 * The slide route caches a day at the CDN, so every check carries its own cache-busting query; the address posted to the
 * network is the plain one.
 */
export async function gateCarouselCover(admin: SupabaseClient, post: { slug: string; title: string; cover_image_url?: string | null }, input: CarouselGateInput): Promise<CarouselGateOutcome> {
  let retries = 0
  let demotedFacts = 0
  let reasons: string[] = []
  let photoId: string | null = null
  const read = async (): Promise<CarouselSlide[]> => {
    const raw = await getSetting(admin, carouselKey(post.slug))
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? (parsed as CarouselSlide[]) : []
  }
  const write = async (slides: CarouselSlide[]) => {
    const { error } = await setSetting(admin, carouselKey(post.slug), JSON.stringify(slides))
    if (error) throw new Error(error)
  }
  const nonce = Date.now()
  const slideUrl = (n: number, tag: string) => `${input.base.replace(/\/$/, '')}/carousel/${encodeURIComponent(post.slug)}/${n}?gate=${nonce}-${tag}`
  const outcome = (status: CarouselGateOutcome['status'], hasFact = false): CarouselGateOutcome => ({ status, retries, reasons, demotedFacts, hasFact, photoId })

  try {
    let slides = await read()
    if (slides.length === 0) return outcome('deferred')
    const used = new Set<string>(slides.map((s) => s.imageUrl).filter((u): u is string => !!u))

    for (let attempt = 0; attempt <= COVER_ALT_MAX; attempt++) {
      if (!input.hasTime()) return outcome('budget')
      const r = await gateRenderedUrl(slideUrl(1, `c${attempt}`), 'cover', input.fetchImpl, input.timeoutMs)
      if (r.infra) {
        reasons = r.reasons
        return outcome('deferred')
      }
      photoId = r.photoId ?? photoIdOf(slides[0].imageUrl) ?? null
      if (r.ok) {
        reasons = []
        break
      }
      reasons = r.reasons
      if (attempt === COVER_ALT_MAX) return outcome('skip')
      // Retry: shorter headline and the next photo for slide 1.
      retries++
      const first = slides[0]
      const next = first.imageQuery ? await findPortraitPhoto(first.imageQuery, used) : null
      const fallbackPhoto = post.cover_image_url && !used.has(post.cover_image_url) ? post.cover_image_url : null
      const imageUrl = next ?? fallbackPhoto ?? undefined
      if (imageUrl) used.add(imageUrl)
      slides = [{ ...first, headline: retryCoverHeadline(first.headline, post.title, attempt + 1), ...(imageUrl ? { imageUrl } : {}) }, ...slides.slice(1)]
      await write(slides)
    }

    // Teal fact cards: one cheap check each; a card that fails is redrawn as a photo slide.
    let hasFact = false
    let changed = false
    for (let i = 1; i < slides.length; i++) {
      if (resolveSlideType(slides[i], i) !== 'fact') continue
      hasFact = true
      if (!input.hasTime()) break
      const f = await gateRenderedUrl(slideUrl(i + 1, `f${i}`), 'fact', input.fetchImpl, input.timeoutMs)
      if (f.infra) return outcome('deferred', hasFact)
      if (!f.ok) {
        slides = slides.map((s, j) => (j === i ? { ...s, type: 'photo' as const } : s))
        demotedFacts++
        changed = true
      }
    }
    if (changed) await write(slides)
    return outcome('pass', hasFact)
  } catch (err) {
    reasons = [err instanceof Error ? err.message : 'carousel check failed']
    return outcome('deferred')
  }
}

/** Generates a grounded carousel for a post and stores it (app_settings `carousel:{slug}`, which
 * the public /carousel/[slug]/[n] image route reads). Shared by the admin button and the autopilot
 * so both behave identically. Returns the slides, or null if generation or grounding failed. */
export async function generateAndSaveCarousel(admin: SupabaseClient, post: { slug: string; title: string; body: string }): Promise<CarouselSlide[] | null> {
  // Rotate slide 1's hook style and the last slide's CTA style over the last 5 carousels.
  const hookStyle = rotateStyle(await readRecentVariantValues(admin, 'carousel_hook', 12), COVER_HOOK_STYLES)
  const ctaStyle = rotateStyle(await readRecentVariantValues(admin, 'carousel_cta', 12), CTA_STYLES)
  const deck = await generateCarouselDeck(post.title, post.body, { hookStyle, ctaStyle })
  if (!deck) return null
  const generated = deck.slides
  // A different photo behind each slide, found one after another so no two slides share a picture.
  const used = new Set<string>()
  const slides: CarouselSlide[] = []
  for (const slide of generated) {
    const url = slide.imageQuery ? await findPortraitPhoto(slide.imageQuery, used) : null
    if (url) used.add(url)
    slides.push(url ? { ...slide, imageUrl: url } : slide)
  }
  const { error } = await setSetting(admin, carouselKey(post.slug), JSON.stringify(slides))
  if (error) throw new Error(error)
  await tagVariant(admin, post.slug, { hasCarousel: true, carousel_hook: deck.hookStyle ?? hookStyle, carousel_cta: ctaStyle, hook_style_at: new Date().toISOString() })
  return slides
}
