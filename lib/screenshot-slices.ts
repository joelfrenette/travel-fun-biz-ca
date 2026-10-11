// Tall screenshots (growth loop WP13). Facebook posts and events cannot be read from a link, so Joel takes a scrolling
// screenshot (SnagIt, or Windows Snip with scroll), often 600 px wide and 2000+ px tall. A model reads such a picture
// badly when it is squeezed into one block, so before it is sent:
//   1. an image wider than MAX_WIDTH is scaled down to MAX_WIDTH (aspect kept);
//   2. an image taller than MAX_STRIP_HEIGHT is cut into strips of at most MAX_STRIP_HEIGHT pixels, each starting
//      STRIP_STEP (= MAX_STRIP_HEIGHT - OVERLAP) pixels after the one before, so neighbours share OVERLAP pixels and no
//      line of text is cut in half without also appearing whole in a neighbour;
//   3. the strips of every image, in order, are sent as separate image blocks in ONE model call.
// planStrips is pure (offline checks in scripts/check-package-completeness.ts); prepareImages needs sharp.

export const SLICE_RULES = { maxStripHeight: 1400, overlap: 120, maxWidth: 1600 } as const
export const STRIP_STEP = SLICE_RULES.maxStripHeight - SLICE_RULES.overlap

export interface Strip {
  top: number
  height: number
}

/** The pixel size after the width rule: wider than maxWidth is scaled to maxWidth, nothing is ever scaled up. */
export function scaledSize(width: number, height: number): { width: number; height: number; scaled: boolean } {
  if (width <= SLICE_RULES.maxWidth) return { width, height, scaled: false }
  const f = SLICE_RULES.maxWidth / width
  return { width: SLICE_RULES.maxWidth, height: Math.max(1, Math.round(height * f)), scaled: true }
}

/** Strips for an image of this height (already width-scaled). One strip covering all of it when it is short enough. */
export function planStrips(height: number): Strip[] {
  if (!(height > 0)) return []
  if (height <= SLICE_RULES.maxStripHeight) return [{ top: 0, height }]
  const strips: Strip[] = []
  let top = 0
  for (;;) {
    const h = Math.min(SLICE_RULES.maxStripHeight, height - top)
    strips.push({ top, height: h })
    if (top + h >= height) break
    top += STRIP_STEP
  }
  return strips
}

export type ImageType = 'image/png' | 'image/jpeg' | 'image/webp'
export interface PreparedImage {
  buffer: Buffer
  mediaType: ImageType
}

/** One model call never carries more than this many strips or this many bytes of pictures. */
export const SLICE_LIMITS = { maxStrips: 40, maxTotalBytes: 20 * 1024 * 1024 } as const
export const SPLIT_MESSAGE = 'These screenshots are too big to read in one go. Split them into smaller screenshots (fewer or shorter pictures) and add them again.'

export interface PreparedSet {
  /** Set when the pictures are over the limits; nothing is sent to the model. */
  error?: string
  images: PreparedImage[]
  /** True when any picture was cut into strips. */
  sliced: boolean
  /** Per original picture: its size as read and how many strips it became. */
  report: { width: number; height: number; strips: number; scaledTo?: number }[]
}

/**
 * Readies uploaded pictures for the model: scale, then cut tall ones into overlapping strips, keeping order. A short
 * picture that needed neither is passed through byte for byte. Never throws for one unreadable picture: it is passed
 * through unchanged (the model call decides what it can read).
 */
export async function prepareImages(inputs: { buffer: Buffer; mediaType: ImageType }[]): Promise<PreparedSet> {
  const sharp = (await import('sharp')).default
  const tooBig: PreparedSet = { images: [], sliced: false, report: [], error: SPLIT_MESSAGE }
  // Limits BEFORE anything is cut or sent: total bytes in, then the number of strips the pictures would become.
  if (inputs.reduce((n, i) => n + i.buffer.length, 0) > SLICE_LIMITS.maxTotalBytes) return tooBig
  let planned = 0
  for (const input of inputs) {
    try {
      const m = await sharp(input.buffer).metadata()
      planned += m.width && m.height ? planStrips(scaledSize(m.width, m.height).height).length : 1
    } catch {
      planned += 1
    }
  }
  if (planned > SLICE_LIMITS.maxStrips) return tooBig
  const images: PreparedImage[] = []
  const report: PreparedSet['report'] = []
  let sliced = false
  for (const input of inputs) {
    let meta: { width?: number; height?: number }
    try {
      meta = await sharp(input.buffer).metadata()
    } catch {
      images.push(input)
      report.push({ width: 0, height: 0, strips: 1 })
      continue
    }
    const w = meta.width ?? 0
    const h = meta.height ?? 0
    if (!w || !h) {
      images.push(input)
      report.push({ width: w, height: h, strips: 1 })
      continue
    }
    const size = scaledSize(w, h)
    const strips = planStrips(size.height)
    if (!size.scaled && strips.length === 1) {
      images.push(input)
      report.push({ width: w, height: h, strips: 1 })
      continue
    }
    try {
      const base = size.scaled ? await sharp(input.buffer).resize({ width: size.width }).png().toBuffer() : await sharp(input.buffer).png().toBuffer()
      // Cut against the real size of the scaled picture (a resize can differ from the estimate by a pixel).
      const real = await sharp(base).metadata()
      const rw = real.width ?? size.width
      const cuts = planStrips(real.height ?? size.height)
      const out: PreparedImage[] = []
      for (const s of cuts) {
        const buffer = cuts.length === 1 ? base : await sharp(base).extract({ left: 0, top: s.top, width: rw, height: s.height }).png().toBuffer()
        out.push({ buffer, mediaType: 'image/png' })
      }
      images.push(...out)
      if (cuts.length > 1) sliced = true
      report.push({ width: w, height: h, strips: cuts.length, ...(size.scaled ? { scaledTo: size.width } : {}) })
    } catch {
      images.push(input)
      report.push({ width: w, height: h, strips: 1 })
    }
  }
  // The strips are PNG and can be larger than the originals: the same byte ceiling applies to what is actually sent.
  if (images.reduce((n, i) => n + i.buffer.length, 0) > SLICE_LIMITS.maxTotalBytes) return tooBig
  return { images, sliced, report }
}
