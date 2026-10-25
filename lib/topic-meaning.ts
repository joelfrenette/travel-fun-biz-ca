// "Same meaning" topic check (autoblog topic step, second dedupe layer).
//
// The first layer (lib/content-dedupe.ts, postWithSameKeyword in lib/blog-topics.ts) matches WORDS. It lets
// "Best time to visit Santorini" and "When should you go to Santorini" both through, because they share only one word. This layer
// folds a topic into a small set of concepts (stemmed words, synonyms folded together, filler dropped) and compares those sets with a
// TF-IDF weighted cosine and Jaccard score. No network, no database, no embeddings service, no cost: everything here is PURE and
// unit-tested by scripts/check-topic-meaning.ts. The server side (reading posts, the AI tie-break, the log) is lib/topic-meaning-run.ts.
//
// How a score is made:
//  1. text -> tokens: lower-cased, "first time" folded to one word, filler and qualifiers ("best", "how", "should") dropped.
//  2. every token is stemmed, then looked up in the synonym table ("go", "visit", "trip" are one concept; "when", "time", "season" another).
//  3. weights: place names and other specific words weigh most (1.6), question-type concepts (when, cost, packing, safety...) weigh 1.0,
//     generic concepts (visit, guide) weigh 0.35. Corpus IDF multiplies in when a corpus is given.
//  4. score = 0.6 * weighted cosine + 0.4 * weighted Jaccard. If both texts ask clearly different questions (one is about WHEN, the other
//     about COST, say) the score is cut to 55%, so "Santorini weather" and "Santorini budget" stay apart.

export const SAME_THRESHOLD = 0.72
export const BORDERLINE_THRESHOLD = 0.5
/** A facet conflict (both texts ask a question, and not the same one) multiplies the score by this. */
export const FACET_CONFLICT_FACTOR = 0.55
/** Generic-only texts ("travel tips" vs "travel guide") can never be the same topic by themselves. */
export const GENERIC_ONLY_CAP = 0.4
/** A page under this many characters of body is "thin"; a page older than this many days is "old" (refresh instead of a second page). */
export const THIN_BODY_CHARS = 2500
export const OLD_PAGE_DAYS = 540

// ---- vocabulary ----------------------------------------------------------------------------------------------------------------

const STOP = new Set(
  (
    'a an the to for of in on and or with what how is are do does your you my our from about at it its be can should would will could i we us me this that these those which where who why ' +
    'there their into by as if so than then too very just really also not no up out over under around near am was were been being get got make makes through during while money ' +
    // qualifiers that say "a post", not what it is about
    'best top ideal perfect good great right ultimate complete essential everything need needs know must ' +
    // generic words that only mark the kind of post
    'list overview introduction basics explained'
  ).split(/\s+/),
)

/** concept -> words that mean it. The concept itself is the token the rest of the code sees. */
const CONCEPTS: Record<string, string> = {
  visit: 'visit visiting visits go going goes went gone travel traveling travelling travels trip trips journey vacation vacations holiday holidays tour tours see seeing explore exploring getaway getaways destination visitor visitors tourist tourists traveler travelers traveller travellers',
  guide: 'guide guides tip tips advice guidance idea ideas thing things hack hacks secret secrets mistake mistakes way ways reason reasons checklist',
  when: 'when time times season seasons month months period window timing',
  weather: 'weather climate temperature temperatures rain rainy hot cold humid forecast',
  cost: 'cost costs price prices pricing cheap cheaper cheapest affordable budget budgets expensive money spend spending afford much fee fees',
  pack: 'pack packing packs luggage suitcase wear bring carry-on',
  safe: 'safe safety safer dangerous danger secure scam scams',
  family: 'family families kid kids child children toddler toddlers teen teens',
  couple: 'couple couples romantic romance honeymoon honeymoons anniversary',
  solo: 'solo alone single singles',
  food: 'food foods eat eating dining restaurant restaurants cuisine dish dishes taste tasting tastes',
  stay: 'stay stays staying accommodation accommodations lodging hotel hotels resort resorts hostel hostels',
  plan: 'itinerary itineraries plan plans planning schedule route routes day days week weeks weekend',
  flight: 'flight flights fly flying airfare airline airlines airport',
  train: 'train trains rail railway ride riding rides',
  ferry: 'ferry ferries boat boats',
  drive: 'drive driving car cars rental bus buses',
  entry: 'visa visas passport passports entry requirement requirements',
  insurance: 'insurance insure insured coverage',
  compare: 'vs versus compare comparison compared difference differences better',
  worth: 'worth worthwhile',
  cruise: 'cruise cruises cruising sailing ship ships voyage voyages',
  first: 'first firsttimer beginner beginners newbie novice',
}

/** Words that are the same place or thing under another name. */
const ALIASES: Record<string, string> = {
  greek: 'greece', italian: 'italy', french: 'france', spanish: 'spain', dutch: 'netherlands', holland: 'netherlands', croatian: 'croatia', portuguese: 'portugal',
  icelandic: 'iceland', mexican: 'mexico', japanese: 'japan', thai: 'thailand', turkish: 'turkey', swiss: 'switzerland', german: 'germany', irish: 'ireland',
  scottish: 'scotland', norwegian: 'norway', swedish: 'sweden', danish: 'denmark', hawaiian: 'hawaii', jamaican: 'jamaica', cuban: 'cuba', peruvian: 'peru',
  moroccan: 'morocco', egyptian: 'egypt', vietnamese: 'vietnam', austrian: 'austria', hungarian: 'hungary', czech: 'czechia', polish: 'poland', belgian: 'belgium',
}

/** concept -> the question it asks. Two texts that ask different questions are about different posts, even in the same place. */
const FACET_OF: Record<string, string> = {
  when: 'timing', weather: 'timing', cost: 'cost', pack: 'pack', safe: 'safety', family: 'family', couple: 'couple', solo: 'solo', food: 'food', stay: 'stay', plan: 'plan',
  flight: 'flight', train: 'train', ferry: 'ferry', drive: 'drive', entry: 'docs', insurance: 'insurance', compare: 'compare', worth: 'worth', first: 'first',
}
const MONTHS = 'january february march april may june july august september october november december jan feb mar apr jun jul aug sep sept oct nov dec spring summer autumn fall winter'.split(' ')
// A named month or season is a facet of its own ("m:may"), on top of "timing": "Alaska in May" and "Alaska in September" are two posts.
const monthFacet = (m: string): string => `m:${m.slice(0, 3)}`

const GENERIC = new Set(['visit', 'guide'])

/** Lower-case word stem. Deliberately light: the same word in two forms must meet, nothing cleverer. Pure. */
export function stem(word: string): string {
  const w = word.toLowerCase()
  if (w.length <= 3 || /^\d+$/.test(w)) return w
  let s = w
  if (s.endsWith('ies') && s.length > 4) s = `${s.slice(0, -3)}y`
  else if (s.endsWith('sses')) s = s.slice(0, -2)
  else if (/(ches|shes|xes|zes)$/.test(s)) s = s.slice(0, -2)
  else if (s.endsWith('s') && !/(ss|us|is)$/.test(s)) s = s.slice(0, -1)
  if (s.length > 5 && s.endsWith('ing')) {
    s = s.slice(0, -3)
    if (/([^aeiou])\1$/.test(s)) s = s.slice(0, -1)
  } else if (s.length > 4 && s.endsWith('ed')) {
    s = s.slice(0, -2)
    if (/([^aeiou])\1$/.test(s)) s = s.slice(0, -1)
  }
  return s
}

const SYN = new Map<string, string>()
for (const [concept, words] of Object.entries(CONCEPTS)) {
  for (const w of words.split(/\s+/)) {
    SYN.set(w, concept)
    SYN.set(stem(w), concept)
  }
}
for (const m of MONTHS) SYN.set(m, m)
const STOP_STEMS = new Set([...STOP].map(stem))

export interface Concepts {
  /** Distinct concept tokens, in order of first appearance. */
  tokens: string[]
  /** The questions the text asks (timing, cost, pack...). */
  facets: Set<string>
}

/** Text -> concepts. Pure. */
export function conceptsOf(text: string): Concepts {
  const cleaned = text
    .toLowerCase()
    .replace(/\bfirst[\s-]+time(r|rs)?\b/g, ' first ')
    .replace(/\bcarry[\s-]+on\b/g, ' pack ')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s]/g, ' ')
  const out: string[] = []
  for (const raw of cleaned.split(/\s+/)) {
    if (!raw) continue
    if (/^(19|20)\d\d$/.test(raw)) continue // a year in a title does not change what the post is about
    if (STOP.has(raw)) continue
    const aliased = ALIASES[raw] ?? raw
    const st = stem(aliased)
    if (STOP_STEMS.has(st) && !SYN.has(aliased)) continue
    const token = SYN.get(aliased) ?? SYN.get(st) ?? st
    if (token.length < 2 && !/^\d$/.test(token)) continue
    if (!out.includes(token)) out.push(token)
  }
  const facets = new Set<string>()
  for (const t of out) {
    if (FACET_OF[t]) facets.add(FACET_OF[t])
    if (MONTHS.includes(t)) {
      facets.add('timing')
      facets.add(monthFacet(t))
    }
  }
  return { tokens: out, facets }
}

// ---- scoring -------------------------------------------------------------------------------------------------------------------

export type IdfMap = Map<string, number>

/** Inverse document frequency over a corpus of texts: rare words weigh more. Always at least 1. Pure. */
export function buildIdf(texts: string[]): IdfMap {
  const df = new Map<string, number>()
  for (const t of texts) for (const tok of new Set(conceptsOf(t).tokens)) df.set(tok, (df.get(tok) ?? 0) + 1)
  const n = texts.length
  const idf: IdfMap = new Map()
  for (const [tok, c] of df) idf.set(tok, Math.log((n + 1) / (c + 1)) + 1)
  return idf
}

function classWeight(token: string): number {
  if (GENERIC.has(token)) return 0.35
  if (FACET_OF[token] || MONTHS.includes(token) || /^\d+$/.test(token)) return 1.0
  return 1.6
}

const weightOf = (token: string, idf?: IdfMap): number => classWeight(token) * (idf?.get(token) ?? 1)

export interface MeaningScore {
  score: number
  cosine: number
  jaccard: number
  /** True when the two texts ask different questions about the same place. */
  facetConflict: boolean
}

/** How alike two texts are in meaning, 0 to 1. Symmetric. Pure. */
export function meaningScore(a: string | Concepts, b: string | Concepts, idf?: IdfMap): MeaningScore {
  const A = typeof a === 'string' ? conceptsOf(a) : a
  const B = typeof b === 'string' ? conceptsOf(b) : b
  if (!A.tokens.length || !B.tokens.length) return { score: 0, cosine: 0, jaccard: 0, facetConflict: false }
  const setB = new Set(B.tokens)
  const setA = new Set(A.tokens)
  let dot = 0
  let na = 0
  let nb = 0
  let inter = 0
  let union = 0
  for (const t of A.tokens) {
    const w = weightOf(t, idf)
    na += w * w
    if (setB.has(t)) {
      dot += w * w
      inter += w
    }
    union += w
  }
  for (const t of B.tokens) {
    const w = weightOf(t, idf)
    nb += w * w
    if (!setA.has(t)) union += w
  }
  const cosine = dot / Math.sqrt(na * nb)
  const jaccard = union > 0 ? inter / union : 0
  let score = 0.6 * cosine + 0.4 * jaccard
  let facetConflict = false
  // Both texts ask a question and neither one's questions are contained in the other's: different posts.
  const aInB = [...A.facets].every((f) => B.facets.has(f))
  const bInA = [...B.facets].every((f) => A.facets.has(f))
  if (A.facets.size && B.facets.size && !aInB && !bInA) {
    facetConflict = true
    score *= FACET_CONFLICT_FACTOR
  }
  const specific = (c: Concepts) => c.tokens.some((t) => !GENERIC.has(t))
  if (!specific(A) || !specific(B)) score = Math.min(score, GENERIC_ONLY_CAP)
  return { score: Math.round(score * 1000) / 1000, cosine: Math.round(cosine * 1000) / 1000, jaccard: Math.round(jaccard * 1000) / 1000, facetConflict }
}

// ---- matching a topic against what already exists --------------------------------------------------------------------------------

export type MeaningDocKind = 'post' | 'rejected' | 'queued'

/** Something that already exists: a post, a recently rejected topic, or a topic waiting in the queue. */
export interface MeaningDoc {
  kind: MeaningDocKind
  /** A post's slug; for a topic, its keyword. Shown in the reason ("duplicate of <slug>"). */
  slug: string
  title: string
  /** The primary keyword (posts) or the keyword (topics). */
  keyword?: string | null
  /** Queue row id, so a topic never matches itself. */
  id?: string
  body_chars?: number | null
  /** publish_date or created_at. */
  date?: string | null
}

export interface TopicText {
  keyword: string
  angle?: string | null
  title?: string | null
}

export type MeaningBand = 'same' | 'borderline' | 'different'

export interface MeaningMatch {
  doc: MeaningDoc
  score: number
  /** Which text pair gave the score, for the log. */
  via: string
}

export interface MeaningResult {
  band: MeaningBand
  best: MeaningMatch | null
}

/** The texts of a topic that are worth comparing: its keyword, its title idea, and its angle. */
export function topicTexts(t: TopicText): { label: string; text: string }[] {
  const out: { label: string; text: string }[] = []
  if (t.keyword?.trim()) out.push({ label: 'keyword', text: t.keyword })
  if (t.title?.trim()) out.push({ label: 'title idea', text: t.title })
  if (t.angle?.trim()) out.push({ label: 'angle', text: t.angle })
  return out
}

const docTexts = (d: MeaningDoc): { label: string; text: string }[] => {
  const out: { label: string; text: string }[] = []
  if (d.title?.trim()) out.push({ label: 'title', text: d.title })
  if (d.keyword?.trim()) out.push({ label: 'keyword', text: d.keyword })
  return out
}

/** Compares a topic with every doc and returns the closest one and which band it falls in. A doc is compared on its title and primary
 * keyword; the topic on its keyword, title idea and angle; the best pair counts. Docs whose id is `excludeId` are skipped. Pure. */
export function findSameMeaning(topic: TopicText, docs: MeaningDoc[], opts: { excludeId?: string | null; same?: number; borderline?: number } = {}): MeaningResult {
  const same = opts.same ?? SAME_THRESHOLD
  const borderline = opts.borderline ?? BORDERLINE_THRESHOLD
  const mine = topicTexts(topic)
  const pool = docs.filter((d) => !(opts.excludeId && d.id === opts.excludeId))
  if (!mine.length || !pool.length) return { band: 'different', best: null }
  const idf = buildIdf([...mine.map((m) => m.text), ...pool.flatMap((d) => docTexts(d).map((x) => x.text))])
  const mineC = mine.map((m) => ({ label: m.label, c: conceptsOf(m.text) }))
  let best: MeaningMatch | null = null
  for (const d of pool) {
    for (const dt of docTexts(d)) {
      const dc = conceptsOf(dt.text)
      for (const m of mineC) {
        const s = meaningScore(m.c, dc, idf).score
        if (!best || s > best.score) best = { doc: d, score: s, via: `${m.label} vs ${dt.label}` }
      }
    }
  }
  if (!best) return { band: 'different', best: null }
  return { band: best.score >= same ? 'same' : best.score >= borderline ? 'borderline' : 'different', best }
}

/** "refresh <slug> instead" when the existing page is thin or old, otherwise null. Log text only, never an action. Pure. */
export function refreshHint(doc: MeaningDoc, now: Date = new Date()): string | null {
  if (doc.kind !== 'post') return null
  const thin = typeof doc.body_chars === 'number' && doc.body_chars > 0 && doc.body_chars < THIN_BODY_CHARS
  const ms = Date.parse(doc.date ?? '')
  const old = Number.isFinite(ms) && now.getTime() - ms > OLD_PAGE_DAYS * 86_400_000
  if (!thin && !old) return null
  return `refresh ${doc.slug} instead (${thin ? 'the page is thin' : 'the page is more than 18 months old'})`
}

/** The plain-English reason stored on the queue row and in the decision log. Pure. */
export function duplicateReason(match: MeaningMatch, how: 'deterministic' | 'ai', now: Date = new Date()): string {
  const what = match.doc.kind === 'post' ? '' : match.doc.kind === 'rejected' ? 'rejected topic ' : 'queued topic '
  const base = `duplicate of ${what}${match.doc.slug} (same meaning, ${how === 'ai' ? 'confirmed by AI, ' : ''}similarity ${match.score.toFixed(2)})`
  const hint = refreshHint(match.doc, now)
  return hint ? `${base}. Suggestion: ${hint}` : base
}
