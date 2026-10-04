import type { SupabaseClient } from '@supabase/supabase-js'
import { findDestinationPhoto, isPexelsConfigured } from '@/lib/pexels'
import { generateAiImage, isImageAiConfigured } from '@/lib/image-ai-gen'
import { getSetting, setSetting } from '@/lib/app-settings'
import { tagVariant } from '@/lib/content-variants'

const MAX_BYTES = 8 * 1024 * 1024

/** `app_settings.autoblog_ai_image_fallback`: 'off' (default) or 'on'. Pexels-only is the
 * standing default because an AI image costs real money per call (lib/image-ai-gen.ts) and this
 * project's rule is every credit-costing call is admin-triggered, never silent - this toggle IS
 * that admin trigger: a deliberate, considered decision Joel makes once in the admin UI, not a
 * default this code picks for him. Off until he turns it on. */
const AI_IMAGE_FALLBACK_KEY = 'autoblog_ai_image_fallback'

export async function getAutoblogAiImageFallback(admin: SupabaseClient): Promise<boolean> {
  return (await getSetting(admin, AI_IMAGE_FALLBACK_KEY)) === 'on'
}

export async function setAutoblogAiImageFallback(admin: SupabaseClient, on: boolean): Promise<{ error?: string }> {
  return setSetting(admin, AI_IMAGE_FALLBACK_KEY, on ? 'on' : 'off')
}

async function uploadCoverImage(
  admin: SupabaseClient,
  buf: ArrayBuffer | Buffer,
  slugForFilename: string,
  contentType: string,
): Promise<string | null> {
  const safeName = (slugForFilename || 'post').replace(/[^a-z0-9-]/gi, '_').toLowerCase()
  const ext = contentType.includes('png') ? 'png' : 'jpg'
  const filename = `${safeName}-${Date.now()}.${ext}`
  const storage = admin.storage.from('post-images')
  const { error } = await storage.upload(filename, Buffer.from(buf), { contentType })
  if (error) {
    console.error('[blog-image] upload failed:', error.message)
    return null
  }
  return storage.getPublicUrl(filename).data.publicUrl || null
}

/** Autoblog never attached a cover image at all - every AI-written post published with none.
 * When Pexels is configured, look up a real photo for the post's keyword/topic, upload it to the
 * same 'post-images' bucket the manual editor's upload button uses, and return its URL plus real
 * alt text (Pexels' own description, when it has one).
 *
 * When Pexels comes up empty AND the admin has explicitly turned on the AI fallback (see
 * getAutoblogAiImageFallback above) AND OPENAI_API_KEY is set, falls back to a generated
 * illustration instead of shipping the post with no image at all - closing the "published post
 * with a generic beach-photo placeholder" gap. Alt text says it's an illustration, not a claimed
 * photo of the place, same honesty rule generateAiImage's own prompt already enforces visually.
 *
 * Returns null only when every configured path fails or none is configured - a missing cover
 * image must never block the post itself, same rule as every other image fallback here. */
export async function attachAutoblogCoverImage(
  admin: SupabaseClient,
  keyword: string,
  slugForFilename: string,
): Promise<{ cover_image_url: string; alt_text: string } | null> {
  if (!keyword.trim()) return null

  if (isPexelsConfigured()) {
    const photo = await findDestinationPhoto(keyword)
    if (photo) {
      try {
        const res = await fetch(photo.url, { cache: 'no-store', signal: AbortSignal.timeout(20_000) })
        const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
        if (res.ok && type.startsWith('image/')) {
          const buf = await res.arrayBuffer()
          if (buf.byteLength > 0 && buf.byteLength <= MAX_BYTES) {
            const url = await uploadCoverImage(admin, buf, slugForFilename, 'image/jpeg')
            if (url) {
              await tagVariant(admin, slugForFilename, { coverSource: 'pexels' })
              return { cover_image_url: url, alt_text: photo.alt || keyword }
            }
          }
        }
      } catch (err) {
        console.error('[blog-image] Pexels fetch/upload error:', err instanceof Error ? err.message : err)
      }
    }
  }

  if (isImageAiConfigured() && (await getAutoblogAiImageFallback(admin))) {
    try {
      const generated = await generateAiImage(keyword)
      if (generated) {
        const url = await uploadCoverImage(admin, generated.buffer, slugForFilename, 'image/png')
        if (url) {
          await tagVariant(admin, slugForFilename, { coverSource: 'ai' })
          return { cover_image_url: url, alt_text: `Illustration: ${keyword}` }
        }
      }
    } catch (err) {
      console.error('[blog-image] AI fallback error:', err instanceof Error ? err.message : err)
    }
  }

  return null
}
