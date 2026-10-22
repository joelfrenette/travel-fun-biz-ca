import { repairDashes } from '@/lib/hook-styles'
import { validateCoverHeadline, fallbackCoverHeadline, coverRetryInstruction, headlineWords } from '@/lib/cover-headline'
import { FACT_MAX_WORDS } from '@/lib/cover-fit'

// Pure carousel slide model and the checks that run on a model-written deck. No network, no
// database, so scripts/check-carousel-slides.ts can test it offline. lib/carousel.ts does the calls.

/** cover = slide 1 (red headline block over a photo); fact = teal card with one big claim;
 * photo = photo with its text on a solid panel. */
export type SlideType = 'cover' | 'fact' | 'photo'

export interface CarouselSlide {
  /** Optional so decks stored before slide types existed still load; see resolveSlideType. */
  type?: SlideType
  headline: string
  body: string
  /** Stock-photo search words the model chose for this slide (never shown to the viewer). */
  imageQuery?: string
  /** The photo behind the slide, resolved when the carousel is saved. */
  imageUrl?: string
}

/** The type a slide is DRAWN as. Slide 1 is always the cover. An older deck (no type) draws every
 * other slide as a photo slide. A fact slide with a claim over 14 words falls back to a photo slide. */
export function resolveSlideType(slide: Pick<CarouselSlide, 'type' | 'headline'>, index: number): SlideType {
  if (index === 0) return 'cover'
  if (slide.type === 'fact' && headlineWords(slide.headline).length <= FACT_MAX_WORDS) return 'fact'
  return 'photo'
}

/** Turns the model's raw slide list into clean slides: needs a headline; needs a body unless it is a fact
 * card (whose claim is the headline); dashes repaired; unknown types dropped. Order is kept. */
export function normaliseSlides(raw: unknown): CarouselSlide[] {
  if (!Array.isArray(raw)) return []
  const out: CarouselSlide[] = []
  for (const s of raw as Array<Partial<CarouselSlide> | null | undefined>) {
    if (!s || typeof s.headline !== 'string' || !s.headline.trim()) continue
    const type: SlideType | undefined = s.type === 'cover' || s.type === 'fact' || s.type === 'photo' ? s.type : undefined
    const body = typeof s.body === 'string' ? s.body.trim() : ''
    if (!body && type !== 'fact') continue
    out.push({ ...(type ? { type } : {}), headline: repairDashes(s.headline.trim()), body: repairDashes(body), ...(typeof s.imageQuery === 'string' ? { imageQuery: s.imageQuery } : {}), ...(typeof s.imageUrl === 'string' ? { imageUrl: s.imageUrl } : {}) })
  }
  return out
}

/** Asks the model for a shorter cover headline. `instruction` already carries the reasons and the banned lists. */
export type AskShorterHeadline = (instruction: string) => Promise<string | null>

/**
 * Makes sure slide 1 carries a valid cover headline (lib/cover-headline.ts). A failing one gets ONE retry
 * through `askShorter`, then a whole short phrase of the post title, then null (the caller treats null as
 * a failed deck). Slides after the first are never touched. The returned slides have type 'cover' on slide 1.
 */
export async function finalizeCoverHeadline(slides: CarouselSlide[], postTitle: string, postBody: string, askShorter: AskShorterHeadline): Promise<CarouselSlide[] | null> {
  if (slides.length === 0) return null
  const source = `${postTitle} ${postBody}`
  const tidy = (h: string) => repairDashes(h).replace(/\s+/g, ' ').replace(/[.\s]+$/, '').trim()
  const withCover = (headline: string): CarouselSlide[] => [{ ...slides[0], type: 'cover', headline }, ...slides.slice(1)]

  const first = tidy(slides[0].headline)
  const check = validateCoverHeadline(first, source)
  if (check.ok) return withCover(first)

  let retried: string | null = null
  try {
    retried = await askShorter(coverRetryInstruction(first, check.reasons))
  } catch {
    retried = null
  }
  if (retried) {
    const t = tidy(retried)
    if (validateCoverHeadline(t, source).ok) return withCover(t)
  }
  const fallback = fallbackCoverHeadline(postTitle, source)
  return fallback ? withCover(fallback) : null
}
