import { createPackage, type DbPackage } from '@/lib/packages'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { generateSlug } from '@/lib/utils'
import { generateImageVariants } from '@/lib/image-pipeline'

const REQUIRED_FIELDS = ['name', 'destination', 'duration', 'price_display'] as const

export type ImportError = { status: number; message: string }
export type ImportResult = { pkg: DbPackage; error: null } | { pkg: null; error: ImportError }

/** Fetches an external image and uploads one JPEG to the package-images bucket, returning its
 * public URL — the original behavior, kept for callers that just want one file stored. */
async function fetchAndUploadOne(buffer: Buffer, contentType: string, filename: string): Promise<string | null> {
  const storage = getSupabaseAdmin().storage.from('package-images')
  const { error } = await storage.upload(filename, buffer, { contentType, upsert: true })
  if (error) {
    console.error('[import] image upload failed:', error.message)
    return null
  }
  return storage.getPublicUrl(filename).data.publicUrl || null
}

async function fetchExternalImage(externalUrl: string): Promise<Buffer | null> {
  try {
    const res = await fetch(externalUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        Referer: new URL(externalUrl).origin + '/',
      },
      redirect: 'follow',
    })
    if (!res.ok) return null
    const contentType = res.headers.get('content-type') || ''
    if (!contentType.startsWith('image/') && !contentType.includes('octet-stream')) return null
    const buffer = Buffer.from(await res.arrayBuffer())
    if (buffer.length < 1000) return null // tracking pixel or error page, not a photo
    return buffer
  } catch (err) {
    console.error('[import] image fetch error:', err instanceof Error ? err.message : err)
    return null
  }
}

export interface PackageImageUrls {
  image_url: string | null
  image_url_square: string | null
  image_url_portrait: string | null
  image_url_banner: string | null
}

const EMPTY_IMAGE_URLS: PackageImageUrls = { image_url: null, image_url_square: null, image_url_portrait: null, image_url_banner: null }

/** Generates every format the site and social media need (image-formats.ts) from one photo
 * already in hand, uploads each, and returns their URLs. Shared by both
 * uploadImagePackageVariants (fetches the source from a URL first) and
 * uploadGeneratedImageVariants (the source is already an in-memory buffer, e.g. AI-generated).
 * Falls back to storing just the raw source as image_url if sharp processing fails for any reason
 * (a bad/corrupt source image must never block importing or generating a package's image). */
async function processAndUploadVariants(source: Buffer, slugBase: string): Promise<PackageImageUrls> {
  const safeName = (slugBase || 'package').replace(/[^a-z0-9\-]/gi, '_').toLowerCase()
  const ts = Date.now()

  try {
    const variants = await generateImageVariants(source)
    const urls: Record<string, string | null> = {}
    for (const variant of variants) {
      urls[variant.key] = await fetchAndUploadOne(variant.buffer, variant.contentType, `${safeName}-${ts}-${variant.key}.jpg`)
    }
    return {
      image_url: urls.horizontal ?? null,
      image_url_square: urls.square ?? null,
      image_url_portrait: urls.portrait ?? null,
      image_url_banner: urls.banner ?? null,
    }
  } catch (err) {
    console.error('[import] image variant generation failed, falling back to raw copy:', err instanceof Error ? err.message : err)
    const raw = await fetchAndUploadOne(source, 'image/jpeg', `${safeName}-${ts}.jpg`)
    return { ...EMPTY_IMAGE_URLS, image_url: raw }
  }
}

/** Fetches an external photo once and generates every format the site and social media need
 * from that single source, instead of copying the raw photo in as-is and letting the site
 * force-fit it into every shape at render time — that force-fit is what made copied-over images
 * look blurry/low-quality once zoomed into a banner or cropped to a square post. */
export async function uploadImagePackageVariants(externalUrl: string, slugBase = 'package'): Promise<PackageImageUrls> {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return EMPTY_IMAGE_URLS
  const source = await fetchExternalImage(externalUrl)
  if (!source) return EMPTY_IMAGE_URLS
  return processAndUploadVariants(source, slugBase)
}

/** Same as uploadImagePackageVariants, but for a photo that's already an in-memory buffer (an
 * AI-generated image, in practice — see lib/image-ai-gen.ts) rather than something to fetch. */
export async function uploadGeneratedImageVariants(source: Buffer, slugBase = 'package'): Promise<PackageImageUrls> {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return EMPTY_IMAGE_URLS
  return processAndUploadVariants(source, slugBase)
}

/**
 * Normalize an admin-supplied package (from the form, the scrape preview, or the sync),
 * copy its image into storage, and insert it as a row. Errors carry an HTTP status so
 * both the API route and the sync can report them without re-deriving the reason.
 */
export async function importPackage(input: Record<string, any>): Promise<ImportResult> {
  const body = { ...input }

  // Postgres rejects '' for date columns and NULL for the NOT NULL text columns.
  for (const key of ['available_from', 'available_to', 'image_url', 'booking_url']) {
    if (body[key] === '') body[key] = null
  }
  // category is NOT NULL with a DB default; omit it so the default applies rather than sending null.
  if (body.category == null || body.category === '') delete body.category

  const missing = REQUIRED_FIELDS.filter((key) => typeof body[key] !== 'string' || !body[key].trim())
  if (missing.length > 0) return { pkg: null, error: { status: 400, message: `Missing required field(s): ${missing.join(', ')}` } }

  if (!body.slug) body.slug = generateSlug(body.name)
  if (body.price_value == null) {
    const m = String(body.price_display).match(/\d[\d,]*/)
    if (m) body.price_value = parseFloat(m[0].replace(/,/g, ''))
  }
  if (body.duration_days == null) {
    const m = String(body.duration).match(/(\d+)\s*(day|night)/i)
    if (m) body.duration_days = parseInt(m[1], 10) + (/night/i.test(m[2]) ? 1 : 0)
  }

  if (typeof body.image_url === 'string' && /^https?:\/\//i.test(body.image_url)) {
    const stored = await uploadImagePackageVariants(body.image_url, body.slug)
    if (stored.image_url) {
      body.image_url = stored.image_url
      body.image_url_square = stored.image_url_square
      body.image_url_portrait = stored.image_url_portrait
      body.image_url_banner = stored.image_url_banner
    }
  }

  const { pkg, error } = await createPackage(body)
  if (error || !pkg) {
    if (error?.code === '23505') return { pkg: null, error: { status: 409, message: `Already imported: a package named "${body.name}" exists` } }
    if (error?.code === '23502' || error?.code === '22007' || error?.code === '23514') return { pkg: null, error: { status: 400, message: error.message } }
    return { pkg: null, error: { status: 500, message: error?.message || 'Failed to create package' } }
  }
  return { pkg, error: null }
}
