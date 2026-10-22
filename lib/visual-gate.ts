// Visual quality gate for generated Instagram images (owner rule: every generated visual must pass a check;
// a failing one is retried, then skipped silently and counted, never posted).
//
// Deterministic pixel checks on a rendered PNG. No AI, no network in the analysis itself: `analysePixels` is a
// pure function over raw RGB bytes, and `checkVisual` only adds the sharp decode in front of it. The thresholds
// are named constants below, calibrated by scripts/check-visual-gate.ts (synthetic good and bad images) and
// against the real photos in /public (see the notes beside each constant).
//
// All distances are written for a 1080 px wide frame and scaled by width / 1080, so a smaller render still works.

export const GATE_REF_WIDTH = 1080
export const GATE_ASPECT = 1350 / 1080
export const GATE_ASPECT_TOLERANCE = 0.02
export const GATE_MIN_WIDTH = 540

/** Edge safety: a strip this wide on every side must not hold clipped text or the red block. */
export const EDGE_STRIP_PX = 24
/** The red block must stay this far from the left and right edges (Instagram crops the grid tile). */
export const SIDE_MARGIN_PX = 100
/** Slack for anti-aliasing at the block edge. */
export const SIDE_MARGIN_TOLERANCE_PX = 6
/** The red block covers this share of the frame (a 3 line headline is about 26%, one short line about 8%). */
export const BLOCK_AREA_MIN = 0.05
export const BLOCK_AREA_MAX = 0.35
export const BLOCK_MIN_WIDTH_PX = 300
export const BLOCK_MIN_HEIGHT_PX = 100
/** A row counts as part of the block when this share of the frame width is red there. */
export const BLOCK_ROW_RED_SHARE = 0.2
/** A column counts as part of the block when this share of the block's rows is red there. */
export const BLOCK_COL_RED_SHARE = 0.25
/** The block is a rectangle with text cut out of it: at least this share of its box must be red. */
export const BLOCK_FILL_MIN = 0.4
/** Photo vividness outside the block. Passes when EITHER measure clears its bar. Calibrated: every real photo in
 * /public sits well above both bars, a flat grey frame sits at 0. */
export const MIN_MEAN_SATURATION = 0.18
export const MIN_LUMA_STD = 0.1
/** Mean absolute luma change between horizontal neighbours (0 to 1). A smooth gradient (the "photo failed to load"
 * fallback) is far below this, a real photo far above. */
export const MIN_PHOTO_DETAIL = 0.002
/** White text on the red block (WCAG contrast ratio; 3 is the large-text bar). */
export const MIN_TEXT_CONTRAST = 3
/** Share of the block's pixels that are white text: an empty block or a block flooded with white both fail. */
export const TEXT_SHARE_MIN = 0.04
export const TEXT_SHARE_MAX = 0.7
/** The bottom band that holds the TRAVELFUNBIZ.CA strip, and how many light pixels the strip's letters give. */
export const BRAND_STRIP_HEIGHT_PX = 140
export const BRAND_MIN_LIGHT_PIXELS = 120
/** A letter pixel has a pixel this far to its left or right that is darker than this luma (0 to 1). */
export const BRAND_DARK_REACH_PX = 4
export const BRAND_DARK_LUMA = 0.45
/** Edge strips: white or red pixels allowed before the image counts as clipped (scaled by area for the width). */
export const EDGE_MAX_BAD_PIXELS = 30
/** Teal cards (news, fact) must be mostly teal and carry visible text. */
export const TEAL_SHARE_MIN = 0.45
export const CARD_TEXT_SHARE_MIN = 0.01
export const CARD_TEXT_SHARE_MAX = 0.5

/** Centring: the red block's centre and the centre of mass of its white text must sit within this share of the frame width
 * of the frame's horizontal centre (4% of 1080 = 43px). A title pushed to one side is a defect even when it is clear of the margins. */
export const CENTRE_TOLERANCE_SHARE = 0.04

export type GateKind ='cover' | 'news' | 'fact'

export interface GateMetrics {
  width: number
  height: number
  block?: { left: number; top: number; right: number; bottom: number; areaShare: number; fill: number }
  meanSaturation?: number
  lumaStd?: number
  photoDetail?: number
  textShare?: number
  contrast?: number
  /** Horizontal distance of the block centre / the text centre of mass from the frame centre, as a share of the frame width (signed, right is positive). */
  blockCentreOffset?: number
  textCentreOffset?: number
  brandLightPixels?: number
  edgeBadPixels?: number
  tealShare?: number
}

export interface GateResult {
  ok: boolean
  reasons: string[]
  /** True when the check itself could not run (sharp or the download failed): the caller must defer, not post. */
  infra?: boolean
  metrics?: GateMetrics
}

const isRed = (r: number, g: number, b: number) => r >= 170 && g <= 90 && b <= 90 && r - g >= 100 && r - b >= 100
const isWhite = (r: number, g: number, b: number) => r >= 225 && g >= 225 && b >= 225
const isLight = (r: number, g: number, b: number) => r >= 200 && g >= 200 && b >= 200
const lumaOf = (r: number, g: number, b: number) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
const isTeal =(r: number, g: number, b: number) => r <= 60 && g >= 50 && g <= 150 && g - r >= 30 && b - r >= 30

function lin(c: number): number {
  const v = c / 255
  return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
}
const luminance = (r: number, g: number, b: number) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
export function contrastRatio(a: [number, number, number], b: [number, number, number]): number {
  const la = luminance(a[0], a[1], a[2])
  const lb = luminance(b[0], b[1], b[2])
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** The longest stretch of true flags, joining stretches separated by at most `maxGap` false flags. */
function longestRun(flags: ArrayLike<number | boolean>, maxGap: number): [number, number] | null {
  let best: [number, number] | null = null
  let start = -1
  let last = -1
  const close = () => {
    if (start >= 0 && (!best || last - start > best[1] - best[0])) best = [start, last]
  }
  for (let i = 0; i < flags.length; i++) {
    if (!flags[i]) continue
    if (start >= 0 && i - last > maxGap + 1) {
      close()
      start = i
    } else if (start < 0) start = i
    last = i
  }
  close()
  return best
}

/** Edge safety counts, shared by every kind. `nearRed` only counts white pixels with red beside them (text of the
 * block), so a white cloud at the photo's edge is not mistaken for clipped text. */
function edgeCounts(data: Uint8Array | Uint8ClampedArray | Buffer, w: number, h: number, ch: number, e: number, requireRedNeighbour: boolean): { white: number; red: number } {
  let white = 0
  let red = 0
  const at = (x: number, y: number) => (y * w + x) * ch
  const near = (x: number, y: number) => {
    for (const [dx, dy] of [[3, 0], [-3, 0], [0, 3], [0, -3]]) {
      const nx = x + dx
      const ny = y + dy
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
      const i = at(nx, ny)
      if (isRed(data[i], data[i + 1], data[i + 2])) return true
    }
    return false
  }
  const visit = (x: number, y: number) => {
    const i = at(x, y)
    const r = data[i]
    const g = data[i + 1]
    const b = data[i + 2]
    if (isWhite(r, g, b)) {
      if (!requireRedNeighbour || near(x, y)) white++
    } else if (isRed(r, g, b) && !requireRedNeighbour) red++
  }
  for (let y = 0; y < h; y++) {
    const inBand = y < e || y >= h - e
    if (inBand) for (let x = 0; x < w; x++) visit(x, y)
    else {
      for (let x = 0; x < e; x++) visit(x, y)
      for (let x = w - e; x < w; x++) visit(x, y)
    }
  }
  return { white, red }
}

/**
 * Checks raw interleaved 8-bit pixels (RGB or RGBA) of a rendered image. Pure and synchronous.
 * `cover` = photo behind a red headline block; `news` = teal text card; `fact` = teal fact card.
 */
export function analysePixels(data: Uint8Array | Uint8ClampedArray | Buffer, width: number, height: number, channels: number, kind: GateKind): GateResult {
  const reasons: string[] = []
  const metrics: GateMetrics = { width, height }
  if (channels < 3 || data.length < width * height * channels) return { ok: false, reasons: ['pixel data is incomplete'], infra: true, metrics }
  if (width < GATE_MIN_WIDTH || Math.abs(height / width - GATE_ASPECT) > GATE_ASPECT_TOLERANCE) {
    return { ok: false, reasons: [`unexpected image size ${width}x${height} (needs a 4:5 frame at least ${GATE_MIN_WIDTH} wide)`], metrics }
  }
  const s = width / GATE_REF_WIDTH
  const px = (n: number) => Math.max(1, Math.round(n * s))
  const w = width
  const h = height
  const ch = channels
  const total = w * h

  // ---- edge safety (a) ----
  const edge = px(EDGE_STRIP_PX)
  const e = edgeCounts(data, w, h, ch, edge, kind === 'cover')
  // Cover: only white pixels touching red count (the block's own text); a block that reaches the edge is caught by
  // the margin checks below. Teal cards have no photo, so any white at the edge is clipped text.
  const edgeBad = e.white
  metrics.edgeBadPixels = edgeBad
  if (edgeBad > EDGE_MAX_BAD_PIXELS * s * s) reasons.push(`text is clipped at the frame edge (${edgeBad} white pixels in the ${edge}px edge strips)`)

  // ---- brand strip (e) ----
  if (kind === 'cover' || kind === 'news') {
    const bandH = px(BRAND_STRIP_HEIGHT_PX)
    // Letters: light pixels with a dark pixel a few pixels to the side (white text on its dark pill or shadow). A bright
    // sky or sand at the bottom has no dark neighbours, so it does not pass for a strip.
    let light = 0
    const reach = px(BRAND_DARK_REACH_PX)
    for (let y = h - bandH; y < h; y++) {
      for (let x = reach; x < w - reach; x++) {
        const i = (y * w + x) * ch
        if (!isLight(data[i], data[i + 1], data[i + 2])) continue
        const a = (y * w + x - reach) * ch
        const b = (y * w + x + reach) * ch
        if (lumaOf(data[a], data[a + 1], data[a + 2]) < BRAND_DARK_LUMA || lumaOf(data[b], data[b + 1], data[b + 2]) < BRAND_DARK_LUMA) light++
      }
    }
    metrics.brandLightPixels = light
    if (light < BRAND_MIN_LIGHT_PIXELS * s * s) reasons.push('the TRAVELFUNBIZ.CA strip is missing at the bottom')
  }

  if (kind === 'cover') {
    // ---- the red block (b, f) ----
    const rowRed = new Int32Array(h)
    for (let y = 0; y < h; y++) {
      let c = 0
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * ch
        if (isRed(data[i], data[i + 1], data[i + 2])) c++
      }
      rowRed[y] = c
    }
    const rowFlags = Array.from(rowRed, (c) => (c >= BLOCK_ROW_RED_SHARE * w ? 1 : 0))
    const rows = longestRun(rowFlags, 4)
    if (!rows) {
      reasons.push('there is no red headline block (no title on the image)')
      return { ok: false, reasons, metrics }
    }
    const [top, bottom] = rows
    const blockRows = bottom - top + 1
    const colRed = new Int32Array(w)
    for (let y = top; y <= bottom; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * ch
        if (isRed(data[i], data[i + 1], data[i + 2])) colRed[x]++
      }
    }
    const colFlags = Array.from(colRed, (c) => (c >= BLOCK_COL_RED_SHARE * blockRows ? 1 : 0))
    const cols = longestRun(colFlags, 8)
    if (!cols) {
      reasons.push('there is no red headline block (no title on the image)')
      return { ok: false, reasons, metrics }
    }
    const [left, right] = cols
    const bw = right - left + 1
    const areaShare = (bw * blockRows) / total
    let redInBox = 0
    for (let x = left; x <= right; x++) redInBox += colRed[x]
    const fill = redInBox / (bw * blockRows)
    metrics.block = { left, top, right, bottom, areaShare, fill }

    if (bw < px(BLOCK_MIN_WIDTH_PX) || blockRows < px(BLOCK_MIN_HEIGHT_PX) || fill < BLOCK_FILL_MIN) {
      reasons.push(`the red headline block is missing or too small (${bw}x${blockRows}px, ${(fill * 100).toFixed(0)}% red)`)
    } else {
      const margin = px(SIDE_MARGIN_PX) - px(SIDE_MARGIN_TOLERANCE_PX)
      if (left < margin || right > w - 1 - margin) reasons.push(`the red block runs into the ${SIDE_MARGIN_PX}px side margins (x ${left} to ${right})`)
      if (top < edge || bottom > h - 1 - edge) reasons.push('the red block touches the top or bottom edge')
      if (areaShare < BLOCK_AREA_MIN) reasons.push(`the red block is too small (${(areaShare * 100).toFixed(1)}% of the frame)`)
      if (areaShare > BLOCK_AREA_MAX) reasons.push(`the red block is too big (${(areaShare * 100).toFixed(1)}% of the frame)`)
      // Centred title block: its centre must be within 4% of the frame width of the frame centre.
      const blockOffset = (left + right) / 2 / (w - 1) - 0.5
      metrics.blockCentreOffset = blockOffset
      if (Math.abs(blockOffset) > CENTRE_TOLERANCE_SHARE) reasons.push(`the title block is off centre (${(blockOffset * 100).toFixed(1)}% of the width, at most ${CENTRE_TOLERANCE_SHARE * 100}%)`)

      // ---- text on the block, and its contrast (d) ----
      let whiteN = 0
      let redN = 0
      let wr = 0
      let wg = 0
      let wb = 0
      let rr = 0
      let rg = 0
      let rb = 0
      let whiteX = 0
      for (let y = top; y <= bottom; y++) {
        for (let x = left; x <= right; x++) {
          const i = (y * w + x) * ch
          const r = data[i]
          const g = data[i + 1]
          const b = data[i + 2]
          if (isWhite(r, g, b)) {
            whiteN++
            whiteX += x
            wr += r
            wg += g
            wb += b
          } else if (isRed(r, g, b)) {
            redN++
            rr += r
            rg += g
            rb += b
          }
        }
      }
      const textShare = whiteN / (bw * blockRows)
      metrics.textShare = textShare
      // Centred text: the centre of mass of the white letters, measured from the frame centre (not the block, so a block
      // that is centred but holds left-aligned words is caught too).
      if (whiteN > 0) {
        const textOffset = whiteX / whiteN / (w - 1) - 0.5
        metrics.textCentreOffset = textOffset
        if (Math.abs(textOffset) > CENTRE_TOLERANCE_SHARE) reasons.push(`the title text is off centre (${(textOffset * 100).toFixed(1)}% of the width, at most ${CENTRE_TOLERANCE_SHARE * 100}%)`)
      }
      if (textShare < TEXT_SHARE_MIN) reasons.push('the red block has no readable text in it')
      else if (textShare > TEXT_SHARE_MAX) reasons.push('the red block is mostly white (text is not readable)')
      else if (whiteN > 0 && redN > 0) {
        const c = contrastRatio([wr / whiteN, wg / whiteN, wb / whiteN], [rr / redN, rg / redN, rb / redN])
        metrics.contrast = c
        if (c < MIN_TEXT_CONTRAST) reasons.push(`text contrast is too low (${c.toFixed(1)}:1)`)
      }

      // ---- photo vividness and detail (c): outside the block and the brand band ----
      const bandTop = h - px(BRAND_STRIP_HEIGHT_PX)
      let n = 0
      let sat = 0
      let ls = 0
      let lsq = 0
      let dsum = 0
      let dn = 0
      for (let y = 0; y < bandTop; y += 2) {
        for (let x = 0; x < w - 1; x += 2) {
          if (y >= top - 2 && y <= bottom + 2 && x >= left - 2 && x <= right + 2) continue
          const i = (y * w + x) * ch
          const r = data[i] / 255
          const g = data[i + 1] / 255
          const b = data[i + 2] / 255
          const mx = Math.max(r, g, b)
          const mn = Math.min(r, g, b)
          sat += mx === 0 ? 0 : (mx - mn) / mx
          const l = 0.2126 * r + 0.7152 * g + 0.0722 * b
          ls += l
          lsq += l * l
          n++
          const j = i + 2 * ch
          if (x + 2 < w) {
            const l2 = (0.2126 * data[j] + 0.7152 * data[j + 1] + 0.0722 * data[j + 2]) / 255
            dsum += Math.abs(l2 - l)
            dn++
          }
        }
      }
      if (n > 0) {
        const meanL = ls / n
        const std = Math.sqrt(Math.max(0, lsq / n - meanL * meanL))
        const meanSat = sat / n
        const detail = dn > 0 ? dsum / dn / 2 : 0 // per pixel (samples are 2px apart)
        metrics.meanSaturation = meanSat
        metrics.lumaStd = std
        metrics.photoDetail = detail
        if (meanSat < MIN_MEAN_SATURATION && std < MIN_LUMA_STD) reasons.push(`the photo is flat or dull (saturation ${meanSat.toFixed(2)}, contrast spread ${std.toFixed(2)})`)
        if (detail < MIN_PHOTO_DETAIL) reasons.push('there is no photo detail (a plain colour or gradient, the photo did not load)')
      } else {
        reasons.push('no photo area could be measured')
      }
    }
  } else {
    // ---- teal text cards (news, fact) ----
    let teal = 0
    let whiteN = 0
    let tr = 0
    let tg = 0
    let tb = 0
    const midTop = px(200)
    const midBottom = h - px(200)
    let midN = 0
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * ch
        const r = data[i]
        const g = data[i + 1]
        const b = data[i + 2]
        if (isTeal(r, g, b)) {
          teal++
          tr += r
          tg += g
          tb += b
        }
        if (y >= midTop && y < midBottom && x >= px(SIDE_MARGIN_PX) && x < w - px(SIDE_MARGIN_PX)) {
          midN++
          if (isWhite(r, g, b)) whiteN++
        }
      }
    }
    const tealShare = teal / total
    metrics.tealShare = tealShare
    if (tealShare < TEAL_SHARE_MIN) reasons.push(`the card is not teal (${(tealShare * 100).toFixed(0)}% teal)`)
    const textShare = midN > 0 ? whiteN / midN : 0
    metrics.textShare = textShare
    if (textShare < CARD_TEXT_SHARE_MIN) reasons.push('the card has no readable headline')
    else if (textShare > CARD_TEXT_SHARE_MAX) reasons.push('the card is mostly white (text is not readable)')
    else if (teal > 0) {
      const c = contrastRatio([255, 255, 255], [tr / teal, tg / teal, tb / teal])
      metrics.contrast = c
      if (c < MIN_TEXT_CONTRAST) reasons.push(`text contrast is too low (${c.toFixed(1)}:1)`)
    }
  }

  return { ok: reasons.length === 0, reasons, metrics }
}

/** Decodes a PNG or JPEG with sharp and runs analysePixels. A decode failure is reported as `infra`, never as a pass. */
export async function checkVisual(image: Buffer | Uint8Array, kind: GateKind): Promise<GateResult> {
  try {
    const sharp = (await import('sharp')).default
    const { data, info } = await sharp(Buffer.from(image)).removeAlpha().raw().toBuffer({ resolveWithObject: true })
    return analysePixels(data, info.width, info.height, info.channels, kind)
  } catch (err) {
    return { ok: false, infra: true, reasons: [`the image could not be decoded (${err instanceof Error ? err.message : 'unknown error'})`] }
  }
}

export const VISUAL_FETCH_TIMEOUT_MS = 12_000

export type FetchedImage = { ok: true; buf: Buffer; headers: { photoId: string | null; template: string | null } } | { ok: false; error: string }

/** Downloads a rendered image (the same checks verifyCoverUrl makes: 200, PNG or JPEG, more than 1000 bytes). Never throws. */
export async function fetchRenderedImage(url: string, fetchImpl: typeof fetch = fetch, timeoutMs: number = VISUAL_FETCH_TIMEOUT_MS): Promise<FetchedImage> {
  try {
    const res = await fetchImpl(url, { cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) })
    const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
    if (!res.ok || (type !== 'image/png' && type !== 'image/jpeg')) {
      await res.body?.cancel().catch(() => {})
      return { ok: false, error: `status ${res.status}, type ${type || 'none'}` }
    }
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.byteLength <= 1000) return { ok: false, error: 'image body too small' }
    return { ok: true, buf, headers: { photoId: res.headers.get('x-cover-photo-id'), template: res.headers.get('x-cover-template') } }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.name : 'fetch failed' }
  }
}

/** Fetches a rendered image and gates it in one call. `infra` is set when the fetch or the decode failed. */
export async function gateRenderedUrl(url: string, kind: GateKind, fetchImpl: typeof fetch = fetch, timeoutMs: number = VISUAL_FETCH_TIMEOUT_MS): Promise<GateResult & { photoId?: string | null; template?: string | null }> {
  const got = await fetchRenderedImage(url, fetchImpl, timeoutMs)
  if (!got.ok) return { ok: false, infra: true, reasons: [`the image could not be fetched (${got.error})`] }
  const result = await checkVisual(got.buf, kind)
  return { ...result, photoId: got.headers.photoId, template: got.headers.template }
}

/** One short line for a ledger note or a tag. */
export function gateSummary(result: Pick<GateResult, 'ok' | 'reasons'>): string {
  return result.ok ? 'pass' : `fail: ${result.reasons.join('; ')}`.slice(0, 240)
}
