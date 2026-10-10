// Growth loop WP1: the catalogue of blog writing styles and call-to-action styles, plus the pure
// functions that rotate through them. Pure data and pure functions on purpose (no database, no AI)
// so the rotation can be tested with a plain script (scripts/check-content-styles.ts) and so a later
// "what is working" step can swap the chooser without touching the composer.

export type ContentStyleId = 'listicle' | 'how-to' | 'comparison' | 'faq-led' | 'story-guide' | 'myth-buster' | 'checklist'
export type CtaStyleId = 'soft-question' | 'direct-book' | 'compare' | 'quiz-style' | 'guide-download'

export interface ContentStyle {
  id: ContentStyleId
  /** Human label, used as the Article JSON-LD articleSection. */
  label: string
  /** Handed to the body step: structure and tone only, never facts. */
  prompt: string
  minWords: number
  maxWords: number
}

const NUMBERS_AS_WORDS = 'Do not state numbers or counts of any kind (no digits and no number words such as "three nights" or "two ports"), except list structure such as numbered steps.'

export const CONTENT_STYLES: ContentStyle[] = [
  {
    id: 'listicle',
    label: 'List',
    prompt: `STYLE: listicle. Organise the post as a list of distinct, useful items (reasons, ideas, things to know). Each item gets its own "##" heading with a short explanation under it, two to four sentences. Keep the tone upbeat and scannable. ${NUMBERS_AS_WORDS}`,
    minWords: 700,
    maxWords: 1000,
  },
  {
    id: 'how-to',
    label: 'How-to',
    prompt: `STYLE: how-to. Walk the reader through a decision or a plan in clear steps, in order, each step under its own "##" heading that starts with a verb. Practical, calm, second person ("you"). End each step with the one thing to check before moving on. ${NUMBERS_AS_WORDS}`,
    minWords: 900,
    maxWords: 1400,
  },
  {
    id: 'comparison',
    label: 'Comparison',
    prompt: `STYLE: comparison. Help the reader choose between two or three realistic options (for example two ways to travel, or two kinds of trip). Give each option a fair "##" section on who it suits and what to weigh, then a section on how to decide. Be even-handed: no option is declared the winner for everyone, and no claims about prices or availability. ${NUMBERS_AS_WORDS}`,
    minWords: 700,
    maxWords: 1000,
  },
  {
    id: 'faq-led',
    label: 'Questions and answers',
    prompt: `STYLE: faq-led. Build the post around the real questions a person asks before booking. Each "##" heading is one such question, written the way a person would type it, and the first sentence under it answers it directly before adding detail. Plain and reassuring. ${NUMBERS_AS_WORDS}`,
    minWords: 700,
    maxWords: 1000,
  },
  {
    id: 'story-guide',
    label: 'Guide',
    prompt: `STYLE: story-guide. Write a guide that reads like a narrative: walk the reader through what a first-time traveller on this kind of trip would typically notice, in the order it tends to happen (planning, arriving, a typical day, winding down), using the second person ("you") and general knowledge only. Never write in the first person and never describe a specific trip you took. Warm and descriptive, with a practical takeaway in every section. ${NUMBERS_AS_WORDS}`,
    minWords: 900,
    maxWords: 1400,
  },
  {
    id: 'myth-buster',
    label: 'Myths and facts',
    prompt: `STYLE: myth-buster. Take the common worries or misconceptions people have about this kind of trip. Each "##" heading states one myth in quotation marks, then explains in plain language what is closer to the truth, using general travel knowledge only (no statistics, no named studies). Reassuring, never dismissive of the reader. ${NUMBERS_AS_WORDS}`,
    minWords: 700,
    maxWords: 1000,
  },
  {
    id: 'checklist',
    label: 'Checklist',
    prompt: `STYLE: checklist. Give the reader something they can use as a checklist: short "##" sections grouped by theme (before you book, before you go, once you arrive), each with a bullet list of concrete things to check or decide, plus a sentence on why it matters. Tight and practical. ${NUMBERS_AS_WORDS}`,
    minWords: 700,
    maxWords: 1000,
  },
]

export interface CtaStyle {
  id: CtaStyleId
  label: string
}

export const CTA_STYLES: CtaStyle[] = [
  { id: 'soft-question', label: 'Soft question' },
  { id: 'direct-book', label: 'Direct book' },
  { id: 'compare', label: 'Compare' },
  { id: 'quiz-style', label: 'Quiz style' },
  { id: 'guide-download', label: 'Planning help' },
]

/** How many of the most recent posts count when deciding which style is under-used. */
export const STYLE_WINDOW = 10

/** Generic rotation: `recent` is newest first (entries that are null, empty or not in the catalogue
 * are ignored). Never returns the most recent style when the catalogue has more than one entry;
 * otherwise prefers the style used least among the last STYLE_WINDOW; ties go to the style used
 * longest ago (never used counts as longest ago), then to catalogue order. No randomness, so the
 * same history always gives the same answer. */
function rotate<T extends { id: string }>(recent: (string | null | undefined)[], catalogue: T[]): T {
  if (catalogue.length === 0) throw new Error('rotate: empty catalogue')
  const known = new Set(catalogue.map((s) => s.id))
  // Window first (the last STYLE_WINDOW posts, styled or not), then drop the ones with no known style.
  const history = recent.slice(0, STYLE_WINDOW).filter((r): r is string => typeof r === 'string' && known.has(r))
  const last = history[0]
  const candidates = catalogue.length > 1 ? catalogue.filter((s) => s.id !== last) : catalogue
  let best = candidates[0]
  let bestCount = history.filter((h) => h === best.id).length
  let bestAge = history.indexOf(best.id) === -1 ? Number.POSITIVE_INFINITY : history.indexOf(best.id)
  for (const item of candidates.slice(1)) {
    const count = history.filter((h) => h === item.id).length
    const idx = history.indexOf(item.id)
    const age = idx === -1 ? Number.POSITIVE_INFINITY : idx
    if (count < bestCount || (count === bestCount && age > bestAge)) {
      best = item
      bestCount = count
      bestAge = age
    }
  }
  return best
}

export function pickStyle(recent: (string | null | undefined)[], catalogue: ContentStyle[] = CONTENT_STYLES): ContentStyle {
  return rotate(recent, catalogue)
}

export function pickCtaStyle(recent: (string | null | undefined)[], catalogue: CtaStyle[] = CTA_STYLES): CtaStyle {
  return rotate(recent, catalogue)
}

export function styleById(id: string | null | undefined): ContentStyle | null {
  return CONTENT_STYLES.find((s) => s.id === id) ?? null
}

/** The closing call-to-action as one markdown paragraph. Grounded the same way as the old
 * appendCta: it can only link to the real package's page, the contact section or the home page,
 * and says nothing about prices, dates or availability. Package names are free text set in the
 * admin, so square brackets are stripped before they go inside link syntax. */
export function ctaFor(style: CtaStyleId, pkg: { name: string; slug: string } | null): string {
  const name = pkg ? pkg.name.replace(/[[\]]/g, '').trim() : ''
  const pkgLink = pkg ? `/packages/${pkg.slug}` : ''
  switch (style) {
    case 'soft-question':
      return pkg
        ? `Wondering whether the ${name} trip suits you? [Have a look at the details](${pkgLink}) or [ask us a question](/#contact) and we will help you think it through.`
        : `Not sure which trip suits you? [Tell us what you are looking for](/#contact) and we will help you narrow it down.`
    case 'direct-book':
      return pkg
        ? `Ready to go? [See the dates and details for the ${name} trip](${pkgLink}).`
        : `Ready to go? [Browse our trips](/) and pick the one that fits.`
    case 'compare':
      return pkg
        ? `Still comparing options? [See how the ${name} trip is laid out](${pkgLink}), then [ask us](/#contact) how it fits what you are weighing up.`
        : `Still comparing options? [Browse our trips](/) side by side, then [ask us](/#contact) which one fits what you are weighing up.`
    case 'quiz-style':
      return pkg
        ? `Three quick questions: who would you travel with, which month works, and how active do you want to be? [Send us your answers](/#contact) and we will tell you whether the [${name} trip](${pkgLink}) fits.`
        : `Three quick questions: who would you travel with, which month works, and how active do you want to be? [Send us your answers](/#contact) and we will suggest a trip that fits.`
    case 'guide-download':
      return pkg
        ? `Want help planning around this? [Ask our team](/#contact) to talk you through it, or [read about the ${name} trip](${pkgLink}).`
        : `Want help planning around this? [Ask our team](/#contact) to talk you through your options, or [browse our trips](/).`
  }
}

/** Appends the closing call-to-action to a post body, separated by a rule. */
export function appendStyledCta(body: string, style: CtaStyleId, pkg: { name: string; slug: string } | null): string {
  return `${body.trimEnd()}\n\n---\n\n${ctaFor(style, pkg)}`
}
