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
          url: first.src?.original || first.src?.large2x || first.src?.large,
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
