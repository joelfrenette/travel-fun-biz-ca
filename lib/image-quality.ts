// Image quality gate (images loop). Pure: no database, no network, no React. One place that says whether a cover
// is good enough to show and share, used by the cover backfill and by the "Posts without a good cover" counter on
// the Posts: Blog admin header. The alt text helpers also live here so a post, a guide and a destination page all
// describe a picture the same way.
import { isBannedAlt } from './photo-score'

/** A cover under this many pixels on its long edge is too small to share or to show full width. */
export const MIN_COVER_PX = 800

export type CoverProblem =
  | 'missing' // no address at all
  | 'svg' // an SVG: social sites cannot draw one
  | 'default_asset' // one of the built-in default thumbnails (public/assets/defaults), never a real cover
  | 'tiny' // known to be smaller than MIN_COVER_PX
  | 'banned_subject' // the alt text names a wrong subject (laptop, office, coffee...)
  | 'duplicate' // another post already uses this exact picture
  | 'broken' // the address was fetched and did not return an image

export interface CoverInput {
  url?: string | null
  alt?: string | null
  /** Pixel size when known (a probe, or the post's own stored size). Inferred from the address when not given. */
  width?: number | null
  height?: number | null
}

export interface CoverContext {
  /** Addresses (see coverKey) already used by an earlier post. */
  otherCovers?: ReadonlySet<string>
  /** True when a fetch of the address failed. */
  broken?: boolean
}

export interface CoverAssessment {
  good: boolean
  problems: CoverProblem[]
  /** True when the alt text is missing or too generic to describe the picture (fixed in place, the cover is kept). */
  needsAlt: boolean
}

/** The path of a rendered share card (/og/...), which is always 1200x630 PNG. */
export function isOgCardUrl(url: string | null | undefined): boolean {
  const s = (url ?? '').trim()
  if (!s) return false
  try {
    return new URL(s, 'https://x.invalid').pathname.startsWith('/og/')
  } catch {
    return false
  }
}

export function isSvgUrl(url: string | null | undefined): boolean {
  const s = (url ?? '').trim().toLowerCase()
  if (!s) return false
  if (s.startsWith('data:image/svg')) return true
  try {
    return new URL(s, 'https://x.invalid').pathname.endsWith('.svg')
  } catch {
    return /\.svg(\?|#|$)/.test(s)
  }
}

export function isDefaultAssetUrl(url: string | null | undefined): boolean {
  const s = (url ?? '').trim()
  if (!s) return false
  try {
    return new URL(s, 'https://x.invalid').pathname.startsWith('/assets/defaults/')
  } catch {
    return false
  }
}

/** The key two covers are compared by: the address without query string, fragment or host case. */
export function coverKey(url: string | null | undefined): string {
  const s = (url ?? '').trim()
  if (!s) return ''
  try {
    const u = new URL(s, 'https://x.invalid')
    return `${u.hostname.toLowerCase()}${u.pathname}`
  } catch {
    return s.toLowerCase()
  }
}

/** Pixel size we can know without fetching: a share card is 1200x630; a Pexels address with a width option names it. */
export function inferDimensions(url: string | null | undefined): { width: number | null; height: number | null } {
  if (isOgCardUrl(url)) return { width: 1200, height: 630 }
  try {
    const u = new URL((url ?? '').trim())
    if (u.hostname === 'images.pexels.com') {
      const w = Number(u.searchParams.get('w'))
      const h = Number(u.searchParams.get('h'))
      return { width: Number.isFinite(w) && w > 0 ? w : null, height: Number.isFinite(h) && h > 0 ? h : null }
    }
  } catch {
    // not an absolute address: size unknown
  }
  return { width: null, height: null }
}

const GENERIC_ALT = /^(image|images|img|photo|photos|picture|pictures|pic|banner|hero|hero image|cover|cover image|thumbnail|stock photo|untitled|placeholder|default|logo)$/i

/** True when alt text says nothing about the picture: blank, one generic word, or a filename. */
export function isGenericAlt(alt: string | null | undefined): boolean {
  const s = (alt ?? '').replace(/\s+/g, ' ').trim()
  if (s.length < 4) return true
  if (GENERIC_ALT.test(s)) return true
  if (/\.(jpe?g|png|webp|gif|svg)$/i.test(s)) return true
  if (/^(img|dsc|pexels)[-_ ]?\d+/i.test(s)) return true
  return false
}

/** Alt text that is usable: real words, and not a wrong subject. */
export function altNeedsFix(alt: string | null | undefined): boolean {
  return isGenericAlt(alt)
}

/** Is this cover good enough? Pure; every rule is one problem in the result. */
export function assessCover(input: CoverInput, ctx: CoverContext = {}): CoverAssessment {
  const problems: CoverProblem[] = []
  const url = (input.url ?? '').trim()
  const needsAlt = altNeedsFix(input.alt)
  if (!url) return { good: false, problems: ['missing'], needsAlt }

  if (isSvgUrl(url)) problems.push('svg')
  if (isDefaultAssetUrl(url)) problems.push('default_asset')

  const inferred = inferDimensions(url)
  const width = input.width ?? inferred.width
  const height = input.height ?? inferred.height
  const long = Math.max(width ?? 0, height ?? 0)
  if (long > 0 && long < MIN_COVER_PX) problems.push('tiny')

  if (input.alt && isBannedAlt(input.alt)) problems.push('banned_subject')
  // A rendered card is unique to its page by construction, so it is never a duplicate.
  if (!isOgCardUrl(url) && ctx.otherCovers && ctx.otherCovers.has(coverKey(url))) problems.push('duplicate')
  if (ctx.broken) problems.push('broken')
  return { good: problems.length === 0, problems, needsAlt }
}

const PROBLEM_TEXT: Record<CoverProblem, string> = {
  missing: 'no cover',
  svg: 'cover is an SVG (social sites cannot show it)',
  default_asset: 'cover is a default thumbnail',
  tiny: `cover is smaller than ${MIN_COVER_PX}px`,
  banned_subject: 'alt text names a wrong subject',
  duplicate: 'same picture as an earlier post',
  broken: 'cover address does not load',
}

export const describeProblems = (p: readonly CoverProblem[]): string => p.map((x) => PROBLEM_TEXT[x]).join('; ')

/** Posts (or guides) whose cover is not good, counting a repeated picture only on the later one. Pure.
 * `rows` are in any order; they are walked oldest first (by `date`, then input order) so the earliest keeps the picture. */
export function countWithoutGoodCover(rows: { url?: string | null; alt?: string | null; date?: string | null }[]): number {
  const order = rows.map((r, i) => ({ r, i })).sort((a, b) => (a.r.date ?? '').localeCompare(b.r.date ?? '') || a.i - b.i)
  const seen = new Set<string>()
  let bad = 0
  for (const { r } of order) {
    const res = assessCover({ url: r.url, alt: r.alt }, { otherCovers: seen })
    if (!res.good) bad++
    else if (r.url && !isOgCardUrl(r.url)) seen.add(coverKey(r.url))
  }
  return bad
}

// ---------------------------------------------------------------------------------------------------
// Alt text
// ---------------------------------------------------------------------------------------------------

const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim()
const cap = (s: string, n = 125) => (s.length <= n ? s : `${s.slice(0, n - 1).replace(/\s+\S*$/, '')}…`)

/** Alt text for a blog cover: the stock photo's own description when it is useful, anchored to the place, else the
 * place and the topic. Never "image", never empty when there is any text to use. */
export function coverAlt(i: { title?: string | null; destination?: string | null; keyword?: string | null; photoAlt?: string | null }): string {
  const place = clean(i.destination)
  const topic = clean(i.keyword) || clean(i.title)
  const photo = clean(i.photoAlt)
  if (photo && !isGenericAlt(photo) && !isBannedAlt(photo)) {
    return cap(place && !photo.toLowerCase().includes(place.toLowerCase()) ? `${place}: ${photo}` : photo)
  }
  if (place && topic && !topic.toLowerCase().includes(place.toLowerCase())) return cap(`${place}: ${topic}`)
  return cap(topic || place || 'Travel photo')
}

/** Alt text for a guide or destination hero. Uses the stored alt when it is descriptive, else the page's name plus what
 * the picture is (an illustrative stock photo), so it is always about the destination and never a bare "image". */
export function heroAlt(stored: string | null | undefined, name: string, subject = 'illustrative stock travel photo'): string {
  const alt = clean(stored)
  const n = clean(name)
  if (alt && !isGenericAlt(alt)) return n && !alt.toLowerCase().includes(n.toLowerCase()) ? cap(`${n}: ${alt}`) : cap(alt)
  return cap(n ? `${n}: ${subject}` : subject)
}
