import { ImageResponse } from 'next/og'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { getSetting } from '@/lib/app-settings'
import type { CarouselSlide } from '@/lib/carousel'
import { SITE_NAME } from '@/lib/site'

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
// Design: a real travel photo behind every slide with a dark fade for legibility, a brand pill and
// slide counter on top, a big headline (slide 1 is a bold red cover card, the last slide a call to
// action), and a progress strip with a swipe cue. Satori (what ImageResponse renders with) needs a
// TTF/OTF font buffer, not the WOFF2 a browser would get, so Inter is fetched from Google's CSS.
const W = 1080
const H = 1350
const RED = '#d81f26'

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

export async function GET(_request: Request, { params }: { params: { slug: string; n: string } }) {
  const index = Number(params.n) - 1
  const admin = getSupabaseAdmin()
  const raw = await getSetting(admin, `carousel:${params.slug}`)
  const slides = raw ? (JSON.parse(raw) as CarouselSlide[]) : null
  const slide = slides?.[index]
  if (!slide || !slides) return new Response('Slide not found', { status: 404 })

  const total = slides.length
  const isFirst = index === 0
  const isLast = index === total - 1

  // The slide's own photo, else the post's cover image, else a brand gradient.
  let photo = slide.imageUrl ?? null
  if (!photo) {
    const { data } = await admin.from('posts').select('cover_image_url').eq('slug', params.slug).maybeSingle()
    photo = (data?.cover_image_url as string | null) ?? null
  }

  const [regular, bold] = await Promise.all([loadGoogleFont('Inter', 400), loadGoogleFont('Inter', 700)])

  return new ImageResponse(
    (
      <div style={{ width: W, height: H, display: 'flex', position: 'relative', backgroundColor: '#1a1515', backgroundImage: `linear-gradient(160deg, ${RED}, #1a1515)`, fontFamily: 'Inter', color: '#ffffff' }}>
        {photo && <img src={photo} width={W} height={H} style={{ position: 'absolute', top: 0, left: 0, width: W, height: H, objectFit: 'cover' }} />}
        <div style={{ position: 'absolute', top: 0, left: 0, width: W, height: H, display: 'flex', backgroundImage: 'linear-gradient(to bottom, rgba(0,0,0,0.45) 0%, rgba(0,0,0,0.10) 30%, rgba(0,0,0,0.55) 62%, rgba(0,0,0,0.92) 100%)' }} />

        <div style={{ position: 'absolute', top: 60, left: 70, right: 70, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', backgroundColor: RED, padding: '12px 24px', borderRadius: 999, fontSize: 26, fontWeight: 700, letterSpacing: 2, textTransform: 'uppercase' }}>{SITE_NAME}</div>
          <div style={{ display: 'flex', fontSize: 28, fontWeight: 700, backgroundColor: 'rgba(0,0,0,0.45)', padding: '10px 22px', borderRadius: 999 }}>
            {index + 1} / {total}
          </div>
        </div>

        <div style={{ position: 'absolute', left: 70, right: 70, bottom: 190, display: 'flex', flexDirection: 'column', gap: 30 }}>
          {!isFirst && <div style={{ display: 'flex', width: 90, height: 10, borderRadius: 5, backgroundColor: RED }} />}
          {isFirst && <div style={{ display: 'flex', alignSelf: 'flex-start', backgroundColor: RED, padding: '22px 34px', borderRadius: 20, fontSize: 92, fontWeight: 700, lineHeight: 1.08, textTransform: 'uppercase', textShadow: '0 4px 14px rgba(0,0,0,0.5)' }}>{slide.headline}</div>}
          {!isFirst && <div style={{ display: 'flex', fontSize: 78, fontWeight: 700, lineHeight: 1.1, textShadow: '0 4px 16px rgba(0,0,0,0.6)' }}>{slide.headline}</div>}
          <div style={{ display: 'flex', fontSize: 38, fontWeight: 400, lineHeight: 1.35, color: 'rgba(255,255,255,0.94)', textShadow: '0 2px 10px rgba(0,0,0,0.7)' }}>{slide.body}</div>
        </div>

        <div style={{ position: 'absolute', left: 70, right: 70, bottom: 70, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {Array.from({ length: total }, (_, i) => (
              <div key={i} style={{ display: 'flex', width: i === index ? 54 : 16, height: 16, borderRadius: 8, backgroundColor: i === index ? RED : 'rgba(255,255,255,0.55)' }} />
            ))}
          </div>
          <div style={{ display: 'flex', fontSize: 30, fontWeight: 700, backgroundColor: isLast ? RED : 'rgba(255,255,255,0.18)', padding: '14px 28px', borderRadius: 999 }}>
            {isLast ? 'Read the full guide' : 'Swipe  >'}
          </div>
        </div>
      </div>
    ),
    {
      width: W,
      height: H,
      fonts: [
        { name: 'Inter', data: regular, weight: 400, style: 'normal' },
        { name: 'Inter', data: bold, weight: 700, style: 'normal' },
      ],
    },
  )
}
