import { dangling } from '@/lib/sentence-safe'

// One rule for every page title on the site: NO TITLE IS LONGER THAN 60 CHARACTERS (Joel's rule, 2026-10-24; the site health crawl
// flags anything longer). Pure and deterministic, no AI and no database: the same text always gives the same title.
//
// How a long title is shortened (each step stops as soon as the title fits):
//   1. dashes become commas, spaces are tidied;
//   2. wordy news phrases are compacted ("travel advisory update for" -> "advisory for"), which keeps the country / storm name
//      and the advisory kind;
//   3. the text is cut at a clause boundary ("with", "as", "after", a comma ...), never mid-clause;
//   4. the label "News: " is dropped if that is what it takes;
//   5. last resort: cut at a word boundary, and a dangling word ("of", "the", a number after "of", "St") is removed.
// There is never a trailing ellipsis: a title that ends cleanly is better than one that ends in "...".

export const TITLE_FIT_MAX = 60
const MIN_KEPT = 18

/** Words a title cannot end on. */
const CONNECTORS = new Set([
  'of', 'the', 'a', 'an', 'and', 'or', 'but', 'than', 'into', 'onto', 'between', 'via', 'which', 'its', 'their', 'our', 'your',
  'to', 'for', 'in', 'at', 'by', 'with', 'from', 'on', 'over', 'near', 'as', 'is', 'are', 'was', 'be', 'after', 'amid', 'about',
  'up', 'no', 'not', 'that', 'this', 'these', 'those', 'will', 'has', 'have', 'while', 'during', 'under', 'through', 'across', 'toward', 'towards',
])

/** Wordy phrases of news titles and their short forms. Applied one at a time until the title fits. */
const COMPACTIONS: [RegExp, string][] = [
  [/\btravel advisory update for\b/i, 'advisory for'],
  [/\btravel advice update for\b/i, 'advice for'],
  [/\bchanges its advisory for\b/i, 'advisory for'],
  [/\bmaximum sustained winds of\b/i, 'winds of'],
  [/\bmaximum sustained winds\b/i, 'winds'],
  [/\bexercise a high degree of caution\b/i, 'exercise high caution'],
]

/** Where a clause can end: the text before these is a complete thought. Colon is a last choice (it often introduces the advisory level). */
const CLAUSE_BREAKS = [/, /g, / with /gi, / as /gi, / after /gi, / amid /gi, / while /gi, / and (?=will|is|are|has|have|could|may)/gi]

export function tidyTitle(title: string): string {
  return title
    .replace(/\s*[—–]\s*/g, ', ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,;:])/g, '$1')
    .trim()
}

const isNumberish = (w: string) => /^\d[\d.,]*(?:%|mph|km\/h|kph|mm|cm)?$/i.test(w)

/** Removes whatever a cut left hanging at the end: punctuation, connecting words, a number after "of", a cut-off "St". */
function trimHanging(text: string): string {
  let t = text.replace(/[\s,;:\-–—]+$/, '')
  for (let guard = 0; guard < 12 && t; guard++) {
    const words = t.split(' ')
    const last = words[words.length - 1].replace(/[.,;:!?]+$/, '')
    const prev = (words[words.length - 2] ?? '').toLowerCase()
    if (words.length > 1 && (CONNECTORS.has(last.toLowerCase()) || dangling(t))) {
      t = words.slice(0, -1).join(' ').replace(/[\s,;:\-–—]+$/, '')
      continue
    }
    if (words.length > 2 && isNumberish(last) && CONNECTORS.has(prev)) {
      t = words.slice(0, -2).join(' ').replace(/[\s,;:\-–—]+$/, '')
      continue
    }
    break
  }
  return t
}

/** The longest clause-boundary prefix that fits, or null. */
function clauseCut(text: string, max: number): string | null {
  let best: string | null = null
  for (const re of CLAUSE_BREAKS) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(text))) {
      const head = trimHanging(text.slice(0, m.index))
      if (head.length >= MIN_KEPT && head.length <= max && (!best || head.length > best.length)) best = head
      if (m[0].length === 0) re.lastIndex++
    }
  }
  if (best) return best
  // A colon last: "Canada advisory for Haiti: Avoid all travel" keeps the country when the level cannot fit.
  const colon = text.indexOf(':')
  if (colon > 0) {
    const head = trimHanging(text.slice(0, colon))
    if (head.length >= MIN_KEPT && head.length <= max) return head
  }
  return null
}

function wordCut(text: string, max: number): string {
  if (text.length <= max) return trimHanging(text)
  let cut = text.slice(0, max + 1)
  // Cut on a space: if the character after the limit is not a space, the last word is partial and goes.
  cut = text[max] === ' ' ? cut.slice(0, max) : cut.slice(0, max).replace(/\s+\S*$/, '')
  const out = trimHanging(cut)
  return out.length >= 8 ? out : text.slice(0, max).trim()
}

function shorten(input: string, max: number): string {
  let t = tidyTitle(input)
  if (t.length <= max) return t
  for (const [re, to] of COMPACTIONS) {
    if (re.test(t)) {
      t = tidyTitle(t.replace(re, to))
      if (t.length <= max) return t
    }
  }
  const cut = clauseCut(t, max)
  if (cut) return cut
  // The "News: " label is the first thing to give up, then clause / word cuts again on what is left.
  const label = /^news:\s*/i.exec(t)
  if (label) {
    const rest = t.slice(label[0].length)
    if (rest.length <= max) return rest
    return clauseCut(rest, max) ?? wordCut(rest, max)
  }
  return wordCut(t, max)
}

/** A title of at most `max` characters (default 60). `uniqueSuffix` ("(Oct 12)") is added at the end and the title is shortened to make room. */
export function fitTitle(title: string, max: number = TITLE_FIT_MAX, opts: { uniqueSuffix?: string } = {}): string {
  const suffix = (opts.uniqueSuffix ?? '').trim()
  if (!suffix) return shorten(title, max)
  const base = shorten(title, Math.max(MIN_KEPT, max - suffix.length - 1))
  const out = `${base} ${suffix}`
  return out.length <= max ? out : shorten(title, max)
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()

/**
 * `fitTitle`, then, when another page already has that title (`taken`, lower-cased), a deterministic suffix: the candidates are
 * tried in order ("(Oct 12)", "(3d9939)"). If none works the last candidate's title is returned (still within `max`).
 */
export function uniqueFitTitle(title: string, taken: ReadonlySet<string>, candidates: readonly string[] = [], max: number = TITLE_FIT_MAX): string {
  const plain = fitTitle(title, max)
  if (!taken.has(norm(plain))) return plain
  let last = plain
  for (const c of candidates) {
    const t = fitTitle(title, max, { uniqueSuffix: c })
    last = t
    if (!taken.has(norm(t))) return t
  }
  return last
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "(Oct 12)" from an ISO date or timestamp, or '' when it is not one. */
export function dateSuffix(iso: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? '')
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) return ''
  return `(${MONTHS[Number(m[2]) - 1]} ${Number(m[3])})`
}

/** "(3d9939)" from the id on the end of a news slug ("news-...-3d9939"), or '' when there is none. */
export function slugIdSuffix(slug: string | null | undefined): string {
  const id = /-([a-z0-9]{6})$/.exec(slug ?? '')?.[1]
  return id ? `(${id})` : ''
}

export interface PostTitleInput {
  slug: string
  title: string
  meta_title?: string | null
  publish_date?: string | null
}

export interface PostTitlePlan {
  title: string
  meta_title: string | null
  titleChanged: boolean
  metaChanged: boolean
}

/**
 * What a post's title and search title should be so the title in Google (meta_title, else "<title> | <site name>") is at most
 * 60 characters and no other page in `taken` shares it. `taken` holds lower-cased search titles of the OTHER pages. Pure.
 * A title that is already fine, and unique, comes back unchanged.
 */
export function planPostTitle(post: PostTitleInput, taken: ReadonlySet<string>, siteName: string, max: number = TITLE_FIT_MAX): PostTitlePlan {
  const cands = [dateSuffix(post.publish_date), slugIdSuffix(post.slug)].filter(Boolean)
  const meta = (post.meta_title ?? '').trim()
  const shown = (t: string, m: string | null) => (m && m.trim() ? m.trim() : `${t} | ${siteName}`)
  const currentShown = shown(post.title, meta || null)
  const fine = currentShown.length <= max && !taken.has(norm(currentShown))
  if (fine && post.title.length <= max) return { title: post.title, meta_title: meta || null, titleChanged: false, metaChanged: false }

  let title = fitTitle(post.title, max)
  // The search title is written explicitly (no site-name suffix), so what Google shows is exactly what was fitted.
  let nextMeta: string | null = meta ? fitTitle(meta, max) : title.length + siteName.length + 3 > max ? title : null
  if (taken.has(norm(shown(title, nextMeta)))) {
    const unique = uniqueFitTitle(meta || post.title, taken, cands, max)
    nextMeta = unique
    // With no separate search title, the title and the search title are the same text.
    if (!meta) title = unique
  }
  const finalTitle = title
  return {
    title: finalTitle,
    meta_title: nextMeta,
    titleChanged: finalTitle !== post.title,
    metaChanged: (nextMeta ?? '') !== meta,
  }
}
