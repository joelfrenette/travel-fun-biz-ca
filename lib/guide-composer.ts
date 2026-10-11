import { callAnthropic, anthropicText, parseModelJson, isAiConfigured } from '@/lib/ai-verify'
import { guideKinds, type GuideKind, type GuideSection, type GuideFaq } from '@/lib/guides'

// Writes one guide page (destination, hotel, resort, cruise line, ship, river cruise, yacht) from a grounded
// brief, then checks it with plain-code rules before anything can go live. Same discipline as
// lib/blog-composer.ts: the AI is never trusted, so every claim that could hurt a customer (a number, an award,
// a rating, a "we were there") is checked by regex in guideBlockers(), not by asking the model nicely.
//
// Two AI calls: (1) the article itself as markdown, (2) a small JSON "enrich" pass (FAQ, key takeaways, meta and
// OG text, keywords). Never writes to the database; lib/guide-run.ts decides draft vs published.

export interface BriefPackage {
  name: string
  slug: string
  destination: string
  category: string
  short_description: string | null
  /** Year of the first date only. No prices, no exact dates. */
  year: string | null
}

export interface GuideBrief {
  kind: GuideKind
  name: string
  /** The parent's display name (a resort's destination, a ship's cruise line), when known. */
  parentName: string | null
  /** Real published packages that touch this subject. The only source of specifics. */
  packages: BriefPackage[]
  /** Researched keywords that mention the subject (from keyword_research). */
  keywords: string[]
  /** Our own destination blurb, when one exists. */
  blurb: string | null
  /** Real pages the article may link to (published packages, destination pages, guides, index pages). */
  links: { path: string; label: string }[]
}

export interface ComposedGuide {
  name: string
  summary: string
  /** Markdown of every section (each starts with a "## " heading). The summary is not repeated here. */
  body: string
  sections: GuideSection[]
  faq: GuideFaq[]
  key_takeaways: string[]
  meta_title: string
  meta_description: string
  og_title: string
  og_description: string
  primary_keyword: string
  secondary_keywords: string[]
  /** A short generic phrase to look up a stock photo with. */
  hero_query: string
}

export const GUIDE_WORDS_MIN = 1000
export const GUIDE_WORDS_MAX = 2300

const NO_FABRICATION = `Never claim personal experience, a specific past trip, a named traveler, a specific date, or a price. You are a marketing writer for a travel agency, not someone who has been there, and the agency has not sent travellers there unless the GROUNDING says so. Write only general, guidebook-level knowledge. If you are not sure a specific thing (a dish, landmark, neighbourhood, restaurant, deck, route or feature) is real or still true, leave it out and describe the general character instead. If you do not recognise the subject, say less and stay general about what that kind of place or ship is like; never guess its features.`

const BANNED_WORDS_RULE = `Never use these words or ideas about the subject: best, number one, #1, award-winning, awards, 5-star, five-star, any star rating, top-rated, highly rated, world-class, finest, newly or recently renovated or built, brand new. ("The best time to visit" is the only allowed use of "best".) Write no digits (0-9) at all unless the exact same number appears in the GROUNDING; keep amounts vague and in words ("a couple of days", "most travellers"). State no prices, dates, availability, room, cabin, restaurant, deck or passenger counts, distances, years built, tonnage or other exact statistics. Do not use em dashes or en dashes anywhere; use commas or full stops.`

const SECTION_PLANS: Record<GuideKind, string[]> = {
  destinations: ['why go', 'neighbourhoods or regions', 'what to do', 'food and drink', 'when to go, in general terms (seasons only, no months or weather numbers)', 'getting around', 'who it suits', 'how a hosted group trip here typically works (general, no claim about our past trips; mention a package only if the GROUNDING lists one)'],
  hotels: ['the setting', 'the style of the hotel', 'who it suits', 'what to expect', 'what is nearby (general terms)', 'how to visit with a group'],
  resorts: ['the setting', 'the style of the resort', 'who it suits', 'what to expect', 'what is nearby (general terms)', 'how to visit with a group'],
  'cruise-lines': ['the style of the cruise line and its ships', 'who it suits', 'typical itineraries, in general terms', 'dining and onboard life, in general terms', 'tips for first-time cruisers', 'how a hosted group trip with them typically works (general, no claim about our past trips)'],
  ships: ['the style of the ship', 'who it suits', 'typical itineraries, in general terms', 'dining and onboard life, in general terms', 'tips for sailing on her', 'how a hosted group trip on her typically works (general, no claim about our past trips)'],
  'river-cruises': ['how a river cruise differs from an ocean cruise', 'routes, in general terms', 'cabin life', 'the pace of a day', 'who it suits', 'how a hosted group river cruise typically works (general, no claim about our past trips)'],
  yachts: ['how a yacht or small-ship cruise differs from a big ship', 'routes, in general terms', 'cabin life', 'the pace of a day', 'who it suits', 'how a hosted group yacht cruise typically works (general, no claim about our past trips)'],
}

export function sectionPlanFor(kind: GuideKind): string[] {
  return SECTION_PLANS[kind]
}

/** One block of text with every fact the writer may use. Also the only place a number may come from. */
export function groundingText(brief: GuideBrief): string {
  const lines = [`Subject: ${guideKinds[brief.kind].label.toLowerCase()} called "${brief.name}"`]
  if (brief.parentName) lines.push(`Related place or company: ${brief.parentName}`)
  if (brief.packages.length) {
    lines.push('Packages on our site that involve it (real; the only specifics you may use):')
    for (const p of brief.packages) {
      lines.push(`- "${p.name}" (page /packages/${p.slug}); destination: ${p.destination}; category: ${p.category}${p.year ? `; runs in ${p.year}` : ''}${p.short_description ? `; summary: ${p.short_description}` : ''}`)
    }
  } else {
    lines.push('No package on our site involves it yet. Do not imply that a specific trip is on sale.')
  }
  if (brief.keywords.length) lines.push(`Keywords people search (use naturally where they fit): ${brief.keywords.join(', ')}`)
  if (brief.blurb) lines.push(`Our existing short description of the place (may be reused): ${brief.blurb}`)
  return lines.join('\n')
}

function linksBlock(brief: GuideBrief): string {
  return brief.links.map((l) => `- ${l.path}  (${l.label})`).join('\n')
}

function articlePrompt(brief: GuideBrief): string {
  const info = guideKinds[brief.kind]
  const plan = SECTION_PLANS[brief.kind].map((s, i) => `${i + 1}. ${s}`).join('\n')
  return `You are writing a genuine, useful guide page for a Canadian travel agency (TravelFunBiz.ca: hosted group trips, river and ocean cruises, singles getaways). Page type: ${info.label.toLowerCase()} guide for "${brief.name}".

GROUNDING (the only specific facts you may use):
${groundingText(brief)}

${NO_FABRICATION}

${BANNED_WORDS_RULE}

Write 1200 to 1800 words in markdown, warm, practical and plain English (Canadian spelling). Structure:
- First an opening paragraph with no heading, 2 or 3 sentences. Its FIRST sentence must be a plain, quotable definition that answers "what is ${brief.name}?" and names it ("${brief.name} is ..."), complete enough for a search engine or AI answer to quote on its own.
- Then these sections in this order, each starting with a "## " heading. Write a natural, descriptive heading for each (it may include "${brief.name}"; the first heading should contain the main search phrase for this page). Do not number the headings:
${plan}
- Under the longest section add at least one "### " sub-heading.
- Use a short bullet list once where it helps scanning.
- Work in 2 or 3 internal links as markdown links like [anchor text](/path), using ONLY these paths (never invent a path, never use a full web address):
${linksBlock(brief)}
- Do not write a title heading, a FAQ section or a key-takeaways list (they are written separately).
- Speak to the reader as "you". Use "we" only for what the agency can do for a group ("we can help you plan"), never for something the agency has already done.
Output raw markdown only, no commentary before or after it.`
}

function enrichPrompt(brief: GuideBrief, article: string): string {
  const info = guideKinds[brief.kind]
  return `Below is a finished guide page about the ${info.label.toLowerCase()} "${brief.name}" for a Canadian travel agency. Write the on-page extras for it.

GROUNDING (the only specific facts you may use):
${groundingText(brief)}

${NO_FABRICATION}

${BANNED_WORDS_RULE}

ARTICLE:
${article}

Return ONLY minified JSON with exactly these keys:
{"faq":[{"q":"...","a":"..."}],"key_takeaways":["..."],"meta_title":"...","meta_description":"...","og_title":"...","og_description":"...","primary_keyword":"...","secondary_keywords":["..."],"hero_query":"..."}
Rules:
- faq: 4 to 6 real questions a searcher would ask about ${brief.name} (most should contain the name). Each answer is 1 to 3 plain sentences, the first words answer the question directly, and it only repeats things the article says. No links in answers.
- key_takeaways: 3 to 5 one-line takeaways (each under 140 characters), no links.
- meta_title: under 60 characters, contains "${brief.name}", says what the page is for.
- meta_description: under 155 characters, contains "${brief.name}", honest, no fake urgency.
- og_title: under 60 characters; may differ from meta_title (more curiosity) but must stay honest.
- og_description: under 110 characters.
- primary_keyword: the single phrase this page should rank for (2 to 5 words, contains "${brief.name}"). secondary_keywords: 3 to 6 related phrases.
- hero_query: 2 to 4 generic words to search a stock photo with (for example "santorini sunset" or "river cruise ship"); never include a brand or ship name for anything other than a destination.`
}

// ---------------------------------------------------------------------------------------------------
// Calling the model
// ---------------------------------------------------------------------------------------------------

type CallResult = { ok: true; text: string } | { ok: false; error: string }

async function callText(prompt: string, maxTokens: number, timeoutMs: number): Promise<CallResult> {
  const r = await callAnthropic({ max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }, { timeoutMs })
  if (!r) return { ok: false, error: 'the AI did not answer in time' }
  if (!r.res.ok) return { ok: false, error: `the AI request failed (HTTP ${r.res.status})` }
  const payload = await r.res.json().catch(() => null)
  if ((payload as { stop_reason?: string } | null)?.stop_reason === 'max_tokens') return { ok: false, error: 'the AI reply was cut off' }
  const text = anthropicText(payload)
  return text ? { ok: true, text } : { ok: false, error: 'the AI returned nothing' }
}

/** Removes em and en dashes: house style has none, and a model slips one in. An en dash between two
 * characters with no spaces (a range such as 3-5) becomes a hyphen; any other dash becomes a comma. */
export function removeDashes(text: string): string {
  return text
    .replace(/(?<=\w)\u2013(?=\w)/g, '-')
    .replace(/\s*[\u2014\u2013]\s*/g, ', ')
    .replace(/\s--\s/g, ', ')
}

/** Splits the model's markdown into the opening summary and the "## " sections. */
export function parseArticle(markdown: string): { summary: string; sections: GuideSection[]; body: string } | null {
  let text = markdown.trim().replace(/^```(?:markdown|md)?\s*\n/i, '').replace(/\n```\s*$/, '').trim()
  text = text.replace(/^#\s+.*\n+/, '') // a stray H1 title
  const first = text.search(/^##\s/m)
  if (first < 0) return null
  const summary = text.slice(0, first).trim()
  const rest = text.slice(first)
  const sections: GuideSection[] = []
  for (const chunk of rest.split(/^(?=##\s)/m)) {
    const m = /^##\s+(.+)\n?([\s\S]*)$/.exec(chunk.trim())
    if (!m) continue
    sections.push({ heading: m[1].trim(), body: m[2].trim() })
  }
  if (!summary || sections.length === 0) return null
  return { summary, sections, body: sections.map((s) => `## ${s.heading}\n\n${s.body}`).join('\n\n') }
}

function clamp(text: unknown, max: number): string {
  const s = typeof text === 'string' ? text.trim().replace(/\s+/g, ' ') : ''
  if (s.length <= max) return s
  return s.slice(0, max).replace(/\s+\S*$/, '').replace(/[,;:\s]+$/, '')
}

function strings(value: unknown, max: number): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map((v) => removeDashes(v.trim())).slice(0, max) : []
}

interface EnrichJson {
  faq?: { q?: unknown; a?: unknown }[]
  key_takeaways?: unknown
  meta_title?: unknown
  meta_description?: unknown
  og_title?: unknown
  og_description?: unknown
  primary_keyword?: unknown
  secondary_keywords?: unknown
  hero_query?: unknown
}

/** Writes one guide. Returns the guide, or the plain-English reason it could not be written. A returned guide
 * has NOT passed the quality gate yet: call guideBlockers() on it. */
export async function composeGuide(brief: GuideBrief): Promise<{ guide: ComposedGuide } | { error: string }> {
  if (!isAiConfigured()) return { error: 'AI writing is not configured (ANTHROPIC_API_KEY is not set)' }

  const article = await callText(articlePrompt(brief), 8000, 100_000)
  if (!article.ok) return { error: `writing the article failed: ${article.error}` }
  const parsed = parseArticle(removeDashes(article.text))
  if (!parsed) return { error: 'the article did not have the expected opening and "##" sections' }

  const enrich = await callText(enrichPrompt(brief, `${parsed.summary}\n\n${parsed.body}`), 4000, 40_000)
  if (!enrich.ok) return { error: `writing the FAQ and meta text failed: ${enrich.error}` }
  const json = parseModelJson<EnrichJson>(enrich.text)
  if (!json || typeof json !== 'object') return { error: 'the FAQ and meta text were not valid JSON' }

  const faq: GuideFaq[] = (Array.isArray(json.faq) ? json.faq : [])
    .map((f) => ({ q: typeof f?.q === 'string' ? removeDashes(f.q.trim()) : '', a: typeof f?.a === 'string' ? removeDashes(f.a.trim()) : '' }))
    .filter((f) => f.q && f.a)
    .slice(0, 6)

  const name = brief.name
  const withName = (t: string, fallback: string) => (t && t.toLowerCase().includes(name.toLowerCase()) ? t : fallback)
  const kindLabel = guideKinds[brief.kind].guideLabel
  const metaTitle = withName(clamp(removeDashes(String(json.meta_title ?? '')), 60), clamp(`${name}: ${kindLabel}`, 60))
  const metaDescription = clamp(removeDashes(String(json.meta_description ?? '')), 155) || clamp(parsed.summary, 155)
  const ogTitle = clamp(removeDashes(String(json.og_title ?? '')), 60) || metaTitle
  const ogDescription = clamp(removeDashes(String(json.og_description ?? '')), 110) || clamp(metaDescription, 110)

  return {
    guide: {
      name,
      summary: parsed.summary,
      body: parsed.body,
      sections: parsed.sections,
      faq,
      key_takeaways: strings(json.key_takeaways, 5),
      meta_title: metaTitle,
      meta_description: metaDescription,
      og_title: ogTitle,
      og_description: ogDescription,
      primary_keyword: clamp(removeDashes(String(json.primary_keyword ?? '')), 80) || `${name} ${kindLabel.toLowerCase()}`,
      secondary_keywords: strings(json.secondary_keywords, 6),
      hero_query: clamp(String(json.hero_query ?? ''), 60),
    },
  }
}

// ---------------------------------------------------------------------------------------------------
// The quality gate (plain code; the model is never trusted)
// ---------------------------------------------------------------------------------------------------

const PLACEHOLDER_PATTERNS = [/\[[^\]]*\](?!\()/, /lorem ipsum/i, /\btodo\b/i, /\btbd\b/i, /insert .* here/i, /\{\{|\}\}/]
const REFUSAL_PATTERNS = [/i (cannot|can't|won'?t) (write|generate|help|comply)/i, /as an ai( language model)?/i, /i don'?t have (enough )?information/i]
const EXPERIENCE_CLAIM_PATTERNS = [
  /\b(when|after) (i|we) (visited|went|traveled|travelled|stayed|sailed|toured)\b/i,
  /\bmy (trip|visit|stay|experience|cruise) (to|on|at)\b/i,
  /\bi (recently|personally|have) (visited|been|stayed|sailed|went)\b/i,
  /\b(i|we) (stayed|sailed|visited|toured|tried|dined) (at|on|in|with)\b/i,
  /\b(we|our team) (have|has|had) (stayed|sailed|visited|been|toured)\b/i,
  /\bour (guests|clients|travell?ers|groups|customers) (loved|love|rave|told|tell|say|said|enjoyed)\b/i,
  /\bwe (recently|often|regularly) (send|sent|take|took|brought)\b/i,
]
// Words that make a claim about a named property that cannot be checked. "The best time to visit" is the only
// allowed use of "best".
const SUPERLATIVE_PATTERNS: [RegExp, string][] = [
  [/\bbest\b(?!\s+(?:time|times|season|months?)\b)/i, 'best'],
  [/\bnumber (?:one|1)\b|#\s?1\b|\bno\.?\s?1\b/i, 'number one'],
  [/\baward[- ]winning\b|\bawards?\b|\bmichelin\b/i, 'award claim'],
  [/\b(?:[1-5]|one|two|three|four|five)[- ]stars?\b|\bstar[- ]rated\b|\b\d(?:\.\d)? stars\b/i, 'star rating'],
  [/\b(?:top|highly|best|five-star)[- ]rated\b/i, 'top-rated'],
  [/\bworld[- ]class\b|\bfinest\b|\bunrivall?ed\b|\bunparalleled\b|\bunmatched\b/i, 'world-class'],
  [/\b(?:largest|biggest|smallest|oldest|newest|latest|tallest)\b/i, 'size or age superlative'],
  [/\bmost (?:popular|loved|famous|luxurious|beautiful|visited)\b/i, 'most popular or similar'],
  [/\b(?:leading|premier|acclaimed|renowned|legendary|iconic|famous|must-see)\b|\bluxur(?:y|ious)\b/i, 'reputation claim'],
  [/\bdiamonds?\b/i, 'diamond rating'],
  [/\bfirst (?:ship|resort|hotel)\b|\bonly (?:ship|resort|hotel)\b/i, 'first or only claim'],
]
const RECENCY_PATTERNS = [
  /\b(newly|recently) (renovated|refurbished|built|opened|launched|redesigned|upgraded)\b/i,
  /\bbrand[- ]new\b/i,
  /\blaunched recently\b|\bdebuted\b|\bmaiden\b|\binaugural\b|\bstate[- ]of[- ]the[- ]art\b|\bnewly\b/i,
]
// Rough sizes and dates in words, which the digit check cannot see.
const WORD_NUMBER_PATTERNS = [
  /\b(?:hundreds?|thousands?|millions?|dozens?)\b/i,
  /\b(?:\w+teenth|twentieth) century\b/i,
]
// A spelled-out count plus a unit ("four-night"). Blocked unless the grounding says the same count with the
// same unit (see ungroundedWordCounts), because a made-up count usually sounds exactly like this.
const COUNTED_UNIT_RE = /(?<!\bor )\b(two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)[- ](night|day|week|guest|passenger|port|stop|ship|deck|cabin|room|restaurant|pool|metre|meter|foot|feet)s?\b/gi
const COUNT_WORD_VALUE: Record<string, number> = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 }

/** Spelled-out counts with a unit that the grounding does not back. The grounding backs "four-night" when it
 * contains the same count next to the same unit, as a digit ("4-night", "4 nights") or as a word ("four nights").
 * A stray digit elsewhere does not excuse it. Returns the offending phrases. */
export function ungroundedWordCounts(text: string, grounding: string): string[] {
  const lower = grounding.toLowerCase()
  const out: string[] = []
  for (const m of text.matchAll(COUNTED_UNIT_RE)) {
    const word = m[1].toLowerCase()
    const unit = m[2].toLowerCase()
    const same = new RegExp(`\\b(?:${COUNT_WORD_VALUE[word]}|${word})[- ]${unit}s?\\b`)
    if (!same.test(lower)) out.push(m[0].toLowerCase())
  }
  return [...new Set(out)]
}
// Itinerary or schedule stated as fact.
const SCHEDULE_PATTERN = /\bevery (?:week|day|month|sailing|departure)\b/i
// The agency speaking about its own history. Only offers of help are allowed.
const AGENCY_SUBJECT = /\b(?:we|I|I['’](?:ve|d|m)|our (?:team|hosts|guides|groups|travell?ers|clients|guests|advisors|agents|staff|company))\b/i
const AGENCY_VERB = /\b(?:offer|offered|run|ran|sail|sailed|host|hosted|know|have|had|visit|visited|take|took|bring|brought|love|loved|return|partner)\b/i
const AGENCY_TIME = /\bevery (?:year|season|spring|summer|fall|winter)\b|\beach (?:year|season)\b|\bmany times\b|\byears of\b/i
const AGENCY_OFFER = /\b(?:we can help|we can|our team can|ask us|we will help|our advisors can)\b/i
// After an offer of help, any of these makes the sentence a claim after all ("we can host groups every spring").
const PAST_OR_HABITUAL = /\b(?:offered|ran|sailed|hosted|visited|took|brought|loved|had|knew|returned|partnered|often|regularly|always|usually|many times|years of|every (?:year|season|spring|summer|fall|winter|week|day)|each (?:year|season))\b/i
const COUNT_CLAIM = /\b(two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|hundred|hundreds|thousand|thousands|dozen|dozens)\b[^.\n]{0,24}\b(rooms|suites|cabins|restaurants|decks|passengers|staterooms|bars|pools|villas|bungalows)\b/i

function numbersIn(text: string): string[] {
  return text.match(/\d[\d,.]*\d|\d/g) ?? []
}

/** Text with markdown link targets removed, so a slug with digits in a link is not counted as prose. */
function proseOf(text: string): string {
  return text.replace(/\]\([^)\s]*\)/g, ']')
}

/** Markdown links to internal paths found in `text`: the path part only, no query or hash. */
export function internalLinksIn(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    const href = m[1]
    if (!href.startsWith('/')) continue
    const path = href.split('#')[0].split('?')[0]
    out.push(path === '' ? '/' : path.length > 1 ? path.replace(/\/+$/, '') : path)
  }
  return out
}

/** Plain sentences of some markdown: headings dropped, link syntax reduced to the anchor text, list markers removed. */
function sentencesOf(markdown: string): string[] {
  const text = markdown
    .split('\n')
    .filter((l) => !/^\s*#{1,6}\s/.test(l))
    .join('\n')
    .replace(/!?\[([^\]]*)\]\([^)\s]*\)/g, '$1')
    .replace(/^\s*(?:[-*]|\d+\.)\s+/gm, '')
    .replace(/[*_`>]/g, '')
  return text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean)
}

/** Sentences where the agency talks about its own past or habits ("we host groups here every spring"). */
export function agencyClaims(markdown: string): string[] {
  const out: string[] = []
  for (const sentence of sentencesOf(markdown)) {
    // An offer of help is exempt only when nothing after it in the sentence is past or habitual.
    const offer = AGENCY_OFFER.exec(sentence)
    const rest = offer && !PAST_OR_HABITUAL.test(sentence.slice(offer.index + offer[0].length)) ? sentence.replace(new RegExp(AGENCY_OFFER.source, 'gi'), ' ') : sentence
    const subject = AGENCY_SUBJECT.exec(rest)
    if (!subject) continue
    const after = rest.slice(subject.index + subject[0].length)
    if (AGENCY_VERB.test(after) || AGENCY_TIME.test(after)) out.push(sentence)
  }
  return out
}

const NOT_VENUE = new Set(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'])
const CAP_WORD = /^[A-Z][\p{L}'’-]+$/u

/** Capitalised phrases of two or more words in the prose (a restaurant, a person, a port) that are not the
 * subject, its parent, a link label or something in the grounding text. A phrase at the very start of a
 * sentence loses its first word (a normal capital letter). */
export function namedThingsNotInBrief(markdown: string, allowedText: string): string[] {
  const known = new Set((allowedText.toLowerCase().match(/[\p{L}'’-]+/gu) ?? []))
  const found: string[] = []
  for (const sentence of sentencesOf(markdown)) {
    const words = sentence.split(/\s+/).map((w) => w.replace(/^[("'“]+|[.,;:!?)"'”]+$/g, '').replace(/['’]s$/i, ''))
    let run: string[] = []
    const flush = (startIdx: number) => {
      let phrase = run
      if (startIdx === 0) phrase = phrase.slice(1) // sentence-initial capital
      phrase = phrase.filter((w) => !NOT_VENUE.has(w.toLowerCase()))
      if (phrase.length >= 2 && !phrase.every((w) => known.has(w.toLowerCase()))) found.push(phrase.join(' '))
      run = []
    }
    let runStart = 0
    words.forEach((w, i) => {
      if (CAP_WORD.test(w)) {
        if (run.length === 0) runStart = i
        run.push(w)
      } else if (run.length) flush(runStart)
    })
    if (run.length) flush(runStart)
  }
  return [...new Set(found)]
}

export interface GateContext {
  /** The text from groundingText(brief): the only place a number may come from. */
  grounding: string
  /** Names the article may use besides the grounding: the parent's name and the link labels. The subject's own name is always allowed. */
  names?: string[]
  /** Paths that exist on the site (guides, packages, destinations, index pages, "/"). */
  allowedPaths: Set<string>
}

/** Reasons a composed guide must not auto-publish. Empty means clean. */
export function guideBlockers(guide: ComposedGuide, ctx: GateContext): string[] {
  const blockers: string[] = []
  const faqText = guide.faq.map((f) => `${f.q} ${f.a}`).join('\n')
  const takeText = guide.key_takeaways.join('\n')
  const metaText = [guide.meta_title, guide.meta_description, guide.og_title, guide.og_description].join('\n')
  const all = [guide.summary, guide.body, faqText, takeText, metaText].join('\n')
  const words = `${guide.summary} ${guide.body}`.trim().split(/\s+/).filter(Boolean).length

  if (words < GUIDE_WORDS_MIN) blockers.push(`too short (${words} words)`)
  if (words > GUIDE_WORDS_MAX) blockers.push(`too long (${words} words)`)
  const headingCount = guide.sections.length
  if (headingCount < 6 || headingCount > 10) blockers.push(`${headingCount} sections, expected 6 to 9`)
  if (guide.faq.length < 4) blockers.push(`missing FAQ (${guide.faq.length} questions, need at least 4)`)
  if (guide.key_takeaways.length < 3) blockers.push(`missing key takeaways (${guide.key_takeaways.length}, need at least 3)`)
  if (!guide.primary_keyword.trim()) blockers.push('no primary keyword')
  if (!guide.meta_title.trim() || !guide.meta_description.trim()) blockers.push('missing meta title or description')
  if (!guide.summary.toLowerCase().replace(/[^a-z0-9 ]/g, '').includes(guide.name.toLowerCase().replace(/[^a-z0-9 ]/g, ''))) blockers.push('the opening paragraph does not name the subject')

  // A number must come from the grounding text. Digits inside link targets do not count as prose.
  const allowedNumbers = new Set(numbersIn(ctx.grounding))
  const strangers = [...new Set(numbersIn(proseOf(all)).filter((n) => !allowedNumbers.has(n)))]
  if (strangers.length) blockers.push(`number not in the grounding: ${strangers.slice(0, 5).join(', ')}`)

  if (/\u2014/.test(all) || /\s--\s/.test(all)) blockers.push('em dash present')
  if (PLACEHOLDER_PATTERNS.some((p) => p.test(all))) blockers.push('placeholder text')
  if (REFUSAL_PATTERNS.some((p) => p.test(all))) blockers.push('model refusal in text')
  if (EXPERIENCE_CLAIM_PATTERNS.some((p) => p.test(all))) blockers.push('fabricated experience claim')
  for (const [pattern, label] of SUPERLATIVE_PATTERNS) {
    if (pattern.test(proseOf(all))) blockers.push(`superlative or rating claim (${label})`)
  }
  if (RECENCY_PATTERNS.some((p) => p.test(all))) blockers.push('unverifiable recency claim')
  if (COUNT_CLAIM.test(all)) blockers.push('amenity or capacity count')
  if (WORD_NUMBER_PATTERNS.some((p) => p.test(all)) || ungroundedWordCounts(all, ctx.grounding).length) blockers.push('a size, count or date written in words')
  if (SCHEDULE_PATTERN.test(all)) blockers.push('itinerary or schedule stated as fact')
  if (/\u2013/.test(all)) blockers.push('en dash present')

  // The agency may offer help, never describe its own history.
  const claims = agencyClaims([guide.summary, guide.body, faqText, takeText].join('\n'))
  if (claims.length) blockers.push(`claim about what the agency has done or does: "${claims[0].slice(0, 80)}"`)

  // A restaurant, person or port the brief never mentioned is a made-up detail until proven otherwise.
  const allowedText = [ctx.grounding, guide.name, ...(ctx.names ?? [])].join(' ')
  const venues = namedThingsNotInBrief([guide.summary, guide.body, faqText, takeText].join('\n'), allowedText)
  if (venues.length) blockers.push(`named venue or person not in brief: ${venues.slice(0, 3).join(', ')}`)

  if (/https?:\/\/|\bwww\./i.test(all)) blockers.push('web address in text')
  if (/\]\(/.test(faqText) || /\]\(/.test(takeText) || /\]\(/.test(metaText)) blockers.push('link inside FAQ, takeaways or meta text')
  const links = internalLinksIn(`${guide.summary}\n${guide.body}`)
  if (links.length === 0) blockers.push('no internal link')
  const dead = [...new Set(links.filter((l) => !ctx.allowedPaths.has(l)))]
  if (dead.length) blockers.push(`dead internal link: ${dead.slice(0, 3).join(', ')}`)
  if (/\]\((?!\/)[^)]*\)/.test(`${guide.summary}\n${guide.body}`)) blockers.push('link that is not an internal path')

  return blockers
}

// Shared with lib/page-copy-composer.ts, which applies the same rules to compare and best-time copy.
// WP10 (lib/content-repair.ts) reuses WORD_NUMBER_PATTERNS to find the sentences behind a gate blocker.
export { numbersIn, proseOf, clamp, strings, callText, PLACEHOLDER_PATTERNS, REFUSAL_PATTERNS, EXPERIENCE_CLAIM_PATTERNS, SUPERLATIVE_PATTERNS, RECENCY_PATTERNS, COUNT_CLAIM, SCHEDULE_PATTERN, WORD_NUMBER_PATTERNS }
