// Trip Page Kit: the network half of the reference lookup (Wikivoyage, Wikipedia, Pexels). Every fetch goes through an
// injected fetcher so scripts/check-trip-kit.ts can run it with fakes and no network.

import {
  parseWikivoyageExtract,
  parseWikipediaSummary,
  referenceIsRelevant,
  type PlaceMention,
  type Reference,
  type KitPhoto,
} from '@/lib/trip-kit-facts'
import { rankCandidates, queryTokens, type PhotoCandidate } from '@/lib/photo-score'

export type JsonFetcher = (url: string) => Promise<unknown | null>

const UA = 'TravelFunBizBot/1.0 (https://travelfunbiz.ca; trip page reference lookup)'

/** The real JSON fetcher: 8 second limit, null on any failure. Wikimedia asks for a descriptive User-Agent. */
export const liveJson: JsonFetcher = async (url) => {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, cache: 'no-store', signal: AbortSignal.timeout(8000) })
    return res.ok ? await res.json().catch(() => null) : null
  } catch {
    return null
  }
}

const wvUrl = (title: string) => `https://en.wikivoyage.org/w/api.php?action=query&prop=extracts&explaintext=1&redirects=1&format=json&titles=${encodeURIComponent(title)}`
const wvSearch = (q: string) => `https://en.wikivoyage.org/w/api.php?action=query&list=search&srlimit=1&format=json&srsearch=${encodeURIComponent(q)}`
const wpUrl = (title: string) => `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}?redirect=true`
const pageUrl = (title: string) => `https://en.wikivoyage.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`

async function wikivoyage(place: string, title: string, f: JsonFetcher): Promise<Reference | null> {
  const j = (await f(wvUrl(title))) as { query?: { pages?: Record<string, { title?: string; missing?: unknown; extract?: string }> } } | null
  const page = j?.query?.pages ? Object.values(j.query.pages)[0] : null
  if (!page || page.missing !== undefined || !page.extract) return null
  return parseWikivoyageExtract(place, page.title ?? title, page.extract, pageUrl(page.title ?? title))
}

/** Finds a reference page for one place. Tries the exact title, then a search, then Wikipedia. A page that does not mention
 * any word tied to this trip (destination, country, region) is rejected. Null when nothing relevant is found. */
export async function resolveReference(mention: PlaceMention, tokens: string[], f: JsonFetcher): Promise<Reference | null> {
  const ok = (r: Reference | null): Reference | null => (r && referenceIsRelevant(r, [...tokens, ...(mention.region ? [mention.region.toLowerCase()] : [])]) ? r : null)
  const direct = ok(await wikivoyage(mention.name, mention.name, f))
  if (direct) return direct
  const s = (await f(wvSearch(`${mention.name} ${mention.region ?? ''}`.trim()))) as { query?: { search?: { title?: string }[] } } | null
  const hit = s?.query?.search?.[0]?.title
  if (hit) {
    const viaSearch = ok(await wikivoyage(mention.name, hit, f))
    if (viaSearch) return viaSearch
  }
  return ok(parseWikipediaSummary(mention.name, await f(wpUrl(mention.name))))
}

// ─── Photos (Pexels) ────────────────────────────────────────────────────────────────

export interface PlacePhoto extends PhotoCandidate {
  photographer: string
  photographerUrl: string | null
  pageUrl: string | null
}

export type PhotoSearch = (query: string) => Promise<PlacePhoto[]>

/** Pexels search with the photographer kept for the credit. [] when no key or on any failure. */
export const livePhotoSearch: PhotoSearch = async (query) => {
  const key = process.env.PEXELS_API_KEY
  if (!key || !query.trim()) return []
  try {
    const res = await fetch(`https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=15&orientation=landscape`, { headers: { Authorization: key }, cache: 'no-store', signal: AbortSignal.timeout(8000) })
    if (!res.ok) return []
    const body = (await res.json().catch(() => ({}))) as { photos?: { id: number; width?: number; height?: number; alt?: string; url?: string; photographer?: string; photographer_url?: string; src?: { large?: string; large2x?: string } }[] }
    return (body.photos ?? [])
      .filter((p) => p && typeof p.id === 'number')
      .map((p) => ({ id: p.id, url: p.src?.large2x || p.src?.large || '', alt: p.alt || null, width: p.width ?? 0, height: p.height ?? 0, photographer: p.photographer ?? 'Pexels', photographerUrl: p.photographer_url ?? null, pageUrl: p.url ?? null }))
  } catch {
    return []
  }
}

/** The best photo for a place using the existing ranked selector (lib/photo-score.ts): banned subjects out, a photo whose alt
 * mentions the place first, photos already used on this trip skipped. Null when nothing is acceptable. */
export async function pickPlacePhoto(place: string, region: string | null, search: PhotoSearch, usedIds: Set<number>): Promise<{ photo: KitPhoto; raw: PlacePhoto } | null> {
  const cands = await search(`${place} ${region ?? ''}`.trim())
  if (cands.length === 0) return null
  const ranked = rankCandidates(cands, { tokens: queryTokens(place), recentIds: usedIds, minWidth: 1000, minHeight: 600 })
  const best = ranked.ranked.find((r) => !usedIds.has(r.photo.id) && r.relevant) ?? ranked.ranked.find((r) => !usedIds.has(r.photo.id))
  if (!best) return null
  const raw = cands.find((c) => c.id === best.photo.id)
  if (!raw) return null
  usedIds.add(raw.id)
  return { photo: { url: raw.url, alt: place, credit: `Photo by ${raw.photographer} on Pexels`, creditUrl: raw.pageUrl }, raw }
}
