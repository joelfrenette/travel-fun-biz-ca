import type { SupabaseClient } from '@supabase/supabase-js'
import { findDestinationPhoto, isPexelsConfigured } from '@/lib/pexels'

const MAX_BYTES = 8 * 1024 * 1024

/** Autoblog never attached a cover image at all - every AI-written post published with none.
 * When Pexels is configured, look up a real photo for the post's keyword/topic, upload it to the
 * same 'post-images' bucket the manual editor's upload button uses, and return its URL plus real
 * alt text (Pexels' own description, when it has one). Returns null on any failure - a missing
 * cover image must never block the post itself, same rule as every other image fallback in this
 * project. */
export async function attachAutoblogCoverImage(
  admin: SupabaseClient,
  keyword: string,
  slugForFilename: string,
): Promise<{ cover_image_url: string; alt_text: string } | null> {
  if (!isPexelsConfigured() || !keyword.trim()) return null

  const photo = await findDestinationPhoto(keyword)
  if (!photo) return null

  try {
    const res = await fetch(photo.url, { cache: 'no-store', signal: AbortSignal.timeout(20_000) })
    const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
    if (!res.ok || !type.startsWith('image/')) return null
    const buf = await res.arrayBuffer()
    if (buf.byteLength === 0 || buf.byteLength > MAX_BYTES) return null

    const safeName = (slugForFilename || 'post').replace(/[^a-z0-9-]/gi, '_').toLowerCase()
    const filename = `${safeName}-${Date.now()}.jpg`
    const storage = admin.storage.from('post-images')
    const { error } = await storage.upload(filename, Buffer.from(buf), { contentType: 'image/jpeg' })
    if (error) {
      console.error('[blog-image] upload failed:', error.message)
      return null
    }

    const url = storage.getPublicUrl(filename).data.publicUrl
    if (!url) return null
    return { cover_image_url: url, alt_text: photo.alt || keyword }
  } catch (err) {
    console.error('[blog-image] fetch/upload error:', err instanceof Error ? err.message : err)
    return null
  }
}
