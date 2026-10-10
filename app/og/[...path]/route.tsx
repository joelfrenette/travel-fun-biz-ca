import { ImageResponse } from 'next/og'
import { DEFAULT_OG_IMAGE, SITE_NAME } from '@/lib/site'
import { resolveOgPath, fitTitle, isAllowedPhotoUrl, allowedRedirectTarget, exceedsPhotoCap, hostOf, MAX_PHOTO_BYTES, OG_WIDTH, OG_HEIGHT, type OgContent } from '@/lib/og-image'

// Social share image for every public page (growth loop WP6): /og/blog/<slug>, /og/destinations/<slug>,
// /og/hotels/<slug>, /og/packages/<slug>, /og/compare/<pair>, /og/best-time-to-visit/<slug>, and so on.
// One route instead of an opengraph-image file per page family, because one renderer and one cache key
// (the path) serves all eleven families, and a page only has to point its metadata at the path.
//
// 1200x630 PNG via next/og (built into Next.js, no new vendor, no AI). Satori (what ImageResponse draws
// with) needs a TTF/OTF buffer, so Inter is fetched from Google's CSS exactly like the carousel route does;
// if that fetch fails the built-in default font is used. Default (nodejs) runtime on purpose: unlike the
// carousel route this one does not need the edge-only Windows workaround to run on Vercel.
// Cached by headers only: the CDN may keep a 200 for a day, a 404 or fallback redirect for five minutes.
// force-dynamic on purpose: the route is never stored by Next's own page cache, so only the Cache-Control
// headers below decide caching. A 404 for a page that is not published yet can then never be kept for a day.
export const dynamic = 'force-dynamic'

const RED = '#d81f26'
const DARK = '#1a1515'
const PHOTO_TIMEOUT_MS = 5000
const FONT_TIMEOUT_MS = 3000
const FONT_FAILURE_TTL_MS = 5 * 60 * 1000
const CACHE_CONTROL = 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800'
const SHORT_CACHE_CONTROL = 'public, s-maxage=300, stale-while-revalidate=60'

// One fetch per font key, shared by concurrent cold renders; a failure is remembered for 5 minutes (the
// default font is used meanwhile) so a Google outage does not add a 3 second wait to every request.
const fontCache = new Map<string, ArrayBuffer>()
const fontInFlight = new Map<string, Promise<ArrayBuffer>>()
const fontFailedAt = new Map<string, number>()

async function fetchGoogleFont(family: string, weight: number): Promise<ArrayBuffer> {
  const cssRes = await fetch(`https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}:wght@${weight}`, { signal: AbortSignal.timeout(FONT_TIMEOUT_MS) })
  const css = await cssRes.text()
  const match = css.match(/src: url\(([^)]+)\) format\('(?:opentype|truetype)'\)/)
  if (!match) throw new Error(`Could not find a TTF/OTF link for ${family} ${weight} in Google Fonts' CSS`)
  const fontRes = await fetch(match[1], { signal: AbortSignal.timeout(FONT_TIMEOUT_MS) })
  if (!fontRes.ok) throw new Error(`Could not download font file (${fontRes.status})`)
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

function skipped(url: string, reason: string): null {
  console.warn('[og] photo skipped', hostOf(url), reason)
  return null
}

/** The photo as a data URI Satori can draw (JPEG, PNG or GIF), or null on any problem: the brand background is used. */
async function loadPhoto(url: string | null): Promise<string | null> {
  if (!url) return null
  if (!isAllowedPhotoUrl(url)) return skipped(url, 'host not allowed')
  try {
    let src = url
    // Pexels serves originals of several MB; ask for a web-sized copy when the URL carries no options.
    const u = new URL(url)
    if (u.hostname === 'images.pexels.com' && !u.search) src = `${url}?auto=compress&cs=tinysrgb&w=1400`
    const fetchOnce = (target: string) => fetch(target, { signal: AbortSignal.timeout(PHOTO_TIMEOUT_MS), redirect: 'manual' })
    let res = await fetchOnce(src)
    // At most one redirect, and only to another allow-listed host (Supabase and Pexels can redirect to a CDN).
    if (res.status >= 300 && res.status < 400) {
      const next = allowedRedirectTarget(res.headers.get('location'), src)
      await res.body?.cancel().catch(() => {})
      if (!next) return skipped(url, `redirect to a host that is not allowed (${res.status})`)
      res = await fetchOnce(next)
      if (res.status >= 300 && res.status < 400) return skipped(url, 'second redirect')
    }
    if (!res.ok) return skipped(url, `status ${res.status}`)
    const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
    if (type === 'image/webp') return skipped(url, 'webp is not supported')
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

function render(content: OgContent, photo: string | null, fonts: { name: string; data: ArrayBuffer; weight: 400 | 700; style: 'normal' }[]) {
  const { lines, fontSize } = fitTitle(content.title)
  return new ImageResponse(
    (
      <div style={{ width: OG_WIDTH, height: OG_HEIGHT, display: 'flex', position: 'relative', backgroundColor: DARK, backgroundImage: `linear-gradient(135deg, ${RED}, ${DARK})`, fontFamily: fonts.length ? 'Inter' : undefined, color: '#ffffff' }}>
        {photo && <img src={photo} width={OG_WIDTH} height={OG_HEIGHT} style={{ position: 'absolute', top: 0, left: 0, width: OG_WIDTH, height: OG_HEIGHT, objectFit: 'cover' }} />}
        <div style={{ position: 'absolute', top: 0, left: 0, width: OG_WIDTH, height: OG_HEIGHT, display: 'flex', backgroundImage: photo ? 'linear-gradient(to bottom, rgba(0,0,0,0.35) 0%, rgba(0,0,0,0.45) 40%, rgba(0,0,0,0.90) 100%)' : 'linear-gradient(to bottom, rgba(0,0,0,0.0) 0%, rgba(0,0,0,0.35) 100%)' }} />

        <div style={{ position: 'absolute', top: 56, left: 64, right: 64, display: 'flex' }}>
          <div style={{ display: 'flex', backgroundColor: RED, padding: '10px 22px', borderRadius: 999, fontSize: 26, fontWeight: 700, letterSpacing: 3, textTransform: 'uppercase' }}>{content.kindLabel}</div>
        </div>

        <div style={{ position: 'absolute', left: 64, right: 64, bottom: 120, display: 'flex', flexDirection: 'column' }}>
          {lines.map((line, i) => (
            <div key={i} style={{ display: 'flex', fontSize, fontWeight: 700, lineHeight: 1.12, textShadow: '0 3px 14px rgba(0,0,0,0.55)' }}>{line}</div>
          ))}
        </div>

        <div style={{ position: 'absolute', left: 64, right: 64, bottom: 48, display: 'flex', alignItems: 'center', gap: 16 }}>
          <div style={{ display: 'flex', width: 56, height: 8, borderRadius: 4, backgroundColor: RED }} />
          <div style={{ display: 'flex', fontSize: 30, fontWeight: 700, letterSpacing: 1 }}>{SITE_NAME}</div>
        </div>
      </div>
    ),
    {
      width: OG_WIDTH,
      height: OG_HEIGHT,
      ...(fonts.length ? { fonts } : {}),
      headers: { 'Cache-Control': CACHE_CONTROL },
    },
  )
}

export async function GET(request: Request, { params }: { params: { path: string[] } }) {
  // Any query string names the same picture as the plain path: send it there so the CDN keeps one copy
  // (a cache-buster like ?v=123 cannot make the server render again). Relative Location, same host.
  const url = new URL(request.url)
  if (url.search) return new Response(null, { status: 308, headers: { Location: url.pathname, 'Cache-Control': 'public, s-maxage=86400' } })

  const fallback = () => new Response(null, { status: 302, headers: { Location: DEFAULT_OG_IMAGE, 'Cache-Control': SHORT_CACHE_CONTROL } })
  let content: OgContent | null
  try {
    content = await resolveOgPath(params.path)
  } catch (err) {
    console.warn('[og] resolve failed', err instanceof Error ? err.name : 'error')
    return fallback()
  }
  // Unknown prefix, bad slug or an unpublished page: not an image. Short cache so a page published a minute later works.
  if (!content) return new Response('Not found', { status: 404, headers: { 'Cache-Control': SHORT_CACHE_CONTROL } })
  const resolved: OgContent = content

  let fonts: { name: string; data: ArrayBuffer; weight: 400 | 700; style: 'normal' }[] = []
  try {
    const [regular, bold] = await Promise.all([loadGoogleFont('Inter', 400), loadGoogleFont('Inter', 700)])
    fonts = [
      { name: 'Inter', data: regular, weight: 400, style: 'normal' },
      { name: 'Inter', data: bold, weight: 700, style: 'normal' },
    ]
  } catch {
    // Default font still draws a correct image.
  }

  const photo = await loadPhoto(content.photoUrl)
  // ImageResponse draws lazily, so its errors only show up when the body is read. Read it here, inside the
  // try, so a failure (a photo Satori cannot decode, for example) falls back instead of becoming a 500.
  const draw = async (withPhoto: string | null) => {
    const png = await render(resolved, withPhoto, fonts).arrayBuffer()
    return new Response(png, { headers: { 'Content-Type': 'image/png', 'Cache-Control': CACHE_CONTROL } })
  }
  try {
    return await draw(photo)
  } catch {
    try {
      return await draw(null)
    } catch {
      return fallback()
    }
  }
}
