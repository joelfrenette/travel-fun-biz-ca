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
  REEL_SAFE_TOP,
  REEL_MIN_FONT,
  REEL_BEAT_MAX_WORDS,
  REEL_SHORT_URL,
  END_CARD_SECONDS,
  endCardCta,
  beatLine,
  reelTextBoxes,
  reelTiming,
  captionCollisions,
  type ReelPlatform,
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
const coverEnd = reelTiming(script('Cancun or Tulum')).coverEnd
check('the cover window is the hook beat (3 seconds at least, longer for a longer hook)', coverEnd >= 3 && coverEnd <= 4, String(coverEnd))
const coverClips = clips(edit).filter((c) => Number(c.start) === 0 && Math.abs(Number(c.length) - coverEnd) < 0.01 && assetType(c) !== 'text-to-speech' && assetType(c) !== 'rich-caption')
const block = coverClips.find((c) => assetType(c) === 'rich-text' && (c.asset.background as { color?: string } | undefined)?.color === REEL_RED)
check('cover has the red #d81f26 block', !!block)
check('red block is solid (opacity 1, square corners)', !!block && (block.asset.background as { opacity: number; borderRadius: number }).opacity === 1 && (block.asset.background as { borderRadius: number }).borderRadius === 0)
check('red block is centred horizontally and inset at least 80px each side', !!block && block.position === 'center' && Number(block.width) <= REEL_WIDTH - 2 * REEL_SAFE_SIDE)
const centreFromTop = block ? (0.5 - Number((block.offset as { y: number }).y)) * REEL_HEIGHT : 0
check('red block centre is in the upper third of the frame', centreFromTop > 0 && centreFromTop < REEL_HEIGHT / 3, String(centreFromTop))
check('headline is uppercase, white, bold', !!block && block.asset.text === 'CANCUN OR TULUM' && (block.asset.font as { color: string; weight: string }).color === '#ffffff' && (block.asset.font as { weight: string }).weight === '700' && (block.asset.style as { textTransform?: string }).textTransform === 'uppercase')
check('headline is 5 words at most', !!block && String(block.asset.text).split(' ').length <= REEL_COVER_MAX_WORDS)
const strip = coverClips.find((c) => String(c.asset.text) === 'TRAVELFUNBIZ.CA')
check('TRAVELFUNBIZ.CA strip sits under the red block, outside the bottom safe zone', !!strip && strip.position === 'center' && Number((strip.offset as { y: number }).y) < 0.5 && Number((strip.offset as { y: number }).y) > -0.5)
const coverPhoto = clips(edit).find((c) => assetType(c) === 'image' && Number(c.start) === 0)
check('cover photo is not dimmed (no darken filter)', !!coverPhoto && coverPhoto.filter === undefined)
check('light overlay is 20% or less', !!shape && (shape.asset.fill as { opacity: number }).opacity <= 0.2)
const editEnd = Math.max(...clips(edit).map((c) => Number(c.start) + Number(c.length)))
const broll = clips(edit).filter((c) => (assetType(c) === 'video' || assetType(c) === 'image') && Number(c.start) > 0 && Number(c.start) + Number(c.length) < editEnd - 0.01)
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

// ---- geometry rules, asserted on several samples (docs/factory/SOCIAL-QUALITY-LOOP.md part 1) ----
// Instagram covers the top 250px and bottom 340px of a 1080 x 1920 reel: 167px and 227px on this 720 x 1280 canvas.
check('safe zones are scaled from 1080x1920 (167 top, 227 bottom)', REEL_SAFE_TOP === 167 && REEL_SAFE_BOTTOM === 227, `${REEL_SAFE_TOP}/${REEL_SAFE_BOTTOM}`)
const CENTRE_TOLERANCE = 1 // pixels
const sample = (hook: string, beats: Array<[string, string]>, cover: string, coverImage?: string, platform?: ReelPlatform): ShotstackEdit =>
  buildVideoEdit(
    { hook, coverTitle: cover, title: cover, description: 'd', hashtags: [], beats: beats.map(([onScreenText, voiceover]) => ({ scene: 's', onScreenText, voiceover, brollSearchTerms: ['x'] })) },
    beats.map(() => ({ videoUrl: 'https://v.test/a.mp4' })),
    coverImage,
    cover,
    'TRAVELFUNBIZ.CA',
    { platform },
  )
const samples: Array<[string, ShotstackEdit]> = [
  ['two beats, short cover', sample('Cancun or Tulum, which one fits you?', [['White sand beaches', 'Cancun has long white beaches.'], ['Ruins by the sea', 'Tulum has quiet ruins.']], 'Cancun or Tulum', 'https://i.test/a.jpg')],
  ['long cover title wraps to 3 lines', sample('Is a Rhine cruise worth it?', [['Slow river days', 'The pace is easy.'], ['Castles at every bend', 'You pass castles every hour.'], ['travelfunbiz.ca', 'The full guide is on travelfunbiz.ca.']], 'Cologne to Basel by river', 'https://i.test/b.jpg', 'tiktok')],
  ['very long beat text is cut to 7 words', sample('Five mistakes first timers make', [['One two three four five six seven eight nine ten', 'Words words words words words words.']], 'Five mistakes first timers make', undefined, 'youtube')],
  ['nine beats of 3 to 4 seconds, a 2 second interrupt at beat 3, a closing question', sample('Boat or boots: which one are you?', [
    ['Slow river days', 'Slow river days with castles at every single bend.'],
    ['Hiking is different', 'A hiking trip means early starts and long climbs.'],
    ['Nobody tells you this', 'Wait, nobody tells you this.'],
    ['Cabins are unpacked once', 'On a river cruise you unpack your bag one time.'],
    ['Trails are quiet', 'Trails give you quiet mornings and big open views.'],
    ['Meals are planned', 'Cruise meals and tours are planned for you daily.'],
    ['Hikes are flexible', 'A hiking trip lets you change plans on a whim.'],
    ['Both are great', 'Both can be a great fit for the right traveller.'],
    ['Which one are you?', 'Boat or boots: which one are you?'],
  ], 'Boat or boots', 'https://i.test/c.jpg', 'instagram')],
  ['no photo, video only', sample('Reef, outback, cities, fjords', [['Reef days', 'The reef is first.'], ['Outback nights', 'The outback is next.'], ['City lights', 'Then the cities.'], ['Fjords', 'Finally the fjords.']], 'Reef, outback, cities, fjords', undefined, 'facebook')],
]
for (const [name, e] of samples) {
  const boxes = reelTextBoxes(e)
  const total = Math.max(...clips(e).map((c) => Number(c.start) + Number(c.length)))
  // 1. horizontally centred with equal margins
  check(`${name}: every text box is centred (left margin = right margin) within ${CENTRE_TOLERANCE}px`, boxes.every((b) => Math.abs(b.left - (REEL_WIDTH - b.right)) <= CENTRE_TOLERANCE), JSON.stringify(boxes.map((b) => [b.left, REEL_WIDTH - b.right])))
  check(`${name}: margins are at least 80px each side`, boxes.every((b) => b.left >= REEL_SAFE_SIDE - 0.5 && REEL_WIDTH - b.right >= REEL_SAFE_SIDE - 0.5))
  check(`${name}: every rich-text asset is centre aligned`, clips(e).filter((c) => assetType(c) === 'rich-text').every((c) => (c.asset.align as { horizontal?: string }).horizontal === 'center') && (clips(e).find((c) => assetType(c) === 'rich-caption')?.asset.align as { horizontal?: string }).horizontal === 'center')
  // 2. inside the Instagram safe zones
  check(`${name}: all text sits between the top (167px) and bottom (227px) safe zones`, boxes.every((b) => b.top >= REEL_SAFE_TOP && b.bottom <= REEL_HEIGHT - REEL_SAFE_BOTTOM), JSON.stringify(boxes.filter((b) => b.top < REEL_SAFE_TOP || b.bottom > REEL_HEIGHT - REEL_SAFE_BOTTOM).map((b) => [b.text, Math.round(b.top), Math.round(b.bottom)])))
  // 3. size
  check(`${name}: every text is at least 44px`, boxes.every((b) => b.fontSize >= REEL_MIN_FONT), JSON.stringify(boxes.map((b) => b.fontSize)))
  check(`${name}: burned-in text is readable (stroke on captions and beat text, or a solid or dark block behind it)`, clips(e).filter((c) => assetType(c) === 'rich-text' || assetType(c) === 'rich-caption').every((c) => !!c.asset.stroke || !!c.asset.background))
  // 4. hook in the first second, beats short, end card
  check(`${name}: the cover headline is on screen from frame 0 (within the first second)`, boxes.some((b) => b.kind === 'rich-text' && b.start <= 1 && b.text.length > 0))
  const coverBoxes = boxes.filter((b) => b.kind === 'rich-text' && b.start <= 0.01)
  const coverUntil = Math.max(...coverBoxes.map((b) => b.end))
  check(`${name}: the hook is the only text for the first 2 seconds (no caption, no beat text)`, coverUntil >= 2 && boxes.filter((b) => b.start < 2 - 0.01).every((b) => b.kind === 'rich-text' && b.start <= 0.01), JSON.stringify(boxes.filter((b) => b.start < 2).map((b) => [b.kind, b.start])))
  check(`${name}: no burned caption overlaps the cover headline block or the end card at any moment they share`, captionCollisions(e).length === 0, JSON.stringify(captionCollisions(e).map((c) => [c.caption.start, c.caption.end, c.with.text])))
  check(`${name}: captions start after the cover window and stop before the end card`, boxes.filter((b) => b.kind === 'rich-caption').every((b) => b.start >= coverUntil - 0.01 && b.end <= total - END_CARD_SECONDS + 0.01))
  const beatBoxes = boxes.filter((b) => b.kind === 'rich-text' && b.start >= 3 && b.end < total - END_CARD_SECONDS + 0.01)
  check(`${name}: beat text is 7 words at most`, beatBoxes.length > 0 && beatBoxes.every((b) => b.text.split(/\s+/).length <= REEL_BEAT_MAX_WORDS), JSON.stringify(beatBoxes.map((b) => b.text)))
  const end = boxes.filter((b) => b.kind === 'rich-text' && Math.abs(b.end - total) < 0.01)
  check(`${name}: an end card of 2 to 3 seconds closes the reel`, end.length === 2 && end.every((b) => b.end - b.start >= 2 && b.end - b.start <= 3), JSON.stringify(end.map((b) => [b.start, b.end])))
  const endBlock = clips(e).find((c) => assetType(c) === 'rich-text' && Math.abs(Number(c.start) + Number(c.length) - total) < 0.01 && (c.asset.background as { color?: string }).color === REEL_RED)
  check(`${name}: end card has the red block with the site name`, !!endBlock && String(endBlock.asset.text) === 'TRAVELFUNBIZ.CA')
  const cta = end.find((b) => /plan your trip/i.test(b.text))
  check(`${name}: end card has one call to action line`, !!cta && cta.text.split('\n').length === 1, cta?.text)
  // 5. no overlap between text boxes that are on screen together (caption track vs beat text vs cover vs end card)
  const overlaps: string[] = []
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]
      const b = boxes[j]
      const together = a.start < b.end - 0.01 && b.start < a.end - 0.01
      const touching = a.top < b.bottom && b.top < a.bottom && a.left < b.right && b.left < a.right
      if (together && touching) overlaps.push(`${a.text || 'captions'} x ${b.text || 'captions'}`)
    }
  }
  check(`${name}: no two text boxes overlap while on screen together`, overlaps.length === 0, overlaps.join(' | '))
  // 6. darkening only where text sits on it: every darkened clip has a beat text on screen for its whole span, the cover and end card photos stay bright
  const darkened = clips(e).filter((c) => c.filter === 'darken')
  check(`${name}: b-roll is darkened only under beat text (the cover and end card photos are not)`, darkened.length > 0 && darkened.every((c) => beatBoxes.some((b) => b.start <= Number(c.start) + 0.01 && b.end >= Number(c.start) + Number(c.length) - 0.01)), `${darkened.length}`)
  const brightAtEnds = clips(e).filter((c) => (assetType(c) === 'image' || assetType(c) === 'video') && (Number(c.start) === 0 || Math.abs(Number(c.start) + Number(c.length) - total) < 0.01))
  check(`${name}: the photo or clip under the cover and the end card is not darkened`, brightAtEnds.every((c) => c.filter === undefined))
}
// ---- pacing: 8 to 10 beats of 3 to 4 seconds (beat 3 is 2 seconds), one text and one new clip per beat ----
{
  const nine = samples.find(([n]) => n.startsWith('nine beats'))![1]
  const nineTotal = Math.max(...clips(nine).map((c) => Number(c.start) + Number(c.length)))
  const beatClips = clips(nine).filter((c) => assetType(c) === 'rich-text' && c.position === 'top' && Number(c.start) >= 3 && Number(c.start) + Number(c.length) < nineTotal - END_CARD_SECONDS + 0.01)
  const lens = beatClips.map((c) => Math.round(Number(c.length) * 10) / 10)
  check('nine beats make nine beat texts', beatClips.length === 9, String(beatClips.length))
  check('beats are 3 to 4 seconds and beat 3 is 2 seconds', lens.every((l, i) => (i === 2 ? l === 2 : l >= 3 && l <= 4)), JSON.stringify(lens))
  check('a reel of nine beats is under 58 seconds with the end card', nineTotal <= 58 && nineTotal >= 25, String(nineTotal))
}
check('the CTA is link in bio for Instagram and TikTok, the short URL for the others', endCardCta('instagram') === 'Plan your trip: link in bio' && endCardCta('tiktok') === 'Plan your trip: link in bio' && endCardCta('youtube') === `Plan your trip: ${REEL_SHORT_URL}` && endCardCta('facebook', 'travelfunbiz.ca/go/x') === 'Plan your trip: travelfunbiz.ca/go/x')
check('beatLine cuts to 7 words and drops trailing punctuation', beatLine('One two three four five six seven eight,') === 'One two three four five six seven' && beatLine('Short line:') === 'Short line')
check('the end card text has no em dash', !JSON.stringify(samples.map(([, e]) => e)).includes(String.fromCharCode(8212)))
const yt = sample('Hook?', [['A', 'B c d.']], 'Cancun or Tulum', undefined, 'youtube')
check('a youtube reel ends on the short URL, not link in bio', clips(yt).some((c) => assetType(c) === 'rich-text' && String(c.asset.text) === `Plan your trip: ${REEL_SHORT_URL}`) && !clips(yt).some((c) => /link in bio/i.test(String(c.asset.text ?? ''))))

// ---- captions never run over the cover headline or the end card (real defect seen in the 21 Oct reel frames) ----
// docs/factory/evidence/reel-2026-10-21-frames.png: the burned caption (title plus first sentence, 4 to 5 lines) sat on top of
// the red cover block for the first 3 seconds, hiding "COLOGNE TO BASEL BY RIVER". The caption box in that render reached from
// y 250 down to about 560 of 1280 while the red block started at about 490.
{
  const evidenceScript: VideoScript = {
    hook: 'Is a Rhine river cruise right for you?',
    coverTitle: 'Cologne to Basel by river',
    title: 'Viking River Cruise Germany: A Rhine guide for solo travelers',
    description: 'd',
    hashtags: [],
    beats: [
      { scene: 'ship', onScreenText: 'A floating hotel', voiceover: 'A floating hotel that docks right in the heart of each town.', brollSearchTerms: ['river cruise ship'] },
      { scene: 'route', onScreenText: 'Grand cities to quiet villages', voiceover: 'This route builds gently from grand cities to quiet villages.', brollSearchTerms: ['rhine old town'] },
      { scene: 'x', onScreenText: 'Nobody tells you this', voiceover: 'Wait, nobody tells you this.', brollSearchTerms: ['river'] },
      { scene: 'price', onScreenText: 'Compare what is included', voiceover: 'Before judging on price, compare what each fare includes.', brollSearchTerms: ['river cruise deck'] },
      { scene: 'solo', onScreenText: 'Solo travel, made easy', voiceover: 'Solo travel is easy because the ship does the planning.', brollSearchTerms: ['rhine castle'] },
      { scene: 'a', onScreenText: 'Castles at every bend', voiceover: 'You pass castles on the hillsides almost every hour.', brollSearchTerms: ['rhine castle'] },
      { scene: 'b', onScreenText: 'Unpack once', voiceover: 'You unpack one time and wake up somewhere new.', brollSearchTerms: ['river cruise cabin'] },
      { scene: 'c', onScreenText: 'Which one are you?', voiceover: 'Boat or boots: which one are you?', brollSearchTerms: ['river cruise'] },
    ],
  }
  const vids = evidenceScript.beats.map((_, i) => ({ videoUrl: `https://v.test/${i}.mp4` }))
  const built = buildVideoEdit(evidenceScript, vids, 'https://i.test/cologne.jpg', 'Cologne to Basel by river', 'TRAVELFUNBIZ.CA', { platform: 'instagram' })
  const t = reelTiming(evidenceScript)
  const total = Math.max(...clips(built).map((c) => Number(c.start) + Number(c.length)))
  check('reelTiming agrees with the built edit (cover end, end card start, total)', Math.abs(t.total - total) < 0.01 && Math.abs(t.endStart - (total - END_CARD_SECONDS)) < 0.01, JSON.stringify(t))

  // The reconstructed old layout: the same reel, but the caption sits in the upper part from frame 0 and the cover block is centred.
  const old = JSON.parse(JSON.stringify(built)) as ShotstackEdit
  const oldCaption = clips(old).find((c) => assetType(c) === 'rich-caption')!
  oldCaption.position = 'top'
  oldCaption.offset = { y: -0.25 }
  oldCaption.start = 0
  oldCaption.length = total
  const oldBlock = clips(old).find((c) => assetType(c) === 'rich-text' && (c.asset.background as { color?: string } | undefined)?.color === REEL_RED && Number(c.start) === 0)!
  oldBlock.offset = { y: 0 }
  check('the detector flags the real 21 Oct layout (caption over the cover block)', captionCollisions(old).length > 0, String(captionCollisions(old).length))

  // The current builder: no caption box shares time and space with the cover or end card.
  check('21 Oct fixture: no burned caption overlaps the cover headline or the end card', captionCollisions(built).length === 0, JSON.stringify(captionCollisions(built).map((c) => [c.caption.start, c.caption.end, c.with.text])))
  const bBoxes = reelTextBoxes(built)
  const bCaptions = bBoxes.filter((b) => b.kind === 'rich-caption')
  check('captions start after the cover window and end before the end card', bCaptions.length > 0 && bCaptions.every((b) => b.start >= t.coverEnd - 0.01 && b.end <= t.endStart + 0.01), JSON.stringify(bCaptions.map((b) => [b.start, b.end])))
  const textAt = (sec: number) => bBoxes.filter((b) => b.start <= sec && sec < b.end).map((b) => b.text || 'captions')
  check('the hook beat shows only the cover headline and the brand strip (0.4s and 2.5s)', [0.4, 1, 2, 2.5].every((s) => JSON.stringify(textAt(s).sort()) === JSON.stringify(['COLOGNE TO BASEL BY RIVER', 'TRAVELFUNBIZ.CA'].sort())), JSON.stringify([0.4, 2.5].map(textAt)))
  check('the cover window equals the hook beat: cover text, cover photo and the first beat line up', clips(built).filter((c) => Number(c.start) === 0 && assetType(c) !== 'text-to-speech' && assetType(c) !== 'shape' && assetType(c) !== 'rich-caption').every((c) => Math.abs(Number(c.length) - t.coverEnd) < 0.01) && clips(built).some((c) => assetType(c) === 'video' && Math.abs(Number(c.start) - t.coverEnd) < 0.01))
  const tts = clips(built).filter((c) => assetType(c) === 'text-to-speech')
  check('the hook is spoken alone during the cover, the beats are read from their own clip that the captions follow', tts.length === 2 && String(tts[0].asset.text) === evidenceScript.hook && Math.abs(Number(tts[0].length) - t.coverEnd) < 0.01 && tts[1].alias === 'narration' && !String(tts[1].asset.text).includes(evidenceScript.hook) && Math.abs(Number(tts[1].start) - t.coverEnd) < 0.01 && Math.abs(Number(bCaptions[0] ? clips(built).find((c) => assetType(c) === 'rich-caption')!.start : -1) - Number(tts[1].start)) < 0.01)
  check('no burned text or narration starts with the blog title', ![...bBoxes.map((b) => b.text), ...tts.map((c) => String(c.asset.text))].some((x) => x.toLowerCase().startsWith('viking river cruise')) && !JSON.stringify(built).includes('Picture'))
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
