import { isAiConfigured, parseModelJson } from '@/lib/ai-verify'
import {
  agencyClaims,
  callText,
  clamp,
  COUNT_CLAIM,
  EXPERIENCE_CLAIM_PATTERNS,
  internalLinksIn,
  namedThingsNotInBrief,
  numbersIn,
  PLACEHOLDER_PATTERNS,
  proseOf,
  RECENCY_PATTERNS,
  REFUSAL_PATTERNS,
  removeDashes,
  SCHEDULE_PATTERN,
  strings,
  SUPERLATIVE_PATTERNS,
} from '@/lib/guide-composer'
import type { PageCopyFaq, PageCopyType } from '@/lib/page-copy'

// Writes the copy for one compare or best-time page from a grounded brief, then checks it with plain-code rules
// before anything can go live. Same discipline as lib/guide-composer.ts (and it reuses that file's gate helpers):
// the AI is never trusted, so every claim that could hurt a customer (a number, a superlative, a weather claim,
// a "we were there") is checked by regex in pageCopyBlockers(), not by asking the model nicely.
//
// ONE AI call returns everything (intro, FAQ, takeaways, meta and OG text). Never touches the database; lib/page-copy-run.ts
// decides draft vs published.

export interface CopyBriefPackage {
  name: string
  slug: string
  destination: string
  category: string
  short_description: string | null
  /** Month names only, from available_from / available_to ("April to June"). No years, no day numbers. */
  months: string | null
}

export interface CopyBriefDestination {
  name: string
  slug: string
  /** Our own destination blurb, when one exists. */
  blurb: string | null
  /** The summary of our published destination guide, when one exists. */
  guideSummary: string | null
  packages: CopyBriefPackage[]
}

export interface PageCopyBrief {
  type: PageCopyType
  /** The page's own heading, for example "Italy vs Tahiti" or "Best time to visit Santorini". */
  title: string
  destinations: CopyBriefDestination[]
  /** Real pages the intro may link to: the listed packages and the destination pages. */
  links: { path: string; label: string }[]
}

export interface ComposedPageCopy {
  /** Markdown: 150 to 300 words, a direct answer in the first sentence, no headings. */
  intro: string
  faq: PageCopyFaq[]
  key_takeaways: string[]
  meta_title: string
  meta_description: string
  og_title: string
  og_description: string
  primary_keyword: string
}

export const COPY_WORDS_MIN = 150
export const COPY_WORDS_MAX = 300
const MAX_BRIEF_PACKAGES_PER_DESTINATION = 6

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

function monthIndex(date: string | null | undefined): number {
  const m = /^(\d{4})-(\d{2})/.exec(date ?? '')
  const i = m ? Number(m[2]) - 1 : -1
  return i >= 0 && i < 12 ? i : -1
}

/** "April", "April to June" or null, from two ISO dates. The year and the day are dropped on purpose: the page
 * lists the exact dates itself, and the writer must not repeat or invent them. Reads the month straight from the
 * text, so a time zone can never move a date into the neighbouring month. */
export function monthRange(from: string | null | undefined, to: string | null | undefined): string | null {
  const a = monthIndex(from)
  const b = monthIndex(to)
  if (a < 0 && b < 0) return null
  if (a < 0 || b < 0) return MONTH_NAMES[a < 0 ? b : a]
  if (a === b) return MONTH_NAMES[a]
  return `${MONTH_NAMES[a]} to ${MONTH_NAMES[b]}`
}

const NO_FABRICATION = `Never claim personal experience, a specific past trip, a named traveler, a specific date, or a price. You are a marketing writer for a travel agency, not someone who has been there, and the agency has not sent travellers anywhere unless the GROUNDING says so. Use only the facts in the GROUNDING plus plain, guidebook-level knowledge of what kind of place a destination is. If you are not sure a specific thing (a landmark, dish, neighbourhood, restaurant, hotel, ship or route) is real or still true, leave it out. Never name a hotel, resort, restaurant or ship unless its name appears in the GROUNDING.`

const RULES = `Rules, all mandatory:
- Write no digits (0-9) at all unless the exact same number appears in the GROUNDING. Keep other amounts vague and in words ("a couple of days", "most travellers"). State no prices, dates, availability, distances, temperatures, rainfall, counts or other exact statistics.
- Say nothing about weather, temperature, rain, humidity, hurricanes, snow, crowds, prices by season, "high", "low", "peak" or "shoulder" season, or the season words winter, summer, spring, autumn and fall (name the months from the GROUNDING instead). Do not call anything dry, wet, mild, hot, cold, warm, sunny, busy or quiet. The only seasonal fact you may state is when the trips in the GROUNDING run (the months listed there), and you must say those are the trips we list now, not the only time to go.
- Never use these words about a place or trip: best (except in the phrase "best time to visit"), number one, #1, award-winning, awards, 5-star, five-star, any star rating, top-rated, world-class, finest, luxury, iconic, famous, renowned, must-see, most popular, biggest, largest.
- Do not say one destination or trip is better, cheaper, safer or nicer than another. Describe how they differ and who each suits, using only the GROUNDING.
- The agency may only offer help ("we can help you plan"). Never describe what the agency has done, or does regularly, or what its travellers said or did.
- Do not use em dashes or en dashes anywhere; use commas or full stops. Canadian spelling, plain English, warm and practical.`

/** One block of text with every fact the writer may use. Also the only place a number may come from. */
export function copyGroundingText(brief: PageCopyBrief): string {
  const lines = [`Page: ${brief.type === 'compare' ? 'comparison of two destinations' : 'best time to visit one destination'}, titled "${brief.title}"`]
  for (const d of brief.destinations) {
    lines.push('', `Destination: ${d.name} (our page /destinations/${d.slug})`)
    if (d.blurb) lines.push(`Our short description of the place: ${d.blurb}`)
    if (d.guideSummary) lines.push(`Our published travel guide summary: ${d.guideSummary}`)
    if (d.packages.length) {
      lines.push(`Trips we list for ${d.name} right now (real; the only specifics you may use):`)
      for (const p of d.packages) {
        lines.push(`- "${p.name}" (page /packages/${p.slug}); category: ${p.category}${p.months ? `; runs in: ${p.months}` : ''}${p.short_description ? `; summary: ${p.short_description}` : ''}`)
      }
    }
  }
  return lines.join('\n')
}

function typeGuidance(brief: PageCopyBrief): string {
  if (brief.type === 'compare') {
    const [a, b] = brief.destinations
    return `This page lets a reader compare ${a?.name ?? 'the first destination'} and ${b?.name ?? 'the second destination'} using the real trips we list for each (shown in a grid under your intro).
- The intro's FIRST sentence is a direct, honest answer to "${a?.name} or ${b?.name}?": it says the two suit different trips or travellers and names what separates them in the GROUNDING (for example the kind of trip, or the months the trips run). It is not a question and not a verdict.
- Then describe each destination in turn using only the GROUNDING, and who each suits. Mention at least one listed trip by name per destination.`
  }
  const d = brief.destinations[0]
  return `This page tells a reader when they can travel to ${d?.name ?? 'the destination'} with us, using the real dates of the trips we list (shown in a grid under your intro).
- The intro's FIRST sentence is a direct answer to "when can I go to ${d?.name}?": it states the months the listed trips run (copy them from the GROUNDING) and says these are the trips we list now.
- Then explain how to use the dates below to choose, and what kind of place ${d?.name} is, using only the GROUNDING. Do not claim any month is the best or worst time; do not describe weather.`
}

function linksBlock(brief: PageCopyBrief): string {
  return brief.links.map((l) => `- ${l.path}  (${l.label})`).join('\n')
}

function copyPrompt(brief: PageCopyBrief): string {
  const names = brief.destinations.map((d) => d.name).join(' and ')
  return `You are writing the opening copy for a page on a Canadian travel agency's website (TravelFunBiz.ca: hosted group trips, river and ocean cruises, singles getaways). Page: "${brief.title}".

GROUNDING (the only specific facts you may use):
${copyGroundingText(brief)}

${NO_FABRICATION}

${RULES}

${typeGuidance(brief)}

Return ONLY minified JSON with exactly these keys:
{"intro":"...","faq":[{"q":"...","a":"..."}],"key_takeaways":["..."],"meta_title":"...","meta_description":"...","og_title":"...","og_description":"...","primary_keyword":"..."}
- intro: markdown, 190 to 260 words (never below 160, never above 290), plain paragraphs, NO headings, NO lists, NO FAQ. Name ${names} in it. Include 1 to 3 internal links written as markdown links like [anchor text](/path), using ONLY these paths (never invent a path, never use a full web address):
${linksBlock(brief)}
- faq: 3 to 5 real questions a searcher would ask about this page's topic. Each answer is 1 to 3 plain sentences, the first words answer the question directly, and it only repeats what the GROUNDING supports. No links in answers.
- key_takeaways: 3 to 5 one-line takeaways (each under 140 characters), no links.
- meta_title: under 60 characters, contains "${brief.destinations[0]?.name ?? ''}", says what the page is for.
- meta_description: under 155 characters, honest, no fake urgency.
- og_title: under 60 characters; may differ from meta_title (more curiosity) but must stay honest. og_description: under 110 characters.
- primary_keyword: the single phrase this page should rank for (2 to 5 words).`
}

// ---------------------------------------------------------------------------------------------------
// Calling the model and cleaning what comes back
// ---------------------------------------------------------------------------------------------------

interface CopyJson {
  intro?: unknown
  faq?: { q?: unknown; a?: unknown }[]
  key_takeaways?: unknown
  meta_title?: unknown
  meta_description?: unknown
  og_title?: unknown
  og_description?: unknown
  primary_keyword?: unknown
}

export const META_TITLE_MAX = 60
export const META_DESCRIPTION_MAX = 155
export const OG_TITLE_MAX = 60
export const OG_DESCRIPTION_MAX = 110

/** Turns the model's raw JSON into a ComposedPageCopy: dashes removed (a model slips one in), text trimmed,
 * meta and OG fields cut to their limits at a word boundary, lists capped, empty OG fields falling back to the
 * meta fields. It repairs; pageCopyBlockers() still checks the result. Pure. */
export function normalizePageCopy(raw: CopyJson, brief: PageCopyBrief): ComposedPageCopy {
  const intro = removeDashes(typeof raw.intro === 'string' ? raw.intro : '')
    .replace(/^```(?:markdown|md)?\s*\n/i, '')
    .replace(/\n```\s*$/, '')
    .trim()
  const faq: PageCopyFaq[] = (Array.isArray(raw.faq) ? raw.faq : [])
    .map((f) => ({ q: typeof f?.q === 'string' ? removeDashes(f.q.trim()) : '', a: typeof f?.a === 'string' ? removeDashes(f.a.trim()) : '' }))
    .filter((f) => f.q && f.a)
    .slice(0, 5)
  const first = brief.destinations[0]?.name.split(',')[0].trim() ?? ''
  const fallbackTitle = clamp(brief.title, META_TITLE_MAX)
  let metaTitle = clamp(removeDashes(String(raw.meta_title ?? '')), META_TITLE_MAX)
  if (!metaTitle || (first && !metaTitle.toLowerCase().includes(first.toLowerCase()))) metaTitle = fallbackTitle
  const metaDescription = clamp(removeDashes(String(raw.meta_description ?? '')), META_DESCRIPTION_MAX) || clamp(intro.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1'), META_DESCRIPTION_MAX)
  const ogTitle = clamp(removeDashes(String(raw.og_title ?? '')), OG_TITLE_MAX) || metaTitle
  const ogDescription = clamp(removeDashes(String(raw.og_description ?? '')), OG_DESCRIPTION_MAX) || clamp(metaDescription, OG_DESCRIPTION_MAX)
  return {
    intro,
    faq,
    key_takeaways: strings(raw.key_takeaways, 5),
    meta_title: metaTitle,
    meta_description: metaDescription,
    og_title: ogTitle,
    og_description: ogDescription,
    primary_keyword: clamp(removeDashes(String(raw.primary_keyword ?? '')), 80) || brief.title,
  }
}

/** Writes the copy for one page. Returns it, or the plain-English reason it could not be written. A returned
 * copy has NOT passed the quality gate yet: call pageCopyBlockers() on it. */
export async function composePageCopy(brief: PageCopyBrief): Promise<{ copy: ComposedPageCopy } | { error: string }> {
  if (!isAiConfigured()) return { error: 'AI writing is not configured (ANTHROPIC_API_KEY is not set)' }
  if (brief.destinations.length === 0 || brief.destinations.every((d) => d.packages.length === 0)) return { error: 'the page lists no trips to write about' }
  const answer = await callText(copyPrompt(brief), 4000, 80_000)
  if (!answer.ok) return { error: `writing the copy failed: ${answer.error}` }
  const json = parseModelJson<CopyJson>(answer.text)
  if (!json || typeof json !== 'object') return { error: 'the copy was not valid JSON' }
  const copy = normalizePageCopy(json, brief)
  if (!copy.intro) return { error: 'the reply had no intro' }
  return { copy }
}

// ---------------------------------------------------------------------------------------------------
// The quality gate (plain code; the model is never trusted)
// ---------------------------------------------------------------------------------------------------

// Built from char codes so no literal dash character sits in this file.
const EM_DASH = String.fromCharCode(0x2014)
const EN_DASH = String.fromCharCode(0x2013)
const WORD_NUMBERS: Record<string, string> = { two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10', eleven: '11', twelve: '12' }
const WORD_UNIT = /(?<!\bor )\b(two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)[- ](night|day|week|guest|passenger|port|stop|ship|deck|cabin|room|restaurant|pool|metre|meter|foot|feet)s?\b/gi
const VAGUE_QUANTITY = /\b(?:hundreds?|thousands?|millions?|dozens?)\b|\b(?:\w+teenth|twentieth) century\b/i

/** A count written in words with a unit ("four-night", "three days") that the grounding does not support. It is
 * supported when the grounding has the same count as a digit OR as a word with the same unit ("4-night" excuses
 * "four-night"). "or three days" is excused as a vague range. */
export function ungroundedWordCounts(text: string, grounding: string): string[] {
  const g = grounding.toLowerCase()
  const out: string[] = []
  for (const m of text.matchAll(WORD_UNIT)) {
    const word = m[1].toLowerCase()
    const unit = m[2].toLowerCase()
    const supported = new RegExp(`\\b(?:${WORD_NUMBERS[word]}|${word})[- ]${unit}s?\\b`).test(g)
    if (!supported) out.push(m[0])
  }
  return [...new Set(out)]
}

// Weather, climate, crowd and season words. Checked in ALL prose (intro, FAQ, takeaways, meta text) with no other
// condition: the page may state when the listed trips run (month names are not in this list, so copying them from
// the grounding is fine) but never what the weather or the crowds are like. "warm welcome" is a known false
// positive; the result is only a draft.
const WEATHER_OR_CROWD = /\b(?:dr(?:y|ier|iest)|wet(?:ter|test)?|rain(?:s|y|ier|iest|fall)?|humid(?:ity)?|mild|hot(?:ter|test)?|heat(?:wave)?|cold(?:er|est)?|chilly|cool(?:er)?|warm(?:er|est|th)?|sunn(?:y|ier|iest)|sunshine|storms?|stormy|hurricanes?|typhoons?|cyclones?|monsoons?|snow(?:y)?|temperatures?|weather|climate|crowd(?:s|ed|ier)?|busy|busier|busiest|quiet(?:er|est)?|(?:peak|low|high|shoulder) seasons?|off-season|winter|summer|spring|autumn|fall)\b/i
// A verdict about which place is better. The pages say how destinations differ, never which one wins.
const VERDICT = /\b(?:is|are|was|were) (?:the )?(?:better|cheaper|safer|nicer|superior|worse)\b|\b(?:better|cheaper|safer|nicer) (?:choice|option|value|deal|pick|bet|fit)\b|\bwins?\b|\bhands down\b|\bno contest\b|\bbeats\b|\bedges\b|\boutshines?\b|\btops\b|\bstronger\b|\bahead of\b|\bbetter suited\b|\bthe better choice\b|\bthe clear winner\b/i
// The first sentence must not say one named destination is better, more or less than something.
const COMPARATIVE = /\b(?:better|more|less|worse)\b/i

/** Slugs of the /packages/<slug> trips a piece of markdown links to, without duplicates. */
export function linkedPackageSlugs(markdown: string): string[] {
  const out: string[] = []
  for (const path of internalLinksIn(markdown)) {
    const m = /^\/packages\/([^/]+)$/.exec(path)
    if (m && !out.includes(m[1])) out.push(m[1])
  }
  return out
}

function sentencesOfText(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean)
}

export interface CopyGateContext {
  /** The text from copyGroundingText(brief): the only place a number may come from. */
  grounding: string
  /** The destinations' display names; the intro must mention each. */
  destinations: string[]
  /** Names the copy may use besides the grounding (link labels). */
  names?: string[]
  /** Paths that exist on the site and may be linked: the listed packages and the destination pages. */
  allowedPaths: Set<string>
}

/** Reasons composed copy must not auto-publish. Empty means clean. Pure. */
export function pageCopyBlockers(copy: ComposedPageCopy, ctx: CopyGateContext): string[] {
  const blockers: string[] = []
  const faqText = copy.faq.map((f) => `${f.q} ${f.a}`).join('\n')
  const takeText = copy.key_takeaways.join('\n')
  const metaText = [copy.meta_title, copy.meta_description, copy.og_title, copy.og_description, copy.primary_keyword].join('\n')
  const all = [copy.intro, faqText, takeText, metaText].join('\n')
  const prose = proseOf(all)
  const words = copy.intro.trim().split(/\s+/).filter(Boolean).length

  // Shape
  if (words < COPY_WORDS_MIN) blockers.push(`intro too short (${words} words, need ${COPY_WORDS_MIN} to ${COPY_WORDS_MAX})`)
  if (words > COPY_WORDS_MAX) blockers.push(`intro too long (${words} words, need ${COPY_WORDS_MIN} to ${COPY_WORDS_MAX})`)
  if (/^\s*#{1,6}\s/m.test(copy.intro)) blockers.push('the intro has a heading')
  const firstSentence = sentencesOfText(copy.intro.replace(/!?\[([^\]]*)\]\([^)\s]*\)/g, '$1').replace(/[*_`]/g, ''))[0] ?? ''
  if (!firstSentence) blockers.push('the intro is empty')
  else if (/\?\s*$/.test(firstSentence)) blockers.push('the first sentence is a question, not a direct answer')
  else if (firstSentence.split(/\s+/).length > 45) blockers.push('the first sentence is too long to be a direct answer')
  if (copy.faq.length < 3 || copy.faq.length > 5) blockers.push(`${copy.faq.length} FAQ questions, need 3 to 5`)
  if (copy.key_takeaways.length < 3 || copy.key_takeaways.length > 5) blockers.push(`${copy.key_takeaways.length} key takeaways, need 3 to 5`)
  if (!copy.primary_keyword.trim()) blockers.push('no primary keyword')
  if (!copy.meta_title.trim() || !copy.meta_description.trim()) blockers.push('missing meta title or description')
  if (copy.meta_title.length > META_TITLE_MAX) blockers.push(`meta title over ${META_TITLE_MAX} characters`)
  if (copy.meta_description.length > META_DESCRIPTION_MAX) blockers.push(`meta description over ${META_DESCRIPTION_MAX} characters`)
  if (copy.og_title.length > OG_TITLE_MAX) blockers.push(`OG title over ${OG_TITLE_MAX} characters`)
  if (copy.og_description.length > OG_DESCRIPTION_MAX) blockers.push(`OG description over ${OG_DESCRIPTION_MAX} characters`)
  for (const d of ctx.destinations) {
    const short = d.split(',')[0].trim().toLowerCase()
    if (short && !copy.intro.toLowerCase().includes(short)) blockers.push(`the intro does not name ${d}`)
  }

  // Numbers: a digit must come from the grounding (digits inside link targets are not prose), and a count
  // written in words must be supported by the grounding too.
  const allowedNumbers = new Set(numbersIn(ctx.grounding))
  const strangers = [...new Set(numbersIn(prose).filter((n) => !allowedNumbers.has(n)))]
  if (strangers.length) blockers.push(`number not in the grounding: ${strangers.slice(0, 5).join(', ')}`)
  const wordCounts = ungroundedWordCounts(prose, ctx.grounding)
  if (wordCounts.length) blockers.push(`a count written in words that the grounding does not support: ${wordCounts.slice(0, 3).join(', ')}`)
  if (VAGUE_QUANTITY.test(prose)) blockers.push('a size, count or date written in words')

  // Text hygiene
  if (all.includes(EM_DASH) || /\s--\s/.test(all)) blockers.push('em dash present')
  if (all.includes(EN_DASH)) blockers.push('en dash present')
  if (PLACEHOLDER_PATTERNS.some((p) => p.test(all))) blockers.push('placeholder text')
  if (REFUSAL_PATTERNS.some((p) => p.test(all))) blockers.push('model refusal in text')
  if (/https?:\/\/|\bwww\./i.test(all)) blockers.push('web address in text')

  // Claims
  if (EXPERIENCE_CLAIM_PATTERNS.some((p) => p.test(all))) blockers.push('fabricated experience claim')
  for (const [pattern, label] of SUPERLATIVE_PATTERNS) {
    if (pattern.test(prose)) blockers.push(`superlative or rating claim (${label})`)
  }
  if (VERDICT.test(prose)) blockers.push('says which destination is better (a verdict)')
  if (RECENCY_PATTERNS.some((p) => p.test(all))) blockers.push('unverifiable recency claim')
  if (COUNT_CLAIM.test(all)) blockers.push('amenity or capacity count')
  if (SCHEDULE_PATTERN.test(all)) blockers.push('itinerary or schedule stated as fact')
  const weatherWord = WEATHER_OR_CROWD.exec(prose)
  if (weatherWord) blockers.push(`weather, crowd or season word: "${weatherWord[0]}"`)
  if (firstSentence && COMPARATIVE.test(firstSentence) && ctx.destinations.some((d) => firstSentence.toLowerCase().includes(d.split(',')[0].trim().toLowerCase()))) {
    blockers.push('the first sentence compares a destination as better, more or less')
  }

  // The agency may offer help, never describe its own history.
  const claims = agencyClaims([copy.intro, faqText, takeText].join('\n'))
  if (claims.length) blockers.push(`claim about what the agency has done or does: "${claims[0].slice(0, 80)}"`)

  // A hotel, restaurant, person or port the brief never mentioned is a made-up detail until proven otherwise.
  const allowedText = [ctx.grounding, ...ctx.destinations, ...(ctx.names ?? [])].join(' ')
  const venues = namedThingsNotInBrief([copy.intro, faqText, takeText].join('\n'), allowedText)
  if (venues.length) blockers.push(`named venue or person not in brief: ${venues.slice(0, 3).join(', ')}`)

  // Links: 1 to 3 in the intro, all to pages that exist; none in the FAQ, takeaways or meta text.
  if (/\]\(/.test(faqText) || /\]\(/.test(takeText) || /\]\(/.test(metaText)) blockers.push('link inside FAQ, takeaways or meta text')
  const links = internalLinksIn(copy.intro)
  if (links.length === 0) blockers.push('no internal link in the intro')
  if (links.length > 3) blockers.push(`${links.length} links in the intro, at most 3`)
  const dead = [...new Set(links.filter((l) => !ctx.allowedPaths.has(l)))]
  if (dead.length) blockers.push(`dead internal link: ${dead.slice(0, 3).join(', ')}`)
  if (/\]\((?!\/)[^)]*\)/.test(copy.intro)) blockers.push('link that is not an internal path')

  return blockers
}

export type PageCopyPublishMode = 'draft' | 'publish'

/** Whether gate-clean copy goes live, and if not, why it is held. Blockers always hold it. In 'draft' mode (the
 * default) even clean copy is held for review; only 'publish' lets a clean result go live. These pages name no
 * hotels, so there is no per-kind rule on top of the mode. Pure, so it can be tested. */
export function copyPublishDecision(blockers: string[], mode: PageCopyPublishMode): { publish: boolean; note: string | null } {
  if (blockers.length) return { publish: false, note: blockers.join('; ') }
  if (mode !== 'publish') return { publish: false, note: 'held for review (page_copy_publish_mode=draft)' }
  return { publish: true, note: null }
}

export { MAX_BRIEF_PACKAGES_PER_DESTINATION }
