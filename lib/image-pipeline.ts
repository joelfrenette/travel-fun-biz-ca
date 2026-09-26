import sharp from 'sharp'
import { IMAGE_FORMATS } from '@/lib/image-formats'

export interface ImageVariant {
  key: string
  buffer: Buffer
  contentType: 'image/jpeg'
}

/** One real photo in, one JPEG per target format out — each smart-cropped to fill its exact
 * shape (sharp's "attention" strategy favors edges/saturated regions over a blind center crop, so
 * a wide photo of a ship doesn't just lose its top and bottom when cropped to a portrait feed
 * post). This is what actually fixes "blurry/low quality when zoomed for the banner": every
 * format gets generated at its own target resolution from the original, instead of the site
 * stretching or cropping one already-small copy at render time. Never resizes UP past what the
 * source can support in a way that fabricates detail — sharp's cover fit still just scales,
 * same as any resize; a low-resolution source stays low-resolution, it just isn't made worse by
 * an additional lossy render-time crop on top. */
export async function generateImageVariants(source: Buffer): Promise<ImageVariant[]> {
  const variants: ImageVariant[] = []
  for (const spec of IMAGE_FORMATS) {
    const buffer = await sharp(source)
      .resize(spec.width, spec.height, { fit: 'cover', position: sharp.strategy.attention })
      .jpeg({ quality: 85 })
      .toBuffer()
    variants.push({ key: spec.key, buffer, contentType: 'image/jpeg' })
  }
  return variants
}
