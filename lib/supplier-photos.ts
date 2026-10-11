import type { SupabaseClient } from '@supabase/supabase-js'
import type { DbPackage } from '@/lib/packages'
import type { PackageEdit, PackageSourceRow, PhotoCandidate } from '@/lib/package-sources'
import type { PackageImageUrls } from '@/lib/import-package'

// Supplier photos for a trip page (growth loop WP12). Only for a LINK source (never a screenshot, a PDF or pasted
// text): while the page is fetched, the pictures on it are listed as candidates (nothing is downloaded), then up to
// 6 of them are picked automatically (Joel, 2026-10-10), copied into our own storage through
// uploadImagePackageVariants, and appended to the trip's gallery. Every photo added is one logged edit on the
// source (package_edits) that Revert puts back, and the admin can still add more from the list or remove one.
//
// The pure parts (the candidate filter, the edit planning, the "which photos are in" view) come first and have no
// network or database access, so scripts/check-package-completeness.ts can test them. Server-only modules are
// imported lazily inside the functions that need them.

/** The photo rules as data. The check script asserts these values, and the admin copy quotes them. */
export const PHOTO_RULES = {
  /** Candidates stored on the source. */
  maxCandidates: 12,
  /** Photos added automatically per link source. */
  autoPick: 6,
  /** Gallery images on a trip, all sources together. */
  galleryMax: 12,
  /** A tag that declares a width under this is dropped. */
  minWidth: 800,
  /** When a tag declares only a height (no width), under this is dropped (800 wide at 16:9). */
  minHeightWhenNoWidth: 450,
  /** File extensions kept (checked on the path, query ignored). */
  extensions: ['jpg', 'jpeg', 'png', 'webp'],
  /** A path containing any of these words is dropped (logos, icons, tracking pixels ...). */
  blockedNames: ['logo', 'icon', 'sprite', 'avatar', 'badge', 'pixel', 'tracking', 'banner-ad'],
  /** Same registrable domain as the supplier page (its own subdomains and CDN hosts); other hosts are dropped. */
  hostRule: 'same registrable domain as the page',
  /** HEAD request limits before a photo is copied. */
  headTimeoutMs: 8_000,
  maxBytes: 8 * 1024 * 1024,
  /** Smaller files are icons or pixels, not photos. */
  minBytes: 10 * 1024,
} as const

const BLOCKED_NAME = new RegExp(PHOTO_RULES.blockedNames.join('|'), 'i')
const EXTENSION = new RegExp(`\\.(${PHOTO_RULES.extensions.join('|')})$`, 'i')
const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|\[?::1\]?$|172\.(1[6-9]|2\d|3[01])\.)/i

// ─── Hosts ──────────────────────────────────────────────────────────────────────────

const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'gov', 'edu', 'ac'])

/** The registrable domain of a host: www.x.com and cdn.x.com give x.com; shop.x.co.uk gives x.co.uk. A small rule,
 * not the full public suffix list: it only has to keep a supplier's own CDN hosts and refuse unrelated sites. */
export function registrableDomain(host: string): string {
  const h = host.toLowerCase().replace(/\.$/, '')
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h) || h.includes(':')) return h
  const labels = h.split('.')
  if (labels.length <= 2) return h
  const last = labels[labels.length - 1]
  const second = labels[labels.length - 2]
  if (last.length === 2 && SECOND_LEVEL.has(second)) return labels.slice(-3).join('.')
  return labels.slice(-2).join('.')
}

export function sameRegistrableDomain(a: string, b: string): boolean {
  try {
    return registrableDomain(new URL(a).hostname) === registrableDomain(new URL(b).hostname)
  } catch {
    return false
  }
}

// ─── Collecting candidates from a page ──────────────────────────────────────────────

function attrsOf(tag: string): Map<string, string> {
  const out = new Map<string, string>()
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g
  let m: RegExpExecArray | null
  while ((m = re.exec(tag))) {
    const name = m[1].toLowerCase()
    if (!out.has(name)) out.set(name, (m[2] ?? m[3] ?? m[4] ?? '').replace(/&amp;/g, '&').trim())
  }
  return out
}

function pixels(v: string | undefined): number | null {
  if (!v || v.includes('%')) return null
  const n = parseInt(v, 10)
  return Number.isFinite(n) && n > 0 ? n : null
}

/** The largest entry of a srcset ("a.jpg 400w, b.jpg 1200w"): its address and declared width (null for x descriptors). */
export function largestSrcset(srcset: string): { url: string; width: number | null } | null {
  let best: { url: string; width: number | null; score: number } | null = null
  for (const part of srcset.split(/,\s+|,(?=\S+\s+\d)/)) {
    const bits = part.trim().split(/\s+/)
    if (!bits[0]) continue
    const d = bits[1] ?? ''
    const w = /^(\d+)w$/i.exec(d)
    const x = /^(\d+(?:\.\d+)?)x$/i.exec(d)
    const score = w ? Number(w[1]) : x ? Number(x[1]) * 1000 : 1
    if (!best || score > best.score) best = { url: bits[0], width: w ? Number(w[1]) : null, score }
  }
  return best ? { url: best.url, width: best.width } : null
}

interface RawCandidate {
  url: string
  width: number | null
  height: number | null
  origin: PhotoCandidate['origin']
}

/** The key two addresses share when they are the same picture: host and path, no query, no fragment. */
export function dedupeKey(url: string): string {
  try {
    const u = new URL(url)
    return `${u.hostname.toLowerCase()}${u.pathname}`
  } catch {
    return url
  }
}

/**
 * Why a candidate is not kept, or null when it passes every rule in PHOTO_RULES. `pageUrls` are the addresses the
 * page was fetched from (as asked and after redirects): the photo may live on any host that shares a registrable
 * domain with one of them.
 */
export function rejectReason(c: { url: string; width: number | null; height: number | null }, pageUrls: string[]): string | null {
  let u: URL
  try {
    u = new URL(c.url)
  } catch {
    return 'not a web address'
  }
  if (u.protocol !== 'https:') return 'not https'
  if (u.username || u.password) return 'has a login in the address'
  if (PRIVATE_HOST.test(u.hostname)) return 'private address'
  if (!pageUrls.some((p) => sameRegistrableDomain(p, c.url))) return 'different website'
  if (!EXTENSION.test(u.pathname)) return 'not a jpg, png or webp file'
  let path = u.pathname
  try {
    path = decodeURIComponent(path)
  } catch {
    // keep the raw path
  }
  if (BLOCKED_NAME.test(path)) return 'looks like a logo, icon or tracking image'
  if (c.width !== null && c.width < PHOTO_RULES.minWidth) return `narrower than ${PHOTO_RULES.minWidth}px`
  if (c.width === null && c.height !== null && c.height < PHOTO_RULES.minHeightWhenNoWidth) return `shorter than ${PHOTO_RULES.minHeightWhenNoWidth}px`
  return null
}

/** Applies the rules to raw candidates (in order), dedupes by address without the query, and caps the list. */
export function filterCandidates(raw: RawCandidate[], pageUrls: string[]): PhotoCandidate[] {
  const out: PhotoCandidate[] = []
  const seen = new Set<string>()
  for (const c of raw) {
    if (out.length >= PHOTO_RULES.maxCandidates) break
    if (rejectReason(c, pageUrls)) continue
    const key = dedupeKey(c.url)
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ url: c.url, width: c.width, height: c.height, origin: c.origin })
  }
  return out
}

/**
 * Photos on a page: og:image first, then every `<img>` (and `<source>` inside a picture) in page order, using the
 * largest srcset entry when there is one. Relative addresses are resolved against the page. `pageUrl` is where the
 * page was read from after redirects, `askedUrl` the address that was requested (host rules accept either).
 */
export function collectPhotoCandidates(html: string, pageUrl: string, askedUrl?: string): PhotoCandidate[] {
  const raw: RawCandidate[] = []
  const resolve = (value: string): string | null => {
    const v = value.trim()
    if (!v || v.startsWith('data:') || v.startsWith('blob:')) return null
    try {
      const u = new URL(v, pageUrl)
      u.hash = ''
      return u.toString()
    } catch {
      return null
    }
  }

  // og:image (and twitter:image), with the width and height the page declares for it.
  let ogWidth: number | null = null
  let ogHeight: number | null = null
  const ogUrls: string[] = []
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const a = attrsOf(m[0])
    const key = (a.get('property') ?? a.get('name') ?? '').toLowerCase()
    const content = a.get('content') ?? ''
    if (key === 'og:image:width') ogWidth = pixels(content)
    else if (key === 'og:image:height') ogHeight = pixels(content)
    else if (key === 'og:image' || key === 'og:image:url' || key === 'og:image:secure_url' || key === 'twitter:image' || key === 'twitter:image:src') ogUrls.push(content)
  }
  for (const [i, v] of ogUrls.entries()) {
    const url = resolve(v)
    if (url) raw.push({ url, width: i === 0 ? ogWidth : null, height: i === 0 ? ogHeight : null, origin: 'og' })
  }

  for (const m of html.matchAll(/<(img|source)\b[^>]*>/gi)) {
    const a = attrsOf(m[0])
    const srcset = a.get('srcset') ?? a.get('data-srcset') ?? ''
    const width = pixels(a.get('width'))
    const height = pixels(a.get('height'))
    const big = srcset ? largestSrcset(srcset) : null
    if (big) {
      const url = resolve(big.url)
      if (url) raw.push({ url, width: big.width ?? width, height, origin: 'srcset' })
      continue
    }
    if (m[1].toLowerCase() === 'source') continue
    const src = a.get('src') ?? a.get('data-src') ?? a.get('data-lazy-src') ?? a.get('data-original') ?? ''
    const url = resolve(src)
    if (url) raw.push({ url, width, height, origin: 'img' })
  }

  return filterCandidates(raw, [pageUrl, ...(askedUrl ? [askedUrl] : [])])
}

// ─── What a source has added ────────────────────────────────────────────────────────

export interface PhotoView extends PhotoCandidate {
  /** In the trip's gallery right now because of this source. */
  added: boolean
  /** Our stored copy of it, when added. */
  stored: string | null
  /** Also the trip's cover, because of this source. */
  cover: boolean
}

/** The live photo edits of a source, in order: an add puts a photo in, a later remove takes it out. Reverted and
 * pending entries do not count. Pure. */
export function addedPhotos(edits: PackageEdit[]): Map<string, { stored: string; cover: boolean }> {
  const live = new Map<string, { stored: string; cover: boolean }>()
  for (const e of edits ?? []) {
    if (e.reverted || e.pending || !e.photo || e.field !== 'gallery_urls') continue
    if (e.op === 'add' && e.stored) live.set(e.photo, { stored: e.stored, cover: !!e.cover })
    else if (e.op === 'remove') live.delete(e.photo)
  }
  return live
}

/** The candidate list with each photo's state, for the admin thumbnails. */
export function photoViews(candidates: PhotoCandidate[] | null | undefined, edits: PackageEdit[]): PhotoView[] {
  const live = addedPhotos(edits)
  return (candidates ?? []).map((c) => {
    const hit = live.get(c.url)
    return { ...c, added: !!hit, stored: hit?.stored ?? null, cover: !!hit?.cover }
  })
}

// ─── Planning the edits (pure) ──────────────────────────────────────────────────────

const COVER_FIELDS = ['image_url', 'image_url_square', 'image_url_portrait', 'image_url_banner'] as const

type Row = Record<string, unknown>
const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
const hasText = (v: unknown) => typeof v === 'string' && v.trim().length > 0

export interface PlannedAdd {
  photo: string
  stored: PackageImageUrls
}

/**
 * Edits that append photos to the gallery: one `gallery_urls` edit per photo (each edit's before and after are the
 * whole list, so Revert unwinds them newest first), capped at PHOTO_RULES.galleryMax. When the trip has no cover
 * yet, the first photo also becomes the cover: image_url and its square, portrait and banner shapes, and
 * image_source 'upload' (the column only allows upload, pexels or ai_generated; the supplier page is the credit and
 * is kept on each edit). Each of those is its own edit, so a Revert clears the cover only if this source set it.
 */
export function planPhotoAdds(row: Row, adds: PlannedAdd[], opts: { credit: string | null; method: PackageEdit['method']; at: string }): { updates: Row; edits: PackageEdit[]; skipped: { photo: string; reason: string }[] } {
  const edits: PackageEdit[] = []
  const updates: Row = {}
  const skipped: { photo: string; reason: string }[] = []
  const gallery = list(row.gallery_urls)
  let hasCover = hasText(row.image_url)
  for (const a of adds) {
    const url = a.stored.image_url
    if (!url) {
      skipped.push({ photo: a.photo, reason: 'the photo could not be copied into our storage' })
      continue
    }
    if (gallery.length >= PHOTO_RULES.galleryMax) {
      skipped.push({ photo: a.photo, reason: `the gallery is full (${PHOTO_RULES.galleryMax} photos)` })
      continue
    }
    if (gallery.includes(url)) {
      skipped.push({ photo: a.photo, reason: 'already in the gallery' })
      continue
    }
    const before = [...gallery]
    gallery.push(url)
    const makeCover = !hasCover
    edits.push({ field: 'gallery_urls', before, after: [...gallery], method: opts.method, at: opts.at, photo: a.photo, stored: url, credit: opts.credit ?? undefined, op: 'add', ...(makeCover ? { cover: true } : {}) })
    if (makeCover) {
      hasCover = true
      for (const f of COVER_FIELDS) {
        const next = a.stored[f]
        if (!next) continue
        edits.push({ field: f, before: row[f] ?? null, after: next, method: opts.method, at: opts.at, photo: a.photo, credit: opts.credit ?? undefined })
        updates[f] = next
      }
      edits.push({ field: 'image_source', before: row.image_source ?? null, after: 'upload', method: opts.method, at: opts.at, photo: a.photo, credit: opts.credit ?? undefined })
      updates.image_source = 'upload'
    }
  }
  if (edits.some((e) => e.field === 'gallery_urls')) updates.gallery_urls = gallery
  return { updates, edits, skipped }
}

/**
 * Edits that take photos this source added back out of the gallery (one edit each). If a removed photo was also the
 * cover this source set, and the cover is still exactly what that edit wrote, the cover goes back to what it was
 * before; a cover someone changed since is left alone. Only photos this source added can be removed.
 */
export function planPhotoRemoval(row: Row, sourceEdits: PackageEdit[], urls: string[], at: string): { updates: Row; edits: PackageEdit[]; removed: string[]; skipped: { url: string; reason: string }[] } {
  const live = addedPhotos(sourceEdits)
  const byStored = new Map([...live.entries()].map(([photo, v]) => [v.stored, photo]))
  const edits: PackageEdit[] = []
  const updates: Row = {}
  const removed: string[] = []
  const skipped: { url: string; reason: string }[] = []
  let gallery = list(row.gallery_urls)
  const current = (f: string) => (f in updates ? updates[f] : row[f]) ?? null
  for (const url of urls) {
    const photo = live.has(url) ? url : byStored.get(url)
    const hit = photo ? live.get(photo) : undefined
    if (!photo || !hit) {
      skipped.push({ url, reason: 'this source did not add that photo' })
      continue
    }
    if (!gallery.includes(hit.stored)) {
      skipped.push({ url, reason: 'it is not in the gallery any more' })
      continue
    }
    const before = [...gallery]
    gallery = gallery.filter((g) => g !== hit.stored)
    edits.push({ field: 'gallery_urls', before, after: [...gallery], method: 'click', at, photo, stored: hit.stored, op: 'remove' })
    removed.push(photo)
    if (hit.cover && current('image_url') === hit.stored) {
      for (const f of [...COVER_FIELDS, 'image_source'] as const) {
        const wrote = [...sourceEdits].reverse().find((e) => !e.reverted && !e.pending && e.field === f && e.photo === photo && !e.op)
        if (!wrote || JSON.stringify(current(f)) !== JSON.stringify(wrote.after ?? null)) continue
        edits.push({ field: f, before: current(f), after: wrote.before ?? null, method: 'click', at, photo, op: 'remove' })
        updates[f] = wrote.before ?? null
      }
    }
  }
  if (removed.length) updates.gallery_urls = gallery
  return { updates, edits, removed, skipped }
}

// ─── Checking a photo before it is copied ───────────────────────────────────────────

export type Probe = { ok: true; type: string; bytes: number } | { ok: false; reason: string }

/** HEAD the photo (8 second limit): it must answer, be an image (not svg), and state a size between 10 KB and 8 MB.
 * A server that refuses HEAD or does not say how big the file is counts as a failure: the photo is skipped, never
 * pulled blind into memory. */
export async function probeImage(url: string, doFetch: typeof fetch = fetch): Promise<Probe> {
  try {
    const res = await doFetch(url, {
      method: 'HEAD',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(PHOTO_RULES.headTimeoutMs),
    })
    if (!res.ok) return { ok: false, reason: `the supplier site answered ${res.status}` }
    if (res.url) {
      try {
        if (PRIVATE_HOST.test(new URL(res.url).hostname)) return { ok: false, reason: 'redirected to a private address' }
      } catch {
        // an unreadable final address is judged by the checks below
      }
    }
    const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
    if (!type.startsWith('image/') || type.includes('svg')) return { ok: false, reason: `not a photo (${type || 'no type'})` }
    const bytes = Number(res.headers.get('content-length'))
    if (!Number.isFinite(bytes) || bytes <= 0) return { ok: false, reason: 'the supplier site did not say how big the file is' }
    if (bytes > PHOTO_RULES.maxBytes) return { ok: false, reason: 'larger than 8 MB' }
    if (bytes < PHOTO_RULES.minBytes) return { ok: false, reason: 'too small to be a photo' }
    return { ok: true, type, bytes }
  } catch (e) {
    return { ok: false, reason: e instanceof Error && e.name === 'TimeoutError' ? 'the supplier site took too long' : 'the supplier site could not be reached' }
  }
}

// ─── Adding photos (network + database) ─────────────────────────────────────────────

export interface PhotoDeps {
  probe?: (url: string) => Promise<Probe>
  upload?: (url: string, slugBase: string) => Promise<PackageImageUrls>
}

export interface PhotoAddResult {
  added: { photo: string; stored: string; cover: boolean }[]
  skipped: { url: string; reason: string }[]
  pkg: DbPackage | null
  error?: string
}

/**
 * Copies candidate photos from a link source into our storage and appends them to the trip's gallery. Every `urls`
 * entry must be one of the source's stored candidates (never an address from the request), is probed (HEAD, 8
 * seconds, image, under 8 MB), uploaded through uploadImagePackageVariants, and logged as one edit with Revert.
 * `max` stops after that many photos; `budgetMs` stops starting new uploads after that long. Never throws.
 */
export async function addSourcePhotos(
  admin: SupabaseClient,
  packageId: string,
  source: Pick<PackageSourceRow, 'id' | 'kind' | 'source_url' | 'package_edits' | 'photo_candidates'>,
  urls: string[],
  opts: { max: number; method: PackageEdit['method']; budgetMs?: number; deps?: PhotoDeps },
): Promise<PhotoAddResult> {
  const skipped: { url: string; reason: string }[] = []
  try {
    if (source.kind !== 'url') return { added: [], skipped: urls.map((url) => ({ url, reason: 'only a link source has photos' })), pkg: null }
    const known = new Set((source.photo_candidates ?? []).map((c) => c.url))
    const have = addedPhotos(source.package_edits)
    const wanted: string[] = []
    for (const url of [...new Set(urls)]) {
      if (!known.has(url)) skipped.push({ url, reason: 'not one of the photos found on that page' })
      else if (have.has(url)) skipped.push({ url, reason: 'already added' })
      else wanted.push(url)
    }
    if (wanted.length === 0) return { added: [], skipped, pkg: null }

    const { getPackageById } = await import('@/lib/packages')
    const start = await getPackageById(packageId)
    if (!start) return { added: [], skipped, pkg: null, error: 'The trip page could not be read.' }
    const room = PHOTO_RULES.galleryMax - list(start.gallery_urls).length
    if (room <= 0) return { added: [], skipped: [...skipped, ...wanted.map((url) => ({ url, reason: `the gallery is full (${PHOTO_RULES.galleryMax} photos)` }))], pkg: start }

    const probe = opts.deps?.probe ?? ((u: string) => probeImage(u))
    const checks = await Promise.all(wanted.map(async (url) => ({ url, probe: await probe(url) })))
    const passing: string[] = []
    for (const c of checks) {
      if (c.probe.ok) passing.push(c.url)
      else skipped.push({ url: c.url, reason: c.probe.reason })
    }

    const upload = opts.deps?.upload ?? (async (u: string, slug: string) => (await import('@/lib/import-package')).uploadImagePackageVariants(u, slug))
    const started = Date.now()
    const budget = opts.budgetMs ?? 60_000
    const limit = Math.min(opts.max, room)
    const done: PlannedAdd[] = []
    for (const url of passing) {
      if (done.length >= limit) {
        skipped.push({ url, reason: 'not needed (limit reached)' })
        continue
      }
      if (Date.now() - started > budget) {
        skipped.push({ url, reason: 'ran out of time; use Add more to try it again' })
        continue
      }
      const stored = await upload(url, `${start.slug || 'trip'}-photo`).catch(() => null)
      if (!stored || !stored.image_url) skipped.push({ url, reason: 'the photo could not be copied into our storage' })
      else done.push({ photo: url, stored })
    }
    if (done.length === 0) return { added: [], skipped, pkg: start }

    // Plan against a fresh read, so the before and after lists match the trip as it is at the moment of the write.
    const latest = (await getPackageById(packageId)) ?? start
    const plan = planPhotoAdds(latest as unknown as Row, done, { credit: source.source_url, method: opts.method, at: new Date().toISOString() })
    for (const s of plan.skipped) skipped.push({ url: s.photo, reason: s.reason })
    if (plan.edits.length === 0) return { added: [], skipped, pkg: latest }
    const { commitEdits } = await import('@/lib/package-enrich')
    const r = await commitEdits(admin, packageId, source.id, plan.updates, plan.edits, [], latest)
    if (r.applied.length === 0) {
      for (const d of done) skipped.push({ url: d.photo, reason: r.skipped[0]?.reason ?? 'the change was not made' })
      return { added: [], skipped, pkg: latest }
    }
    const added = plan.edits.filter((e) => e.field === 'gallery_urls').map((e) => ({ photo: e.photo as string, stored: e.stored as string, cover: !!e.cover }))
    return { added, skipped, pkg: r.pkg }
  } catch (e) {
    console.error('[supplier-photos] add failed', e)
    return { added: [], skipped, pkg: null, error: e instanceof Error ? e.message : 'Adding the photos failed' }
  }
}

/** The automatic pick after a link source is read: the first PHOTO_RULES.autoPick candidates that pass the HEAD
 * check, in page order (a candidate that fails does not use up one of the six). */
export function autoPickPhotos(
  admin: SupabaseClient,
  packageId: string,
  source: Pick<PackageSourceRow, 'id' | 'kind' | 'source_url' | 'package_edits' | 'photo_candidates'>,
  opts: { budgetMs?: number; deps?: PhotoDeps } = {},
): Promise<PhotoAddResult> {
  return addSourcePhotos(admin, packageId, source, (source.photo_candidates ?? []).map((c) => c.url), { max: PHOTO_RULES.autoPick, method: 'auto', ...opts })
}

/** Removes photos this source added from the gallery (logged, Revert-able). Never throws. */
export async function removeSourcePhotos(
  admin: SupabaseClient,
  packageId: string,
  source: Pick<PackageSourceRow, 'id' | 'package_edits'>,
  urls: string[],
): Promise<{ removed: string[]; skipped: { url: string; reason: string }[]; pkg: DbPackage | null; error?: string }> {
  try {
    const { getPackageById } = await import('@/lib/packages')
    const latest = await getPackageById(packageId)
    if (!latest) return { removed: [], skipped: urls.map((url) => ({ url, reason: 'The trip page could not be read.' })), pkg: null, error: 'The trip page could not be read.' }
    const plan = planPhotoRemoval(latest as unknown as Row, source.package_edits, urls, new Date().toISOString())
    if (plan.edits.length === 0) return { removed: [], skipped: plan.skipped, pkg: latest }
    const { commitEdits } = await import('@/lib/package-enrich')
    const r = await commitEdits(admin, packageId, source.id, plan.updates, plan.edits, [], latest)
    if (r.applied.length === 0) return { removed: [], skipped: [...plan.skipped, ...plan.removed.map((url) => ({ url, reason: r.skipped[0]?.reason ?? 'the change was not made' }))], pkg: latest }
    return { removed: plan.removed, skipped: plan.skipped, pkg: r.pkg }
  } catch (e) {
    console.error('[supplier-photos] remove failed', e)
    return { removed: [], skipped: [], pkg: null, error: e instanceof Error ? e.message : 'Removing the photos failed' }
  }
}
