import type { VideoScript } from '@/lib/video-script'

// Shotstack (shotstack.io) - a hosted video-render API, chosen to match the Nomad Escape Plan
// pipeline this was ported from: no local ffmpeg/video-processing infrastructure needed, the whole
// render happens in Shotstack's cloud from a JSON "edit" description.
//
// ** NOT LIVE-TESTED. ** Every other vendor integration in this codebase (lib/upload-post.ts,
// lib/pexels.ts, lib/bing-webmaster.ts) was built from a real call against the live API first,
// specifically because this project has already been burned by trusting vendor docs over a real
// test (lib/upload-post.ts's own comments document two real bugs that caused - a wrong URL path, a
// wrong field name). This file could NOT get that same treatment: there is no SHOTSTACK_API_KEY
// and making a real paid render call without one is impossible, and making one WITH one requires
// Joel's go-ahead this session doesn't have. What's here is built from Shotstack's publicly
// documented Edit API shape as of this training's knowledge, which may be stale or subtly wrong.
// Treat the FIRST real call against this as exactly that - a test, not a known-working feature -
// and fix whatever the real response shape disagrees with, the same way every other integration
// here was hardened.
const BASE = 'https://api.shotstack.io/v1'

export function isShotstackConfigured(): boolean {
  return !!process.env.SHOTSTACK_API_KEY?.trim()
}

export interface ShotstackClip {
  asset: Record<string, unknown>
  start: number
  length: number
}

export interface ShotstackTrack {
  clips: ShotstackClip[]
}

export interface ShotstackEdit {
  timeline: { tracks: ShotstackTrack[]; background?: string }
  output: { format: string; resolution?: string; aspectRatio?: string }
}

/** Builds the Edit API request body for one script: a title-card track (first ~3s, doubles as the
 * cover thumbnail), a b-roll track (one clip per beat, back to back, placeholder color clips until
 * real stock-clip URLs are wired in - see the TODO below), one continuous TTS asset covering the
 * whole narration (hook + every beat's voiceover concatenated, never one clip per beat, so beats
 * can never overlap or clip each other), and a caption track transcribing that same TTS audio.
 *
 * TODO (not built here): real b-roll clip sourcing. Nomad's version searches a stock-video API per
 * beat's search terms; this port ships with each beat's asset as a solid-color placeholder clip
 * (no stock-video vendor chosen yet - a separate decision from Shotstack itself) so the edit JSON
 * shape and timing logic can be built and reviewed now rather than blocked on that pick too. */
export function buildVideoEdit(script: VideoScript): ShotstackEdit {
  const fullNarration = [script.hook, ...script.beats.map((b) => b.voiceover)].join(' ')
  const TITLE_CARD_SECONDS = 3
  const SECONDS_PER_WORD = 1 / 2.5

  // Narration is one continuous asset; b-roll clips are timed under it by cumulative word count
  // from each beat's own voiceover line (Nomad's own "estimated timing by word count" approach,
  // not a frame-accurate sync - a hosted TTS render has no earlier point to measure real timing
  // from until the render itself exists).
  const brollClips: ShotstackClip[] = []
  let cursor = TITLE_CARD_SECONDS
  for (const beat of script.beats) {
    const words = beat.voiceover.trim().split(/\s+/).filter(Boolean).length
    const length = Math.max(words * SECONDS_PER_WORD, 1.5)
    brollClips.push({
      asset: {
        type: 'title',
        text: beat.onScreenText,
        style: 'minimal',
      },
      start: cursor,
      length,
    })
    cursor += length
  }
  const totalLength = cursor

  return {
    timeline: {
      background: '#000000',
      tracks: [
        // Caption track (top-most): transcribes the TTS audio automatically via Shotstack's
        // native caption asset type - no separate transcription service, no manual timing.
        {
          clips: [
            {
              asset: { type: 'caption', src: 'alias://narration', format: 'srt' },
              start: 0,
              length: totalLength,
            },
          ],
        },
        // Title card: the literal first frame, doubles as the cover thumbnail on networks that
        // don't generate their own. Shows alone for TITLE_CARD_SECONDS before the b-roll starts.
        {
          clips: [
            {
              asset: { type: 'title', text: script.hook, style: 'blockbuster' },
              start: 0,
              length: TITLE_CARD_SECONDS,
            },
          ],
        },
        { clips: brollClips },
        // One continuous TTS clip for the whole narration (hook + every beat), aliased so the
        // caption track above can reference it by name.
        {
          clips: [
            {
              asset: { type: 'text-to-speech', text: fullNarration, voice: 'Joanna' },
              start: 0,
              length: totalLength,
              // NOT CONFIRMED: whether Shotstack's clip-alias mechanism is really a top-level
              // `alias` field on the clip (as assumed here) or configured differently - verify
              // against the real API docs/a live call before relying on the caption track above
              // actually finding this audio.
              // @ts-expect-error - alias is outside the typed ShotstackClip shape on purpose, see note above
              alias: 'narration',
            },
          ],
        },
      ],
    },
    output: { format: 'mp4', aspectRatio: '9:16' },
  }
}

export interface ShotstackRenderResult {
  ok: boolean
  renderId?: string
  error?: string
}

/** Submits a render job. Returns the render id to poll with getRenderStatus - Shotstack renders
 * asynchronously, this call does not wait for the video to finish. */
export async function submitRender(edit: ShotstackEdit): Promise<ShotstackRenderResult> {
  const key = process.env.SHOTSTACK_API_KEY?.trim()
  if (!key) return { ok: false, error: 'SHOTSTACK_API_KEY is not set' }
  try {
    const res = await fetch(`${BASE}/render`, {
      method: 'POST',
      headers: { 'x-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify(edit),
      signal: AbortSignal.timeout(30_000),
    })
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) {
      const message = typeof json.message === 'string' ? json.message : `Shotstack returned ${res.status}`
      return { ok: false, error: message }
    }
    const response = json.response as { id?: string } | undefined
    if (!response?.id) return { ok: false, error: 'Shotstack accepted the request but returned no render id - response shape may not match what this integration expects (untested).' }
    return { ok: true, renderId: response.id }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not reach Shotstack.' }
  }
}

export interface ShotstackStatus {
  ok: boolean
  status?: 'queued' | 'fetching' | 'rendering' | 'saving' | 'done' | 'failed'
  url?: string
  error?: string
}

/** Polls a render's progress: queued -> fetching -> rendering -> saving -> done (or failed). */
export async function getRenderStatus(renderId: string): Promise<ShotstackStatus> {
  const key = process.env.SHOTSTACK_API_KEY?.trim()
  if (!key) return { ok: false, error: 'SHOTSTACK_API_KEY is not set' }
  try {
    const res = await fetch(`${BASE}/render/${encodeURIComponent(renderId)}`, {
      headers: { 'x-api-key': key, Accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
    })
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) return { ok: false, error: `Shotstack returned ${res.status}` }
    const response = json.response as { status?: string; url?: string; error?: string } | undefined
    return {
      ok: true,
      status: response?.status as ShotstackStatus['status'],
      url: response?.url,
      error: response?.error,
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not reach Shotstack.' }
  }
}
