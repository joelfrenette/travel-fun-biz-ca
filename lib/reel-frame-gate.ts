import { fetchRenderedImage, type FetchedImage } from '@/lib/visual-gate'

// Post-render frame gate for reels. A Shotstack render can save a poster (a still of the cover window) and a thumbnail (a still of
// the end card) next to the video (edit.output.poster / edit.output.thumbnail, see lib/shotstack.ts). There is no ffmpeg on Vercel, so
// these two stills are the only way to LOOK at a finished reel before it is posted. Two deterministic pixel checks:
//
//   cover  the red headline block is there, centred, inside the side margins and readable, and NOTHING dark or stroked is drawn
//          over it (a caption sitting on the headline, the real 21 Oct defect), and no stroked caption text sits on the photo.
//   end    the closing card: the red block with the site name and the call to action strip under it.
//
// Verdicts: 'pass', 'fail' (never post it), 'unknown' (no still was returned, the fetch or decode failed twice, or the picture has an
// unexpected size: the gate cannot say, so the reel is posted on the strength of the pre-render checks, exactly as before).
// A reel that fails here has already cost a render credit, so the caller logs it as a silent, counted skip, not an alert.

export type FrameVerdict = 'pass' | 'fail' | 'unknown'

export interface FrameCheck {
  ok: boolean
  reasons: string[]
  /** True when the check could not run (unexpected size or incomplete pixels): the verdict is then 'unknown', never a pass or a fail. */
  infra?: boolean
}

type Pixels = Uint8Array | Uint8ClampedArray | Buffer

const isRed = (r: number, g: number, b: number) => r >= 170 && g <= 90 && b <= 90 && r - g >= 100 && r - b >= 100
const isWhite = (r: number, g: number, b: number) => r >= 225 && g >= 225 && b >= 225
const lumaOf = (r: number, g: number, b: number) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255

const REEL_ASPECT = 1280 / 720
const ASPECT_TOLERANCE = 0.03
const MIN_WIDTH = 240
/** The headline block is at least this share of the frame width (560 of 720 wide is 78%), and at least this far from each side. The side margin was 9%,
 * but the live template draws a headline block up to 646 of 720 wide (left edge 21 to 55) and an end card block at x 34 to 327 of a 360 wide still (32 px
 * on the right), so every reel since 22 Oct 2026 failed this check after its render credit was spent (8 skips, 0 posted). 2.5% still catches a block
 * that touches the frame edge and is cut off; the centre check below still catches a lopsided one. */
export const REEL_BLOCK_MIN_WIDTH_SHARE = 0.45
export const REEL_BLOCK_SIDE_MARGIN_SHARE = 0.025
export const REEL_BLOCK_TOP_MIN_SHARE = 0.12
export const REEL_BLOCK_AREA_MIN = 0.04
export const REEL_BLOCK_AREA_MAX = 0.35
export const REEL_CENTRE_TOLERANCE = 0.04
export const REEL_TEXT_SHARE_MIN = 0.04
/** Dark, non-red pixels inside the red block: a clean block has none beyond anti-aliasing; a caption's black outline has many. */
export const REEL_BLOCK_DARK_MAX_SHARE = 0.012
/** Stroked white text (white with a near black pixel 4px to the side) outside the block and the strip under it, as a share of the frame. */
export const REEL_STRAY_TEXT_MAX_SHARE = 0.0012
/** Light pixels with a dark neighbour in the strip band of the end card, as a share of the frame. */
export const REEL_END_STRIP_MIN_SHARE = 0.00008

/** The brand strip (cover) and the call to action strip (end card) sit mid frame, about 0.29 of the frame height below the block's centre; the band
 * under the block that holds them is this tall. */
export const STRIP_BAND_SHARE = 0.36

interface Block {
  left: number
  top: number
  right: number
  bottom: number
  fill: number
}

function findRedBlock(data: Pixels, w: number, h: number, ch: number): Block | null {
  const rowFlags: number[] = []
  for (let y = 0; y < h; y++) {
    let c = 0
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * ch
      if (isRed(data[i], data[i + 1], data[i + 2])) c++
    }
    rowFlags.push(c >= 0.2 * w ? 1 : 0)
  }
  const rows = longestRun(rowFlags, 4)
  if (!rows) return null
  const [top, bottom] = rows
  const blockRows = bottom - top + 1
  const colRed = new Int32Array(w)
  for (let y = top; y <= bottom; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * ch
      if (isRed(data[i], data[i + 1], data[i + 2])) colRed[x]++
    }
  }
  const cols = longestRun(Array.from(colRed, (c) => (c >= 0.25 * blockRows ? 1 : 0)), 8)
  if (!cols) return null
  const [left, right] = cols
  let redInBox = 0
  for (let x = left; x <= right; x++) redInBox += colRed[x]
  return { left, top, right, bottom, fill: redInBox / ((right - left + 1) * blockRows) }
}

function longestRun(flags: number[], maxGap: number): [number, number] | null {
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

function sizeProblem(width: number, height: number, channels: number, length: number): FrameCheck | null {
  if (channels < 3 || length < width * height * channels) return { ok: false, infra: true, reasons: ['pixel data is incomplete'] }
  if (width < MIN_WIDTH || Math.abs(height / width - REEL_ASPECT) > ASPECT_TOLERANCE * REEL_ASPECT) return { ok: false, infra: true, reasons: [`unexpected frame size ${width}x${height} (needs a 9:16 frame)`] }
  return null
}

/** Block checks shared by the cover and the end card: present, wide enough, inside the side margins, clear of the top, centred, with white text in it. */
function blockProblems(data: Pixels, w: number, h: number, ch: number, block: Block | null, what: string): { reasons: string[]; block: Block | null } {
  const reasons: string[] = []
  if (!block) return { reasons: [`there is no red ${what} block`], block: null }
  const bw = block.right - block.left + 1
  const bh = block.bottom - block.top + 1
  const area = (bw * bh) / (w * h)
  if (bw < REEL_BLOCK_MIN_WIDTH_SHARE * w || block.fill < 0.4) reasons.push(`the red ${what} block is missing or too small (${bw}px wide, ${(block.fill * 100).toFixed(0)}% red)`)
  else {
    if (block.left < REEL_BLOCK_SIDE_MARGIN_SHARE * w || block.right > w - 1 - REEL_BLOCK_SIDE_MARGIN_SHARE * w) reasons.push(`the red ${what} block runs into the side margins (x ${block.left} to ${block.right})`)
    if (block.top < REEL_BLOCK_TOP_MIN_SHARE * h) reasons.push(`the red ${what} block sits in the top area that Instagram covers (y ${block.top})`)
    if (area < REEL_BLOCK_AREA_MIN || area > REEL_BLOCK_AREA_MAX) reasons.push(`the red ${what} block has an odd size (${(area * 100).toFixed(1)}% of the frame)`)
    const offset = (block.left + block.right) / 2 / (w - 1) - 0.5
    if (Math.abs(offset) > REEL_CENTRE_TOLERANCE) reasons.push(`the red ${what} block is off centre (${(offset * 100).toFixed(1)}% of the width)`)
    let white = 0
    for (let y = block.top; y <= block.bottom; y++) {
      for (let x = block.left; x <= block.right; x++) {
        const i = (y * w + x) * ch
        if (isWhite(data[i], data[i + 1], data[i + 2])) white++
      }
    }
    if (white / (bw * bh) < REEL_TEXT_SHARE_MIN) reasons.push(`the red ${what} block has no readable text in it`)
  }
  return { reasons, block }
}

/** Pixels that are white with a near black pixel 4 px (scaled) to the left or right: the look of a stroked caption letter. Counted in the rows
 * [y0, y1), skipping the columns and rows of `skip`. */
function strokedWhiteCount(data: Pixels, w: number, ch: number, y0: number, y1: number, reach: number, skip?: Block): number {
  let n = 0
  for (let y = y0; y < y1; y++) {
    if (skip && y >= skip.top && y <= skip.bottom) continue
    for (let x = reach; x < w - reach; x++) {
      const i = (y * w + x) * ch
      if (!isWhite(data[i], data[i + 1], data[i + 2])) continue
      const a = (y * w + x - reach) * ch
      const b = (y * w + x + reach) * ch
      if (lumaOf(data[a], data[a + 1], data[a + 2]) < 0.12 || lumaOf(data[b], data[b + 1], data[b + 2]) < 0.12) n++
    }
  }
  return n
}

/** Checks the cover still (the poster taken inside the cover window) of a 9:16 reel. Pure. */
export function analyseReelCover(data: Pixels, width: number, height: number, channels: number): FrameCheck {
  const bad = sizeProblem(width, height, channels, data.length)
  if (bad) return bad
  const w = width
  const h = height
  const { reasons, block } = blockProblems(data, w, h, channels, findRedBlock(data, w, h, channels), 'headline')
  if (!block) return { ok: false, reasons }
  // Something dark drawn over the block (a caption's black outline) means the headline is partly covered.
  let dark = 0
  for (let y = block.top; y <= block.bottom; y++) {
    for (let x = block.left; x <= block.right; x++) {
      const i = (y * w + x) * channels
      const r = data[i]
      const g = data[i + 1]
      const b = data[i + 2]
      if (!isRed(r, g, b) && !isWhite(r, g, b) && lumaOf(r, g, b) < 0.2) dark++
    }
  }
  const bh = block.bottom - block.top + 1
  const bw = block.right - block.left + 1
  if (dark / (bw * bh) > REEL_BLOCK_DARK_MAX_SHARE) reasons.push(`something dark is drawn over the headline block (${((dark / (bw * bh)) * 100).toFixed(1)}% of it): a caption over the title`)
  // Stroked white text on the photo outside the block and the brand strip under it: a caption running over the cover.
  const reach = Math.max(2, Math.round((4 * w) / 720))
  const stripEnd = Math.min(h, block.bottom + Math.round(STRIP_BAND_SHARE * h))
  const above = strokedWhiteCount(data, w, channels, 0, block.top, reach)
  const below = strokedWhiteCount(data, w, channels, stripEnd, h, reach)
  if ((above + below) / (w * h) > REEL_STRAY_TEXT_MAX_SHARE) reasons.push('caption text is on the cover photo outside the headline block')
  return { ok: reasons.length === 0, reasons }
}

/** Checks the end card still: the red block with the site name, and the call to action strip under it. Pure. */
export function analyseReelEndCard(data: Pixels, width: number, height: number, channels: number): FrameCheck {
  const bad = sizeProblem(width, height, channels, data.length)
  if (bad) return bad
  const w = width
  const h = height
  const { reasons, block } = blockProblems(data, w, h, channels, findRedBlock(data, w, h, channels), 'end card')
  if (!block) return { ok: false, reasons }
  const reach = Math.max(2, Math.round((4 * w) / 720))
  const bandTop = Math.min(h - 1, block.bottom + 1)
  const bandBottom = Math.min(h, block.bottom + Math.round(STRIP_BAND_SHARE * h))
  let light = 0
  for (let y = bandTop; y < bandBottom; y++) {
    for (let x = reach; x < w - reach; x++) {
      const i = (y * w + x) * channels
      if (!(data[i] >= 200 && data[i + 1] >= 200 && data[i + 2] >= 200)) continue
      const a = (y * w + x - reach) * channels
      const b = (y * w + x + reach) * channels
      if (lumaOf(data[a], data[a + 1], data[a + 2]) < 0.45 || lumaOf(data[b], data[b + 1], data[b + 2]) < 0.45) light++
    }
  }
  if (light / (w * h) < REEL_END_STRIP_MIN_SHARE) reasons.push('the call to action strip is missing under the end card block')
  return { ok: reasons.length === 0, reasons }
}

export interface FrameGateResult {
  verdict: FrameVerdict
  reasons: string[]
  /** Which frames could actually be looked at. */
  checked: { cover: boolean; end: boolean }
}

export interface FrameGateDeps {
  /** Fetches a still. Defaults to the visual gate's own downloader. */
  fetchImage?: (url: string) => Promise<FetchedImage>
  /** Decodes bytes to raw pixels, or null. Defaults to sharp. */
  decode?: (buf: Buffer) => Promise<{ data: Pixels; width: number; height: number; channels: number } | null>
}

async function defaultDecode(buf: Buffer) {
  try {
    const sharp = (await import('sharp')).default
    const { data, info } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true })
    return { data, width: info.width, height: info.height, channels: info.channels }
  } catch {
    return null
  }
}

/** One still: fetched and analysed, retried once when the fetch or the decode fails. Null means "could not look". */
async function lookAt(url: string | undefined, analyse: typeof analyseReelCover, deps: FrameGateDeps): Promise<FrameCheck | null> {
  if (!url) return null
  const fetchImage = deps.fetchImage ?? ((u: string) => fetchRenderedImage(u))
  const decode = deps.decode ?? defaultDecode
  for (let attempt = 0; attempt < 2; attempt++) {
    const got = await fetchImage(url)
    if (!got.ok) continue
    const px = await decode(got.buf)
    if (!px) continue
    const result = analyse(px.data, px.width, px.height, px.channels)
    return result.infra ? null : result
  }
  return null
}

/** Looks at the cover still and the end card still of a finished render. 'fail' on the cover (or end card) means do not post. Never throws. */
export async function gateReelFrames(urls: { posterUrl?: string; endUrl?: string }, deps: FrameGateDeps = {}): Promise<FrameGateResult> {
  try {
    const cover = await lookAt(urls.posterUrl, analyseReelCover, deps)
    const end = await lookAt(urls.endUrl, analyseReelEndCard, deps)
    const reasons = [...(cover && !cover.ok ? cover.reasons.map((r) => `cover: ${r}`) : []), ...(end && !end.ok ? end.reasons.map((r) => `end card: ${r}`) : [])]
    const checked = { cover: !!cover, end: !!end }
    if (reasons.length > 0) return { verdict: 'fail', reasons, checked }
    return { verdict: checked.cover || checked.end ? 'pass' : 'unknown', reasons: [], checked }
  } catch {
    return { verdict: 'unknown', reasons: [], checked: { cover: false, end: false } }
  }
}
