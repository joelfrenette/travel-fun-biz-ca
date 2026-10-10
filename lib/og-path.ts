// Pure helpers for the share-image route (growth loop WP6): path parsing, photo-host allow-list and
// title wrapping. No database, no network, so scripts/check-og-paths.ts can test them directly.
// The part that reads the database is lib/og-image.ts.
import { absoluteUrl, SITE_URL } from '@/lib/site'

export const OG_WIDTH = 1200
export const OG_HEIGHT = 630

/** The first path segment after /og/. Guide kinds use their own URL prefix. */
export const OG_PREFIXES = [
  'blog',
  'packages',
  'compare',
  'best-time-to-visit',
  'destinations',
  'hotels',
  'resorts',
  'cruise-lines',
  'ships',
  'river-cruises',
  'yachts',
] as const
export type OgPrefix = (typeof OG_PREFIXES)[number]

export interface OgTarget {
  prefix: OgPrefix
  slug: string
}

// Letters, digits, dot, dash and underscore only; must start with a letter or digit. A pair slug such as
// "italy-vs-tahiti" and a slug with a dot ("st.-lucia") both pass; "..", "/" and "%" never do.
const SLUG_RE = /^[a-z0-9][a-z0-9._-]*$/i
const MAX_SLUG = 160

/** Turns the catch-all segments of /og/[...path] into a target, or null when they are not a page we draw. */
export function parseOgPath(segments: readonly string[] | undefined | null): OgTarget | null {
  if (!segments || segments.length !== 2) return null
  const [prefix, slug] = segments
  if (!(OG_PREFIXES as readonly string[]).includes(prefix)) return null
  if (!slug || slug.length > MAX_SLUG || slug.includes('..') || !SLUG_RE.test(slug)) return null
  return { prefix: prefix as OgPrefix, slug }
}

/** "/og/blog/my-post" for a page, built from the same prefix list the route accepts. */
export function ogPath(prefix: OgPrefix, slug: string): string {
  return `/og/${prefix}/${slug}`
}

/** The absolute URL a page puts in openGraph.images / twitter.images. */
export function ogImageUrl(prefix: OgPrefix, slug: string): string {
  return absoluteUrl(ogPath(prefix, slug))
}

/** The openGraph.images entry for a page, with the real size so crawlers do not have to guess. */
export function ogImageEntry(prefix: OgPrefix, slug: string, alt: string) {
  return { url: ogImageUrl(prefix, slug), width: OG_WIDTH, height: OG_HEIGHT, alt }
}

// ---------------------------------------------------------------------------------------------------
// Photo allow-list: the renderer fetches a URL that came from a database row, so only known hosts.
// ---------------------------------------------------------------------------------------------------

const ALLOWED_EXACT_HOSTS = ['images.pexels.com', 'travelfunbiz.com', 'www.travelfunbiz.com', 'travelfunbiz.ca', 'www.travelfunbiz.ca']

function siteHost(): string | null {
  try {
    return new URL(SITE_URL).hostname.toLowerCase()
  } catch {
    return null
  }
}

/** True for an https URL on Pexels, Supabase storage or the site itself. Anything else is not fetched. */
export function isAllowedPhotoUrl(raw: string | null | undefined): boolean {
  if (!raw) return false
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return false
  }
  if (u.protocol !== 'https:' || u.username || u.password) return false
  const host = u.hostname.toLowerCase()
  if (ALLOWED_EXACT_HOSTS.includes(host)) return true
  if (host === siteHost()) return true
  return host.endsWith('.supabase.co')
}

// ---------------------------------------------------------------------------------------------------
// Title wrapping. Satori has no reliable line clamp across versions, so lines are cut here.
// ---------------------------------------------------------------------------------------------------

export const TITLE_MAX_LINES = 3
const TITLE_BOX_WIDTH = 1040
// Biggest first. The first size whose wrap fits in 3 lines wins; if none does, the smallest is used and cut.
const TITLE_SIZES = [76, 64, 54, 46]
// Average glyph width of a bold sans as a share of the font size, kept a little wide so lines do not overflow.
const GLYPH_WIDTH = 0.58

/** Collapses whitespace and drops a trailing " | Site name" so the picture does not repeat the brand twice. */
export function cleanTitle(raw: string, siteName = ''): string {
  let t = raw.replace(/\s+/g, ' ').trim()
  if (siteName) {
    const suffix = ` | ${siteName}`
    if (t.toLowerCase().endsWith(suffix.toLowerCase())) t = t.slice(0, t.length - suffix.length).trim()
  }
  return t
}

/**
 * Greedy word wrap to `maxLines` lines of at most `maxChars` characters. Text that does not fit is cut
 * with an ellipsis on the last line. A single word longer than a line is split.
 */
export function wrapTitle(text: string, maxChars: number, maxLines = TITLE_MAX_LINES): { lines: string[]; truncated: boolean } {
  // Split any word longer than a line into line-sized chunks first.
  const tokens: string[] = []
  for (const word of text.split(' ').filter(Boolean)) {
    for (let i = 0; i < word.length; i += maxChars) tokens.push(word.slice(i, i + maxChars))
  }
  const all: string[] = []
  let current = ''
  for (const token of tokens) {
    if (!current) current = token
    else if (current.length + 1 + token.length <= maxChars) current = `${current} ${token}`
    else {
      all.push(current)
      current = token
    }
  }
  if (current) all.push(current)

  if (all.length <= maxLines) return { lines: all, truncated: false }
  const lines = all.slice(0, maxLines)
  const trimEnd = (s: string) => s.replace(/[\s.,;:!?-]+$/, '')
  const last = trimEnd(lines[maxLines - 1])
  // Leave room for the ellipsis inside the line width.
  lines[maxLines - 1] = `${trimEnd(last.slice(0, Math.max(1, maxChars - 1)))}…`
  return { lines, truncated: true }
}

/** Picks a font size and the wrapped lines for a title: as large as possible, never more than 3 lines. */
export function fitTitle(title: string): { lines: string[]; fontSize: number; truncated: boolean } {
  const text = title.replace(/\s+/g, ' ').trim()
  for (const size of TITLE_SIZES) {
    const maxChars = Math.floor(TITLE_BOX_WIDTH / (size * GLYPH_WIDTH))
    const wrapped = wrapTitle(text, maxChars)
    if (!wrapped.truncated) return { lines: wrapped.lines, fontSize: size, truncated: false }
  }
  const size = TITLE_SIZES[TITLE_SIZES.length - 1]
  const wrapped = wrapTitle(text, Math.floor(TITLE_BOX_WIDTH / (size * GLYPH_WIDTH)))
  return { lines: wrapped.lines, fontSize: size, truncated: wrapped.truncated }
}
