import { createPackage, type DbPackage } from '@/lib/packages'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { generateSlug } from '@/lib/utils'

const REQUIRED_FIELDS = ['name', 'destination', 'duration', 'price_display'] as const

export type ImportError = { status: number; message: string }
export type ImportResult = { pkg: DbPackage; error: null } | { pkg: null; error: ImportError }

/** Copy an external image into the package-images bucket; null when it cannot be stored. */
export async function uploadImageToSupabase(externalUrl: string, slugBase = 'package'): Promise<string | null> {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return null
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

    const contentType = res.headers.get('content-type') || 'image/jpeg'
    if (!contentType.startsWith('image/') && !contentType.includes('octet-stream')) return null

    const ext = contentType.includes('png') ? '.png'
      : contentType.includes('webp') ? '.webp'
      : contentType.includes('gif') ? '.gif'
      : contentType.includes('svg') ? '.svg'
      : '.jpg'
    const safeName = (slugBase || 'package').replace(/[^a-z0-9\-]/gi, '_').toLowerCase()
    const filename = `${safeName}-${Date.now()}${ext}`

    const buffer = Buffer.from(await res.arrayBuffer())
    if (buffer.length < 1000) return null // tracking pixel or error page, not a photo

    const storage = getSupabaseAdmin().storage.from('package-images')
    const { error } = await storage.upload(filename, buffer, { contentType, upsert: true })
    if (error) {
      console.error('[import] image upload failed:', error.message)
      return null
    }
    return storage.getPublicUrl(filename).data.publicUrl || null
  } catch (err) {
    console.error('[import] image upload error:', err instanceof Error ? err.message : err)
    return null
  }
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
    const stored = await uploadImageToSupabase(body.image_url, body.slug)
    if (stored) body.image_url = stored
  }

  const { pkg, error } = await createPackage(body)
  if (error || !pkg) {
    if (error?.code === '23505') return { pkg: null, error: { status: 409, message: `Already imported: a package named "${body.name}" exists` } }
    if (error?.code === '23502' || error?.code === '22007' || error?.code === '23514') return { pkg: null, error: { status: 400, message: error.message } }
    return { pkg: null, error: { status: 500, message: error?.message || 'Failed to create package' } }
  }
  return { pkg, error: null }
}
