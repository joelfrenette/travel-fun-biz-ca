import { ImageResponse } from 'next/og'
import { SITE_NAME } from '@/lib/site'
import { getPublishedPostBySlug } from '@/lib/posts'
import { GUIDE_KINDS } from '@/lib/guides'
import { resolveOgTarget, cleanTitle, isAllowedPhotoUrl, allowedRedirectTarget, exceedsPhotoCap, hostOf, MAX_PHOTO_BYTES, type OgPrefix } from '@/lib/og-image'
import {
  COVER_WIDTH,
  COVER_HEIGHT,
  COVER_SAFE_SIDE,
  COVER_SAFE_VERTICAL,
  COVER_BLOCK_MAX_WIDTH,
  COVER_BLOCK_PAD_X,
  fitCoverTitle,
  fitNewsText,
  isSocialCoverKind,
  isValidCoverSlug,
  pickRecapQuestion,
  RECAP_STRIP_PREFIX,
  coverHeadlineFor,
  shortenNewsHeadline,
  shorterCoverHeadline,
  parseAlt,
  photoIdOf,
  NEWS_ALT_WORDS,
  type SocialCoverKind,
} from '@/lib/social-cover'
import { findAlternatePortraitPhoto } from '@/lib/pexels'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { readCoverHeadline } from '@/lib/cover-headline-store'

// Titled single-image social cover, 1080x1350 (Instagram portrait): /social-cover/<kind>/<slug>.
//   blog / trip / guide: the post's own photo, un-dimmed, with a short ALL-CAPS headline in a solid red block
//   in the upper middle and a small TRAVELFUNBIZ.CA strip at the bottom.
//   news: a teal typed card (no photo) with the brand tag, one big headline and the strip.
// Built from the same pieces as app/og/[...path]/route.tsx (next/og, Inter fetched from Google Fonts, allow-listed
// photo hosts, a cached font fetch). Public reads only (published rows), so a draft never gets a picture. It must
// never 500: any failure draws without the photo, and a total failure returns a plain 404/503 the sender detects.
// For guides the slug is the ledger slug `guide-<kind>-<slug>`; for trips it is the package slug.
export const dynamic = 'force-dynamic'
export const maxDuration = 30

const RED = '#d81f26'
const TEAL = '#0f6f7c'
const TEAL_TAG = '#0b5560'
const PHOTO_TIMEOUT_MS = 6000
const FONT_TIMEOUT_MS = 3000
const FONT_FAILURE_TTL_MS = 5 * 60 * 1000
const CACHE_CONTROL = 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800'
const SHORT_CACHE_CONTROL = 'public, s-maxage=300, stale-while-revalidate=60'

type Font = { name: string; data: ArrayBuffer; weight: 700 | 800; style: 'normal' }

const fontCache = new Map<string, ArrayBuffer>()
const fontInFlight = new Map<string, Promise<ArrayBuffer>>()
const fontFailedAt = new Map<string, number>()

async function fetchGoogleFont(family: string, weight: number): Promise<ArrayBuffer> {
  const cssRes = await fetch(`https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}:wght@${weight}`, { signal: AbortSignal.timeout(FONT_TIMEOUT_MS) })
  const css = await cssRes.text()
  const match = css.match(/src: url\(([^)]+)\) format\('(?:opentype|truetype)'\)/)
  if (!match) throw new Error(`No TTF/OTF link for ${family} ${weight}`)
  const fontRes = await fetch(match[1], { signal: AbortSignal.timeout(FONT_TIMEOUT_MS) })
  if (!fontRes.ok) throw new Error(`Font download failed (${fontRes.status})`)
  return fontRes.arrayBuffer()
}

function loadGoogleFont(family: string, weight: number): Promise<ArrayBuffer> {
  const key = `${family}:${weight}`
  const cached = fontCache.get(key)
  if (cached) return Promise.resolve(cached)
  const failedAt = fontFailedAt.get(key)
  if (failedAt && Date.now() - failedAt < FONT_FAILURE_TTL_MS) return Promise.reject(new Error('font recently failed'))
  let pending = fontInFlight.get(key)
  if (!pending) {
    pending = fetchGoogleFont(family, weight)
      .then((buf) => {
        fontCache.set(key, buf)
        fontFailedAt.delete(key)
        return buf
      })
      .catch((err) => {
        fontFailedAt.set(key, Date.now())
        throw err
      })
      .finally(() => {
        fontInFlight.delete(key)
      })
    fontInFlight.set(key, pending)
  }
  return pending
}

async function loadFonts(): Promise<Font[]> {
  try {
    return [{ name: 'Inter', data: await loadGoogleFont('Inter', 800), weight: 800, style: 'normal' }]
  } catch {
    try {
      return [{ name: 'Inter', data: await loadGoogleFont('Inter', 700), weight: 700, style: 'normal' }]
    } catch {
      return [] // the built-in default font still draws a correct image
    }
  }
}

function skipped(url: string, reason: string): null {
  console.warn('[social-cover] photo skipped', hostOf(url), reason)
  return null
}

/** The photo as a data URI Satori can draw (JPEG, PNG or GIF), or null on any problem. */
async function loadPhoto(url: string | null): Promise<string | null> {
  if (!url) return null
  if (!isAllowedPhotoUrl(url)) return skipped(url, 'host not allowed')
  try {
    let src = url
    const u = new URL(url)
    // Pexels serves originals of several MB; ask for a copy that covers 1080x1350 when the URL has no options.
    if (u.hostname === 'images.pexels.com' && !u.search) src = `${url}?auto=compress&cs=tinysrgb&h=1500`
    const fetchOnce = (target: string) => fetch(target, { signal: AbortSignal.timeout(PHOTO_TIMEOUT_MS), redirect: 'manual' })
    let res = await fetchOnce(src)
    if (res.status >= 300 && res.status < 400) {
      const next = allowedRedirectTarget(res.headers.get('location'), src)
      await res.body?.cancel().catch(() => {})
      if (!next) return skipped(url, `redirect to a host that is not allowed (${res.status})`)
      res = await fetchOnce(next)
      if (res.status >= 300 && res.status < 400) return skipped(url, 'second redirect')
    }
    if (!res.ok) return skipped(url, `status ${res.status}`)
    const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
    if (type !== 'image/jpeg' && type !== 'image/png' && type !== 'image/gif') return skipped(url, `content type ${type || 'missing'}`)
    if (exceedsPhotoCap(res.headers.get('content-length'))) return skipped(url, 'too large (content-length)')
    const buf = await res.arrayBuffer()
    if (buf.byteLength === 0) return skipped(url, 'empty body')
    if (buf.byteLength > MAX_PHOTO_BYTES) return skipped(url, 'too large')
    return `data:${type};base64,${Buffer.from(buf).toString('base64')}`
  } catch (err) {
    return skipped(url, err instanceof Error ? err.name : 'fetch failed')
  }
}

interface CoverContent {
  kind: SocialCoverKind
  /** Already shortened for the card. */
  headline: string
  photoUrl: string | null
  /** The cleaned page title, used as the search words when the quality gate asks for another photo. */
  searchTitle?: string
}

/** guide-<kind>-<slug> -> { kind, slug }; the longest matching kind wins. */
function parseGuideLedgerSlug(slug: string): { prefix: OgPrefix; slug: string } | null {
  const kinds = [...GUIDE_KINDS].sort((a, b) => b.length - a.length)
  for (const kind of kinds) {
    const prefix = `guide-${kind}-`
    if (slug.startsWith(prefix) && slug.length > prefix.length) return { prefix: kind, slug: slug.slice(prefix.length) }
  }
  return null
}

async function resolveContent(kind: SocialCoverKind, slug: string, alt = 0): Promise<CoverContent | null> {
  if (kind === 'news') {
    const post = await getPublishedPostBySlug(slug)
    if (!post) return null
    const headline = shortenNewsHeadline(post.title, NEWS_ALT_WORDS[Math.min(alt, NEWS_ALT_WORDS.length - 1)])
    return headline ? { kind, headline, photoUrl: null } : null
  }
  if (kind === 'recap') {
    // slug is the blog post's own slug. The headline is one of its real FAQ questions; a retry (alt) changes only the photo.
    const og = await resolveOgTarget({ prefix: 'blog', slug })
    const post = await getPublishedPostBySlug(slug)
    if (!og || !post) return null
    const searchTitle = cleanTitle(og.title, SITE_NAME)
    const question = pickRecapQuestion((post.faq ?? []).map((f) => f?.q))
    const headline = question ? question.toUpperCase() : coverHeadlineFor(null, searchTitle, SITE_NAME)
    return headline ? { kind, headline, photoUrl: og.photoUrl, searchTitle } : null
  }
  const target = kind === 'blog' ? { prefix: 'blog' as OgPrefix, slug } : kind === 'trip' ? { prefix: 'packages' as OgPrefix, slug } : parseGuideLedgerSlug(slug)
  if (!target) return null
  const og = await resolveOgTarget(target)
  if (!og) return null
  // cleanTitle strips a trailing site name; the shortener then picks a whole phrase.
  const searchTitle = cleanTitle(og.title, SITE_NAME)
  // The quality gate's retries (alt 1 and 2) ask for the same headline cut shorter.
  // A blog post may carry a hook-style cover headline written by the title step (app_settings, validated on read).
  // Any failure falls back to the shortened title exactly as before.
  let stored: string | null = null
  if (kind === 'blog') {
    try {
      const post = await getPublishedPostBySlug(slug)
      stored = post ? await readCoverHeadline(getSupabaseAdmin(), slug, `${post.title} ${post.body ?? ''}`) : null
    } catch {
      stored = null
    }
  }
  const headline = shorterCoverHeadline(coverHeadlineFor(stored, searchTitle, SITE_NAME), alt)
  return headline ? { kind, headline, photoUrl: og.photoUrl, searchTitle } : null
}

const STRIP_TEXT = SITE_NAME.toUpperCase()

function strip(font: boolean, text: string = STRIP_TEXT) {
  return (
    <div style={{ position: 'absolute', left: 0, right: 0, bottom: COVER_SAFE_VERTICAL, display: 'flex', justifyContent: 'center' }}>
      <div style={{ display: 'flex', backgroundColor: 'rgba(0,0,0,0.55)', color: '#ffffff', padding: '10px 26px', borderRadius: 999, fontSize: 28, fontWeight: 800, letterSpacing: 4, fontFamily: font ? 'Inter' : undefined }}>{text}</div>
    </div>
  )
}

function renderPhotoCover(content: CoverContent, photo: string | null, fonts: Font[]) {
  const { lines, fontSize } = fitCoverTitle(content.headline)
  const hasFont = fonts.length > 0
  return new ImageResponse(
    (
      <div style={{ width: COVER_WIDTH, height: COVER_HEIGHT, display: 'flex', position: 'relative', backgroundColor: '#1d4f5c', backgroundImage: `linear-gradient(160deg, #1d6f8a, ${RED})`, fontFamily: hasFont ? 'Inter' : undefined }}>
        {photo && <img src={photo} width={COVER_WIDTH} height={COVER_HEIGHT} style={{ position: 'absolute', top: 0, left: 0, width: COVER_WIDTH, height: COVER_HEIGHT, objectFit: 'cover' }} />}
        {/* Headline block: about 20% from the top, horizontally centred, never wider than 880px. */}
        <div style={{ position: 'absolute', top: Math.round(COVER_HEIGHT * 0.2), left: 0, right: 0, display: 'flex', justifyContent: 'center' }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', maxWidth: COVER_BLOCK_MAX_WIDTH, backgroundColor: RED, padding: `26px ${COVER_BLOCK_PAD_X}px`, color: '#ffffff' }}>
            {lines.map((line, i) => (
              <div key={i} style={{ display: 'flex', fontSize, fontWeight: 800, lineHeight: 1.08, textAlign: 'center', whiteSpace: 'nowrap' }}>{line}</div>
            ))}
          </div>
        </div>
        {strip(hasFont, content.kind === 'recap' ? `${RECAP_STRIP_PREFIX}${STRIP_TEXT}` : STRIP_TEXT)}
      </div>
    ),
    { width: COVER_WIDTH, height: COVER_HEIGHT, ...(hasFont ? { fonts } : {}), headers: { 'Cache-Control': CACHE_CONTROL } },
  )
}

function renderNewsCard(content: CoverContent, fonts: Font[]) {
  const { lines, fontSize } = fitNewsText(content.headline)
  const hasFont = fonts.length > 0
  return new ImageResponse(
    (
      <div style={{ width: COVER_WIDTH, height: COVER_HEIGHT, display: 'flex', position: 'relative', backgroundColor: TEAL, color: '#ffffff', fontFamily: hasFont ? 'Inter' : undefined }}>
        <div style={{ position: 'absolute', top: COVER_SAFE_VERTICAL, left: 0, right: 0, display: 'flex', justifyContent: 'center' }}>
          <div style={{ display: 'flex', backgroundColor: TEAL_TAG, padding: '12px 30px', borderRadius: 999, fontSize: 30, fontWeight: 800, letterSpacing: 5 }}>{`${STRIP_TEXT} TRAVEL NEWS`}</div>
        </div>
        <div style={{ position: 'absolute', top: 200, bottom: 200, left: COVER_SAFE_SIDE, right: COVER_SAFE_SIDE, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
          {lines.map((line, i) => (
            <div key={i} style={{ display: 'flex', fontSize, fontWeight: 800, lineHeight: 1.15, textAlign: 'center', whiteSpace: 'nowrap' }}>{line}</div>
          ))}
        </div>
        {strip(hasFont)}
      </div>
    ),
    { width: COVER_WIDTH, height: COVER_HEIGHT, ...(hasFont ? { fonts } : {}), headers: { 'Cache-Control': CACHE_CONTROL } },
  )
}

export async function GET(request: Request, { params }: { params: { kind: string; slug: string } }) {
  // Any query string names the same picture as the plain path: one CDN copy, a cache-buster cannot force a re-render.
  // The one exception is ?alt=1 or ?alt=2: the visual quality gate (lib/visual-gate.ts) asks for the next photo and a
  // shorter headline when the plain cover failed its checks. Only those two values are accepted.
  const url = new URL(request.url)
  const alt = parseAlt(url.search)
  if (url.search && !alt) return new Response(null, { status: 308, headers: { Location: url.pathname, 'Cache-Control': 'public, s-maxage=86400' } })

  const kind = params.kind
  const slug = params.slug || ''
  if (!isSocialCoverKind(kind) || !isValidCoverSlug(slug)) return new Response('Not found', { status: 404, headers: { 'Cache-Control': SHORT_CACHE_CONTROL } })

  let content: CoverContent | null = null
  try {
    content = await resolveContent(kind, slug, alt)
  } catch (err) {
    console.warn('[social-cover] resolve failed', err instanceof Error ? err.name : 'error')
    return new Response('Unavailable', { status: 503, headers: { 'Cache-Control': 'no-store' } })
  }
  if (!content) return new Response('Not found', { status: 404, headers: { 'Cache-Control': SHORT_CACHE_CONTROL } })
  const resolved: CoverContent = content

  const fonts = await loadFonts()
  // A retry asks for the next-best photo for the title (never the one the plain cover used); with no other photo to
  // be had it keeps the original.
  let photoUrl = resolved.photoUrl
  if (alt && resolved.kind !== 'news' && resolved.searchTitle) {
    const other = await findAlternatePortraitPhoto(resolved.searchTitle, alt, [photoIdOf(resolved.photoUrl) ?? ''].filter(Boolean))
    if (other && isAllowedPhotoUrl(other.url)) photoUrl = other.url
  }
  const photo = resolved.kind === 'news' ? null : await loadPhoto(photoUrl)
  // Read by the quality gate and the variant tags: which design drew this and which photo is behind it.
  const template = resolved.kind === 'news' ? 'news-card' : 'red-block-v1'
  const photoHeader = (drew: boolean) => (drew && photoUrl ? photoIdOf(photoUrl) ?? 'unknown' : 'none')
  // ImageResponse draws lazily: read the body inside the try so a photo Satori cannot decode falls back
  // to the no-photo version instead of becoming a 500.
  const draw = async (withPhoto: string | null, withFonts: Font[]) => {
    const res = resolved.kind === 'news' ? renderNewsCard(resolved, withFonts) : renderPhotoCover(resolved, withPhoto, withFonts)
    const png = await res.arrayBuffer()
    return new Response(png, { headers: { 'Content-Type': 'image/png', 'Cache-Control': CACHE_CONTROL, 'X-Cover-Template': template, 'X-Cover-Photo-Id': photoHeader(withPhoto !== null) } })
  }
  try {
    return await draw(photo, fonts)
  } catch {
    try {
      return await draw(null, fonts)
    } catch {
      try {
        return await draw(null, [])
      } catch {
        return new Response('Unavailable', { status: 503, headers: { 'Cache-Control': 'no-store' } })
      }
    }
  }
}
