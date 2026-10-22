// Guide photo loop (pure part). No database, no network, no React: lib/guide-photo-run.ts does the reading, the searching and the
// writing, this file decides WHICH guides need a photo, WHAT to search for, and WHICH photo is acceptable, so
// scripts/check-guide-photo.ts can test every rule offline.
//
// Why it exists: guide heroes are captioned "Illustrative stock photo", and 17 published guides showed a picture another page already
// used. The loop picks a fresh, relevant, landscape photo for them by itself and never claims the photo is the named ship or property:
// the search words and the alt text describe the SUBJECT TYPE (a cruise ship, a resort, a place), not the brand.
import { assessCover, coverKey, isOgCardUrl, type CoverProblem } from './image-quality'
import { isBannedAlt, queryTokens, rankCandidates, type PhotoCandidate } from './photo-score'

/** The original photo must be at least this wide (the delivered copy is Pexels' ~1880px "large2x"). */
export const GUIDE_PHOTO_MIN_WIDTH = 1600
/** A landscape photo is wider than tall; this is the loosest height it may have (so a 1600 wide photo is not a thin strip). */
export const GUIDE_PHOTO_MIN_HEIGHT = 600
/** At most this many guides get a new photo per day in the daily heal. */
export const GUIDE_PHOTOS_PER_DAY = 3
/** In the daily heal one guide tries this many query variants a day (a search is free; the next day moves on). */
export const VARIANTS_PER_DAY = 2
/** How many acceptable photos, best first, are checked for a live 200 image before giving up on a variant. */
export const VERIFY_TOP = 3
export const GUIDE_PHOTO_ATTEMPTS_KEY = 'guide_photo_attempts'
export const GUIDE_PHOTO_DAY_PREFIX = 'guide_photo_day'

export type SubjectType = 'cruise ship' | 'river cruise ship' | 'resort' | 'hotel' | 'sailing yacht' | 'scenic view'

const SUBJECT_BY_KIND: Record<string, SubjectType> = {
  destinations: 'scenic view',
  hotels: 'hotel',
  resorts: 'resort',
  'cruise-lines': 'cruise ship',
  ships: 'cruise ship',
  'river-cruises': 'river cruise ship',
  yachts: 'sailing yacht',
}

/** What a guide's hero shows: the type of thing, never the named one. Null for a kind this loop does not know. */
export function subjectTypeOf(kind: string): SubjectType | null {
  return SUBJECT_BY_KIND[kind] ?? null
}

/** Words that prove a photo's description is about the right TYPE of subject. */
const SUBJECT_WORDS: Record<SubjectType, RegExp> = {
  'cruise ship': /\b(cruise|cruises|ship|ships|liner|vessel|boat|ferry|deck)\b/i,
  'river cruise ship': /\b(river|boat|boats|ship|ships|cruise|barge|vessel)\b/i,
  resort: /\b(resort|resorts|pool|hotel|villa|beach|swimming|palm|palms|lagoon|spa|bungalow|bungalows)\b/i,
  hotel: /\b(hotel|hotels|resort|lobby|building|facade|room|suite|pool|exterior)\b/i,
  'sailing yacht': /\b(yacht|yachts|sail|sails|sailing|sailboat|schooner|mast|ship|boat)\b/i,
  'scenic view': /\b(landscape|city|skyline|beach|mountain|mountains|coast|coastal|village|aerial|view|scenic|town|island|harbou?r|bay|lake|river|temple|castle|sunset|sea|ocean|street|old town)\b/i,
}

export interface GuidePhotoGuide {
  id: string
  kind: string
  slug: string
  name: string
  parentSlug: string | null
  hero: string | null
  alt: string | null
  /** Created date, for walking oldest first (the earliest page keeps a repeated picture). */
  date: string | null
}

export interface StoredCover {
  url: string | null
  alt?: string | null
  date?: string | null
}

// ---------------------------------------------------------------------------------------------------
// Where is it? (the place a guide is about, never its brand)
// ---------------------------------------------------------------------------------------------------

const BRAND_WORDS = /\b(cruises?|waterways|lines?|collection|boutique|resorts?|hotels?|club|yachts?|travel|vacations?|hospitality)\b/i
const RIVER_REGION = /^\s*(the\s+)?(rhine|danube|seine|mekong|nile|douro|elbe|rhone|rhône|moselle|mississippi|amazon|volga|irrawaddy|yangtze|main|po|garonne|dordogne)\b/i

/** The place a guide is about: a destination guide's own name, else the name of the destination it sits under (following the parent
 * chain up to 4 steps), else a river region when a river cruise guide is itself named for a river. Empty when there is none: a brand name
 * is never used as a place. */
export function placeOf(guide: Pick<GuidePhotoGuide, 'kind' | 'name' | 'parentSlug'>, all: ReadonlyMap<string, { name: string; kind: string; parentSlug: string | null }>): string {
  if (guide.kind === 'destinations') return clean(guide.name)
  let slug = guide.parentSlug
  for (let i = 0; i < 4 && slug; i++) {
    const parent = all.get(slug)
    if (!parent) break
    if (parent.kind === 'destinations') return clean(parent.name)
    slug = parent.parentSlug
  }
  if (guide.kind === 'river-cruises' && RIVER_REGION.test(guide.name) && !BRAND_WORDS.test(guide.name)) return clean(guide.name)
  return ''
}

const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim()

// ---------------------------------------------------------------------------------------------------
// What to search for: a ranked list of query variants, best first
// ---------------------------------------------------------------------------------------------------

/** Query variants for a guide, most specific first, each one a little more generic than the one before. The last ones name no place at
 * all, so a guide always has something to try. Deduplicated. */
export function buildQueryVariants(kind: string, name: string, place: string): string[] {
  const n = clean(name)
  const p = clean(place)
  const list: string[] = []
  switch (kind) {
    case 'cruise-lines':
    case 'ships':
      list.push(`${n} cruise ship`, p ? `${p} cruise ship sea` : 'cruise ship sea', 'cruise ship deck ocean sunset', 'cruise ship ocean sunset')
      break
    case 'river-cruises':
      list.push(`${n} river cruise ship`, p ? `river cruise ship ${p}` : 'river cruise ship europe', 'river cruise ship', 'river boat sunset')
      break
    case 'resorts':
      list.push(p ? `luxury resort pool ${p}` : `${n} resort pool`, p ? `${p} beach resort` : 'beach resort', 'resort pool palm trees', 'luxury resort pool')
      break
    case 'hotels':
      list.push(p ? `luxury hotel ${p}` : `${n} hotel`, p ? `${p} hotel exterior` : 'hotel exterior', 'luxury hotel pool', 'hotel lobby luxury')
      break
    case 'yachts':
      list.push('tall ship sailing yacht', p ? `luxury sailing yacht ${p}` : 'luxury sailing yacht', 'sailing yacht sea', 'sailboat ocean sunset')
      break
    case 'destinations':
      list.push(`${n} landscape travel`, `${n} scenic view`, `${n} travel`, `${n} aerial`)
      break
    default:
      return []
  }
  const seen = new Set<string>()
  return list.map(clean).filter((q) => q && !seen.has(q.toLowerCase()) && seen.add(q.toLowerCase()))
}

// ---------------------------------------------------------------------------------------------------
// Which photo is acceptable
// ---------------------------------------------------------------------------------------------------

/** The Pexels photo id inside a stored address (images.pexels.com/photos/<id>/...), or null. */
export function photoIdOfUrl(url: string | null | undefined): number | null {
  const m = /\/photos\/(\d+)\//.exec(url ?? '')
  return m ? Number(m[1]) : null
}

export interface UsedPhotos {
  /** coverKey() of every stored hero or cover. */
  keys: Set<string>
  /** Pexels ids found in those addresses. */
  ids: Set<number>
}

/** Everything already used as a hero or cover anywhere (guides of any status, posts), so no photo is ever used twice. */
export function collectUsed(covers: readonly (string | null | undefined)[]): UsedPhotos {
  const keys = new Set<string>()
  const ids = new Set<number>()
  for (const c of covers) {
    const url = (c ?? '').trim()
    if (!url || isOgCardUrl(url)) continue
    keys.add(coverKey(url))
    const id = photoIdOfUrl(url)
    if (id !== null) ids.add(id)
  }
  return { keys, ids }
}

/** Photos a person ruled out by eye: they show another company's named vessel or property. Add the Pexels id here to never use one. */
export const BLOCKED_PHOTO_IDS: ReadonlySet<number> = new Set([36104392])

export type RejectWhy ='invalid' | 'banned' | 'too-small' | 'not-landscape' | 'already-used' | 'wrong-subject'

/** Why a candidate is not acceptable, or null when it is. A photo is accepted only when:
 *  - its description is not a banned subject (laptop, office ...),
 *  - it is a landscape photo at least GUIDE_PHOTO_MIN_WIDTH wide,
 *  - no other guide, post or earlier pick uses it (same address or same photo id),
 *  - its description names the right TYPE of subject (ship, resort, place ...). A photo with NO description is accepted on the strength
 *    of the query alone, because every variant names the subject type; a description that names something else is rejected. */
export function rejectReason(c: PhotoCandidate, subject: SubjectType, query: string, used: UsedPhotos): RejectWhy | null {
  if (!c || !c.url || !Number.isFinite(c.id)) return 'invalid'
  const alt = clean(c.alt)
  if (isBannedAlt(alt)) return 'banned'
  if (!(c.width >= GUIDE_PHOTO_MIN_WIDTH) || !(c.height >= GUIDE_PHOTO_MIN_HEIGHT)) return 'too-small'
  if (!(c.width > c.height)) return 'not-landscape'
  if (used.ids.has(c.id) || used.keys.has(coverKey(c.url)) || BLOCKED_PHOTO_IDS.has(c.id)) return 'already-used'
  const words = SUBJECT_WORDS[subject]
  if (alt ? !words.test(alt) : !words.test(query)) return 'wrong-subject'
  return null
}

export interface RankedPick {
  candidate: PhotoCandidate
  score: number
}

/** The acceptable candidates for one query, best first (the existing score: relevance tier, vividness, size, recent history). */
export function rankAcceptable(candidates: readonly PhotoCandidate[], subject: SubjectType, query: string, used: UsedPhotos): { picks: RankedPick[]; rejected: Record<RejectWhy, number> } {
  const rejected: Record<RejectWhy, number> = { invalid: 0, banned: 0, 'too-small': 0, 'not-landscape': 0, 'already-used': 0, 'wrong-subject': 0 }
  const ok: PhotoCandidate[] = []
  const seenIds = new Set<number>()
  for (const c of candidates) {
    const why = rejectReason(c, subject, query, used)
    if (why) rejected[why]++
    else if (!seenIds.has(c.id)) {
      seenIds.add(c.id)
      ok.push(c)
    }
  }
  const ranked = rankCandidates(ok, { tokens: queryTokens(query), recentIds: new Set(), minWidth: GUIDE_PHOTO_MIN_WIDTH, minHeight: GUIDE_PHOTO_MIN_HEIGHT })
  return { picks: ranked.ranked.map((s) => ({ candidate: s.photo, score: s.score })), rejected }
}

/** Honest alt text: it says what the picture is (an illustrative stock photo of a TYPE of thing), plus the place when there is one. It
 * never names the guide, so it can never claim the photo shows that vessel or property. */
export function guidePhotoAlt(kind: string, place: string): string {
  const subject = subjectTypeOf(kind) ?? 'scenic view'
  const p = clean(place)
  return `Illustrative stock photo: ${subject}${p ? `, ${p}` : ''}`
}

/** Alt text for a generated illustration (the AI fallback): says plainly that it is an illustration. */
export function guideIllustrationAlt(kind: string, place: string): string {
  const subject = subjectTypeOf(kind) ?? 'scenic view'
  const p = clean(place)
  return `Illustration: ${subject}${p ? `, ${p}` : ''}`
}

/** The prompt for the generated illustration. It names the type of subject and the place, never the brand. */
export function guideIllustrationPrompt(kind: string, place: string): string {
  const subject = subjectTypeOf(kind) ?? 'scenic view'
  const p = clean(place)
  return `${subject === 'scenic view' ? 'a scenic travel view' : `a ${subject}`}${p ? ` near ${p}` : ''}, bright daylight`
}

// ---------------------------------------------------------------------------------------------------
// Which guides need a photo
// ---------------------------------------------------------------------------------------------------

export interface FlaggedGuide {
  guide: GuidePhotoGuide
  problems: CoverProblem[]
}

const PROBLEMS_THAT_NEED_A_PHOTO: readonly CoverProblem[] = ['missing', 'svg', 'default_asset', 'tiny', 'banned_subject', 'duplicate', 'broken']

/** Guides whose hero is missing, tiny, a wrong subject, an SVG or default thumbnail, broken (when `broken` says so) or the SAME picture as
 * an earlier guide or post. Posts and guides are walked together, oldest first, so the earliest page keeps a repeated picture and only
 * the later one is flagged. A guide with a good hero is never flagged (alt text alone is not a reason: that is fixed in place elsewhere).
 * Pure. */
export function flaggedGuides(guides: readonly GuidePhotoGuide[], posts: readonly StoredCover[], broken: ReadonlySet<string> = new Set()): FlaggedGuide[] {
  type Row = { date: string; i: number; guide: GuidePhotoGuide | null; url: string | null; alt: string | null }
  const rows: Row[] = [
    ...posts.map((p, i): Row => ({ date: p.date ?? '', i, guide: null, url: clean(p.url) || null, alt: p.alt ?? null })),
    ...guides.map((g, i): Row => ({ date: g.date ?? '', i: posts.length + i, guide: g, url: clean(g.hero) || null, alt: g.alt })),
  ].sort((a, b) => a.date.localeCompare(b.date) || a.i - b.i)
  const seen = new Set<string>()
  const out: FlaggedGuide[] = []
  for (const r of rows) {
    const res = assessCover({ url: r.url, alt: r.alt }, { otherCovers: seen, broken: r.url ? broken.has(r.url) : false })
    if (res.good) {
      if (r.url && !isOgCardUrl(r.url)) seen.add(coverKey(r.url))
      continue
    }
    if (r.guide) out.push({ guide: r.guide, problems: res.problems.filter((p) => PROBLEMS_THAT_NEED_A_PHOTO.includes(p)) })
  }
  return out
}

// ---------------------------------------------------------------------------------------------------
// Tries (app_settings 'guide_photo_attempts')
// ---------------------------------------------------------------------------------------------------

export interface PhotoAttempt {
  /** The query variant to try next (an index into buildQueryVariants). */
  n: number
  /** When the last try was made (ISO). */
  at: string
  /** What happened last, in plain words. */
  last: string
}
export type PhotoAttempts = Record<string, PhotoAttempt>

export const guideKey = (g: Pick<GuidePhotoGuide, 'kind' | 'slug'>) => `${g.kind}/${g.slug}`

/** Parses the stored JSON defensively: anything unexpected is dropped, never thrown. */
export function parseAttempts(raw: string | null | undefined): PhotoAttempts {
  if (!raw) return {}
  try {
    const v: unknown = JSON.parse(raw)
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
    const out: PhotoAttempts = {}
    for (const [k, a] of Object.entries(v as Record<string, unknown>)) {
      const o = a as Partial<PhotoAttempt> | null
      if (o && typeof o.n === 'number' && Number.isFinite(o.n) && o.n >= 0) out[k] = { n: Math.floor(o.n), at: typeof o.at === 'string' ? o.at : '', last: typeof o.last === 'string' ? o.last : '' }
    }
    return out
  } catch {
    return {}
  }
}

/** The attempt record after a day with no acceptable photo: move on to the next variant, and start over once every variant was tried. */
export function advanceAttempt(prev: PhotoAttempt | undefined, tried: number, variantCount: number, last: string, now: Date = new Date()): PhotoAttempt {
  const from = Math.min(prev?.n ?? 0, Math.max(0, variantCount - 1))
  const next = variantCount > 0 && from + Math.max(1, tried) >= variantCount ? 0 : from + Math.max(1, tried)
  return { n: next, at: now.toISOString(), last: last.slice(0, 200) }
}

/** The order guides are worked in: never tried first, then the longest ago. The daily cap then takes the first few. Pure. */
export function orderTargets<T extends { guide: GuidePhotoGuide }>(flagged: readonly T[], attempts: PhotoAttempts): T[] {
  const at = (t: T) => Date.parse(attempts[guideKey(t.guide)]?.at ?? '') || 0
  return flagged.map((t, i) => ({ t, i })).sort((a, b) => at(a.t) - at(b.t) || a.i - b.i).map((x) => x.t)
}

/** How many guides may still get a photo today. */
export const guidesLeftToday = (usedToday: number, cap = GUIDE_PHOTOS_PER_DAY): number => Math.max(0, cap - Math.max(0, usedToday))

// ---------------------------------------------------------------------------------------------------
// Choosing for one guide (the search is injected, so the check runs offline)
// ---------------------------------------------------------------------------------------------------

export type SearchPhotos = (query: string) => Promise<PhotoCandidate[]>

export interface Choice {
  guide: GuidePhotoGuide
  subject: SubjectType
  place: string
  variants: string[]
  /** The acceptable photos of the first variant that had any, best first (the caller verifies the address answers). */
  picks: { query: string; candidate: PhotoCandidate; score: number }[]
  /** Variants tried, with what happened. */
  tried: { variant: number; query: string; found: number; rejected: Record<RejectWhy, number> }[]
  /** True when the variants ran out (every one from `startIndex` to the last was tried with nothing acceptable). */
  exhausted: boolean
  /** Variant index to start from next time when nothing was accepted. */
  nextIndex: number
  alt: string
}

/** Searches variant by variant from `startIndex` (at most `maxVariants`) and stops at the first variant with an acceptable photo. Never
 * throws: a failing search counts as "found nothing". */
export async function chooseGuidePhoto(
  guide: GuidePhotoGuide,
  all: ReadonlyMap<string, { name: string; kind: string; parentSlug: string | null }>,
  used: UsedPhotos,
  search: SearchPhotos,
  opts: { startIndex?: number; maxVariants?: number } = {},
): Promise<Choice | null> {
  const subject = subjectTypeOf(guide.kind)
  if (!subject) return null
  const place = placeOf(guide, all)
  const variants = buildQueryVariants(guide.kind, guide.name, place)
  if (variants.length === 0) return null
  const start = Math.min(Math.max(0, opts.startIndex ?? 0), variants.length - 1)
  const max = Math.max(1, opts.maxVariants ?? variants.length)
  const choice: Choice = { guide, subject, place, variants, picks: [], tried: [], exhausted: false, nextIndex: 0, alt: guidePhotoAlt(guide.kind, place) }
  let i = start
  for (; i < variants.length && choice.tried.length < max; i++) {
    const query = variants[i]
    let found: PhotoCandidate[] = []
    try {
      found = await search(query)
    } catch {
      found = []
    }
    const { picks, rejected } = rankAcceptable(found, subject, query, used)
    choice.tried.push({ variant: i, query, found: found.length, rejected })
    if (picks.length) {
      choice.picks = picks.map((p) => ({ query, candidate: p.candidate, score: p.score }))
      return choice
    }
  }
  choice.exhausted = i >= variants.length
  choice.nextIndex = choice.exhausted ? 0 : i
  return choice
}

/** The final gate on a chosen photo's address and alt before anything is saved: the image quality gate must call it good against every
 * other picture in use. Pure. */
export function passesGate(url: string, alt: string, used: UsedPhotos): boolean {
  return assessCover({ url, alt }, { otherCovers: used.keys }).good
}
