import type { SupabaseClient } from '@supabase/supabase-js'
import { setSetting } from '@/lib/app-settings'
import { tagVariant } from '@/lib/content-variants'
import { callAnthropic, anthropicText, parseModelJson, isAiConfigured } from '@/lib/ai-verify'

// Carousels (factory item 4/6): the "missing middle" of the social funnel - reels build reach,
// carousels build trust (saves/shares are the strongest engagement signal Instagram/LinkedIn
// give). Cheap to generate from content that already exists: a published post turned into a
// fixed-length slide deck, each slide a headline + short body GENERATED from the post, not
// copy-pasted paragraphs.
export interface CarouselSlide {
  headline: string
  body: string
}

const SLIDE_COUNT = 7 // enough to develop an idea, short enough to finish

function carouselPrompt(postTitle: string, postBody: string): string {
  return `Turn this blog post into a ${SLIDE_COUNT}-slide Instagram/LinkedIn carousel. Each slide needs a short headline (under 8 words) and a short body (under 30 words) - write them fresh, summarizing and developing the post's real points, never copy-pasting whole paragraphs verbatim.

Post title: ${postTitle}

Post body:
${postBody}

Slide 1 should hook with the post's core promise. The last slide should be a soft call-to-action to read the full post or get in touch - never invent a specific price, date or offer not already in the post body above.

Every fact, number or claim on any slide must be traceable back to something actually stated in the post body above - never add a statistic, price or date that isn't already there.

Return ONLY minified JSON of this exact shape: {"slides":[{"headline":"...","body":"..."},...]} with exactly ${SLIDE_COUNT} entries.`
}

/** Every number appearing on a slide must appear in the source post too - same hard gate the
 * admin's FAQ generator and the autoblog composer already enforce, applied here. Returns the
 * slides unchanged if none fail, or null if ANY slide can't be grounded (the whole carousel
 * either passes together or doesn't ship, not a partial deck). */
function enforceNumberGrounding(slides: CarouselSlide[], sourceText: string): CarouselSlide[] | null {
  const known = new Set((sourceText.replace(/(\d)[,\s](?=\d{3}\b)/g, '$1').match(/\d+/g) ?? []))
  for (const slide of slides) {
    const nums = `${slide.headline} ${slide.body}`.replace(/(\d)[,\s](?=\d{3}\b)/g, '$1').match(/\d+/g) ?? []
    if (!nums.every((n) => known.has(n))) return null
  }
  return slides
}

/** Generates a grounded carousel from a real post, or null if AI is unconfigured, the call fails,
 * or any slide fails the numeric-grounding gate (never ships a partially-fabricated deck). */
export async function generateCarouselSlides(postTitle: string, postBody: string): Promise<CarouselSlide[] | null> {
  if (!isAiConfigured()) return null
  try {
    const r = await callAnthropic({ max_tokens: 2000, messages: [{ role: 'user', content: carouselPrompt(postTitle, postBody) }] }, { timeoutMs: 40_000 })
    if (!r || !r.res.ok) return null
    const parsed = parseModelJson<{ slides?: CarouselSlide[] }>(anthropicText(await r.res.json()))
    const slides = parsed?.slides
    if (!Array.isArray(slides) || slides.length === 0) return null
    const valid = slides.filter((s): s is CarouselSlide => !!s && typeof s.headline === 'string' && typeof s.body === 'string' && !!s.headline.trim() && !!s.body.trim())
    if (valid.length === 0) return null
    return enforceNumberGrounding(valid, `${postTitle} ${postBody}`)
  } catch {
    return null
  }
}

export const carouselKey = (slug: string) => `carousel:${slug}`

/** Generates a grounded carousel for a post and stores it (app_settings `carousel:{slug}`, which
 * the public /carousel/[slug]/[n] image route reads). Shared by the admin button and the autopilot
 * so both behave identically. Returns the slides, or null if generation or grounding failed. */
export async function generateAndSaveCarousel(admin: SupabaseClient, post: { slug: string; title: string; body: string }): Promise<CarouselSlide[] | null> {
  const slides = await generateCarouselSlides(post.title, post.body)
  if (!slides) return null
  const { error } = await setSetting(admin, carouselKey(post.slug), JSON.stringify(slides))
  if (error) throw new Error(error)
  await tagVariant(admin, post.slug, { hasCarousel: true })
  return slides
}
