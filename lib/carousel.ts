import type { SupabaseClient } from '@supabase/supabase-js'
import { setSetting } from '@/lib/app-settings'
import { tagVariant } from '@/lib/content-variants'
import { callAnthropic, anthropicText, parseModelJson, isAiConfigured } from '@/lib/ai-verify'
import { findPortraitPhoto } from '@/lib/pexels'
import { HOOK_STYLES, CTA_STYLES, HOOK_STYLE_PROMPTS, CTA_STYLE_PROMPTS, rotateStyle, readRecentVariantValues, ungroundedNumbers, repairDashes, type HookStyle, type CtaStyle } from '@/lib/hook-styles'

// Carousels (factory item 4/6): the "missing middle" of the social funnel - reels build reach,
// carousels build trust (saves/shares are the strongest engagement signal Instagram/LinkedIn
// give). Cheap to generate from content that already exists: a published post turned into a
// fixed-length slide deck, each slide a headline + short body GENERATED from the post, not
// copy-pasted paragraphs.
export interface CarouselSlide {
  headline: string
  body: string
  /** Stock-photo search words the model chose for this slide (never shown to the viewer). */
  imageQuery?: string
  /** The photo behind the slide, resolved when the carousel is saved. */
  imageUrl?: string
}

const SLIDE_COUNT = 7 // enough to develop an idea, short enough to finish

/** Which hook style slide 1 uses and which call-to-action style the last slide uses. Both optional:
 * with neither, the prompt is the one it always was. */
export interface CarouselStyles {
  hookStyle?: HookStyle
  ctaStyle?: CtaStyle
}

function carouselPrompt(postTitle: string, postBody: string, styles: CarouselStyles = {}): string {
  const hookLine = styles.hookStyle ? `Slide 1's headline must use this hook style: ${styles.hookStyle}, meaning ${HOOK_STYLE_PROMPTS[styles.hookStyle]}. It is a headline, so keep it under 8 words and still true to the post.${styles.hookStyle === 'number' || styles.hookStyle === 'comparison' ? ' Reuse only numbers already in the post body above; if it has none, do not use a number at all.' : ''}` : ''
  const ctaLine = styles.ctaStyle ? `The last slide's call to action must use this style: ${styles.ctaStyle}, meaning ${CTA_STYLE_PROMPTS[styles.ctaStyle]}. The slide is a picture, so never print a web address or say "click"; refer to the full post instead.` : ''
  return `Turn this blog post into a ${SLIDE_COUNT}-slide Instagram/LinkedIn carousel. Each slide needs a punchy headline (under 8 words, the kind that makes someone swipe) and a short body (under 24 words) - write them fresh, summarizing and developing the post's real points, never copy-pasting whole paragraphs verbatim.

Post title: ${postTitle}

Post body:
${postBody}

Slide 1 should hook with the post's core promise. The last slide should be a soft call-to-action to read the full post or get in touch - never invent a specific price, date or offer not already in the post body above.${hookLine ? `\n${hookLine}` : ''}${ctaLine ? `\n${ctaLine}` : ''}
Never use an em dash (the long dash character) on any slide; use a comma or a full stop.

Every fact, number or claim on any slide must be traceable back to something actually stated in the post body above - never add a statistic, price or date that isn't already there.

Also give every slide imageQuery: 2 to 4 English words for a stock-photo search that visually fits that slide (a place, activity or mood such as "puerto plata beach" or "cruise ship deck at sunset"; never a person's name). It is only used to find a picture and is never shown.

Return ONLY minified JSON of this exact shape: {"slides":[{"headline":"...","body":"...","imageQuery":"..."},...]} with exactly ${SLIDE_COUNT} entries.`
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

type DeckAttempt = { slides: CarouselSlide[] } | 'gate' | null

async function attemptDeck(postTitle: string, postBody: string, styles: CarouselStyles): Promise<DeckAttempt> {
  try {
    const r = await callAnthropic({ max_tokens: 2000, messages: [{ role: 'user', content: carouselPrompt(postTitle, postBody, styles) }] }, { timeoutMs: 40_000 })
    if (!r || !r.res.ok) return null
    const parsed = parseModelJson<{ slides?: CarouselSlide[] }>(anthropicText(await r.res.json()))
    const slides = parsed?.slides
    if (!Array.isArray(slides) || slides.length === 0) return null
    // Long dashes are swapped for a comma (no fact changes); the number gate below still runs on the result.
    const valid = slides
      .filter((s): s is CarouselSlide => !!s && typeof s.headline === 'string' && typeof s.body === 'string' && !!s.headline.trim() && !!s.body.trim())
      .map((s) => ({ ...s, headline: repairDashes(s.headline), body: repairDashes(s.body) }))
    if (valid.length === 0) return null
    const grounded = enforceNumberGrounding(valid, `${postTitle} ${postBody}`)
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

/** Generates a grounded carousel for a post and stores it (app_settings `carousel:{slug}`, which
 * the public /carousel/[slug]/[n] image route reads). Shared by the admin button and the autopilot
 * so both behave identically. Returns the slides, or null if generation or grounding failed. */
export async function generateAndSaveCarousel(admin: SupabaseClient, post: { slug: string; title: string; body: string }): Promise<CarouselSlide[] | null> {
  // Rotate slide 1's hook style and the last slide's CTA style over the last 5 carousels.
  const hookStyle = rotateStyle(await readRecentVariantValues(admin, 'carousel_hook', 12), HOOK_STYLES)
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
