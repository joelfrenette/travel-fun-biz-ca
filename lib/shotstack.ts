import type { SupabaseClient } from '@supabase/supabase-js'
import { getSetting, setSetting } from '@/lib/app-settings'
import type { VideoScript } from '@/lib/video-script'
import { pickReelCoverTitle, headlineWords, REEL_COVER_MAX_WORDS } from '@/lib/cover-headline'
import { fitText, CAPS_WIDTH_RATIO } from '@/lib/social-cover'
import { reelBeatSeconds } from '@/lib/reel-beats'
import { reelNarration } from '@/lib/reel-script-rules'

// Shotstack (shotstack.io) - hosted video-render API. The whole render happens in Shotstack's
// cloud from a JSON "edit" description; no ffmpeg or video infrastructure here.
//
// Rewritten 2026-10-07 against Shotstack's published API reference. The first version (2026-10-04)
// was built from memory and had two real mistakes: the base path was `/v1` instead of
// `/edit/{version}`, and the caption asset was `caption` instead of `rich-caption`. Still not
// exercised by a real render from this codebase - the first sandbox render is the real test.
//
// Environments: Shotstack has a free sandbox (`stage`, watermarked output) and production (`v1`,
// uses paid credits). `SHOTSTACK_ENV` picks one and defaults to `stage` so nothing costs money or
// ships a watermark-free video until it is set to `v1` on purpose. The two environments use
// different API keys.
export type ShotstackEnv = 'stage' | 'v1'

// Which environment the key belongs to. An explicit SHOTSTACK_ENV always wins. When it is unset,
// detectShotstackEnv() asks Shotstack which environment accepts the key (a free, read-only call) and
// remembers the answer, so a production key does not need a second setting to work. Until detection
// has run, the safe default is the sandbox.
let detectedEnv: ShotstackEnv | null = null

export function shotstackEnv(): ShotstackEnv {
  const v = process.env.SHOTSTACK_ENV?.trim()
  if (v === 'v1' || v === 'stage') return v
  return detectedEnv ?? 'stage'
}

async function keyAccepted(env: ShotstackEnv, key: string): Promise<boolean | null> {
  try {
    const res = await fetch(`https://api.shotstack.io/edit/${env}/templates`, {
      headers: { 'x-api-key': key, Accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    })
    if (res.ok) return true
    if (res.status === 401 || res.status === 403) return false
    return null
  } catch {
    return null
  }
}

const ENV_CACHE_KEY = 'shotstack_env_detected'
const ENV_CACHE_MS = 24 * 60 * 60 * 1000

export async function detectShotstackEnv(admin: SupabaseClient): Promise<ShotstackEnv> {
  const explicit = process.env.SHOTSTACK_ENV?.trim()
  if (explicit === 'v1' || explicit === 'stage') return explicit
  const key = process.env.SHOTSTACK_API_KEY?.trim()
  if (!key) return shotstackEnv()
  try {
    const cached = JSON.parse((await getSetting(admin, ENV_CACHE_KEY)) ?? 'null') as { env?: string; at?: number } | null
    if (cached && (cached.env === 'v1' || cached.env === 'stage') && typeof cached.at === 'number' && Date.now() - cached.at < ENV_CACHE_MS) {
      detectedEnv = cached.env
      return cached.env
    }
  } catch {
    // unreadable cache: probe again below
  }
  const onV1 = await keyAccepted('v1', key)
  const onStage = onV1 ? null : await keyAccepted('stage', key)
  const found: ShotstackEnv | null = onV1 ? 'v1' : onStage ? 'stage' : null
  if (found) {
    detectedEnv = found
    await setSetting(admin, ENV_CACHE_KEY, JSON.stringify({ env: found, at: Date.now() }))
    return found
  }
  return shotstackEnv()
}

const baseUrl = () => `https://api.shotstack.io/edit/${shotstackEnv()}`

export function isShotstackConfigured(): boolean {
  return !!process.env.SHOTSTACK_API_KEY?.trim()
}

export interface ShotstackClip {
  asset: Record<string, unknown>
  start: number | string
  length: number | string
  fit?: string
  effect?: string
  transition?: { in?: string; out?: string }
  position?: string
  offset?: { x?: number; y?: number }
  width?: number
  height?: number
  filter?: string
  alias?: string
}

export interface ShotstackTrack {
  clips: ShotstackClip[]
}

export interface ShotstackEdit {
  timeline: { tracks: ShotstackTrack[]; background?: string }
  output: {
    format: string
    resolution?: string
    aspectRatio?: string
    /** Still frame Shotstack saves next to the video, captured `capture` seconds in (Edit API: output.poster.capture). */
    poster?: { capture: number }
    /** A second, scaled still (Edit API: output.thumbnail.capture and .scale), used here for the end card frame. */
    thumbnail?: { capture: number; scale?: number }
  }
}

/** Visual for one beat: a real stock video clip when one was found, otherwise a still image. */
export interface BeatVisual {
  videoUrl?: string
  imageUrl?: string
}

const COVER_SECONDS = 3
/** The closing end card (red block with the site name, one call to action line, brand strip): the final 2 to 3 seconds. It also
 * serves as the margin so a slower real voice is not cut mid-sentence. */
export const END_CARD_SECONDS = 2.5
const SECONDS_PER_WORD = 1 / 2.5
// The output is 9:16 "hd" = 720 x 1280. Every burned-in text box is 560 wide (80px margins each side, centred) and wraps
// inside that box, so nothing is cut off at the edges. Instagram covers the top 250px and the bottom 340px of a 1080 x 1920 reel
// with its own buttons and caption; on this 720 x 1280 canvas that is 250 x 2/3 = 167px and 340 x 2/3 = 227px. All text stays between them.
export const REEL_WIDTH = 720
export const REEL_HEIGHT = 1280
export const REEL_SAFE_SIDE = 80
export const REEL_SAFE_TOP = Math.ceil((250 * REEL_WIDTH) / 1080)
export const REEL_SAFE_BOTTOM = Math.ceil((340 * REEL_WIDTH) / 1080)
export const TEXT_WIDTH = REEL_WIDTH - REEL_SAFE_SIDE * 2
/** Burned-in captions are at least this big, with a stroke. */
export const CAPTION_FONT = 48
export const CAPTION_MIN_FONT = 44
export const CAPTION_STROKE = 4
/** Every burned-in text (cover headline, beat text, brand strip, call to action) is at least this size. */
export const REEL_MIN_FONT = 44
/** A beat's on-screen text is a short line: 7 words at most. */
export const REEL_BEAT_MAX_WORDS = 7
/** The cover (frame 0) matches the feed cover: red block in the upper part, uppercase bold white headline (5 words at most), brand strip below it. */
export const REEL_RED = '#d81f26'
export const REEL_COVER_TEMPLATE = 'reel-red-v1'
/** Centre of the red block, as a share of the frame height from the top. 27% keeps even a 3 line headline (about 340px tall)
 * below the 167px top safe zone. */
const COVER_BLOCK_CENTER = 0.27
/** Centre of the brand strip (cover) and of the call to action strip (end card): the same spot on both, clear of the
 * red block above and of the caption track below. */
const STRIP_CENTER = 0.56
/** The call to action on the end card. Instagram and TikTok cannot tap a caption link, so they get "link in bio"; the others the short URL. */
export type ReelPlatform = 'instagram' | 'tiktok' | 'youtube' | 'facebook' | 'generic'
export const REEL_SHORT_URL = 'travelfunbiz.ca/links'
export function endCardCta(platform: ReelPlatform = 'instagram', shortUrl = REEL_SHORT_URL): string {
  return platform === 'instagram' || platform === 'tiktok' ? 'Plan your trip: link in bio' : `Plan your trip: ${shortUrl}`
}
/** The seconds the hook is allowed to take: its estimated spoken length plus headroom so a slightly slower real voice is not cut off. */
const HOOK_HEADROOM_SECONDS = 0.5
/** Poster frame (cover) and end card frame the post-render gate looks at. The poster is taken inside the cover window, the
 * end frame inside the end card. */
export const POSTER_CAPTURE_SECONDS = 0.8
export const END_FRAME_BEFORE_END_SECONDS = 0.8
export const END_THUMBNAIL_SCALE = 0.5

/** When the parts of a reel start: the cover window is the hook beat (the hook is spoken over the cover and nothing else is
 * on screen), the beats follow, and the end card closes the reel. Pure; the edit builder and the offline checks both use it. */
export function reelTiming(script: VideoScript): { coverEnd: number; beatsStart: number; endStart: number; total: number } {
  const hookWords = script.hook.trim().split(/\s+/).filter(Boolean).length
  const beatsStart = Math.max(COVER_SECONDS, Math.round((hookWords * SECONDS_PER_WORD + HOOK_HEADROOM_SECONDS) * 10) / 10)
  let endStart = beatsStart
  script.beats.forEach((b, i) => {
    endStart += reelBeatSeconds(b.voiceover, i)
  })
  return { coverEnd: beatsStart, beatsStart, endStart, total: endStart + END_CARD_SECONDS }
}

/** A beat's on-screen text cut to a short line: 7 words at most, no trailing punctuation. */
export function beatLine(text: string): string {
  return text.trim().split(/\s+/).filter(Boolean).slice(0, REEL_BEAT_MAX_WORDS).join(' ').replace(/[,:;\-\s]+$/, '')
}
/** Light overlay on the cover photo; b-roll under the captions is darkened harder (filter: darken). */
const COVER_OVERLAY_OPACITY = 0.12
const FONT = 'Open Sans'

const richText = (text: string, size: number, opts: { color?: string; background?: string; bgOpacity?: number; stroke?: number; uppercase?: boolean; radius?: number; padding?: number } = {}) => ({
  type: 'rich-text',
  text,
  font: { family: FONT, size, weight: '700', color: opts.color ?? '#ffffff' },
  // Shotstack wants stroke beside font, not inside it (inside it is "unknown_property").
  ...(opts.stroke ? { stroke: { width: opts.stroke, color: '#000000' } } : {}),
  style: { lineHeight: 1.15, ...(opts.uppercase ? { textTransform: 'uppercase' } : {}) },
  ...(opts.background ? { background: { color: opts.background, opacity: opts.bgOpacity ?? 0.9, borderRadius: opts.radius ?? 16, wrap: true } } : {}),
  padding: opts.padding ?? 16,
  align: { horizontal: 'center', vertical: 'middle' },
})

/** Font size for the cover headline so the longest word and the whole title fit the block (3 lines at most). */
export function reelCoverFontSize(title: string): number {
  return fitText(title.toUpperCase(), { innerWidth: TEXT_WIDTH - 2 * 24, maxSize: 84, minSize: 48, maxLines: 3, widthRatio: CAPS_WIDTH_RATIO }).fontSize
}

/** Builds the Edit API body for one script. Layers, top-most first: captions from the narration
 * audio, the opening cover card (catchy headline over the post's cover image) for the first 3
 * seconds, short on-screen text per beat, the visuals (cover image then stock video per beat), and
 * one continuous text-to-speech clip the captions read from. Beat timing is estimated by word count
 * (2.5 words/sec) because a hosted render has nothing to measure until it exists. */
export function buildVideoEdit(
  script: VideoScript,
  visuals: BeatVisual[] = [],
  coverImageUrl?: string,
  coverTitle?: string,
  brand = 'TRAVELFUNBIZ.CA',
  opts: { platform?: ReelPlatform; shortUrl?: string } = {},
): ShotstackEdit {
  // The cover headline must pass the feed cover rules and the 5 word reel limit (lib/cover-headline.ts); a failing one is
  // replaced by a whole phrase of the title. If nothing valid exists (the autopilot refuses to render then) it is cut to 5 words.
  const picked = pickReelCoverTitle([coverTitle, script.coverTitle], script.title || script.hook, `${script.title ?? ''} ${script.hook}`)
  const headline = (picked.ok ? picked.title : headlineWords(picked.title || script.hook).slice(0, REEL_COVER_MAX_WORDS).join(' ')).toUpperCase()
  // The hook is spoken first, alone, over the cover; the beats (and the captions that follow them) start when it ends. The cover
  // window IS the hook beat, so for those seconds the headline and the brand strip are the only text on screen.
  const narration = reelNarration(script)
  const { beatsStart } = reelTiming(script)
  const coverSeconds = beatsStart

  const visualClips: ShotstackClip[] = []
  const textClips: ShotstackClip[] = []

  // Cover: the post's own image, NOT dimmed (only a light overlay below keeps the white headline readable); falls back to the first stock clip.
  if (coverImageUrl) {
    visualClips.push({ asset: { type: 'image', src: coverImageUrl }, start: 0, length: beatsStart, fit: 'cover', effect: 'zoomIn' })
  } else if (visuals[0]?.videoUrl) {
    visualClips.push({ asset: { type: 'video', src: visuals[0].videoUrl, volume: 0 }, start: 0, length: beatsStart, fit: 'cover' })
  }

  let cursor = beatsStart
  script.beats.forEach((beat, i) => {
    // 3 to 4 seconds a beat (2 for the pattern interrupt at beat 3), following the spoken words so picture and voice stay in step.
    const length = reelBeatSeconds(beat.voiceover, i)
    const v = visuals[i]
    // Only the b-roll under the captions is darkened, so the white words read over any footage.
    if (v?.videoUrl) {
      visualClips.push({ asset: { type: 'video', src: v.videoUrl, volume: 0 }, start: cursor, length, fit: 'cover', filter: 'darken' })
    } else if (v?.imageUrl || coverImageUrl) {
      visualClips.push({ asset: { type: 'image', src: v?.imageUrl || coverImageUrl }, start: cursor, length, fit: 'cover', effect: 'zoomIn', filter: 'darken' })
    }
    // A short line (7 words at most), centred, starting 20% down: clear of the 167px top safe zone and far above the caption track.
    textClips.push({
      asset: richText(beatLine(beat.onScreenText), 50, { background: '#000000', bgOpacity: 0.55, stroke: 2 }),
      start: cursor,
      length,
      width: TEXT_WIDTH,
      position: 'top',
      offset: { y: -0.2 },
    })
    cursor += length
  })
  // The end card takes the last 2.5 seconds, which is also the margin so a slower real voice is not cut mid-sentence.
  const endStart = cursor
  const totalLength = cursor + END_CARD_SECONDS
  // End card photo: the post's own cover (not darkened; the red block and the strip carry the words).
  if (coverImageUrl) visualClips.push({ asset: { type: 'image', src: coverImageUrl }, start: endStart, length: END_CARD_SECONDS, fit: 'cover', effect: 'zoomIn' })
  else if (visuals[0]?.videoUrl) visualClips.push({ asset: { type: 'video', src: visuals[0].videoUrl, volume: 0 }, start: endStart, length: END_CARD_SECONDS, fit: 'cover' })
  const endBlockSize = fitText(brand.toUpperCase(), { innerWidth: TEXT_WIDTH - 2 * 24, maxSize: 72, minSize: 48, maxLines: 2, widthRatio: CAPS_WIDTH_RATIO }).fontSize
  const endCta = endCardCta(opts.platform, opts.shortUrl)

  const tracks: ShotstackTrack[] = [
    // Captions, transcribed from the beat narration (src aliases the second TTS clip below), kept to the lower part of the frame
    // and wrapped inside the same 560px box. They run only from the end of the cover window to the start of the end card, so they
    // can never sit on the cover headline or the end card (real defect in the 21 Oct reel), and they start with the same
    // timing as the narration clip they are read from.
    {
      clips: [
        {
          asset: {
            type: 'rich-caption',
            src: 'alias://narration',
            // rich-caption has no background or wrap, and stroke sits beside font; the heavy black
            // outline keeps the words readable over any footage.
            font: { family: FONT, size: CAPTION_FONT, weight: '700', color: '#ffffff' },
            stroke: { width: CAPTION_STROKE, color: '#000000' },
            padding: { top: 12, right: 12, bottom: 12, left: 12 },
            align: { horizontal: 'center', vertical: 'middle' },
          },
          start: beatsStart,
          length: endStart - beatsStart,
          width: TEXT_WIDTH,
          position: 'bottom',
          offset: { y: 0.18 },
        },
      ],
    },
    // Cover card text, matching the feed cover: the headline in a solid red block centred in the upper third (uppercase,
    // bold, white, 5 words at most), and the brand strip near the bottom.
    {
      clips: [
        { asset: richText(headline, reelCoverFontSize(headline), { background: REEL_RED, bgOpacity: 1, uppercase: true, radius: 0, padding: 24 }), start: 0, length: coverSeconds, width: TEXT_WIDTH, position: 'center', offset: { y: 0.5 - COVER_BLOCK_CENTER } },
        // Brand strip under the red block, mid frame: the bottom 227px belong to Instagram's own UI and the caption track.
        { asset: richText(brand, REEL_MIN_FONT, { background: '#000000', bgOpacity: 0.55, radius: 24, padding: 12 }), start: 0, length: coverSeconds, width: TEXT_WIDTH, position: 'center', offset: { y: 0.5 - STRIP_CENTER } },
        // End card: the same red block with the site name, one call to action line in the strip spot.
        { asset: richText(brand.toUpperCase(), endBlockSize, { background: REEL_RED, bgOpacity: 1, uppercase: true, radius: 0, padding: 24 }), start: endStart, length: END_CARD_SECONDS, width: TEXT_WIDTH, position: 'center', offset: { y: 0.5 - COVER_BLOCK_CENTER } },
        { asset: richText(endCta, REEL_MIN_FONT, { background: '#000000', bgOpacity: 0.55, radius: 24, padding: 12 }), start: endStart, length: END_CARD_SECONDS, width: TEXT_WIDTH, position: 'center', offset: { y: 0.5 - STRIP_CENTER } },
      ],
    },
    // Light overlay over the cover photo (not a dim): just enough that white words read on a bright photo.
    {
      clips: [
        {
          asset: { type: 'shape', shape: 'rectangle', rectangle: { width: REEL_WIDTH, height: REEL_HEIGHT }, fill: { color: '#000000', opacity: COVER_OVERLAY_OPACITY } },
          start: 0,
          length: coverSeconds,
          position: 'center',
        },
        {
          asset: { type: 'shape', shape: 'rectangle', rectangle: { width: REEL_WIDTH, height: REEL_HEIGHT }, fill: { color: '#000000', opacity: COVER_OVERLAY_OPACITY } },
          start: endStart,
          length: END_CARD_SECONDS,
          position: 'center',
        },
      ],
    },
    { clips: textClips },
  ]
  if (visualClips.length > 0) tracks.push({ clips: visualClips })
  tracks.push({
    // Two sequential voice clips on one track: the hook alone over the cover, then every beat's line as one continuous clip (the
    // captions read from this second one). They never overlap, and the end card still leaves room for a slower real voice.
    clips: [
      { asset: { type: 'text-to-speech', text: narration.hook, voice: 'Matthew', language: 'en-US' }, start: 0, length: beatsStart },
      { asset: { type: 'text-to-speech', text: narration.beats, voice: 'Matthew', language: 'en-US' }, start: beatsStart, length: totalLength - beatsStart, alias: 'narration' },
    ],
  })

  return {
    timeline: { background: '#000000', tracks },
    // A poster inside the cover window and a thumbnail on the end card let the post-render gate look at the two frames that
    // matter (lib/reel-frame-gate.ts); the render itself is unchanged.
    output: {
      format: 'mp4',
      resolution: 'hd',
      aspectRatio: '9:16',
      poster: { capture: Math.min(POSTER_CAPTURE_SECONDS, coverSeconds - 0.2) },
      thumbnail: { capture: Math.max(endStart + 0.2, totalLength - END_FRAME_BEFORE_END_SECONDS), scale: END_THUMBNAIL_SCALE },
    },
  }
}

/** Estimated on-screen box of one burned-in text clip, in output pixels (0,0 is the top left corner), plus its time span. */
export interface ReelTextBox {
  kind: 'rich-text' | 'rich-caption'
  text: string
  start: number
  end: number
  left: number
  right: number
  top: number
  bottom: number
  fontSize: number
}

/** Estimates where each burned-in text clip lands, with no render: the clip's width (a text clip is centred on the frame
 * by its position), its wrapped line count from the font size, and its vertical place from `position` and `offset.y`
 * (Shotstack: a positive y offset moves the clip UP, as a share of the frame height). The rich-caption track is assumed to
 * show up to 3 lines at a time (a deliberately pessimistic guess). The estimate is deliberately a little generous (capitals count 0.7 of the font size per letter). */
export function reelTextBoxes(edit: ShotstackEdit): ReelTextBox[] {
  const out: ReelTextBox[] = []
  for (const clip of edit.timeline.tracks.flatMap((t) => t.clips)) {
    const type = String(clip.asset.type)
    if (type !== 'rich-text' && type !== 'rich-caption') continue
    const font = clip.asset.font as { size: number }
    const size = font.size
    const padRaw = clip.asset.padding
    const pad = typeof padRaw === 'number' ? padRaw : padRaw && typeof padRaw === 'object' ? Number((padRaw as { top?: number }).top ?? 0) : 0
    const width = Number(clip.width ?? REEL_WIDTH)
    const upper = (clip.asset.style as { textTransform?: string } | undefined)?.textTransform === 'uppercase'
    const text = type === 'rich-text' ? String(clip.asset.text) : ''
    const ratio = upper ? CAPS_WIDTH_RATIO : 0.6
    const maxChars = Math.max(1, Math.floor((width - 2 * pad) / (size * ratio)))
    const lines = type === 'rich-caption' ? 3 : Math.max(1, wrapLineCount(text, maxChars))
    const height = lines * size * 1.15 + 2 * pad
    const y = Number((clip.offset as { y?: number } | undefined)?.y ?? 0) * REEL_HEIGHT
    let top: number
    if (clip.position === 'top') top = -y
    else if (clip.position === 'bottom') top = REEL_HEIGHT - y - height
    else top = REEL_HEIGHT / 2 - y - height / 2
    const start = Number(clip.start)
    out.push({ kind: type, text, start, end: start + Number(clip.length), left: (REEL_WIDTH - width) / 2, right: (REEL_WIDTH + width) / 2, top, bottom: top + height, fontSize: size })
  }
  return out
}

/** Every burned-in caption box that shares both time and space with the cover or end card text (the red headline block and
 * the strip under it). Empty means the captions never cover the cover headline or the end card. Pure, no render. */
export function captionCollisions(edit: ShotstackEdit): Array<{ caption: ReelTextBox; with: ReelTextBox }> {
  const boxes = reelTextBoxes(edit)
  const captions = boxes.filter((b) => b.kind === 'rich-caption')
  const total = Math.max(0, ...boxes.map((b) => b.end))
  const cardBoxes = boxes.filter((b) => b.kind === 'rich-text' && (b.start <= 0.01 || Math.abs(b.end - total) < 0.01))
  const out: Array<{ caption: ReelTextBox; with: ReelTextBox }> = []
  for (const caption of captions) {
    for (const card of cardBoxes) {
      const together = caption.start < card.end - 0.01 && card.start < caption.end - 0.01
      const touching = caption.top < card.bottom && card.top < caption.bottom && caption.left < card.right && card.left < caption.right
      if (together && touching) out.push({ caption, with: card })
    }
  }
  return out
}

function wrapLineCount(text: string, maxChars: number): number {
  let lines = 1
  let len = 0
  for (const w of text.split(/\s+/).filter(Boolean)) {
    if (len === 0) len = w.length
    else if (len + 1 + w.length <= maxChars) len += 1 + w.length
    else {
      lines++
      len = w.length
    }
  }
  return lines
}

export interface ShotstackRenderResult {
  ok: boolean
  renderId?: string
  error?: string
  /** HTTP status when Shotstack answered with an error. */
  status?: number
  /** Shotstack definitely did not accept the job (429 or 503): safe to try again later, costs nothing. */
  transient?: boolean
  /** The request may have been accepted and charged although no answer arrived (timeout, dropped
   * connection, or an answer without a render id). Submitting again could pay for a second render. */
  ambiguous?: boolean
}

/** Submits a render job; Shotstack renders asynchronously, so poll with getRenderStatus. */
export async function submitRender(edit: ShotstackEdit): Promise<ShotstackRenderResult> {
  const first = await submitRenderOnce(edit)
  // The poster and thumbnail fields are only there for the post-render gate. If Shotstack's schema check rejects them (a 400 that
  // names them, which means nothing was queued and nothing was charged) the same edit is sent once without them; the gate then
  // reports "unknown" for that render and the reel is posted on the strength of the pre-render checks, as before.
  if (!first.ok && first.status === 400 && /poster|thumbnail/i.test(first.error ?? '') && (edit.output.poster || edit.output.thumbnail)) {
    const { poster: _poster, thumbnail: _thumbnail, ...output } = edit.output
    return submitRenderOnce({ ...edit, output })
  }
  return first
}

async function submitRenderOnce(edit: ShotstackEdit): Promise<ShotstackRenderResult> {
  const key = process.env.SHOTSTACK_API_KEY?.trim()
  if (!key) return { ok: false, error: 'SHOTSTACK_API_KEY is not set' }
  try {
    const res = await fetch(`${baseUrl()}/render`, {
      method: 'POST',
      headers: { 'x-api-key': key, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(edit),
      signal: AbortSignal.timeout(30_000),
    })
    const text = await res.text().catch(() => '')
    let json: Record<string, unknown> = {}
    try {
      json = JSON.parse(text) as Record<string, unknown>
    } catch {
      // not JSON: the raw text is reported below
    }
    if (!res.ok) {
      const message = typeof json.message === 'string' ? json.message : `Shotstack returned ${res.status}`
      const detail = typeof json.response === 'object' && json.response ? JSON.stringify(json.response) : json.message ? '' : text
      const error = `${message} (${shotstackEnv()} environment${detail ? `: ${detail.slice(0, 700)}` : ''})`
      // Only 429 (rate limited) and 503 (unavailable) mean "the job was not taken". Any other 5xx, and
      // 502/504 in particular, can come from a gateway AFTER Shotstack queued and charged the job, with
      // the render id lost on the way back, so those go down the ambiguous path (a person checks).
      if (res.status >= 500 && res.status !== 503) return { ok: false, status: res.status, ambiguous: true, error }
      return { ok: false, status: res.status, transient: res.status === 429 || res.status === 503, error }
    }
    const response = json.response as { id?: string } | undefined
    if (!response?.id) return { ok: false, ambiguous: true, error: 'Shotstack accepted the request but returned no render id.' }
    return { ok: true, renderId: response.id }
  } catch (err) {
    return { ok: false, ambiguous: true, error: err instanceof Error ? err.message : 'Could not reach Shotstack.' }
  }
}

export interface ShotstackStatus {
  ok: boolean
  status?: 'queued' | 'fetching' | 'rendering' | 'saving' | 'done' | 'failed'
  url?: string
  /** Still frames saved next to the video when the edit asked for them (response.poster, response.thumbnail). */
  poster?: string
  thumbnail?: string
  error?: string
}

/** Polls a render: queued -> fetching -> rendering -> saving -> done (or failed). */
export async function getRenderStatus(renderId: string): Promise<ShotstackStatus> {
  const key = process.env.SHOTSTACK_API_KEY?.trim()
  if (!key) return { ok: false, error: 'SHOTSTACK_API_KEY is not set' }
  try {
    const res = await fetch(`${baseUrl()}/render/${encodeURIComponent(renderId)}`, {
      headers: { 'x-api-key': key, Accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
    })
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) return { ok: false, error: `Shotstack returned ${res.status}` }
    const response = json.response as { status?: string; url?: string; poster?: string; thumbnail?: string; error?: string } | undefined
    return {
      ok: true,
      status: response?.status as ShotstackStatus['status'],
      url: response?.url || undefined,
      poster: response?.poster || undefined,
      thumbnail: response?.thumbnail || undefined,
      error: response?.error || undefined,
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not reach Shotstack.' }
  }
}

const serveUrl = () => `https://api.shotstack.io/serve/${shotstackEnv()}`

/** Deletes every file Shotstack is hosting for one render (the video itself plus its poster and
 * thumbnail - each is a separate asset and must be deleted individually). Shotstack keeps hosted
 * renders until they are deleted, so without this they pile up against your storage. A render with
 * no remaining assets (already deleted, or never saved) counts as success. */
export async function deleteRenderAssets(renderId: string): Promise<{ ok: boolean; deleted: number; error?: string }> {
  const key = process.env.SHOTSTACK_API_KEY?.trim()
  if (!key) return { ok: false, deleted: 0, error: 'SHOTSTACK_API_KEY is not set' }
  try {
    const list = await fetch(`${serveUrl()}/assets/render/${encodeURIComponent(renderId)}`, {
      headers: { 'x-api-key': key, Accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
    })
    if (list.status === 404) return { ok: true, deleted: 0 }
    if (!list.ok) return { ok: false, deleted: 0, error: `Shotstack returned ${list.status} listing assets` }
    const json = (await list.json().catch(() => ({}))) as { data?: unknown }
    // Response is JSON:API-style ({data:[{type:'asset', attributes:{id,...}}]}); tolerate a single
    // object or a bare id field too, since this shape has not been seen from a live call here.
    const items = Array.isArray(json.data) ? json.data : json.data ? [json.data] : []
    const ids = items
      .map((i) => {
        const o = i as { id?: unknown; attributes?: { id?: unknown } }
        return typeof o.attributes?.id === 'string' ? o.attributes.id : typeof o.id === 'string' ? o.id : null
      })
      .filter((id): id is string => !!id)
    let deleted = 0
    for (const id of ids) {
      const res = await fetch(`${serveUrl()}/assets/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: { 'x-api-key': key },
        signal: AbortSignal.timeout(15_000),
      })
      if (res.ok || res.status === 404) deleted++
      else return { ok: false, deleted, error: `Shotstack returned ${res.status} deleting an asset` }
    }
    return { ok: true, deleted }
  } catch (err) {
    return { ok: false, deleted: 0, error: err instanceof Error ? err.message : 'Could not reach Shotstack.' }
  }
}
