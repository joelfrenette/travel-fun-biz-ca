import { removeDashes } from '@/lib/guide-composer'
import { TEMPLATE_MIN_WORDS, briefProblems, sentencesOf, wordCount, wordRange, type NewsBrief, type NewsFacts } from '@/lib/news-brief'
import { UK_FCDO_TITLE_PREFIX } from '@/lib/news-feed'

// Growth loop WP20 tuning: the UK FCDO travel advice update is written by PLAIN CODE, not by a model (same idea as lib/news-nhc.ts).
//
// Why: a UK Atom entry carries about 16 words of facts (the country and ONE short update line such as "Additional information on
// demonstrations and strikes (Safety and security)."). A model can only pad that, and padding is how invented facts get in, so the
// brief is assembled from the entry's own fields and from fixed framing words, and from nothing else. No model call, no heal budget.
//
// Safety: the feed text is untrusted. Nothing from it is ever obeyed; each piece is only QUOTED inside an attributed sentence, and
// every sentence is run through the SAME gate as a model brief (briefProblems, meansSentenceProblems): a sentence that fails (advice
// wording, instruction-like text, a name or number the entry does not have) is dropped, and if the finished brief still fails, or is
// under the template minimum word count (TEMPLATE_MIN_WORDS, 20: a template only quotes, so the 40 word floor that stops a MODEL
// padding does not apply), the item is rejected. Nothing is added from outside the entry.

/** The plain reason for an item whose own text is too short to make a brief that reaches the tier 1 minimum. */
export const UK_TOO_LITTLE_TEXT_REASON = 'too little text to write a safe brief'
/** "what it means" is limited to 45 words for an official notice (lib/news-brief.ts). */
const MEANS_WORD_BUDGET = 45
const MAX_MEANS_SENTENCES = 3
const MAX_UPDATE_SENTENCES = 4

export type UkTemplate = { ok: true; brief: NewsBrief; facts: string[] } | { ok: false; reason: string }

export const isUkFcdoSource = (sourceKey: string): boolean => sourceKey === 'uk-fcdo'

/** The country from a shaped title ("UK travel advice update for Belgium"), or null. */
export function ukCountryOf(title: string): string | null {
  if (!title.startsWith(UK_FCDO_TITLE_PREFIX)) return null
  const country = title.slice(UK_FCDO_TITLE_PREFIX.length).replace(/\s+/g, ' ').trim()
  return /^[A-Za-z][A-Za-z .,'()&-]{1,70}$/.test(country) ? country : null
}

/** The part of the advice that changed, from a bracketed name in the update text ("(Safety and security)"). Mixed case, 2 to 6 words;
 * an acronym such as "(FCDO)" is not a section. Null when there is none. Pure. */
export function ukSectionOf(summary: string): string | null {
  for (const m of summary.matchAll(/\(([A-Z][a-z][A-Za-z,'& ]{1,58})\)/g)) {
    const name = m[1].replace(/\s+/g, ' ').trim()
    const words = name.split(' ').length
    if (words <= 6 && /[a-z]/.test(name)) return name
  }
  return null
}

const cap = (w: string): string => (w ? w[0].toUpperCase() + w.slice(1) : w)

/** An all-capitals sentence becomes a sentence; anything with lower-case letters is returned exactly as written. The country words, UK
 * and US get their capitals back (they are in the entry). */
function sentenceCaseIfShouted(s: string, names: Set<string>): string {
  // A bracketed section name ("(Entry requirements)") is written in mixed case even in a shouted line, so it is left alone and
  // only the text outside the brackets decides whether the line is shouted.
  const outside = s.replace(/\([^)]*\)/g, '')
  if (/[a-z]/.test(outside) || !/[A-Z]/.test(outside)) return s
  const fix = (part: string): string =>
    part
      .toLowerCase()
      .split(' ')
      .map((w) => {
        const bare = w.replace(/^[^a-z]+|[^a-z]+$/g, '')
        return bare === 'uk' || bare === 'us' ? w.replace(bare, bare.toUpperCase()) : names.has(bare) ? w.replace(bare, cap(bare)) : w
      })
      .join(' ')
  return cap(s.split(/(\([^)]*\))/).map((part) => (part.startsWith('(') ? part : fix(part))).join(''))
}

const withStop = (s: string): string => (/[.]$/.test(s) ? s : `${s}.`)

/** Builds the post's brief from the item's own text with no model call. `ok: false` carries the plain reason the item is rejected.
 * Pure. */
export function buildUkBrief(f: NewsFacts, sourceKey: string): UkTemplate {
  if (!isUkFcdoSource(sourceKey)) return { ok: false, reason: 'not a UK travel advice update' }
  const country = ukCountryOf(f.title)
  if (!country) return { ok: false, reason: 'no country in the title' }
  const names = new Set(country.toLowerCase().split(/[^a-z]+/).filter(Boolean))

  const text = removeDashes(f.summary).replace(/\s+/g, ' ').trim()
  const section = ukSectionOf(text)
  const sentences = sentencesOf(text)
    .slice(0, MAX_UPDATE_SENTENCES)
    .map((s) => withStop(sentenceCaseIfShouted(s, names)))

  const source = f.sourceName.replace(/^the\s+/i, '')
  const agency = f.sourceName.startsWith('the ') ? `The ${source}` : source
  const happened = `${agency} updated its travel advice for ${country}.`

  // Candidate "what it means" sentences, most useful first. Each has a second form without the bracketed section name, used only
  // when the first form fails the gate (a section such as "Warnings and insurance" contains a word the gate refuses).
  const lead = (i: number) => (i === 0 ? 'The source says: ' : 'According to the source: ')
  // The gate's name check reads a capital letter in the middle of a sentence as a name, and it looks the word up in the entry text
  // (title, then the update line, run together), so the first word of the update line, which follows the title, is never found as
  // a plain sentence opener. Each form therefore also has a variant whose first ordinary word starts in lower case after the colon.
  const lowerFirst = (s: string): string => {
    const first = /^[A-Za-z]+/.exec(s)?.[0] ?? ''
    return /^[A-Z][a-z]+$/.test(first) && !names.has(first.toLowerCase()) ? `${first[0].toLowerCase()}${s.slice(1)}` : s
  }
  const updateAt = (i: number): string[] => {
    const s = sentences[i]
    if (!s) return []
    const plain = withStop(s.replace(/\s*\([^)]*\)/g, '').replace(/\s+([.!?])$/, '$1').trim())
    const forms = [s, ...(plain.length > 3 && plain !== s ? [plain] : [])]
    return [...new Set(forms.flatMap((v) => [`${lead(i)}${v}`, `${lead(i)}${lowerFirst(v)}`]))]
  }
  const groups: string[][] = [updateAt(0)]
  if (section) groups.push([`The source says the update is in the ${section} section of the advice.`])
  for (let i = 1; i < sentences.length; i++) groups.push(updateAt(i))
  const all = groups.filter((g) => g.length)
  if (!all.length) return { ok: false, reason: UK_TOO_LITTLE_TEXT_REASON }

  const headline = f.title.length <= 90 ? f.title : `${UK_FCDO_TITLE_PREFIX}${country}`.slice(0, 90)
  const draft = (means: string[]): NewsBrief => ({ headline, happened, means })

  // Advice wording in the update line itself ("advises against ...", "should avoid ...") is refused for the whole item with the
  // gate's own reason: quoting the other sentences and silently leaving that one out would misstate what the source said.
  // (The government's own level wording, copied word for word, is allowed by the gate itself and is not refused here.)
  for (let i = 0; i < sentences.length; i++) {
    const problems = updateAt(i).map((c) => briefProblems(draft([c]), f).filter((p) => p.startsWith('what it means (1): ')))
    if (problems.length && problems.every((p) => p.length)) {
      const advice = problems.flat().find((p) => /gives advice or an instruction/.test(p))
      if (advice) return { ok: false, reason: `the template did not pass the checks: ${advice}`.slice(0, 280) }
    }
  }

  const means: string[] = []
  let used = 0
  for (const variants of all) {
    if (means.length >= MAX_MEANS_SENTENCES) break
    const pick = variants.find((c) => !briefProblems(draft([c]), f).some((p) => p.startsWith('what it means (1): ')) && used + wordCount(c) <= MEANS_WORD_BUDGET)
    if (!pick) continue
    means.push(pick)
    used += wordCount(pick)
  }
  if (!means.length) {
    const probe = draft([all[0][0]])
    const why = briefProblems(probe, f).filter((p) => p.startsWith('what it means') || p.startsWith('headline') || p.startsWith('what happened')).slice(0, 2)
    return { ok: false, reason: `the template did not pass the checks: ${why.join('; ') || 'no usable sentence'}`.slice(0, 280) }
  }

  const brief = draft(means)
  const problems = briefProblems(brief, f, { template: true })
  if (problems.length === 0) return { ok: true, brief, facts: means }
  const min = Math.min(wordRange(f.tier).min, TEMPLATE_MIN_WORDS)
  const shortOnly = problems.every((p) => p.startsWith('length: ')) && wordCount([brief.happened, ...brief.means].join(' ')) < min
  if (shortOnly) return { ok: false, reason: UK_TOO_LITTLE_TEXT_REASON }
  return { ok: false, reason: `the template did not pass the checks: ${problems.slice(0, 2).join('; ')}`.slice(0, 280) }
}

/** True when a saved draft is exactly what the template builds from this item today (so the independent model review is not needed). */
export function isUkTemplateBrief(f: NewsFacts, sourceKey: string, saved: NewsBrief): boolean {
  const t = buildUkBrief(f, sourceKey)
  return t.ok && t.brief.headline === saved.headline && t.brief.happened === saved.happened && t.brief.means.join(' ') === saved.means.join(' ')
}
