// Choosing stock b-roll for a reel, as pure functions (no network, no database): the search words, the relevance check on a
// candidate clip, and the pick. lib/pexels.ts does the fetching and hands the candidates here.
//
// Found in the real 21 Oct reel (docs/factory/evidence): a river cruise reel cut to an indoor dinner scene and ended on a skate park
// with a shadow of feet. Pexels video results carry no description field, but their page address ends in a readable slug
// ("a-man-skateboarding-in-a-park-1234"), so the slug is the description used here.
//
// Rules: 1. every search names the subject type of the post (river cruise, ship deck, old town, beach ...), 2. a clip whose slug
// names an unrelated subject (skate, laptop, office, gym, kitchen ...) is rejected unless the post is about that subject,
// 3. a clip must share a word with the subject or the beat's own search words, 4. a clip used earlier in this reel is never
// used again, and one used by a recent reel goes to the back of the line, 5. portrait clips first, a landscape clip only when a
// centre crop to 9:16 is safe (HD, not wider than 2:1).

import { inferDestination } from '@/lib/reel-questions'

export interface BrollContext {
  destination?: string | null
  keyword?: string | null
  title?: string | null
}

interface SubjectType {
  id: string
  /** Matches the post's keyword, title or destination. */
  re: RegExp
  /** What goes into the search. */
  phrase: string
  /** Words a clip's description may share with this subject to count as on-topic. */
  tokens: string[]
}

/** Checked in order; the first that matches the keyword, then the title, then the beat's words wins. */
export const SUBJECT_TYPES: SubjectType[] = [
  { id: 'river-cruise', re: /\briver\s+cruis|\bcruise\b.*\b(?:rhine|danube|seine|elbe|rhone|douro|mekong|nile)\b|\b(?:rhine|danube|seine|elbe|rhone|douro|mekong)\b.*\bcruis/i, phrase: 'river cruise', tokens: ['river', 'cruise', 'ship', 'boat', 'vessel', 'deck', 'riverside', 'rhine', 'danube', 'barge', 'castle', 'vineyard', 'village', 'town', 'bridge'] },
  { id: 'ocean-cruise', re: /\bcruis|\bcruiser|\bship\b|\bsailing\b|\bport\b/i, phrase: 'cruise ship deck', tokens: ['cruise', 'ship', 'deck', 'ocean', 'sea', 'boat', 'harbor', 'harbour', 'port', 'sail', 'sailing', 'vessel', 'liner'] },
  { id: 'beach', re: /\bbeach|\bresort|\bisland|\bcaribbean|\btropical|\bsnorkel|\bcancun|\btulum|\bbali\b/i, phrase: 'tropical beach', tokens: ['beach', 'sea', 'ocean', 'island', 'resort', 'palm', 'sand', 'coast', 'tropical', 'turquoise', 'lagoon', 'shore', 'waves'] },
  { id: 'old-town', re: /\bold\s+town|\bhistoric|\bcity\b|\bcities\b|\beurope|\bcastle|\bvillage|\bcathedral/i, phrase: 'old town', tokens: ['old', 'town', 'city', 'street', 'historic', 'castle', 'cathedral', 'village', 'square', 'architecture', 'church', 'europe', 'european'] },
  { id: 'hiking', re: /\bhik(?:e|ing)\b|\btrek|\btrail|\bmountain|\balps\b/i, phrase: 'hiking trail', tokens: ['hiking', 'hike', 'trail', 'mountain', 'mountains', 'hiker', 'valley', 'forest', 'alps', 'peak'] },
  { id: 'safari', re: /\bsafari|\bwildlife|\bserengeti|\bkenya|\btanzania/i, phrase: 'safari wildlife', tokens: ['safari', 'wildlife', 'elephant', 'lion', 'giraffe', 'zebra', 'savanna', 'savannah', 'africa'] },
  { id: 'ski', re: /\bski\b|\bskiing|\bsnowboard|\bsnow\b/i, phrase: 'ski slope', tokens: ['ski', 'skiing', 'snow', 'slope', 'mountain', 'winter', 'snowboard', 'resort'] },
]

/** Subjects that almost never belong in a travel reel. A clip whose description names one is rejected, unless the post (its
 * keyword, title, destination or the beat's own search words) names it too. */
export const UNRELATED_SUBJECTS = ['skate', 'skateboard', 'skateboarding', 'skateboarder', 'skatepark', 'laptop', 'office', 'gym', 'workout', 'fitness', 'weightlifting', 'kitchen', 'cooking', 'chef', 'typing', 'keyboard', 'computer', 'coding', 'programmer', 'meeting', 'businessman', 'businesswoman', 'business', 'desk', 'shadow', 'feet', 'sneakers', 'shoes', 'legs', 'selfie', 'gaming', 'gamer', 'baby', 'dentist', 'surgery', 'hospital', 'factory', 'construction', 'protest', 'wedding', 'yoga']

const STOP = new Set(['the', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'for', 'and', 'with', 'from', 'by', 'view', 'video', 'stock', 'footage', 'shot', 'clip', 'scene', 'travel', 'trip', 'holiday', 'vacation', 'is', 'are'])

const tokensOf = (s: string): string[] =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOP.has(w))

/** The subject type of a post: from its keyword, else its title, else its destination, else the beat's own search words. Null when none matches. */
export function subjectTypeOf(ctx: BrollContext, terms: string[] = []): SubjectType | null {
  for (const text of [ctx.keyword, ctx.title, ctx.destination, terms.join(' ')]) {
    if (!text) continue
    const hit = SUBJECT_TYPES.find((s) => s.re.test(text))
    if (hit) return hit
  }
  return null
}

/** The destination a post is about (given, else read from the keyword), or null. */
export function brollDestination(ctx: BrollContext): string | null {
  return inferDestination({ title: ctx.title ?? '', keyword: ctx.keyword, destination: ctx.destination })
}

const MAX_QUERY_WORDS = 6
const cut = (q: string) => q.split(/\s+/).filter(Boolean).slice(0, MAX_QUERY_WORDS).join(' ')

/** Up to three searches for one beat, best first. Each one names the subject type of the post (river cruise, ship deck, old town,
 * beach ...) so "a floating hotel" does not return an indoor hotel room; the last two are broader, for when the first is empty. */
export function buildBrollQueries(terms: string[], ctx: BrollContext): string[] {
  const subject = subjectTypeOf(ctx)
  const beat = terms.join(' ').replace(/\s+/g, ' ').trim()
  const dest = brollDestination(ctx)
  const out: string[] = []
  if (subject) {
    // Only the subject's own search words count as "already named" ("river", "cruise"): a beat about an "old town" still gets the prefix.
    const phraseWords = subject.phrase.split(' ')
    const have = tokensOf(beat).some((t) => phraseWords.includes(t))
    out.push(cut(have ? beat : `${subject.phrase} ${beat}`))
    if (dest) out.push(cut(`${dest} ${subject.phrase}`))
    out.push(subject.phrase)
  } else {
    if (beat) out.push(cut(dest && !beat.toLowerCase().includes(dest.toLowerCase()) ? `${dest} ${beat}` : beat))
    if (dest) out.push(cut(`${dest} travel`))
  }
  return [...new Set(out.filter(Boolean))].slice(0, 3)
}

export interface BrollFile {
  link?: string
  file_type?: string
  width?: number
  height?: number
}

export interface BrollVideo {
  id: number | string
  /** The Pexels page address, which ends in a readable description. */
  url?: string
  duration?: number
  video_files?: BrollFile[]
}

/** The words of a Pexels video page address ("https://www.pexels.com/video/a-ship-on-a-river-3456/" gives "a ship on a river"). */
export function videoSlug(pageUrl: string | undefined): string {
  if (!pageUrl) return ''
  const last = pageUrl.replace(/[?#].*$/, '').replace(/\/+$/, '').split('/').pop() ?? ''
  return last.replace(/-\d+$/, '').replace(/[-_]+/g, ' ').trim()
}

/** Why a clip description is rejected (an unrelated subject), or null. A subject the post itself names is allowed. */
export function unrelatedSubjectIn(description: string, contextText: string): string | null {
  const have = new Set(tokensOf(description))
  const ctx = new Set(tokensOf(contextText))
  return UNRELATED_SUBJECTS.find((w) => have.has(w) && !ctx.has(w)) ?? null
}

/** The mp4 to use for one clip: a portrait file between 540 and 1080 wide (720 and up preferred), else a landscape HD file whose
 * centre crop to 9:16 is safe (at least 720 high and not wider than 2:1). Null when neither exists. */
export function bestBrollFile(files: BrollFile[] | undefined): { link: string; landscape: boolean } | null {
  const mp4 = (files ?? []).filter((f) => f.link && f.file_type === 'video/mp4' && (f.width ?? 0) > 0 && (f.height ?? 0) > 0)
  const portrait = mp4.filter((f) => (f.height ?? 0) > (f.width ?? 0) && (f.width ?? 0) >= 540)
  const bestPortrait = portrait.filter((f) => (f.width ?? 0) >= 720 && (f.width ?? 0) <= 1080).sort((a, b) => (a.width ?? 0) - (b.width ?? 0))[0] ?? portrait.sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0]
  if (bestPortrait?.link) return { link: bestPortrait.link, landscape: false }
  const land = mp4
    .filter((f) => (f.width ?? 0) >= (f.height ?? 0) && (f.height ?? 0) >= 720 && (f.height ?? 0) <= 1440 && (f.width ?? 0) / (f.height ?? 1) <= 2)
    .sort((a, b) => (a.height ?? 0) - (b.height ?? 0))[0]
  return land?.link ? { link: land.link, landscape: true } : null
}

export interface BrollPick {
  id: string
  url: string
  duration: number
  landscape: boolean
  /** The description the clip was judged on (its page slug). */
  description: string
}

/** Picks one clip from search results, or null when none is good enough (the beat then falls back to a still image).
 * `terms` are the beat's own search words, `usedIds` the clips already in this reel and `recentIds` the clips of recent reels:
 * both are skipped (a repeated clip is worse than a still image). Pure. */
export function pickBroll(
  videos: BrollVideo[],
  opts: { terms: string[]; ctx: BrollContext; usedIds?: ReadonlySet<string>; recentIds?: ReadonlySet<string>; minSeconds?: number },
): BrollPick | null {
  const subject = subjectTypeOf(opts.ctx, opts.terms)
  const contextText = [opts.ctx.keyword, opts.ctx.title, opts.ctx.destination, ...opts.terms].filter(Boolean).join(' ')
  const wanted = new Set([...tokensOf(opts.terms.join(' ')), ...(subject?.tokens ?? []), ...tokensOf(opts.ctx.destination ?? '')])
  const minSeconds = opts.minSeconds ?? 3
  let best: { pick: BrollPick; score: number } | null = null
  for (const v of videos) {
    const id = String(v.id)
    if (opts.usedIds?.has(id) || opts.recentIds?.has(id)) continue
    if (v.duration !== undefined && v.duration > 0 && v.duration < minSeconds) continue
    const description = videoSlug(v.url)
    if (unrelatedSubjectIn(description, contextText)) continue
    const overlap = tokensOf(description).filter((t) => wanted.has(t)).length
    // A clip must share at least one word with the subject or the beat; a description that says nothing (no slug) is not good enough.
    if (overlap === 0) continue
    const file = bestBrollFile(v.video_files)
    if (!file) continue
    const score = overlap * 3 + (file.landscape ? 0 : 2) + ((v.duration ?? 0) >= 5 ? 1 : 0)
    if (!best || score > best.score) best = { pick: { id, url: file.link, duration: v.duration ?? 0, landscape: file.landscape, description }, score }
  }
  return best?.pick ?? null
}
