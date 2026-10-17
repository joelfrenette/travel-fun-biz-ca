import type { NewsCategory, NewsSource } from '@/lib/news-sources'

// Growth loop WP20: is a feed item about something that changes a traveller's plans? Deterministic keyword rules only
// (no model, no cost). Celebrity news, reviews, ads and listicles are dropped first. Pure.

export interface Classification {
  relevant: boolean
  category: NewsCategory
  /** Why (a short plain note, also stored as the reject reason when not relevant). */
  reason: string
  /** A tier 1 item about a warning, a top-level advisory or an emergency. Sorted first and allowed to publish at once. */
  breaking: boolean
}

const DROP: RegExp[] = [
  /\b(celebrity|celebrities|kardashian|red carpet|royal family|influencer)\b/i,
  /\b(giveaway|sweepstakes|sponsored|advertorial|promo code|coupon|discount code|black friday|cyber monday|sale ends)\b/i,
  /\b(hotel|resort|restaurant|ship|cruise|airline|flight|lounge|suite|cabin) review\b/i,
  /\breview:/i,
  /\bhands[- ]on\b/i,
  /\b(\d+|ten|five|seven|nine) (best|top|things|reasons|ways|places|tips|hotels|beaches|restaurants|destinations|cruises)\b/i,
  /\b(best|top) (hotels?|beaches|places|restaurants|cruises?|destinations|airlines?|credit cards?)\b/i,
  /\b(bucket list|podcast|webinar|quiz|horoscope|photo gallery|sweepstake|earnings|stock price|shares (rise|fall|jump)|quarterly results|appoints|names new (ceo|president))\b/i,
]

const RULES: { category: NewsCategory; patterns: RegExp[] }[] = [
  { category: 'storm', patterns: [/\b(hurricane|tropical storm|tropical depression|tropical cyclone|post-tropical|typhoon|cyclone|storm surge)\b/i] },
  { category: 'disaster', patterns: [/\b(volcano|volcanic|eruption|earthquake|tsunami|wildfires?|flood(ing|s)?|landslide|mudslide|blizzard)\b/i] },
  { category: 'entry', patterns: [/\b(visas?|e-?visa|entry requirements?|etias|travel authori[sz]ation|passports?|border (crossing|control|closure|restriction|rules?)|travel ban|entry ban|immigration rules?|quarantine)\b/i, /\b(ETA|EES)\b/] },
  { category: 'advisory', patterns: [/\b(travel advisory|travel advice|advisory level|travel alert|travel warning|security alert|do not travel|reconsider travel|exercise (increased |a high degree of )?caution|avoid (all |non-essential )?travel)\b/i, /\blevel [1-4]\b/i] },
  {
    category: 'disruption',
    patterns: [/\b(port|terminal|airport|runway) (is |are |has |have )?(clos|shut)/i, /\b(strike|walkout|industrial action|lockout)\b/i, /\b(flight|sailing|voyage|departure)s? (is |are |was |were |has been |have been )?(cancell?ed|suspended|delayed|diverted)/i, /\bcancell?s (flights|sailings|voyages|service)\b/i, /\b(suspend\w*|cancel\w*|skip\w*|omit\w*|bypass\w*) (all |some )?(port )?(calls?|stops?|sailings?|flights?|service)\b/i, /\b(pier|dock|terminal) (damage|collapse)\b/i, /\b(ground stop|air traffic control|grounded|ship (aground|fire|collision|breakdown|stranded)|power outage|itinerary change)\b/i],
  },
  { category: 'health', patterns: [/\b(norovirus|outbreak|measles|cholera|dengue|yellow fever|health alert|ebola|mpox|zika|chikungunya|malaria|legionella|e\. coli|covid)\b/i] },
  { category: 'legislation', patterns: [/\b(legislation|new law|bill (passed|signed)|regulations?|tourist tax|tourism tax|visitor fee|entry fee|passenger rights|levy|cruise ship ban)\b/i, /\b(APPR|EU261|FAA)\b/] },
  { category: 'unrest', patterns: [/\b(war|conflict|unrest|protests?|riots?|coup|curfew|state of emergency|missile|terror(ism|ist)?|ceasefire|airspace (is |has been )?clos|hostilities)\b/i] },
]

/** NHC feeds also carry "no storms" notices, outlooks and graphics pages that say nothing happened. */
const NHC_NOT_AN_EVENT = /\b(no (active )?tropical cyclones?|no tropical|outlook|graphical|archive|tropical weather discussion)\b/i
const NHC_EVENT = /\b(hurricane|tropical storm|tropical depression|potential tropical cyclone|post-tropical|tropical cyclone)\b/i

const BREAKING = /\b(hurricane (warning|watch)|tropical storm (warning|watch)|major hurricane|category [3-5]|do not travel|level 4|level 3|reconsider travel|state of emergency|evacuat|avoid all travel|advise against all travel|advises against all travel)\b/i

/** Recomputed from the stored title and summary (the table has no breaking column). Pure. */
export function isBreaking(tier: number, title: string, summary: string): boolean {
  return tier === 1 && BREAKING.test(`${title} ${summary}`)
}

/** Decides whether an item is travel-affecting. Order: drop rules, then source-specific rules, then keyword rules. */
export function classifyItem(source: Pick<NewsSource, 'key' | 'tier' | 'defaultCategory'>, item: { title: string; summary: string }): Classification {
  const text = `${item.title} ${item.summary}`
  const breaking = source.tier === 1 && BREAKING.test(text)
  const none = (reason: string): Classification => ({ relevant: false, category: source.defaultCategory, reason, breaking: false })
  if (DROP.some((re) => re.test(item.title))) return none('not travel-affecting (a review, a list, an ad, or celebrity or business news)')

  if (source.key.startsWith('nhc-')) {
    if (NHC_NOT_AN_EVENT.test(item.title)) return none('the hurricane centre posted an outlook or a no-storms notice, not an event')
    if (!NHC_EVENT.test(text)) return none('not about a named storm or a tropical cyclone')
    return { relevant: true, category: 'storm', reason: 'a tropical cyclone bulletin', breaking }
  }

  const matched = RULES.find((r) => r.patterns.some((re) => re.test(text)))
  if (source.tier === 1 && (source.defaultCategory === 'advisory' || source.defaultCategory === 'entry')) {
    // Every item of an official advisory feed is a travel advisory update; a keyword only refines the category.
    return { relevant: true, category: matched && matched.category !== 'legislation' ? matched.category : source.defaultCategory, reason: 'an official travel advisory update', breaking }
  }
  if (!matched) return none('no travel-affecting topic found (storm, disaster, visa or entry rule, advisory, disruption, health, law, unrest)')
  return { relevant: true, category: matched.category, reason: `about ${matched.category}`, breaking }
}

// ---------------------------------------------------------------------------------------------------
// Duplicates
// ---------------------------------------------------------------------------------------------------

const STOP = new Set(['the', 'a', 'an', 'of', 'in', 'on', 'for', 'to', 'and', 'at', 'by', 'with', 'as', 'is', 'are', 'from', 'new', 'update', 'updated', 'number', 'advisory', 'intermediate', 'public', 'special', 'forecast', 'discussion', 'summary'])

/** A title reduced to the words that name the event: lower case, no digits, no filler. Pure. */
export function titleTokens(title: string): string[] {
  return title
    .toLowerCase()
    .replace(/[0-9]+/g, ' ')
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP.has(w))
}

export function titleKey(title: string): string {
  return [...new Set(titleTokens(title))].sort().join(' ')
}

export function titleSimilarity(a: string, b: string): number {
  const x = new Set(titleTokens(a))
  const y = new Set(titleTokens(b))
  if (x.size === 0 || y.size === 0) return 0
  let both = 0
  for (const w of x) if (y.has(w)) both++
  return both / (x.size + y.size - both)
}

export const SIMILAR_TITLE_THRESHOLD = 0.7

/** True when `title` repeats one of `others` (the same words once numbers and filler are ignored, or 70% the same words). Pure. */
export function isNearDuplicate(title: string, others: string[]): boolean {
  const key = titleKey(title)
  if (!key) return false
  return others.some((o) => titleKey(o) === key || titleSimilarity(title, o) >= SIMILAR_TITLE_THRESHOLD)
}

/** Sort order for picking what to write about: breaking tier 1 first, then tier 1, then tier 2; newest first inside a group. */
export function priorityOf(i: { tier: number; breaking?: boolean; published_at: string | null; fetched_at: string }): number {
  const group = i.breaking ? 0 : i.tier === 1 ? 1 : 2
  const ms = Date.parse(i.published_at ?? i.fetched_at)
  return group * 1e13 - (Number.isFinite(ms) ? ms : 0) / 1e0
}
