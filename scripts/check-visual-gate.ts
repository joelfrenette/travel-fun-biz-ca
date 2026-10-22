// Calibration and regression check for the Instagram visual gate (lib/visual-gate.ts) and its counters
// (lib/visual-gate-stats.ts). Builds synthetic good and bad 1080x1350 PNGs with sharp, plus good covers made from the
// real photos in /public, and asserts pass or fail. No network, no database.
// Run: pnpm dlx tsx scripts/check-visual-gate.ts
import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import {
  checkVisual,
  analysePixels,
  gateSummary,
  fetchRenderedImage,
  BLOCK_AREA_MAX,
  BLOCK_AREA_MIN,
  MIN_MEAN_SATURATION,
  MIN_LUMA_STD,
  MIN_PHOTO_DETAIL,
  type GateKind,
  type GateResult,
} from '../lib/visual-gate'
import { gateComposedCover, visualTags } from '../lib/cover-gate'
import { retryCoverHeadline } from '../lib/carousel'
import { shorterCoverHeadline, parseAlt, photoIdOf, socialCoverUrl } from '../lib/social-cover'
import { bumpStats, sumRecent, parseStats, emptyStats, STATS_KEEP_DAYS } from '../lib/visual-gate-stats'

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : detail ? `  (${detail})` : ''}`)
  if (!ok) failures++
}

const W = 1080
const H = 1350
type RGB = [number, number, number]
const RED: RGB = [216, 31, 38]
const WHITE: RGB = [255, 255, 255]
const TEAL: RGB = [15, 111, 124]

interface Img {
  data: Buffer
  w: number
  h: number
}

function solid(w: number, h: number, c: RGB): Img {
  const data = Buffer.alloc(w * h * 3)
  for (let i = 0; i < w * h; i++) {
    data[i * 3] = c[0]
    data[i * 3 + 1] = c[1]
    data[i * 3 + 2] = c[2]
  }
  return { data, w, h }
}

function rect(img: Img, x0: number, y0: number, x1: number, y1: number, c: RGB) {
  for (let y = Math.max(0, y0); y < Math.min(img.h, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(img.w, x1); x++) {
      const i = (y * img.w + x) * 3
      img.data[i] = c[0]
      img.data[i + 1] = c[1]
      img.data[i + 2] = c[2]
    }
  }
}

let seed = 12345
const rnd = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296
  return seed / 4294967296
}

/** A photo-like frame: colour gradients, soft blobs and noise (saturated, varied luminance, plenty of detail). */
function syntheticPhoto(w = W, h = H): Img {
  const img = solid(w, h, [0, 0, 0])
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3
      const blob = 45 * Math.sin(x / 61) * Math.cos(y / 83) + 30 * Math.sin((x + y) / 140)
      img.data[i] = Math.max(0, Math.min(255, 40 + (150 * x) / w + blob + (rnd() - 0.5) * 40))
      img.data[i + 1] = Math.max(0, Math.min(255, 110 + (80 * y) / h - blob / 2 + (rnd() - 0.5) * 40))
      img.data[i + 2] = Math.max(0, Math.min(255, 170 - (90 * x) / w + blob / 2 + (rnd() - 0.5) * 40))
    }
  }
  return img
}

function gradientOnly(): Img {
  const img = solid(W, H, [0, 0, 0])
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const t = (x * 0.4 + y * 0.6) / (W * 0.4 + H * 0.6)
      const i = (y * W + x) * 3
      img.data[i] = Math.round(29 + t * (216 - 29))
      img.data[i + 1] = Math.round(111 + t * (31 - 111))
      img.data[i + 2] = Math.round(138 + t * (38 - 138))
    }
  }
  return img
}

async function realPhoto(file: string): Promise<Img> {
  const { data, info } = await sharp(file).resize(W, H, { fit: 'cover' }).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  return { data, w: info.width, h: info.height }
}

/** Letter-like white rectangles (44 wide, 86 tall, 14 gap) centred on `cx`, `lines` rows, inside a block box. */
function drawHeadlineText(img: Img, x0: number, y0: number, x1: number, lines: number, lineH = 130, letterH = 86) {
  const cx = (x0 + x1) / 2
  for (let l = 0; l < lines; l++) {
    const letters = Math.max(3, Math.floor(((x1 - x0) * 0.8) / 58) - l * 2)
    const lw = letters * 58 - 14
    const ly = y0 + 26 + l * lineH + Math.round((lineH - letterH) / 2)
    for (let k = 0; k < letters; k++) {
      const lx = Math.round(cx - lw / 2 + k * 58)
      rect(img, lx, ly, lx + 44, ly + letterH, WHITE)
      rect(img, lx + 12, ly + 20, lx + 32, ly + letterH - 20, RED) // a counter, like the hole in an O
    }
  }
}

interface CoverOpts {
  photo?: Img
  left?: number
  right?: number
  top?: number
  lines?: number
  noBlock?: boolean
  noText?: boolean
  noStrip?: boolean
  edgeText?: boolean
  blockHeight?: number
}

/** A cover as the route draws it: photo, red block with text, brand strip. Options break one thing at a time. */
function cover(o: CoverOpts = {}): Img {
  const img = o.photo ? { data: Buffer.from(o.photo.data), w: o.photo.w, h: o.photo.h } : syntheticPhoto()
  const lines = o.lines ?? 3
  const left = o.left ?? 100
  const right = o.right ?? 980
  const top = o.top ?? 270
  const bh = o.blockHeight ?? lines * 130 + 52
  if (!o.noBlock) {
    rect(img, left, top, right, top + bh, RED)
    if (!o.noText) drawHeadlineText(img, left, top, right, lines)
  }
  if (o.edgeText) {
    // A word cut by the frame: white letters touching a red strip at the very left edge.
    rect(img, 0, 700, 60, 790, RED)
    rect(img, 0, 710, 30, 780, WHITE)
  }
  if (!o.noStrip) {
    rect(img, 270, 1206, 810, 1260, [20, 20, 20])
    for (let k = 0; k < 15; k++) rect(img, 300 + k * 33, 1222, 300 + k * 33 + 22, 1246, WHITE)
  }
  return img
}

interface CardOpts {
  bg?: RGB
  noText?: boolean
  noStrip?: boolean
  edgeText?: boolean
}

function card(o: CardOpts = {}): Img {
  const img = solid(W, H, o.bg ?? TEAL)
  if (!o.noText) {
    for (let l = 0; l < 4; l++) {
      for (let k = 0; k < 14; k++) rect(img, 120 + k * 56 + (l % 2) * 20, 420 + l * 120, 120 + k * 56 + 36 + (l % 2) * 20, 420 + l * 120 + 80, WHITE)
    }
  }
  rect(img, 330, 90, 750, 140, [11, 85, 96])
  for (let k = 0; k < 12; k++) rect(img, 350 + k * 32, 102, 350 + k * 32 + 20, 128, WHITE)
  if (!o.noStrip) for (let k = 0; k < 15; k++) rect(img, 300 + k * 33, 1222, 300 + k * 33 + 22, 1246, WHITE)
  if (o.edgeText) rect(img, 0, 500, 40, 560, WHITE)
  return img
}

async function png(img: Img): Promise<Buffer> {
  return sharp(img.data, { raw: { width: img.w, height: img.h, channels: 3 } }).png().toBuffer()
}

async function gate(img: Img, kind: GateKind): Promise<GateResult> {
  return checkVisual(await png(img), kind)
}

async function expectPass(name: string, img: Img, kind: GateKind) {
  const r = await gate(img, kind)
  check(`good: ${name}`, r.ok && !r.infra, gateSummary(r))
  return r
}
async function expectFail(name: string, img: Img, kind: GateKind, reasonPart: string) {
  const r = await gate(img, kind)
  check(`bad: ${name}`, !r.ok && r.reasons.some((x) => x.includes(reasonPart)), r.ok ? 'it passed' : `reasons: ${r.reasons.join(' | ')}`)
}

async function main() {
  console.log(`thresholds: area ${BLOCK_AREA_MIN}..${BLOCK_AREA_MAX}, saturation >= ${MIN_MEAN_SATURATION} or luma std >= ${MIN_LUMA_STD}, photo detail >= ${MIN_PHOTO_DETAIL}`)

  // ---- synthetic covers ----
  const good = await expectPass('synthetic photo, 3 line block centred', cover(), 'cover')
  await expectPass('synthetic photo, 1 line block', cover({ lines: 1, left: 160, right: 920 }), 'cover')
  await expectPass('synthetic photo, 2 line block, narrow', cover({ lines: 2, left: 220, right: 860 }), 'cover')
  console.log(`      metrics of the synthetic good cover: ${JSON.stringify({ ...good.metrics, block: undefined })} block ${JSON.stringify(good.metrics?.block)}`)

  await expectFail('no block at all', cover({ noBlock: true }), 'cover', 'no red headline block')
  await expectFail('block clipped at the left edge', cover({ left: 0, right: 700 }), 'cover', 'side margins')
  await expectFail('block outside the side margins', cover({ left: 40, right: 1040 }), 'cover', 'side margins')
  await expectFail('block clipped at the right edge', cover({ left: 400, right: 1080 }), 'cover', 'side margins')
  await expectFail('block touching the top edge', cover({ top: 6 }), 'cover', 'top or bottom edge')
  await expectFail('block far too big', cover({ lines: 3, blockHeight: 1000, top: 130 }), 'cover', 'too big')
  await expectFail('block too small', cover({ lines: 1, left: 420, right: 700 }), 'cover', 'too small')
  await expectFail('empty block, no text in it', cover({ noText: true }), 'cover', 'no readable text')
  await expectFail('no brand strip', cover({ noStrip: true }), 'cover', 'strip is missing')
  const brightBottom = syntheticPhoto()
  rect(brightBottom, 0, 1150, W, H, [245, 245, 245])
  await expectFail('bright sky at the bottom is not a brand strip', cover({ photo: brightBottom, noStrip: true }), 'cover', 'strip is missing')
  await expectPass('bright sand at the bottom with the strip drawn', cover({ photo: brightBottom }), 'cover')
  await expectFail('white text clipped at the frame edge', cover({ edgeText: true }), 'cover', 'clipped')
  const grey = solid(W, H, [128, 128, 128])
  await expectFail('flat grey photo', cover({ photo: grey }), 'cover', 'flat or dull')
  await expectFail('gradient only (the photo did not load)', cover({ photo: gradientOnly() }), 'cover', 'no photo detail')
  await expectFail('wrong size', solid(600, 600, [10, 10, 10]), 'cover', 'unexpected image size')

  // A smaller render of the same design still passes (distances are scaled).
  const half = await sharp(await png(cover())).resize(540, 675).png().toBuffer()
  const halfRes = await checkVisual(half, 'cover')
  check('good: the same cover rendered at 540 wide', halfRes.ok, gateSummary(halfRes))

  // ---- real photos from /public, composed as the route composes them ----
  const pubDir = path.join(__dirname, '..', 'public')
  const files = fs
    .readdirSync(pubDir)
    .filter((f) => /\.(jpe?g|png)$/i.test(f) && !/logo|portrait|smiling|couple|woman|man-/i.test(f))
    .slice(0, 14)
  console.log(`      calibrating on ${files.length} real photos from /public`)
  let minSat = 1
  let minStd = 1
  let minDetail = 1
  for (const f of files) {
    let photo: Img
    try {
      photo = await realPhoto(path.join(pubDir, f))
    } catch {
      continue
    }
    const r = await gate(cover({ photo }), 'cover')
    const m = r.metrics
    if (m?.meanSaturation !== undefined) minSat = Math.min(minSat, m.meanSaturation)
    if (m?.lumaStd !== undefined) minStd = Math.min(minStd, m.lumaStd)
    if (m?.photoDetail !== undefined) minDetail = Math.min(minDetail, m.photoDetail)
    check(`good: real photo ${f}`, r.ok, gateSummary(r))
    console.log(`      ${f}: sat ${m?.meanSaturation?.toFixed(3)} std ${m?.lumaStd?.toFixed(3)} detail ${m?.photoDetail?.toFixed(4)}`)
  }
  console.log(`      lowest over real photos: saturation ${minSat.toFixed(3)}, luma std ${minStd.toFixed(3)}, detail ${minDetail.toFixed(4)}`)
  check('detail threshold sits below every real photo', minDetail > MIN_PHOTO_DETAIL * 1.5, `${minDetail} vs ${MIN_PHOTO_DETAIL}`)

  // ---- teal cards ----
  await expectPass('news card', card(), 'news')
  await expectPass('fact card (no brand strip needed)', card({ noStrip: true }), 'fact')
  await expectFail('news card without the brand strip', card({ noStrip: true }), 'news', 'strip is missing')
  await expectFail('news card without a headline', card({ noText: true }), 'news', 'no readable headline')
  await expectFail('news card that is not teal', card({ bg: [90, 90, 90] }), 'news', 'not teal')
  await expectFail('news card with text clipped at the edge', card({ edgeText: true }), 'news', 'clipped')

  // ---- raw buffer entry point, RGBA input ----
  const rgba = Buffer.alloc(W * H * 4)
  const base = cover()
  for (let i = 0; i < W * H; i++) {
    rgba[i * 4] = base.data[i * 3]
    rgba[i * 4 + 1] = base.data[i * 3 + 1]
    rgba[i * 4 + 2] = base.data[i * 3 + 2]
    rgba[i * 4 + 3] = 255
  }
  check('analysePixels reads RGBA', analysePixels(rgba, W, H, 4, 'cover').ok)
  check('analysePixels flags short pixel data as an infrastructure problem', analysePixels(Buffer.alloc(10), W, H, 3, 'cover').infra === true)

  // ---- infrastructure errors never pass ----
  const broken = await checkVisual(Buffer.from('not an image'), 'cover')
  check('an undecodable image is infra, not a pass', !broken.ok && broken.infra === true)
  const failFetch = await fetchRenderedImage('https://example.invalid/x.png', (async () => {
    throw new Error('offline')
  }) as unknown as typeof fetch)
  check('a failed fetch is reported, not thrown', failFetch.ok === false)
  const okFetch = await fetchRenderedImage('https://example.test/x.png', (async () => new Response(await png(cover()), { headers: { 'content-type': 'image/png', 'x-cover-photo-id': '12345', 'x-cover-template': 'red-block-v1' } })) as unknown as typeof fetch)
  check('a fetch returns the photo id and template headers', okFetch.ok && okFetch.headers.photoId === '12345' && okFetch.headers.template === 'red-block-v1')

  // ---- cover retry orchestration (lib/cover-gate.ts) with a fake route ----
  const goodPng = await png(cover())
  const badPng = await png(cover({ noBlock: true }))
  const route = (byAlt: Record<string, Buffer | 'throw' | number>) =>
    (async (url: string) => {
      const alt = /alt=(\d)/.exec(url)?.[1] ?? '0'
      const v = byAlt[alt]
      if (v === 'throw') throw new Error('offline')
      if (typeof v === 'number') return new Response('x', { status: v, headers: { 'content-type': 'text/plain' } })
      return new Response(v, { headers: { 'content-type': 'image/png', 'x-cover-photo-id': `p${alt}`, 'x-cover-template': 'red-block-v1' } })
    }) as unknown as typeof fetch
  const run = (byAlt: Record<string, Buffer | 'throw' | number>, hasTime = () => true) => gateComposedCover({ base: 'https://x.test', kind: 'blog', slug: 'a-post', hasTime, fetchImpl: route(byAlt) })
  const o1 = await run({ 0: goodPng, 1: badPng, 2: badPng })
  check('cover gate: plain cover passes first time, no retries', o1.status === 'pass' && o1.retries === 0 && o1.url === 'https://x.test/social-cover/blog/a-post' && o1.photoId === 'p0', JSON.stringify(o1))
  const o2 = await run({ 0: badPng, 1: goodPng, 2: badPng })
  check('cover gate: a failing cover is retried and the alt=1 address is the one sent', o2.status === 'pass' && o2.retries === 1 && o2.url === 'https://x.test/social-cover/blog/a-post?alt=1' && o2.photoId === 'p1', JSON.stringify(o2))
  const o3 = await run({ 0: badPng, 1: badPng, 2: goodPng })
  check('cover gate: passes on the second retry', o3.status === 'pass' && o3.retries === 2 && o3.url?.endsWith('?alt=2') === true)
  const o4 = await run({ 0: badPng, 1: badPng, 2: badPng })
  check('cover gate: three failures skip, never a url', o4.status === 'skip' && o4.retries === 2 && !o4.url && o4.reasons.length > 0, JSON.stringify(o4))
  const o5 = await run({ 0: 'throw', 1: goodPng, 2: goodPng })
  check('cover gate: a fetch error defers (never posts unchecked)', o5.status === 'deferred' && !o5.url)
  const o6 = await run({ 0: 503, 1: goodPng, 2: goodPng })
  check('cover gate: a 503 from the route defers', o6.status === 'deferred')
  const o7 = await run({ 0: badPng, 1: goodPng, 2: goodPng }, (() => { let n = 0; return () => n++ < 1 })())
  check('cover gate: out of time after the first try returns budget', o7.status === 'budget' && !o7.url)
  const news = await gateComposedCover({ base: 'https://x.test', kind: 'news', slug: 'news-x', hasTime: () => true, fetchImpl: (async () => new Response(await png(card()), { headers: { 'content-type': 'image/png', 'x-cover-template': 'news-card' } })) as unknown as typeof fetch })
  check('cover gate: a news card is checked as a teal card', news.status === 'pass' && news.template === 'news-card', JSON.stringify(news))
  const tags = visualTags('feed', 'red-block-v1', { ok: true, reasons: [], retries: 1 }, '777')
  check('tags carry template, gate result and photo id', tags.cover_template === 'red-block-v1' && tags['cover_template:feed'] === 'red-block-v1' && tags.gate_result === 'pass-after-1-retry' && tags.photo_id === '777')
  const failTags = visualTags('carousel', 'red-block-v1', { ok: false, reasons: ['no red headline block'] })
  check('a failed gate is tagged with its reason', String(failTags.gate_result).startsWith('fail: ') && !('photo_id' in failTags))
  check('retry headlines get shorter', retryCoverHeadline('BEST TIME TO VISIT ZANZIBAR NOW', 'Zanzibar Travel Guide', 2).split(' ').length <= 3 && shorterCoverHeadline('A B C D E F', 1).split(' ').length <= 4)
  check('retry alt only accepts 1 and 2', parseAlt('?alt=1') === 1 && parseAlt('?alt=2') === 2 && parseAlt('?alt=3') === 0 && parseAlt('?x=1') === 0 && parseAlt('') === 0)
  check('socialCoverUrl adds alt only for 1 and 2', socialCoverUrl('https://x.test', 'blog', 's', 2).endsWith('?alt=2') && !socialCoverUrl('https://x.test', 'blog', 's', 3).includes('alt'))
  check('photo ids are read from Pexels addresses', photoIdOf('https://images.pexels.com/photos/1234567/pexels-photo-1234567.jpeg?auto=compress') === '1234567' && photoIdOf('https://x.test/a.jpg') === null)

  // ---- counters ----
  const t0 = new Date('2026-10-21T12:00:00Z')
  let st = emptyStats()
  st = bumpStats(st, 'pass', t0)
  st = bumpStats(st, 'pass', t0)
  st = bumpStats(st, 'retry', t0)
  st = bumpStats(st, 'skip', t0, { slug: 'a-post', surface: 'feed', reason: 'no red headline block' })
  check('counters add up for one day', JSON.stringify(sumRecent(st, t0)) === JSON.stringify({ pass: 2, retry: 1, skip: 1, deferred: 0 }), JSON.stringify(sumRecent(st, t0)))
  check('the skip is logged with its reason', st.recentSkips.length === 1 && st.recentSkips[0].reason === 'no red headline block')
  const t8 = new Date('2026-10-29T12:00:00Z')
  st = bumpStats(st, 'pass', t8)
  check('a count from 8 days ago is outside the 7 day window', sumRecent(st, t8).pass === 1)
  const t20 = new Date(t0.getTime() + (STATS_KEEP_DAYS + 3) * 86_400_000)
  st = bumpStats(st, 'deferred', t20)
  check('days older than the retention are dropped', !('2026-10-21' in st.days))
  check('unreadable stored stats fall back to empty', JSON.stringify(parseStats('{not json')) === JSON.stringify(emptyStats()))
  check('absent stored stats fall back to empty', JSON.stringify(parseStats(null)) === JSON.stringify(emptyStats()))

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
