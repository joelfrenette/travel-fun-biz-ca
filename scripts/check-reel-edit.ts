// Offline checks for the reel (short video) edit built by lib/shotstack.ts: the cover frame matches the feed cover style,
// captions sit inside the safe zones, and the cover headline is checked before a render is submitted.
// Pure functions only: nothing here calls Shotstack. Run: pnpm dlx tsx scripts/check-reel-edit.ts
import {
  buildVideoEdit,
  reelCoverFontSize,
  REEL_WIDTH,
  REEL_HEIGHT,
  REEL_SAFE_SIDE,
  REEL_SAFE_BOTTOM,
  CAPTION_MIN_FONT,
  REEL_RED,
  TEXT_WIDTH,
  type ShotstackEdit,
  type ShotstackClip,
} from '../lib/shotstack'
import { reelCoverTitleFor, type VideoScript } from '../lib/video-script'
import { checkReelCoverTitle, pickReelCoverTitle, REEL_COVER_MAX_WORDS } from '../lib/cover-headline'

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : detail ? `  (${detail})` : ''}`)
  if (!ok) failures++
}

const script = (coverTitle?: string): VideoScript => ({
  hook: 'Cancun or Tulum, which one fits you?',
  coverTitle,
  beats: [
    { scene: 'beach', onScreenText: 'White sand beaches', voiceover: 'Cancun has long white beaches and big resorts.', brollSearchTerms: ['cancun beach'] },
    { scene: 'ruins', onScreenText: 'Ruins by the sea', voiceover: 'Tulum has quiet ruins right by the water.', brollSearchTerms: ['tulum ruins'] },
    { scene: 'cta', onScreenText: 'travelfunbiz.ca', voiceover: 'The full guide is on travelfunbiz.ca.', brollSearchTerms: ['travel'] },
  ],
  title: 'Cancun or Tulum',
  description: 'd',
  hashtags: [],
})

const edit = buildVideoEdit(script('Cancun or Tulum'), [{ videoUrl: 'https://v.test/a.mp4' }, { videoUrl: 'https://v.test/b.mp4' }, {}], 'https://images.pexels.com/photos/1/a.jpeg', 'Cancun or Tulum', 'TRAVELFUNBIZ.CA')
const clips = (e: ShotstackEdit) => e.timeline.tracks.flatMap((t) => t.clips)
const assetType = (c: ShotstackClip) => String(c.asset.type)

// ---- schema shape (the parts of Shotstack's Edit API this project relies on) ----
const KNOWN_ASSETS = new Set(['image', 'video', 'rich-text', 'rich-caption', 'text-to-speech', 'shape'])
check('output is 9:16 hd (720x1280) mp4', edit.output.format === 'mp4' && edit.output.resolution === 'hd' && edit.output.aspectRatio === '9:16' && REEL_WIDTH === 720 && REEL_HEIGHT === 1280)
check('every clip uses a known asset type with numeric timing', clips(edit).every((c) => KNOWN_ASSETS.has(assetType(c)) && (typeof c.start === 'number' || typeof c.start === 'string') && Number(c.length) > 0))
check('rich-text keeps stroke beside font, never inside it', clips(edit).filter((c) => assetType(c) === 'rich-text').every((c) => !('stroke' in (c.asset.font as Record<string, unknown>))))
check('the edit round-trips through JSON unchanged', JSON.stringify(JSON.parse(JSON.stringify(edit))) === JSON.stringify(edit))
const shape = clips(edit).find((c) => assetType(c) === 'shape')
check('the cover overlay is a rectangle shape with a fill', !!shape && shape.asset.shape === 'rectangle' && typeof (shape.asset.fill as { opacity: number }).opacity === 'number')

// ---- cover frame (0 to 3 seconds) ----
const coverClips = clips(edit).filter((c) => Number(c.start) === 0 && Number(c.length) === 3)
const block = coverClips.find((c) => assetType(c) === 'rich-text' && (c.asset.background as { color?: string } | undefined)?.color === REEL_RED)
check('cover has the red #d81f26 block', !!block)
check('red block is solid (opacity 1, square corners)', !!block && (block.asset.background as { opacity: number; borderRadius: number }).opacity === 1 && (block.asset.background as { borderRadius: number }).borderRadius === 0)
check('red block is centred horizontally and inset at least 80px each side', !!block && block.position === 'center' && Number(block.width) <= REEL_WIDTH - 2 * REEL_SAFE_SIDE)
const centreFromTop = block ? (0.5 - Number((block.offset as { y: number }).y)) * REEL_HEIGHT : 0
check('red block centre is in the upper third of the frame', centreFromTop > 0 && centreFromTop < REEL_HEIGHT / 3, String(centreFromTop))
check('headline is uppercase, white, bold', !!block && block.asset.text === 'CANCUN OR TULUM' && (block.asset.font as { color: string; weight: string }).color === '#ffffff' && (block.asset.font as { weight: string }).weight === '700' && (block.asset.style as { textTransform?: string }).textTransform === 'uppercase')
check('headline is 5 words at most', !!block && String(block.asset.text).split(' ').length <= REEL_COVER_MAX_WORDS)
const strip = coverClips.find((c) => String(c.asset.text) === 'TRAVELFUNBIZ.CA')
check('TRAVELFUNBIZ.CA strip is at the bottom of the cover', !!strip && strip.position === 'bottom' && Number((strip.offset as { y: number }).y) < 0.15)
const coverPhoto = clips(edit).find((c) => assetType(c) === 'image' && Number(c.start) === 0)
check('cover photo is not dimmed (no darken filter)', !!coverPhoto && coverPhoto.filter === undefined)
check('light overlay is 20% or less', !!shape && (shape.asset.fill as { opacity: number }).opacity <= 0.2)
const broll = clips(edit).filter((c) => (assetType(c) === 'video' || assetType(c) === 'image') && Number(c.start) > 0)
check('b-roll under the captions is darkened', broll.length >= 2 && broll.every((c) => c.filter === 'darken'))

// ---- captions and burned-in text: safe zones ----
const caption = clips(edit).find((c) => assetType(c) === 'rich-caption')
check('captions are at least 44px with a stroke', !!caption && (caption.asset.font as { size: number }).size >= CAPTION_MIN_FONT && (caption.asset.stroke as { width: number }).width >= 2)
check('captions are inset 80px on each side', !!caption && Number(caption.width) <= REEL_WIDTH - 2 * REEL_SAFE_SIDE && TEXT_WIDTH === 560)
check('captions stay 220px clear of the bottom', !!caption && caption.position === 'bottom' && Number((caption.offset as { y: number }).y) * REEL_HEIGHT >= REEL_SAFE_BOTTOM, String(Number((caption?.offset as { y: number }).y) * REEL_HEIGHT))
check('on-screen beat text is inset 80px on each side', clips(edit).filter((c) => assetType(c) === 'rich-text' && Number(c.start) >= 3).every((c) => Number(c.width) <= REEL_WIDTH - 2 * REEL_SAFE_SIDE))
check('the caption reads from the narration clip', !!caption && caption.asset.src === 'alias://narration' && clips(edit).some((c) => c.alias === 'narration'))

// ---- a bad cover title never reaches the frame ----
const longEdit = buildVideoEdit(script('The ultimate guide to everything you need to know about Mexico'), [], undefined, 'The ultimate guide to everything you need to know about Mexico')
const longBlock = clips(longEdit).find((c) => assetType(c) === 'rich-text' && (c.asset.background as { color?: string } | undefined)?.color === REEL_RED)
check('an over-long cover title is replaced or cut to 5 words', !!longBlock && String(longBlock.asset.text).split(' ').length <= REEL_COVER_MAX_WORDS, String(longBlock?.asset.text))
check('cover font fits the block (longest word)', reelCoverFontSize('DESTINATIONS GUIDE') >= 48 && reelCoverFontSize('BALI OR LOMBOK?') <= 84)

// ---- the pre-submit text check ----
check('a good title passes the reel check', checkReelCoverTitle('Cancun or Tulum', 'Cancun or Tulum').ok)
check('6 words fail the reel check', !checkReelCoverTitle('Is Cancun or Tulum better today?', 'Is Cancun or Tulum better today').ok)
check('a title ending on "the" fails', !checkReelCoverTitle('Why Cancun beats the', 'x').ok)
const s = script('Why you should visit Mexico this winter season')
const picked = reelCoverTitleFor(s, 'Cancun or Tulum')
check('a failing model title falls back to a whole phrase of the post title first', picked.ok && picked.usedFallback && picked.title === 'Cancun or Tulum', JSON.stringify(picked))
const none = pickReelCoverTitle(['Discover Mexico now'], 'The Ultimate Beginners Complete Travel Planning Resource Hub Overview Article', 'x')
check('when nothing valid exists the reel is rejected, not guessed', none.ok === false && none.reasons.length > 0, JSON.stringify(none))
const ok1 = reelCoverTitleFor(script('Cancun or Tulum'), 'Cancun vs Tulum cruise ports')
check('a good model title is kept', ok1.ok && !ok1.usedFallback && ok1.title === 'Cancun or Tulum')

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
