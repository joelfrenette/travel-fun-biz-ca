// Abbreviation-aware sentence helpers (pure, no imports). A "." after St, Mt, Dr, Mr, a single capital initial, a decimal
// number or "a.m./p.m." is NOT the end of a sentence. Also detects text that ends mid-thought ("... Cathedral of St.",
// "... the Fortress of St and gardens"), which must be regenerated or dropped instead of published.

/** Title abbreviations: their full stop is never a sentence end. */
export const TITLE_ABBR = ['St', 'Sts', 'Ste', 'Mt', 'Mts', 'Dr', 'Fr', 'Mr', 'Mrs', 'Ms', 'Mme', 'Prof', 'Ft', 'Sv', 'sv', 'Sta', 'Sto', 'Gen', 'Col', 'Capt', 'Lt', 'Sgt', 'Rev', 'Hon', 'Gov', 'Pres']
/** Abbreviations that never end a sentence. */
const ALWAYS_GLUE = ['No', 'Nos', 'approx', 'vs', 'cf', 'Fig', 'Vol']
/** Abbreviations that end a sentence only when a capitalised word follows. */
const SOMETIMES_GLUE = ['etc', 'Inc', 'Ltd', 'Co', 'Corp', 'Ave', 'Blvd', 'Rd', 'Dept']

const lastWord = (head: string): string => /([A-Za-z]+)\.$/.exec(head)?.[1] ?? ''
const startsWord = (head: string): boolean => /(?:^|[\s("'“])[A-Za-z]+\.$/.test(head)

/** True when the full stop at the end of `head` belongs to an abbreviation, given the text that follows it. */
function isAbbrevStop(head: string, rest: string): boolean {
  const next = rest.trimStart()
  const nextCap = /^[A-ZÀ-Ý"“']/.test(next)
  // i.e. e.g. a.m. p.m. U.S. (letter-dot chains): joined, never a boundary
  if (/(?:^|[\s("'“])(?:[A-Za-z]\.){2,}$/.test(head)) return true
  // a single capital initial before a capitalised word: "J. K. Rowling"
  if (/(?:^|[\s("'“])[A-Z]\.$/.test(head) && nextCap) return true
  if (!startsWord(head)) return false
  const w = lastWord(head)
  if (TITLE_ABBR.includes(w)) return true
  if (ALWAYS_GLUE.some((a) => a.toLowerCase() === w.toLowerCase())) return true
  if (SOMETIMES_GLUE.some((a) => a.toLowerCase() === w.toLowerCase())) return !nextCap
  return false
}

/** Splits prose into sentences without breaking at abbreviations, initials, decimals or a.m./p.m. Newlines always split. */
export function splitSentencesSafe(text: string): string[] {
  const out: string[] = []
  for (const para of text.replace(/\r/g, '').split(/\n+/)) {
    const t = para.trim()
    if (!t) continue
    let start = 0
    const re = /[.!?]+(?=\s)/g
    let m: RegExpExecArray | null
    while ((m = re.exec(t))) {
      const end = m.index + m[0].length
      const head = t.slice(start, end)
      if (m[0] === '.' && isAbbrevStop(head, t.slice(end))) continue
      out.push(head.trim())
      start = end
    }
    const tail = t.slice(start).trim()
    if (tail) out.push(tail)
  }
  return out.filter(Boolean)
}

// Only words that can never end a real sentence. "to", "by", "with", "from", "at", "for" are left out on purpose:
// "plenty to look forward to." and "as the river rolls by." are complete.
const DANGLE_WORDS = ['of', 'the', 'a', 'an', 'and', 'or', 'but', 'than', 'into', 'onto', 'between', 'via', 'which', 'its', 'their', 'our', 'your']
const DANGLE_END = new RegExp(`(?:^|[\\s("'\\u201c])(?:${DANGLE_WORDS.join('|')})[.!?\\u2026:;,]*$`, 'i')
/** A title abbreviation that is cut off: followed by nothing, punctuation or a lowercase word ("of St and gardens", "of St."). */
const TITLE_CUT = new RegExp(
  `(?:^|[\\s("'\\u201c])(?:${[...TITLE_ABBR, 'Saint'].join('|')})(?:\\.(?=\\s*$|\\s+[a-z]|\\s*[,;:!?\\u2026)])|(?=\\s+[a-z]|\\s*[,;:!?\\u2026)]|\\s*$))`,
)

// "Cathedral of St. For beach time, ..." : the name was cut at the full stop and the next sentence started. A capitalised
// word that starts sentences (never a saint's or a place's name) right after the abbreviation gives it away.
const SENTENCE_STARTERS = [
  'The', 'A', 'An', 'And', 'But', 'Or', 'For', 'You', 'Your', 'It', 'Its', 'There', 'Then', 'Here', 'This', 'That', 'These', 'Those', 'We', 'Our',
  'In', 'On', 'At', 'With', 'If', 'As', 'To', 'From', 'By', 'When', 'While', 'After', 'Before', 'Enjoy', 'Visit', 'See', 'Take', 'Stroll', 'Climb',
  'Wander', 'Explore', 'Relax', 'Spend', 'Head', 'Walk', 'Discover', 'Admire', 'Pause', 'Stop', 'Step', 'Join', 'Sail', 'Dine', 'Taste', 'Ask', 'Let', 'Is', 'Are',
]
const TITLE_CUT_NEXT = new RegExp(`(?:^|[\\s("'\\u201c])(?:${[...TITLE_ABBR, 'Saint'].join('|')})\\.\\s+(?:${SENTENCE_STARTERS.join('|')})\\b`)

/** Why a sentence is cut off mid-thought, or null when it ends properly. Pure. */
export function dangling(sentence: string): string | null {
  const s = sentence.trim().replace(/[”"')\]]+$/, '')
  if (!s) return null
  if (TITLE_CUT.test(s) || TITLE_CUT_NEXT.test(s)) return 'a name is cut off after a title abbreviation (St, Mt, Dr ...)'
  if (DANGLE_END.test(s)) return 'ends on a connecting word (of, the, and ...)'
  return null
}

/** The first cut-off found in a text (any sentence or line), or null. Pure. */
export function firstCutOff(text: string): string | null {
  for (const s of splitSentencesSafe(text)) {
    const why = dangling(s)
    if (why) return `${why}: "${s.slice(-60)}"`
  }
  return null
}
