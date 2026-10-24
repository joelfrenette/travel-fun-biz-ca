import { jaccard, stems } from '@/lib/keyword-score'

// QUESTION INTEL (hub WP5). Pure helpers, no database, no network.
//   1. Buckets for Search Console searches: question-style, buyer-intent, and long (7+ words, how people talk to an assistant).
//   2. A short list of "questions people ask" for the FAQ step of the blog and guide composers. Every question is a real
//      Search Console search or a question already written in one of our own posts. Nothing is invented: with no data the
//      list is empty and the composer prompt is exactly what it was before. The ANSWERS still come from the existing composer
//      rules (only what the post says, no prices, no digits, no links).
// The database half (reading the stored searches and posts) is lib/question-hints.ts.

/** A Search Console search row (structurally the same as QueryRow in lib/gsc-mining.ts). */
export interface IntelRow {
  query: string
  impressions: number
  position: number
  clicks?: number
}

export const QUESTION_WORDS = ['what', 'whats', "what's", 'how', 'hows', 'when', 'where', 'which', 'who', 'why', 'is', 'are', 'can', 'could', 'do', 'does', 'should', 'will', 'would'] as const
/** A search this long (in words) reads like a sentence said to an assistant, not a typed keyword. */
export const LONG_QUERY_WORDS = 7
export const MIN_QUESTION_WORDS = 3
export const MAX_QUESTION_WORDS = 14
export const MAX_BUCKET_EXAMPLES = 10

const BUYER_RE = /\b(book|booking|bookings|price|prices|pricing|cost|costs|how much|deal|deals|package|packages|tour|tours|quote|reserve|reservation|availability|available|for sale|reviews?|worth it|near me|all[- ]inclusive|departures?|dates)\b/i
const QUESTION_START = new RegExp(`^(?:${QUESTION_WORDS.map((w) => w.replace(/'/g, "'?")).join('|')})\\b`, 'i')

const wordsOf = (q: string): string[] => q.trim().split(/\s+/).filter(Boolean)

/** True when the search is phrased as a question: it ends with "?" or starts with a question word and has at least 3 words. */
export function isQuestionQuery(query: string): boolean {
  const q = (query || '').trim()
  if (!q) return false
  const n = wordsOf(q).length
  if (q.endsWith('?') && n >= 2) return true
  return n >= MIN_QUESTION_WORDS && QUESTION_START.test(q)
}

/** True when the words say the person is close to choosing or buying (price, book, tour, package, reviews, dates...). */
export function isBuyerIntent(query: string): boolean {
  return BUYER_RE.test(query || '')
}

export function isLongQuery(query: string): boolean {
  return wordsOf(query || '').length >= LONG_QUERY_WORDS
}

export interface BucketFlags {
  question: boolean
  buyer: boolean
  long: boolean
}

export function classifyQuery(query: string): BucketFlags {
  return { question: isQuestionQuery(query), buyer: isBuyerIntent(query), long: isLongQuery(query) }
}

export interface BucketExample {
  query: string
  impressions: number
  position: number
}

export interface Bucket {
  count: number
  impressions: number
  /** The strongest searches in the bucket (most impressions first), at most MAX_BUCKET_EXAMPLES. */
  top: BucketExample[]
}

export interface QueryIntel {
  question: Bucket
  buyer: Bucket
  long: Bucket
}

export const emptyBucket = (): Bucket => ({ count: 0, impressions: 0, top: [] })
export const emptyIntel = (): QueryIntel => ({ question: emptyBucket(), buyer: emptyBucket(), long: emptyBucket() })

/** Sorts searches into the three buckets (a search can be in more than one). Pure. */
export function bucketQueries(rows: readonly IntelRow[], minImpressions = 1): QueryIntel {
  const out = emptyIntel()
  const lists: Record<keyof QueryIntel, BucketExample[]> = { question: [], buyer: [], long: [] }
  for (const r of rows) {
    if (!r.query || !(r.impressions >= minImpressions)) continue
    const flags = classifyQuery(r.query)
    const ex: BucketExample = { query: r.query, impressions: r.impressions, position: Math.round((r.position || 0) * 10) / 10 }
    for (const k of ['question', 'buyer', 'long'] as const) {
      if (!flags[k]) continue
      out[k].count++
      out[k].impressions += r.impressions
      lists[k].push(ex)
    }
  }
  for (const k of ['question', 'buyer', 'long'] as const) {
    out[k].top = lists[k].sort((a, b) => b.impressions - a.impressions || a.position - b.position || a.query.localeCompare(b.query)).slice(0, MAX_BUCKET_EXAMPLES)
  }
  return out
}

/** Reads a stored intel object. Anything not the right shape reads as empty (older stored results have none). Pure. */
export function parseIntel(v: unknown): QueryIntel {
  const o = (v && typeof v === 'object' ? v : {}) as Partial<Record<keyof QueryIntel, unknown>>
  const bucket = (b: unknown): Bucket => {
    const x = (b && typeof b === 'object' ? b : {}) as Partial<Bucket>
    return {
      count: Number(x.count) || 0,
      impressions: Number(x.impressions) || 0,
      top: Array.isArray(x.top)
        ? x.top.filter((t): t is BucketExample => !!t && typeof t.query === 'string').slice(0, MAX_BUCKET_EXAMPLES).map((t) => ({ query: t.query, impressions: Number(t.impressions) || 0, position: Number(t.position) || 0 }))
        : [],
    }
  }
  return { question: bucket(o.question), buyer: bucket(o.buyer), long: bucket(o.long) }
}

// ---------------------------------------------------------------------------------------------------
// Questions for the FAQ step
// ---------------------------------------------------------------------------------------------------

// The composers forbid superlative claims, so a question built around one is not offered.
const SUPERLATIVE_RE = /\b(best|top|cheap|cheapest|worst|number one|#1|award|awards|ultimate|greatest)\b/i

/** "how long is a rhine cruise" -> "How long is a rhine cruise?" or null when it is not usable as a FAQ question
 * (digits, a web address, too short or too long, or built around a superlative). Pure. */
export function cleanQuestion(raw: string): string | null {
  let q = (raw || '').replace(/\s+/g, ' ').trim().replace(/[?.!\s]+$/, '')
  if (!q) return null
  const n = wordsOf(q).length
  if (n < MIN_QUESTION_WORDS || n > MAX_QUESTION_WORDS) return null
  if (/\d/.test(q) || /[\/\\@<>{}[\]]|https?:|www\.|\.com|\.ca/i.test(q)) return null
  if (SUPERLATIVE_RE.test(q)) return null
  if (!QUESTION_START.test(q)) return null
  q = q.charAt(0).toUpperCase() + q.slice(1)
  return `${q}?`
}

/** The question sentences already in our own posts: markdown headings that read as questions, and stored FAQ questions. Pure. */
export function ownQuestionsFromPosts(posts: readonly { body?: string | null; faq?: readonly { q?: string }[] | null }[]): string[] {
  const out: string[] = []
  for (const p of posts) {
    for (const line of (p.body || '').split(/\r?\n/)) {
      const m = line.match(/^#{2,4}\s+(.*\S)\s*$/)
      if (!m) continue
      const text = m[1].replace(/[*_`]/g, '').trim()
      if (isQuestionQuery(text)) out.push(text)
    }
    for (const f of p.faq ?? []) if (f && typeof f.q === 'string') out.push(f.q)
  }
  return out
}

export const MAX_FAQ_QUESTIONS = 5

/**
 * Picks the questions to offer the FAQ step: only searches or own-post questions that share meaningful words with the topic's
 * keywords, cleaned, near-duplicates removed. Search Console questions come first (most impressions first), then our own.
 * An empty result means "offer nothing" and the prompt is unchanged. Pure.
 */
export function pickFaqQuestions(input: { keywords: readonly string[]; searches?: readonly IntelRow[]; own?: readonly string[]; max?: number }): string[] {
  const max = input.max ?? MAX_FAQ_QUESTIONS
  const topic = new Set<string>()
  for (const k of input.keywords) for (const s of stems(k)) topic.add(s)
  if (topic.size === 0) return []
  const candidates: string[] = [
    ...[...(input.searches ?? [])].filter((r) => r.query && r.impressions > 0).sort((a, b) => b.impressions - a.impressions || a.query.localeCompare(b.query)).map((r) => r.query),
    ...(input.own ?? []),
  ]
  const picked: { q: string; sig: Set<string> }[] = []
  for (const raw of candidates) {
    if (picked.length >= max) break
    const q = cleanQuestion(raw)
    if (!q) continue
    const sig = stems(q)
    let shared = 0
    for (const s of sig) if (topic.has(s)) shared++
    // A tiny topic (one or two words) needs one shared word; a bigger one needs two, so a loose overlap does not pull in an unrelated question.
    if (shared < (topic.size <= 2 ? 1 : 2)) continue
    if (picked.some((p) => jaccard(p.sig, sig) >= 0.6)) continue
    picked.push({ q, sig })
  }
  return picked.map((p) => p.q)
}

/** The prompt block that offers the questions to the FAQ step; '' when there are none, so the prompt stays as it was. Pure. */
export function questionsPromptBlock(questions: readonly string[] | undefined | null, subject = 'post'): string {
  const list = (questions ?? []).map((q) => q.trim()).filter(Boolean).slice(0, MAX_FAQ_QUESTIONS)
  if (list.length === 0) return ''
  return `\n- Real questions people type about this topic (from Search Console and our own pages). Use one of these as a faq "q" ONLY when the ${subject} above genuinely answers it (reword lightly if needed, never add facts it does not give); skip any it does not answer, and write the remaining questions yourself as usual:\n${list.map((q) => `  * ${q}`).join('\n')}`
}
