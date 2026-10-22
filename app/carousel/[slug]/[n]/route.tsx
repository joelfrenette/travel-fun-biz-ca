import { ImageResponse } from 'next/og'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { getSetting } from '@/lib/app-settings'
import { resolveSlideType, type CarouselSlide } from '@/lib/carousel-slide'
import { SITE_URL } from '@/lib/site'
import { isAllowedPhotoUrl, allowedRedirectTarget, exceedsPhotoCap, hostOf, MAX_PHOTO_BYTES } from '@/lib/og-path'
import {
  COVER_W,
  COVER_H,
  COVER_LINE_HEIGHT,
  COVER_MAX_BLOCK_WIDTH,
  COVER_PAD_X,
  COVER_PAD_Y,
  FACT_LINE_HEIGHT,
  brandDomain,
  fitCoverHeadline,
  fitFactClaim,
  fitPanelBody,
  fitPanelHeadline,
} from '@/lib/cover-fit'

// Edge, not nodejs: confirmed real bug, not a style choice. Next 14.2.35's compiled
// @vercel/og/index.node.js has a MODULE-LEVEL statement (`fs.readFileSync(fileURLToPath(join(
// import.meta.url, "../noto-sans-...ttf")))`) that runs unconditionally on import, before any of
// our code executes - `path.join` mixed with a `file://` URL produces a backslash-mangled path on
// Windows ('.\\file:\\C:\\...'), so EVERY request 500s with `TypeError: Invalid URL`, regardless of
// whether we pass custom fonts. Verified by reading the compiled file directly. The edge bundle
// (index.edge.js) does the equivalent default-font load via `fetch(new URL(...))` instead, which
// has no such bug on any OS - confirmed by reading that file too. This is a targeted fix for that
// one bug, not a general edge preference; the route is a stateless image render over a plain
// fetch-based Supabase client, which edge runtime handles fine.
export const runtime = 'edge'

// Real rendered PNG slides (next/og's ImageResponse, built into Next.js - no new vendor), sized for
// Instagram/LinkedIn's 4:5 carousel (1080x1350). Public, no auth: a posting provider's servers fetch
// this by URL, and the content is already derived from a published, public post.
//
// Three looks (owner's Instagram brief):
//  - cover (slide 1): vivid full-bleed photo, ONE bold all-caps headline in a solid red block centred
//    in the upper middle, small brand strip at the bottom. No body text, counter or swipe pill.
//  - fact card (type "fact"): solid teal, small brand tag on top, ONE large centred claim.
//  - photo slide (everything else): photo with the text on a solid panel, body at 48px or more.
// Every element stays 100px from the sides and 90px from the top and bottom. A bad photo or font can
// never 500: the photo is checked and fetched here, and any render failure retries without it.
// Satori (what ImageResponse renders with) needs a TTF/OTF font buffer, not the WOFF2 a browser would
// get, so Inter is fetched from Google's CSS.
const W = COVER_W
const H = COVER_H
const RED = '#d81f26'
const TEAL = '#0f6b63'
const TEAL_DARK = '#0a3f3b'
const PANEL = '#0c2523'
const SIDE = 100
// Satori ignores left+right on an absolute box (the width collapses), so every one gets an explicit width.
const INNER = W - SIDE * 2
const EDGE = 90
const PHOTO_TIMEOUT_MS = 5000
const FONT_TIMEOUT_MS = 3000

type FontSpec = { name: string; data: ArrayBuffer; weight: 400 | 700 | 800; style: 'normal' }

const fontCache = new Map<string, ArrayBuffer>()
async function loadGoogleFont(family: string, weight: number): Promise<ArrayBuffer> {
  const cacheKey = `${family}:${weight}`
  const cached = fontCache.get(cacheKey)
  if (cached) return cached
  const cssRes = await fetch(`https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}:wght@${weight}`, { signal: AbortSignal.timeout(FONT_TIMEOUT_MS) })
  const css = await cssRes.text()
  const match = css.match(/src: url\(([^)]+)\) format\('(?:opentype|truetype)'\)/)
  if (!match) throw new Error(`Could not find a TTF/OTF link for ${family} ${weight} in Google Fonts' CSS`)
  const fontRes = await fetch(match[1], { signal: AbortSignal.timeout(FONT_TIMEOUT_MS) })
  if (!fontRes.ok) throw new Error(`Could not download font file (${fontRes.status})`)
  const buf = await fontRes.arrayBuffer()
  fontCache.set(cacheKey, buf)
  return buf
}

/** Inter 800 for headlines (700 stands in if 800 cannot be fetched) and 700 for body text. No fonts at all is allowed: the default font is used. */
async function loadFonts(): Promise<FontSpec[]> {
  const [extra, bold] = await Promise.allSettled([loadGoogleFont('Inter', 800), loadGoogleFont('Inter', 700)])
  const b = bold.status === 'fulfilled' ? bold.value : null
  const x = extra.status === 'fulfilled' ? extra.value : b
  const fonts: FontSpec[] = []
  if (b) fonts.push({ name: 'Inter', data: b, weight: 700, style: 'normal' })
  if (x) fonts.push({ name: 'Inter', data: x, weight: 800, style: 'normal' })
  return fonts
}

function skipped(url: string, reason: string): null {
  console.warn('[carousel] photo skipped', hostOf(url), reason)
  return null
}

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

/** The photo as a data URI Satori can draw (JPEG, PNG or GIF), or null on any problem: the gradient is used instead. */
async function loadPhoto(url: string | null): Promise<string | null> {
  if (!url) return null
  if (!isAllowedPhotoUrl(url)) return skipped(url, 'host not allowed')
  try {
    let src = url
    // Pexels serves originals of several MB; ask for a web-sized copy when the URL carries no options.
    const u = new URL(url)
    if (u.hostname === 'images.pexels.com' && !u.search) src = `${url}?auto=compress&cs=tinysrgb&w=1600`
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
    if (type === 'image/webp') return skipped(url, 'webp is not supported')
    if (type !== 'image/jpeg' && type !== 'image/png' && type !== 'image/gif') return skipped(url, `content type ${type || 'missing'}`)
    if (exceedsPhotoCap(res.headers.get('content-length'))) return skipped(url, 'too large (content-length)')
    const buf = await res.arrayBuffer()
    if (buf.byteLength === 0) return skipped(url, 'empty body')
    if (buf.byteLength > MAX_PHOTO_BYTES) return skipped(url, 'too large')
    return `data:${type};base64,${toBase64(buf)}`
  } catch (err) {
    return skipped(url, err instanceof Error ? err.name : 'fetch failed')
  }
}

interface Ctx {
  slide: CarouselSlide
  index: number
  total: number
  photo: string | null
  hasFonts: boolean
}

const fill = { position: 'absolute', top: 0, left: 0, width: W, height: H } as const

function Dots({ index, total }: { index: number; total: number }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      {Array.from({ length: total }, (_, i) => (
        <div key={i} style={{ display: 'flex', width: i === index ? 54 : 16, height: 16, borderRadius: 8, backgroundColor: i === index ? RED : 'rgba(255,255,255,0.6)' }} />
      ))}
    </div>
  )
}

function BottomRow({ index, total }: { index: number; total: number }) {
  const isLast = index === total - 1
  return (
    <div style={{ position: 'absolute', left: SIDE, width: INNER, bottom: EDGE, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <Dots index={index} total={total} />
      <div style={{ display: 'flex', fontSize: 30, fontWeight: 700, backgroundColor: isLast ? RED : 'rgba(0,0,0,0.55)', color: '#ffffff', padding: '14px 28px', borderRadius: 999 }}>{isLast ? 'Read the full guide' : 'Swipe  >'}</div>
    </div>
  )
}

function Cover({ slide, photo }: Ctx) {
  const fit = fitCoverHeadline(slide.headline)
  return (
    <>
      {photo && <img src={photo} width={W} height={H} style={{ ...fill, objectFit: 'cover' }} />}
      {/* Light overlay only: the photo stays vivid. The bottom-only fade gives the brand strip a base. */}
      <div style={{ ...fill, display: 'flex', backgroundColor: 'rgba(0,0,0,0.12)' }} />
      <div style={{ position: 'absolute', left: 0, bottom: 0, width: W, height: Math.round(H * 0.18), display: 'flex', backgroundImage: 'linear-gradient(to bottom, rgba(0,0,0,0) 0%, rgba(0,0,0,0.55) 100%)' }} />
      <div style={{ position: 'absolute', top: Math.round(H * 0.2), left: SIDE, width: INNER, display: 'flex', justifyContent: 'center' }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', maxWidth: COVER_MAX_BLOCK_WIDTH, backgroundColor: RED, padding: `${COVER_PAD_Y}px ${COVER_PAD_X}px`, color: '#ffffff' }}>
          {fit.lines.map((line, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'center', fontSize: fit.fontSize, fontWeight: 800, lineHeight: COVER_LINE_HEIGHT, textTransform: 'uppercase', textAlign: 'center' }}>{line}</div>
          ))}
        </div>
      </div>
      <div style={{ position: 'absolute', left: SIDE, width: INNER, bottom: EDGE, display: 'flex', justifyContent: 'center', color: '#ffffff', fontSize: 28, fontWeight: 800, letterSpacing: 4, textShadow: '0 2px 10px rgba(0,0,0,0.6)' }}>{brandDomain(SITE_URL)}</div>
    </>
  )
}

function FactCard({ slide, index, total }: Ctx) {
  const fit = fitFactClaim(slide.headline)
  return (
    <>
      <div style={{ ...fill, display: 'flex', backgroundColor: TEAL, backgroundImage: `linear-gradient(180deg, ${TEAL} 0%, ${TEAL_DARK} 100%)` }} />
      <div style={{ position: 'absolute', top: EDGE, left: SIDE, width: INNER, display: 'flex', justifyContent: 'center', fontSize: 26, fontWeight: 800, letterSpacing: 4, color: 'rgba(255,255,255,0.92)' }}>{brandDomain(SITE_URL)}</div>
      <div style={{ position: 'absolute', top: 200, height: H - 400, left: SIDE, width: INNER, display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', color: '#ffffff' }}>
        {fit.lines.map((line, i) => (
          <div key={i} style={{ display: 'flex', justifyContent: 'center', fontSize: fit.fontSize, fontWeight: 800, lineHeight: FACT_LINE_HEIGHT, textAlign: 'center' }}>{line}</div>
        ))}
      </div>
      <div style={{ position: 'absolute', left: SIDE, width: INNER, bottom: EDGE, display: 'flex', justifyContent: 'center' }}>
        <Dots index={index} total={total} />
      </div>
    </>
  )
}

function PhotoSlide({ slide, index, total, photo }: Ctx) {
  const head = fitPanelHeadline(slide.headline)
  const body = fitPanelBody(slide.body)
  return (
    <>
      {photo ? <img src={photo} width={W} height={H} style={{ ...fill, objectFit: 'cover' }} /> : <div style={{ ...fill, display: 'flex', backgroundImage: `linear-gradient(160deg, ${TEAL}, ${TEAL_DARK})` }} />}
      <div style={{ ...fill, display: 'flex', backgroundColor: 'rgba(0,0,0,0.12)' }} />
      <div style={{ position: 'absolute', top: EDGE, left: SIDE, width: INNER, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', backgroundColor: RED, padding: '10px 22px', borderRadius: 999, fontSize: 24, fontWeight: 800, letterSpacing: 4, color: '#ffffff' }}>{brandDomain(SITE_URL)}</div>
        <div style={{ display: 'flex', fontSize: 28, fontWeight: 700, color: '#ffffff', backgroundColor: 'rgba(0,0,0,0.55)', padding: '10px 22px', borderRadius: 999 }}>
          {index + 1} / {total}
        </div>
      </div>
      {/* The words sit on a solid panel, never straight on the photo. */}
      <div style={{ position: 'absolute', left: SIDE, width: INNER, bottom: EDGE + 110, display: 'flex', flexDirection: 'column', backgroundColor: PANEL, padding: 40, borderRadius: 24, color: '#ffffff' }}>
        <div style={{ display: 'flex', width: 90, height: 10, borderRadius: 5, backgroundColor: RED, marginBottom: 24 }} />
        {head.lines.map((line, i) => (
          <div key={i} style={{ display: 'flex', fontSize: head.fontSize, fontWeight: 800, lineHeight: 1.1 }}>{line}</div>
        ))}
        <div style={{ display: 'flex', flexDirection: 'column', marginTop: 24 }}>
          {body.lines.map((line, i) => (
            <div key={i} style={{ display: 'flex', fontSize: body.fontSize, fontWeight: 700, lineHeight: 1.3, color: 'rgba(255,255,255,0.95)' }}>{line}</div>
          ))}
        </div>
      </div>
      <BottomRow index={index} total={total} />
    </>
  )
}

function Slide(ctx: Ctx) {
  const kind = resolveSlideType(ctx.slide, ctx.index)
  return (
    <div style={{ width: W, height: H, display: 'flex', position: 'relative', backgroundColor: TEAL_DARK, backgroundImage: `linear-gradient(160deg, ${TEAL}, ${TEAL_DARK})`, fontFamily: ctx.hasFonts ? 'Inter' : undefined, color: '#ffffff' }}>
      {kind === 'cover' ? <Cover {...ctx} /> : kind === 'fact' ? <FactCard {...ctx} /> : <PhotoSlide {...ctx} />}
    </div>
  )
}

/** Renders to PNG bytes. ImageResponse draws lazily, so the bytes are read here to catch a failure inside the try. */
async function renderPng(ctx: Ctx, fonts: FontSpec[]): Promise<ArrayBuffer> {
  const res = new ImageResponse(<Slide {...ctx} hasFonts={fonts.length > 0} />, { width: W, height: H, ...(fonts.length ? { fonts } : {}) })
  return res.arrayBuffer()
}

export async function GET(_request: Request, { params }: { params: { slug: string; n: string } }) {
  const index = Number(params.n) - 1
  if (!Number.isInteger(index) || index < 0) return new Response('Slide not found', { status: 404 })
  const admin = getSupabaseAdmin()
  let slides: CarouselSlide[] | null = null
  try {
    const raw = await getSetting(admin, `carousel:${params.slug}`)
    const parsed = raw ? JSON.parse(raw) : null
    slides = Array.isArray(parsed) ? (parsed as CarouselSlide[]) : null
  } catch {
    slides = null
  }
  const slide = slides?.[index]
  if (!slide || !slides || typeof slide.headline !== 'string') return new Response('Slide not found', { status: 404 })

  // The slide's own photo, else the post's cover image, else the teal gradient. A fact card needs no photo.
  const needsPhoto = resolveSlideType(slide, index) !== 'fact'
  let photoUrl = needsPhoto ? (slide.imageUrl ?? null) : null
  if (needsPhoto && !photoUrl) {
    try {
      const { data } = await admin.from('posts').select('cover_image_url').eq('slug', params.slug).maybeSingle()
      photoUrl = (data?.cover_image_url as string | null) ?? null
    } catch {
      photoUrl = null
    }
  }

  const [photo, fonts] = await Promise.all([loadPhoto(photoUrl), loadFonts()])
  const base = { slide: { ...slide, body: typeof slide.body === 'string' ? slide.body : '' }, index, total: slides.length }
  const attempts: Array<{ photo: string | null; fonts: FontSpec[] }> = [
    { photo, fonts },
    { photo: null, fonts },
    { photo: null, fonts: [] },
  ]
  for (const a of attempts) {
    try {
      const png = await renderPng({ ...base, photo: a.photo, hasFonts: a.fonts.length > 0 }, a.fonts)
      return new Response(png, { headers: { 'Content-Type': 'image/png' } })
    } catch (err) {
      console.warn('[carousel] render failed, retrying simpler', params.slug, index + 1, err instanceof Error ? err.message : 'unknown')
    }
  }
  return new Response('Could not render slide', { status: 500 })
}
