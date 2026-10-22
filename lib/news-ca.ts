import { removeDashes } from '@/lib/guide-composer'
import { TEMPLATE_MIN_WORDS, briefProblems, sentencesOf, wordCount, type NewsBrief, type NewsFacts } from '@/lib/news-brief'

// Run 2: the Government of Canada travel advisory update is written by PLAIN CODE, not by a model (same idea as lib/news-uk.ts).
//
// Why: the writer model kept reaching for words the notice does not contain ("overall", "adding", "covers", "changed", "regarding"),
// and the tier 1 gate (every content word of the brief must be in the notice, or be a fixed framing word from
// TEMPLATE_FRAMING_WORDS in lib/news-brief.ts) threw most Canada briefs away. A Canada item is the country, the advisory level and a
// short update text, so the brief is assembled from those fields and from fixed framing words, and from nothing else.
//
// Safety: the feed text is untrusted and is only QUOTED inside attributed sentences. Every sentence goes through the SAME gate as a
// model brief (briefProblems). A sentence that fails is dropped; advice wording in the update text refuses the whole item (quoting
// around it would misstate the notice). Nothing is added from outside the item, and the gate still rejects any factual word that is
// not in the notice.

export const CA_SOURCE_KEY = 'gac-advisories'
export const CA_TITLE_PREFIX = 'Canada advisory for '
export const CA_TOO_LITTLE_TEXT_REASON = 'too little text to write a safe brief'
const MEANS_WORD_BUDGET = 45
const MAX_MEANS_SENTENCES = 3
const MAX_UPDATE_SENTENCES = 3

export type CaTemplate = { ok: true; brief: NewsBrief; facts: string[] } | { ok: false; reason: string }

export const isCaAdvisorySource = (sourceKey: string): boolean => sourceKey === CA_SOURCE_KEY

/** The country and the advisory level from a shaped title ("Canada advisory for Japan: Exercise a high degree of caution"), or null. */
export function caPartsOf(title: string): { country: string; level: string } | null {
  if (!title.startsWith(CA_TITLE_PREFIX)) return null
  const rest = title.slice(CA_TITLE_PREFIX.length)
  const at = rest.indexOf(': ')
  if (at < 2) return null
  const country = rest.slice(0, at).replace(/\s+/g, ' ').trim()
  const level = rest.slice(at + 2).replace(/\s+/g, ' ').trim().replace(/[.]+$/, '')
  if (!/^[A-Za-z][A-Za-z .,'()&-]{1,70}$/.test(country) || level.length < 3) return null
  return { country, level }
}

const withStop = (s: string): string => (/[.]$/.test(s) ? s : `${s}.`)

/** Builds the post's brief from the item's own text with no model call. `ok: false` carries the plain reason the item is rejected. Pure. */
export function buildCaBrief(f: NewsFacts, sourceKey: string): CaTemplate {
  if (!isCaAdvisorySource(sourceKey)) return { ok: false, reason: 'not a Canada travel advisory' }
  const parts = caPartsOf(f.title)
  if (!parts) return { ok: false, reason: 'no country and advisory level in the title' }
  const { country, level } = parts
  const names = new Set(country.toLowerCase().split(/[^a-z]+/).filter(Boolean))

  // The first ordinary word starts in lower case after the colon (the gate reads a mid-sentence capital as a name).
  const lowerFirst = (s: string): string => {
    const first = /^[A-Za-z]+/.exec(s)?.[0] ?? ''
    return /^[A-Z][a-z]+$/.test(first) && !names.has(first.toLowerCase()) ? `${first[0].toLowerCase()}${s.slice(1)}` : s
  }
  const updateLines = sentencesOf(removeDashes(f.summary).replace(/\s+/g, ' ').trim())
    .slice(0, MAX_UPDATE_SENTENCES)
    .map((s) => withStop(s.replace(/\s+([.!?])$/, '$1').trim()))
    .filter((s) => s.length > 3)

  const source = f.sourceName.replace(/^the\s+/i, '')
  const agency = f.sourceName.startsWith('the ') ? `The ${source}` : source
  const headline = `Canada travel advisory update for ${country}`
  const happened = `${agency} updated its travel advisory for ${country}.`
  const draft = (means: string[]): NewsBrief => ({ headline, happened, means })

  const levelSentence = `The source says the advisory level is: ${lowerFirst(level)}.`
  const candidates: string[][] = [[levelSentence]]
  updateLines.forEach((s, i) => candidates.push([`${i === 0 ? 'The source says' : 'According to the source'}: ${lowerFirst(s)}`, `${i === 0 ? 'The source says' : 'According to the source'}: ${s}`]))
  const isMeansProblem = (p: string) => p.startsWith('what it means (1): ')

  // Advice wording in the update text itself ("avoid ...", "should ...") refuses the whole item with the gate's own reason. The
  // government's level wording, copied word for word, is allowed by the gate (it is masked when the notice has it).
  for (const variants of candidates.slice(1)) {
    const per = variants.map((c) => briefProblems(draft([c]), f, { template: true }).filter(isMeansProblem))
    const advice = per.every((p) => p.length) ? per.flat().find((p) => /gives advice or an instruction/.test(p)) : undefined
    if (advice) return { ok: false, reason: `the template did not pass the checks: ${advice}`.slice(0, 280) }
  }

  const means: string[] = []
  let used = 0
  for (const variants of candidates) {
    if (means.length >= MAX_MEANS_SENTENCES) break
    const pick = variants.find((c) => !briefProblems(draft([c]), f, { template: true }).some(isMeansProblem) && used + wordCount(c) <= MEANS_WORD_BUDGET)
    if (!pick) continue
    means.push(pick)
    used += wordCount(pick)
  }
  if (!means.length) {
    const why = briefProblems(draft([levelSentence]), f, { template: true }).filter((p) => p.startsWith('what it means') || p.startsWith('headline') || p.startsWith('what happened')).slice(0, 2)
    return { ok: false, reason: `the template did not pass the checks: ${why.join('; ') || 'no usable sentence'}`.slice(0, 280) }
  }

  const brief = draft(means)
  const problems = briefProblems(brief, f, { template: true })
  if (problems.length === 0) return { ok: true, brief, facts: means }
  const shortOnly = problems.every((p) => p.startsWith('length: ')) && wordCount([brief.happened, ...brief.means].join(' ')) < TEMPLATE_MIN_WORDS
  if (shortOnly) return { ok: false, reason: CA_TOO_LITTLE_TEXT_REASON }
  return { ok: false, reason: `the template did not pass the checks: ${problems.slice(0, 2).join('; ')}`.slice(0, 280) }
}

/** True when a saved draft is exactly what the template builds from this item today (so the independent model review is not needed). */
export function isCaTemplateBrief(f: NewsFacts, sourceKey: string, saved: NewsBrief): boolean {
  const t = buildCaBrief(f, sourceKey)
  return t.ok && t.brief.headline === saved.headline && t.brief.happened === saved.happened && t.brief.means.join(' ') === saved.means.join(' ')
}
