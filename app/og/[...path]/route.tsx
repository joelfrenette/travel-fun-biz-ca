import { ImageResponse } from 'next/og'
import { DEFAULT_OG_IMAGE, SITE_NAME } from '@/lib/site'
import { resolveOgPath, fitTitle, isAllowedPhotoUrl, OG_WIDTH, OG_HEIGHT, type OgContent } from '@/lib/og-image'

// Social share image for every public page (growth loop WP6): /og/blog/<slug>, /og/destinations/<slug>,
// /og/hotels/<slug>, /og/packages/<slug>, /og/compare/<pair>, /og/best-time-to-visit/<slug>, and so on.
// One route instead of an opengraph-image file per page family, because one renderer and one cache key
// (the path) serves all eleven families, and a page only has to point its metadata at the path.
//
// 1200x630 PNG via next/og (built into Next.js, no new vendor, no AI). Satori (what ImageResponse draws
// with) needs a TTF/OTF buffer, so Inter is fetched from Google's CSS exactly like the carousel route does;
// if that fetch fails the built-in default font is used. Default (nodejs) runtime on purpose: unlike the
// carousel route this one does not need the edge-only Windows workaround to run on Vercel.
// Cached: the page is regenerated at most daily, and the CDN may keep a copy for a day.
export const revalidate = 86400

const RED = '#d81f26'
const DARK = '#1a1515'
const MAX_PHOTO_BYTES = 6 * 1024 * 1024
const PHOTO_TIMEOUT_MS = 5000
const CACHE_CONTROL = 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800'

const fontCache = new Map<string, ArrayBuffer>()
async function loadGoogleFont(family: string, weight: number): Promise<ArrayBuffer> {
  const cacheKey = `${family}:${weight}`
  const cached = fontCache.get(cacheKey)
  if (cached) return cached
  const cssRes = await fetch(`https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}:wght@${weight}`)
  const css = await cssRes.text()
  const match = css.match(/src: url\(([^)]+)\) format\('(?:opentype|truetype)'\)/)
  if (!match) throw new Error(`Could not find a TTF/OTF link for ${family} ${weight} in Google Fonts' CSS`)
  const fontRes = await fetch(match[1])
  if (!fontRes.ok) throw new Error(`Could not download font file (${fontRes.status})`)
  const buf = await fontRes.arrayBuffer()
  fontCache.set(cacheKey, buf)
  return buf
}

/** The photo as a data URI Satori can draw (JPEG, PNG or GIF), or null on any problem: the brand background is used. */
async function loadPhoto(url: string | null): Promise<string | null> {
  if (!url || !isAllowedPhotoUrl(url)) return null
  try {
    let src = url
    // Pexels serves originals of several MB; ask for a web-sized copy when the URL carries no options.
    const u = new URL(url)
    if (u.hostname === 'images.pexels.com' && !u.search) src = `${url}?auto=compress&cs=tinysrgb&w=1400`
    const res = await fetch(src, { signal: AbortSignal.timeout(PHOTO_TIMEOUT_MS), redirect: 'error' })
    if (!res.ok) return null
    const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
    if (type !== 'image/jpeg' && type !== 'image/png' && type !== 'image/gif') return null
    const buf = await res.arrayBuffer()
    if (buf.byteLength === 0 || buf.byteLength > MAX_PHOTO_BYTES) return null
    return `data:${type};base64,${Buffer.from(buf).toString('base64')}`
  } catch {
    return null
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

export async function GET(_request: Request, { params }: { params: { path: string[] } }) {
  const content = await resolveOgPath(params.path)
  // Unknown prefix, bad slug or an unpublished page: not an image. Short cache so a page published a minute later works.
  if (!content) return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'public, max-age=300' } })

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
    const png = await render(content, withPhoto, fonts).arrayBuffer()
    return new Response(png, { headers: { 'Content-Type': 'image/png', 'Cache-Control': CACHE_CONTROL } })
  }
  try {
    return await draw(photo)
  } catch {
    try {
      return await draw(null)
    } catch {
      return Response.redirect(DEFAULT_OG_IMAGE, 302)
    }
  }
}
