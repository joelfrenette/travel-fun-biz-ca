// Real, licensed stock photos for a destination/city/port when a package has no source image of
// its own yet — Pexels' free API, not AI-generated art. A generated photo of a real place can be
// subtly wrong (wrong landmark, wrong layout); a real photo of that place can't be. Dormant until
// PEXELS_API_KEY is set — see .env.example.
//
// Photo choice (Instagram quality work): every search fetches several candidates and lib/photo-score.ts
// picks one. It rejects wrong subjects (laptops, offices, coffee), prefers photos whose description mentions
// the searched place or topic, skips photos used by the last 30 picks (list kept in app_settings), and
// prefers lively, colourful photos (a cheap check on a tiny copy with sharp). Every extra step fails open.
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { getSetting, setSetting } from '@/lib/app-settings'
import { buildBrollQueries, pickBroll, type BrollContext, type BrollVideo } from '@/lib/broll-select'
import {
  DEFAULT_MIN_HEIGHT,
  DEFAULT_MIN_WIDTH,
  parseRecentIds,
  pushRecentId,
  queryTokens,
  rankCandidates,
  type ColourStats,
  type PhotoCandidate,
} from '@/lib/photo-score'

const PEXELS_SEARCH_URL = 'https://api.pexels.com/v1/search'
const CACHE_MS = 24 * 60 * 60 * 1000
const EMPTY_CACHE_MS = 60 * 60 * 1000
const CANDIDATES = 12
const RECENT_PHOTOS_KEY = 'pexels_recent_photo_ids'

export interface PexelsPhoto {
  id: number
  url: string
  photographer: string
  photographerUrl: string
  alt: string | null
}

interface RankedPhoto extends PexelsPhoto {
  /** Pexels' pre-cropped portrait variant, used by findPortraitPhoto. */
  portraitUrl: string | null
}

export function isPexelsConfigured(): boolean {
  return !!process.env.PEXELS_API_KEY
}

// ---- recent photo ids (fail open: any error means "nothing recent") ----

async function loadRecentIds(): Promise<Set<number>> {
  try {
    const raw = await getSetting(getSupabaseAdmin(), RECENT_PHOTOS_KEY)
    return new Set(parseRecentIds(raw))
  } catch {
    return new Set()
  }
}

/** Remember a picked photo so the next 30 picks avoid it. Never throws. */
async function rememberPhotoId(id: number): Promise<void> {
  try {
    const admin = getSupabaseAdmin()
    const list = pushRecentId(parseRecentIds(await getSetting(admin, RECENT_PHOTOS_KEY)), id)
    await setSetting(admin, RECENT_PHOTOS_KEY, JSON.stringify(list))
  } catch {
    // The history is a nicety; a failed write must never block a post.
  }
}

// ---- cheap vividness check ----

/** Mean saturation, mean luminance and luminance spread of a tiny copy of the photo, or null when sharp or the
 * download is unavailable. Deterministic for the same bytes. */
async function measureColour(url: string): Promise<ColourStats | null> {
  try {
    const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(4000) })
    if (!res.ok) return null
    const input = Buffer.from(await res.arrayBuffer())
    const sharp = (await import('sharp')).default
    const { data, info } = await sharp(input).resize(48, 48, { fit: 'inside' }).removeAlpha().raw().toBuffer({ resolveWithObject: true })
    return colourStatsOfRgb(data, info.channels)
  } catch {
    return null
  }
}

/** Colour stats of raw interleaved 8-bit pixels. Pure; exported for the offline check. */
export function colourStatsOfRgb(data: ArrayLike<number>, channels: number): ColourStats | null {
  const n = Math.floor(data.length / channels)
  if (n === 0 || channels < 3) return null
  let sat = 0
  let lumaSum = 0
  let lumaSq = 0
  for (let i = 0; i < n; i++) {
    const r = data[i * channels] / 255
    const g = data[i * channels + 1] / 255
    const b = data[i * channels + 2] / 255
    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    sat += max === 0 ? 0 : (max - min) / max
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b
    lumaSum += l
    lumaSq += l * l
  }
  const meanLuma = lumaSum / n
  return { meanSaturation: sat / n, meanLuma, lumaStd: Math.sqrt(Math.max(0, lumaSq / n - meanLuma * meanLuma)) }
}

// ---- search + rank ----

const cache = new Map<string, { photos: RankedPhoto[]; at: number }>()

interface RawPexelsPhoto {
  id: number
  width?: number
  height?: number
  alt?: string
  photographer?: string
  photographer_url?: string
  src?: { original?: string; large2x?: string; large?: string; portrait?: string; small?: string; tiny?: string }
}

/** Candidates for a query, scored and ordered best first. Empty on any failure. Cached 24h per query + orientation
 * (the ordering, not the pick: the recent-photo filter runs fresh on every call). */
async function searchRanked(query: string, orientation: 'landscape' | 'portrait'): Promise<RankedPhoto[]> {
  const key = process.env.PEXELS_API_KEY
  if (!key || !query.trim()) return []
  const cacheKey = `${orientation}:${query.trim().toLowerCase()}`
  const hit = cache.get(cacheKey)
  // An empty list (every candidate rejected, or a failed call) is remembered for 1 hour, not 24.
  if (hit && Date.now() - hit.at < (hit.photos.length === 0 ? EMPTY_CACHE_MS : CACHE_MS)) return hit.photos

  try {
    const url = `${PEXELS_SEARCH_URL}?query=${encodeURIComponent(query)}&per_page=${CANDIDATES}&orientation=${orientation}`
    const res = await fetch(url, { headers: { Authorization: key }, cache: 'no-store', signal: AbortSignal.timeout(8000) })
    if (!res.ok) {
      cache.set(cacheKey, { photos: [], at: Date.now() })
      return []
    }
    const body = (await res.json().catch(() => ({}))) as { photos?: RawPexelsPhoto[] }
    const raw = (body.photos ?? []).filter((p) => p && typeof p.id === 'number')

    // Colour check on a tiny copy of each candidate, in parallel. Any failure just means "unknown".
    const stats = await Promise.all(raw.map((p) => measureColour(p.src?.tiny || p.src?.small || '')))
    const byId = new Map<number, RawPexelsPhoto>()
    const candidates: PhotoCandidate[] = raw.map((p, i) => {
      byId.set(p.id, p)
      // Found 2026-10-03: this used to prefer `original` (the full, uncompressed camera-
      // resolution file - routinely several MB) over Pexels' own pre-sized web variants.
      // The package-import pipeline resizes afterward (lib/image-pipeline.ts), so it only
      // paid the cost of downloading an oversized source; the blog cover-image pipeline
      // (lib/blog-image.ts) uploads this URL's content verbatim with no resize step at all,
      // so every autoblog post shipped a multi-megabyte hero image straight to visitors.
      // large2x is ~1880px wide - comfortably more than any format spec in this project
      // (the widest is the 1600px banner) - at a fraction of the file size, no quality loss.
      return {
        id: p.id,
        url: p.src?.large2x || p.src?.large || p.src?.original || '',
        alt: p.alt || null,
        width: p.width ?? 0,
        height: p.height ?? 0,
        stats: stats[i],
      }
    })
    // Portrait results are narrower than landscape ones, so the minimum is checked on the short edge there.
    const minWidth = orientation === 'portrait' ? DEFAULT_MIN_HEIGHT * 0.75 : DEFAULT_MIN_WIDTH
    const minHeight = orientation === 'portrait' ? DEFAULT_MIN_WIDTH : DEFAULT_MIN_HEIGHT
    const ranked = rankCandidates(candidates, { tokens: queryTokens(query), recentIds: new Set(), minWidth, minHeight })
    if (ranked.failedOpen) console.warn('[pexels] no photo description mentions', JSON.stringify(query), '- using the best remaining one')
    if (ranked.rejectedCount > 0) console.warn('[pexels] rejected', ranked.rejectedCount, 'of', raw.length, 'photos for', JSON.stringify(query))

    const photos: RankedPhoto[] = ranked.ranked.map((s) => {
      const p = byId.get(s.photo.id) as RawPexelsPhoto
      return {
        id: p.id,
        url: s.photo.url,
        photographer: p.photographer || 'Unknown',
        photographerUrl: p.photographer_url || 'https://www.pexels.com',
        alt: p.alt || null,
        portraitUrl: p.src?.portrait || p.src?.large || null,
      }
    })
    cache.set(cacheKey, { photos, at: Date.now() })
    return photos
  } catch {
    cache.set(cacheKey, { photos: [], at: Date.now() })
    return []
  }
}

/** Re-apply the relevance and recency tiers to a cached ranking: the cache holds the order by relevance and
 * colour, the recent list changes between calls. Photos used recently move behind fresh ones (still usable). */
function pickFresh(photos: RankedPhoto[], recent: Set<number>, skip?: (p: RankedPhoto) => boolean): RankedPhoto | null {
  const usable = skip ? photos.filter((p) => !skip(p)) : photos
  return usable.find((p) => !recent.has(p.id)) ?? usable[0] ?? null
}

/** One relevant, landscape-oriented real photo for a search term (e.g. a destination or port
 * name), or null when unconfigured, no match, or the request fails — never throws. The search is
 * cached 24h per query so repeated package creation for the same destination doesn't burn API
 * calls; the pick itself avoids the last 30 photos used and is recorded. */
export async function findDestinationPhoto(query: string): Promise<PexelsPhoto | null> {
  try {
    const ranked = await searchRanked(query, 'landscape')
    if (ranked.length === 0) return null
    const pick = pickFresh(ranked, await loadRecentIds())
    if (!pick) return null
    await rememberPhotoId(pick.id)
    return { id: pick.id, url: pick.url, photographer: pick.photographer, photographerUrl: pick.photographerUrl, alt: pick.alt }
  } catch {
    return null
  }
}

/** Raw landscape candidates for a query, with their original size and a colour check, for the guide photo loop (lib/guide-photo.ts does
 * the accepting and ranking). Unlike findDestinationPhoto it ranks nothing, writes no history and is not cached. Empty on any failure. */
export async function searchGuidePhotoCandidates(query: string): Promise<PhotoCandidate[]> {
  const key = process.env.PEXELS_API_KEY
  if (!key || !query.trim()) return []
  try {
    const url = `${PEXELS_SEARCH_URL}?query=${encodeURIComponent(query)}&per_page=15&orientation=landscape`
    const res = await fetch(url, { headers: { Authorization: key }, cache: 'no-store', signal: AbortSignal.timeout(8000) })
    if (!res.ok) return []
    const body = (await res.json().catch(() => ({}))) as { photos?: RawPexelsPhoto[] }
    const raw = (body.photos ?? []).filter((p) => p && typeof p.id === 'number')
    const stats = await Promise.all(raw.map((p) => measureColour(p.src?.tiny || p.src?.small || '')))
    return raw.map((p, i) => ({
      id: p.id,
      url: p.src?.large2x || p.src?.large || p.src?.original || '',
      alt: p.alt || null,
      width: p.width ?? 0,
      height: p.height ?? 0,
      stats: stats[i],
    }))
  } catch {
    return []
  }
}

const PEXELS_VIDEO_SEARCH_URL ='https://api.pexels.com/videos/search'

export interface FindBrollOptions {
  /** The beat's own search words, the post's subject and place (lib/broll-select.ts). */
  terms?: string[]
  ctx?: BrollContext
  /** Clips already in this reel, and clips of recent reels: neither is picked. */
  usedIds?: ReadonlySet<string>
  recentIds?: ReadonlySet<string>
  /** A stand-in for fetch so the offline checks never reach Pexels. */
  fetchImpl?: typeof fetch
}

/** One real stock video clip for a search, for video b-roll, or null when unconfigured, nothing relevant, or the request fails -
 * never throws, so a missing clip just means that beat falls back to a still image. Candidates are judged by lib/broll-select.ts
 * (unrelated subjects rejected, reused clips skipped, portrait first, a landscape clip only when a 9:16 centre crop is safe); a
 * portrait search runs first and a landscape one only when it finds nothing usable. Prefers an HD file between 720 and 1080 px
 * wide: sharp at 720x1280, small enough for Shotstack to fetch quickly. */
export async function findBrollClip(query: string, opts: FindBrollOptions = {}): Promise<{ url: string; duration: number; id: string; landscape: boolean } | null> {
  const key = process.env.PEXELS_API_KEY
  if (!key || !query.trim()) return null
  const doFetch = opts.fetchImpl ?? fetch
  const terms = opts.terms ?? [query]
  const ctx = opts.ctx ?? {}
  for (const orientation of ['portrait', 'landscape'] as const) {
    try {
      const url = `${PEXELS_VIDEO_SEARCH_URL}?query=${encodeURIComponent(query)}&per_page=15&orientation=${orientation}&size=medium`
      const res = await doFetch(url, { headers: { Authorization: key }, cache: 'no-store', signal: AbortSignal.timeout(10_000) })
      if (!res.ok) continue
      const body = (await res.json().catch(() => ({}))) as { videos?: BrollVideo[] }
      const pick = pickBroll((body.videos ?? []).filter((v) => v && v.id !== undefined), { terms, ctx, usedIds: opts.usedIds, recentIds: opts.recentIds })
      if (pick) return { url: pick.url, duration: pick.duration, id: pick.id, landscape: pick.landscape }
    } catch {
      // try the other orientation, then give up quietly
    }
  }
  return null
}

const RECENT_VIDEOS_KEY = 'pexels_recent_video_ids'
const RECENT_VIDEOS_KEEP = 60

async function loadRecentVideoIds(): Promise<Set<string>> {
  try {
    const raw = await getSetting(getSupabaseAdmin(), RECENT_VIDEOS_KEY)
    const list = JSON.parse(raw ?? '[]') as unknown
    return new Set(Array.isArray(list) ? list.map(String) : [])
  } catch {
    return new Set()
  }
}

async function rememberVideoIds(ids: string[]): Promise<void> {
  if (ids.length === 0) return
  try {
    const admin = getSupabaseAdmin()
    const raw = await getSetting(admin, RECENT_VIDEOS_KEY)
    const old = (JSON.parse(raw ?? '[]') as unknown[]).map(String)
    await setSetting(admin, RECENT_VIDEOS_KEY, JSON.stringify([...ids, ...old.filter((i) => !ids.includes(i))].slice(0, RECENT_VIDEOS_KEEP)))
  } catch {
    // The history is a nicety; a failed write must never block a reel.
  }
}

/** One clip per beat for a whole reel: the searches name the post's subject type, no clip is used twice in the reel, and clips of
 * the last reels (the last 60 are remembered in app_settings) are skipped. Entries are null where nothing relevant was found.
 * Calls Pexels, so offline checks pass `deps` (fetchImpl, recentIds, remember) and never reach it. Never throws. */
export async function findBrollForBeats(
  beats: Array<{ brollSearchTerms: string[] }>,
  ctx: BrollContext,
  deps: { fetchImpl?: typeof fetch; recentIds?: ReadonlySet<string>; remember?: (ids: string[]) => Promise<void> } = {},
): Promise<Array<{ url: string; duration: number; id: string; landscape: boolean } | null>> {
  const recentIds = deps.recentIds ?? (await loadRecentVideoIds())
  const used = new Set<string>()
  const out: Array<{ url: string; duration: number; id: string; landscape: boolean } | null> = []
  for (const beat of beats) {
    let found: { url: string; duration: number; id: string; landscape: boolean } | null = null
    for (const q of buildBrollQueries(beat.brollSearchTerms, ctx)) {
      found = await findBrollClip(q, { terms: beat.brollSearchTerms, ctx, usedIds: used, recentIds, fetchImpl: deps.fetchImpl })
      if (found) break
    }
    if (found) used.add(found.id)
    out.push(found)
  }
  await (deps.remember ?? rememberVideoIds)([...used])
  return out
}

/** The `n`th next-best portrait photo for a search (n = 1 is the first one after the best), skipping the photo ids in
 * `exclude`. Used when the visual quality gate rejects a cover and asks for another picture. The pick is not
 * recorded in the recent-photo history. Returns null when unconfigured, nothing matches or the request fails. */
export async function findAlternatePortraitPhoto(query: string, n: number, exclude: Iterable<string> = []): Promise<{ id: string; url: string } | null> {
  try {
    const skip = new Set(exclude)
    const ranked = (await searchRanked(query, 'portrait')).filter((p) => p.portraitUrl && !skip.has(String(p.id)))
    const pick = ranked[Math.max(0, n - 1)] ?? ranked[ranked.length - 1]
    return pick?.portraitUrl ? { id: String(pick.id), url: pick.portraitUrl } : null
  } catch {
    return null
  }
}

/** A portrait stock photo for a carousel slide, skipping any address in `used` so seven slides about
 * the same place do not all get the identical picture. Same selector as findDestinationPhoto (wrong
 * subjects rejected, relevant and vivid preferred, recently used photos last), but the pick is NOT
 * recorded: a seven-slide carousel would otherwise push every other post out of the 30-photo history.
 * Returns null when unconfigured, nothing matches or the request fails - the slide then falls back to
 * the post's own cover image. */
export async function findPortraitPhoto(query: string, used: Set<string> = new Set()): Promise<string | null> {
  try {
    const ranked = await searchRanked(query, 'portrait')
    const pick = pickFresh(ranked, await loadRecentIds(), (p) => !p.portraitUrl || used.has(p.portraitUrl))
    return pick?.portraitUrl ?? null
  } catch {
    return null
  }
}
