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

// Real rendered PNG images (next/og's ImageResponse, built into Next.js - no new vendor), not
// screenshots of HTML, sized for Instagram/LinkedIn's carousel aspect ratio (1080x1350, 4:5
// portrait - their own documented recommendation, not invented). Public, no auth: a posting
// provider's servers need to fetch this by URL directly, and the content is already derived from
// an already-published, already-public post - nothing sensitive is exposed here.
//
// Fetches Inter (the project's own body font, app/layout.tsx) explicitly rather than relying on
// ImageResponse's built-in default font, which is a plain geometric sans with no brand identity.
// Satori (what ImageResponse renders with) needs a TTF/OTF buffer, not the WOFF2 a browser would
// get, so this fetches Google's CSS and follows the legacy-format link.
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

export async function GET(request: Request, { params }: { params: { slug: string; n: string } }) {
  const index = Number(params.n) - 1
  const raw = await getSetting(getSupabaseAdmin(), `carousel:${params.slug}`)
  const slides = raw ? (JSON.parse(raw) as CarouselSlide[]) : null
  const slide = slides?.[index]
  if (!slide) return new Response('Slide not found', { status: 404 })

  const isFirst = index === 0
  const total = slides?.length ?? 0

  const [regular, bold] = await Promise.all([loadGoogleFont('Inter', 400), loadGoogleFont('Inter', 700)])

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          backgroundColor: isFirst ? '#d81f26' : '#1a1515',
          color: '#ffffff',
          padding: '80px 70px',
          fontFamily: 'Inter',
        }}
      >
        <div style={{ display: 'flex', fontSize: 28, fontWeight: 700, letterSpacing: 2, opacity: 0.85, textTransform: 'uppercase' }}>
          {SITE_NAME}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          <div style={{ display: 'flex', fontSize: 64, fontWeight: 700, lineHeight: 1.15 }}>{slide.headline}</div>
          <div style={{ display: 'flex', fontSize: 34, lineHeight: 1.4, opacity: 0.92 }}>{slide.body}</div>
        </div>
        <div style={{ display: 'flex', fontSize: 24, opacity: 0.7 }}>
          {index + 1} / {total}
        </div>
      </div>
    ),
    {
      width: 1080,
      height: 1350,
      fonts: [
        { name: 'Inter', data: regular, weight: 400, style: 'normal' },
        { name: 'Inter', data: bold, weight: 700, style: 'normal' },
      ],
    },
  )
}
