// Real, licensed stock photos for a destination/city/port when a package has no source image of
// its own yet — Pexels' free API, not AI-generated art. A generated photo of a real place can be
// subtly wrong (wrong landmark, wrong layout); a real photo of that place can't be. Dormant until
// PEXELS_API_KEY is set — see .env.example.
const PEXELS_SEARCH_URL = 'https://api.pexels.com/v1/search'
const CACHE_MS = 24 * 60 * 60 * 1000

export interface PexelsPhoto {
  id: number
  url: string
  photographer: string
  photographerUrl: string
  alt: string | null
}

const cache = new Map<string, { photo: PexelsPhoto | null; at: number }>()

export function isPexelsConfigured(): boolean {
  return !!process.env.PEXELS_API_KEY
}

/** One relevant, landscape-oriented real photo for a search term (e.g. a destination or port
 * name), or null when unconfigured, no match, or the request fails — never throws. Cached 24h per
 * query so repeated package creation for the same destination doesn't burn API calls. */
export async function findDestinationPhoto(query: string): Promise<PexelsPhoto | null> {
  const key = process.env.PEXELS_API_KEY
  if (!key || !query.trim()) return null

  const cacheKey = query.trim().toLowerCase()
  const hit = cache.get(cacheKey)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.photo

  try {
    const url = `${PEXELS_SEARCH_URL}?query=${encodeURIComponent(query)}&per_page=1&orientation=landscape`
    const res = await fetch(url, { headers: { Authorization: key }, cache: 'no-store' })
    if (!res.ok) {
      cache.set(cacheKey, { photo: null, at: Date.now() })
      return null
    }
    const body = await res.json().catch(() => ({}))
    const first = body?.photos?.[0]
    const photo: PexelsPhoto | null = first
      ? {
          id: first.id,
          // Found 2026-10-03: this used to prefer `original` (the full, uncompressed camera-
          // resolution file - routinely several MB) over Pexels' own pre-sized web variants.
          // The package-import pipeline resizes afterward (lib/image-pipeline.ts), so it only
          // paid the cost of downloading an oversized source; the blog cover-image pipeline
          // (lib/blog-image.ts) uploads this URL's content verbatim with no resize step at all,
          // so every autoblog post shipped a multi-megabyte hero image straight to visitors.
          // large2x is ~1880px wide - comfortably more than any format spec in this project
          // (the widest is the 1600px banner) - at a fraction of the file size, no quality loss.
          url: first.src?.large2x || first.src?.large || first.src?.original,
          photographer: first.photographer || 'Unknown',
          photographerUrl: first.photographer_url || 'https://www.pexels.com',
          alt: first.alt || null,
        }
      : null
    cache.set(cacheKey, { photo, at: Date.now() })
    return photo
  } catch {
    cache.set(cacheKey, { photo: null, at: Date.now() })
    return null
  }
}

const PEXELS_VIDEO_SEARCH_URL = 'https://api.pexels.com/videos/search'

/** One real stock video clip (portrait, MP4) for a search term, for video b-roll. Prefers an HD
 * file between 720 and 1080 px wide: big enough to look sharp at 720x1280 output, small enough for
 * Shotstack to fetch quickly. Returns null when unconfigured, no match, or the request fails -
 * never throws, so a missing clip just means that beat falls back to a still image. */
export async function findBrollClip(query: string): Promise<{ url: string; duration: number } | null> {
  const key = process.env.PEXELS_API_KEY
  if (!key || !query.trim()) return null
  try {
    const url = `${PEXELS_VIDEO_SEARCH_URL}?query=${encodeURIComponent(query)}&per_page=5&orientation=portrait&size=medium`
    const res = await fetch(url, { headers: { Authorization: key }, cache: 'no-store', signal: AbortSignal.timeout(10_000) })
    if (!res.ok) return null
    const body = (await res.json().catch(() => ({}))) as {
      videos?: Array<{ duration?: number; video_files?: Array<{ link?: string; file_type?: string; width?: number; height?: number }> }>
    }
    for (const v of body.videos ?? []) {
      const files = (v.video_files ?? []).filter((f) => f.link && f.file_type === 'video/mp4' && (f.height ?? 0) > (f.width ?? 0))
      const best = files.filter((f) => (f.width ?? 0) >= 720 && (f.width ?? 0) <= 1080).sort((a, b) => (a.width ?? 0) - (b.width ?? 0))[0] ?? files[0]
      if (best?.link) return { url: best.link, duration: v.duration ?? 0 }
    }
    return null
  } catch {
    return null
  }
}
