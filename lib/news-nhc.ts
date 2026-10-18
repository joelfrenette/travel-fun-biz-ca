import { briefProblems, wordCount, type NewsBrief, type NewsFacts } from '@/lib/news-brief'
import { isNhcSource } from '@/lib/news-relevance'
import { SUMMARY_MAX_CHARS } from '@/lib/news-sources'

// Growth loop WP20 tuning: the hurricane centre Public Advisory is written by PLAIN CODE, not by a model.
//
// Why: the writer model kept adding a country or expanding "WSW" to "west-southwest", words the bulletin does not contain, so the
// gate threw most NHC briefs away after paying for up to 7 model calls. The bulletin text is already structured (headline phrases
// between "..." markers, LOCATION, ABOUT n MI...n KM <dir> OF <PLACE>, MAXIMUM SUSTAINED WINDS, PRESENT MOVEMENT, MINIMUM CENTRAL
// PRESSURE), so the brief is assembled from those pieces and from nothing else.
//
// Safety: the feed description is untrusted. Every extractor is a strict regex with a narrow character class (upper case letters,
// digits and a little punctuation), so nothing that talks to a model can pass through; every piece is then run through the SAME
// gate as a model brief (briefProblems, meansSentenceProblems): a sentence that fails is dropped, and if the finished brief still
// fails, or fewer than NHC_MIN_FACTS facts were found, the result is "not ok" and the caller falls back to the model path.
// No model is called here. No judge is needed for a pure template (the gate is the law and a template cannot paraphrase).

export const NHC_MIN_FACTS = 2
/** "what it means" is limited to 45 words for an official notice (lib/news-brief.ts). */
const MEANS_WORD_BUDGET = 45
const MAX_MEANS_SENTENCES = 3

export type NhcTemplate = { ok: true; brief: NewsBrief; facts: string[] } | { ok: false; reason: string }

/** True for the plain-language product, the only hurricane centre item type that is written about. */
export const isNhcPublicAdvisory = (sourceKey: string, title: string): boolean => isNhcSource(sourceKey) && /\bpublic advisory\b/i.test(title)

const DIRECTIONS = new Set(['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'])
const LOWER_WORDS = new Set(['of', 'the', 'and', 'de', 'la', 'del', 'y', 'in', 'on', 'to', 'for', 'near'])
/** Place names that may appear in a headline phrase. Used only to put the capital letter back when a SHOUTED phrase is turned into a
 * sentence; it never adds a word (the phrase itself comes from the bulletin). A name not listed here simply stays in lower case. */
const GEO_NAMES = new Set(
  'mexico baja california florida texas louisiana mississippi alabama georgia carolina virginia hawaii cuba jamaica haiti bahamas bermuda honduras belize guatemala nicaragua panama colombia venezuela hispaniola puerto rico caribbean atlantic pacific gulf canada newfoundland acapulco manzanillo cabo corrientes cozumel yucatan tampico veracruz'.split(' '),
)

const cap = (w: string): string => (w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w)

/** "CABO CORRIENTES MEXICO" becomes "Cabo Corrientes Mexico"; little words stay in lower case ("of", "the"). */
function titleCasePlace(s: string): string {
  return s
    .trim()
    .split(/\s+/)
    .map((w, i) => (i > 0 && LOWER_WORDS.has(w.toLowerCase()) ? w.toLowerCase() : cap(w)))
    .join(' ')
}

const stormLabelOf = (title: string): string | null => {
  const head = title.split(/\s+(?:public\s+)?advisory\b/i)[0]?.trim() ?? ''
  return /^[A-Za-z][A-Za-z -]{2,60}$/.test(head) && /[A-Z]/.test(head) ? head.replace(/\s+/g, ' ') : null
}
const advisoryNumberOf = (title: string): string | null => /\badvisory number (\d{1,3}[A-Z]?)\b/i.exec(title)?.[1] ?? null

export interface NhcParts {
  /** Headline phrases between "..." markers, as written (upper case). */
  headlines: string[]
  location: string | null
  /** Distance lines kept as written except for the title-cased place. */
  places: { mi: string; km: string; dir: string; place: string }[]
  winds: { mph: string } | null
  movement: string | null
  pressure: string | null
}

/** Pulls the structured pieces out of the bulletin text with strict, defensive regexes. Every part may be missing; text cut at
 * 600 characters is tolerated (an incomplete last piece is dropped, never guessed). Pure. */
export function extractNhcParts(summary: string): NhcParts {
  const text = summary.replace(/\s+/g, ' ').trim()
  const truncated = summary.length >= SUMMARY_MAX_CHARS - 1
  const parts: NhcParts = { headlines: [], location: null, places: [], winds: null, movement: null, pressure: null }

  // Headline phrases: "...TRUDY EXPECTED TO MOVE AWAY FROM THE COAST OF MEXICO THIS AFTERNOON..." The opening dots follow a space
  // (or the start) and the closing dots are followed by a space (or the end), so "LOCATION...19.1N" and "MST...1500 UTC..." are not phrases.
  for (const m of text.matchAll(/(?:^|\s)\.\.\.([A-Z0-9](?:(?!\.\.\.)[A-Z0-9 ,'/&-])*?)\.\.\.(?=\s|$)/g)) {
    const phrase = m[1].replace(/\s+/g, ' ').replace(/[ ,]+$/, '').trim()
    if (phrase.length < 12 || phrase.length > 140 || phrase.split(' ').length < 3) continue
    if (/^(SUMMARY|WATCHES|WARNINGS|INFORMATION|DISCUSSION|HAZARDS)\b/.test(phrase)) continue
    if ((phrase.match(/[A-Z]/g)?.length ?? 0) < phrase.length * 0.6) continue
    if (!parts.headlines.includes(phrase)) parts.headlines.push(phrase)
    if (parts.headlines.length >= 3) break
  }

  const loc = /LOCATION\.{2,}\s*(\d{1,2}\.\d)([NS]) (\d{1,3}\.\d)([EW])\b/.exec(text)
  if (loc) parts.location = `${loc[1]}${loc[2]} ${loc[3]}${loc[4]}`

  const placeRe = /ABOUT (\d{1,4}) MI\.{2,}(\d{1,5}) KM ([NSEW]{1,3}) OF ([A-Z][A-Z .'-]{2,70}?)(?=\s+(?:ABOUT|MAXIMUM|PRESENT|MINIMUM|ESTIMATED|REPEATING|NEXT|WATCHES|WARNINGS|SUMMARY|DISCUSSION|HAZARDS)\b|\s*$)/g
  for (const m of text.matchAll(placeRe)) {
    const atEnd = (m.index ?? 0) + m[0].length >= text.length
    if (atEnd && truncated) continue // cut off in the middle of the place name
    if (!DIRECTIONS.has(m[3])) continue
    const place = m[4].replace(/\.+$/, '').replace(/\s+/g, ' ').trim()
    if (place.length < 3 || !/[A-Z]{3}/.test(place)) continue
    parts.places.push({ mi: m[1], km: m[2], dir: m[3], place: titleCasePlace(place) })
    if (parts.places.length >= 2) break
  }

  const winds = /MAXIMUM SUSTAINED WINDS\.{2,}\s*(\d{1,3}) MPH\b/.exec(text)
  if (winds) parts.winds = { mph: winds[1] }

  const mv = /PRESENT MOVEMENT\.{2,}\s*((?:[NSEW]{1,3} OR \d{1,3} DEGREES AT \d{1,3} MPH)|(?:NEARLY )?STATIONARY)(?=\.{2,}|\s|$)/.exec(text)
  if (mv) {
    parts.movement = mv[1]
      .toLowerCase()
      .replace(/\b([nsew]{1,3})\b(?= or \d)/, (_x, d: string) => d.toUpperCase())
  }

  const pr = /MINIMUM CENTRAL PRESSURE\.{2,}\s*(\d{3,4}) MB\b/.exec(text)
  if (pr) parts.pressure = `${pr[1]} mb`
  return parts
}

/** A shouted phrase as a sentence fragment: lower case, then the capital letters put back on the storm name, on place words found in
 * the bulletin's own distance lines, on a short list of well-known place names, and on direction letters. */
function sentenceCase(phrase: string, names: Set<string>): string {
  const out = phrase
    .toLowerCase()
    .split(' ')
    .map((w) => {
      const bare = w.replace(/^[^a-z]+|[^a-z]+$/g, '')
      if (DIRECTIONS.has(bare.toUpperCase()) && bare.length >= 2 && bare.length <= 3) return w.replace(bare, bare.toUpperCase())
      return names.has(bare) || GEO_NAMES.has(bare) ? w.replace(bare, cap(bare)) : w
    })
    .join(' ')
  return out[0].toUpperCase() + out.slice(1)
}

const withStop = (s: string): string => (/[.]$/.test(s) ? s : `${s}.`)

/** Builds the post's brief from the item's own text with no model call. `ok: false` means "use the model path instead". Pure. */
export function buildNhcBrief(f: NewsFacts, sourceKey: string): NhcTemplate {
  if (!isNhcPublicAdvisory(sourceKey, f.title)) return { ok: false, reason: 'not a hurricane centre Public Advisory' }
  const storm = stormLabelOf(f.title)
  if (!storm) return { ok: false, reason: 'no storm name in the title' }
  const number = advisoryNumberOf(f.title)
  const parts = extractNhcParts(f.summary)
  const stormWord = storm.split(' ').pop() as string
  const names = new Set<string>([stormWord.toLowerCase(), ...parts.places.flatMap((p) => p.place.toLowerCase().split(' '))])

  const found = parts.headlines.length + parts.places.length + (parts.location ? 1 : 0) + (parts.winds ? 1 : 0) + (parts.movement ? 1 : 0) + (parts.pressure ? 1 : 0)
  if (found < NHC_MIN_FACTS) return { ok: false, reason: `only ${found} fact${found === 1 ? '' : 's'} could be read from the bulletin text` }

  const source = f.sourceName.replace(/^the\s+/i, '')
  const agency = f.sourceName.startsWith('the ') ? `The ${source}` : source
  const happenedText = parts.winds ? `${agency} reports ${storm} has maximum sustained winds of ${parts.winds.mph} mph.` : `${agency} issued ${number ? `Advisory Number ${number}` : 'an advisory'} for ${storm}.`

  // Candidate "what it means" sentences, most useful first. Each one must pass the same per-sentence gate as a model sentence.
  const phrases = parts.headlines.map((h) => sentenceCase(h, names))
  const cands: string[] = []
  if (phrases[0]) cands.push(`The source says: ${withStop(phrases[0])}`)
  if (parts.places[0]) cands.push(`According to the source, ${storm} is about ${parts.places[0].mi} MI, ${parts.places[0].km} KM ${parts.places[0].dir} of ${parts.places[0].place}.`)
  if (parts.movement) cands.push(`The source says present movement is ${parts.movement}.`)
  if (parts.pressure) cands.push(`According to the source, minimum central pressure is ${parts.pressure}.`)
  if (parts.location) cands.push(`The source says the location is ${parts.location}.`)
  if (phrases[1]) cands.push(`According to the source: ${withStop(phrases[1])}`)
  if (parts.places[1]) cands.push(`The source says ${storm} is about ${parts.places[1].mi} MI, ${parts.places[1].km} KM ${parts.places[1].dir} of ${parts.places[1].place}.`)

  // Headline: a headline phrase that opens with the storm name (with the full label put in front), else the advisory number.
  const lead = phrases.find((p) => p.toLowerCase().startsWith(stormWord.toLowerCase() + ' '))
  const phraseHeadline = lead ? `${storm}${lead.slice(stormWord.length)}` : ''
  const plainHeadline = `${storm} advisory${number ? ` number ${number}` : ''}`
  const headlines = [phraseHeadline, `${plainHeadline}${parts.winds ? ` with maximum sustained winds of ${parts.winds.mph} mph` : ''}`, plainHeadline].filter((h) => h.length >= 15 && h.length <= 90)

  const draft = (means: string[], headline: string): NewsBrief => ({ headline, happened: happenedText, means })
  for (const headline of headlines) {
    // Greedy: keep a sentence when it passes the sentence gate and still fits the word budget.
    const means: string[] = []
    let used = 0
    for (const c of cands) {
      if (means.length >= MAX_MEANS_SENTENCES) break
      const probe = draft([c], headline)
      if (briefProblems(probe, f).some((p) => p.startsWith('what it means (1): '))) continue
      if (used + wordCount(c) > MEANS_WORD_BUDGET) continue
      means.push(c)
      used += wordCount(c)
    }
    if (!means.length) continue
    const brief = draft(means, headline)
    if (briefProblems(brief, f).length === 0) return { ok: true, brief, facts: means }
  }
  // Report the real reasons for the most useful draft, so a person can see why the model path was used.
  const probe = draft(cands.slice(0, MAX_MEANS_SENTENCES), headlines[0] ?? plainHeadline)
  return { ok: false, reason: `the template did not pass the checks: ${briefProblems(probe, f).slice(0, 2).join('; ') || 'no usable sentence'}`.slice(0, 280) }
}

/** True when a saved draft is exactly what the template builds from this item today (so the independent model review is not needed). */
export function isTemplateBrief(f: NewsFacts, sourceKey: string, saved: NewsBrief): boolean {
  const t = buildNhcBrief(f, sourceKey)
  return t.ok && t.brief.headline === saved.headline && t.brief.happened === saved.happened && t.brief.means.join(' ') === saved.means.join(' ')
}
