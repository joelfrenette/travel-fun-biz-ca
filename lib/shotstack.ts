import type { SupabaseClient } from '@supabase/supabase-js'
import { getSetting, setSetting } from '@/lib/app-settings'
import type { VideoScript } from '@/lib/video-script'

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
  alias?: string
}

export interface ShotstackTrack {
  clips: ShotstackClip[]
}

export interface ShotstackEdit {
  timeline: { tracks: ShotstackTrack[]; background?: string }
  output: { format: string; resolution?: string; aspectRatio?: string }
}

/** Visual for one beat: a real stock video clip when one was found, otherwise a still image. */
export interface BeatVisual {
  videoUrl?: string
  imageUrl?: string
}

const TITLE_CARD_SECONDS = 3
const SECONDS_PER_WORD = 1 / 2.5

/** Builds the Edit API body for one script. Track order is top-most first (Shotstack layers the
 * first track on top): captions, on-screen text per beat, the hook title card, the visuals
 * (stock video or still image per beat, back to back), and one continuous text-to-speech clip
 * carrying an alias the caption track reads from, so beats can never overlap or clip each other.
 * Beat timing is estimated by word count (2.5 words/sec) because a hosted TTS render has no
 * measurable timing until it exists; it is not frame-accurate. */
export function buildVideoEdit(script: VideoScript, visuals: BeatVisual[] = [], fallbackImageUrl?: string): ShotstackEdit {
  const fullNarration = [script.hook, ...script.beats.map((b) => b.voiceover)].join(' ')

  const visualClips: ShotstackClip[] = []
  const textClips: ShotstackClip[] = []
  let cursor = TITLE_CARD_SECONDS
  script.beats.forEach((beat, i) => {
    const words = beat.voiceover.trim().split(/\s+/).filter(Boolean).length
    const length = Math.max(words * SECONDS_PER_WORD, 1.5)
    const v = visuals[i]
    if (v?.videoUrl) {
      visualClips.push({ asset: { type: 'video', src: v.videoUrl, volume: 0 }, start: cursor, length, fit: 'cover' })
    } else if (v?.imageUrl || fallbackImageUrl) {
      visualClips.push({ asset: { type: 'image', src: v?.imageUrl || fallbackImageUrl }, start: cursor, length, fit: 'cover', effect: 'zoomIn' })
    }
    textClips.push({
      asset: { type: 'title', text: beat.onScreenText, style: 'minimal' },
      start: cursor,
      length,
      position: 'top',
      offset: { y: -0.15 },
    })
    cursor += length
  })
  const totalLength = cursor

  const tracks: ShotstackTrack[] = [
    // Auto-transcribed captions from the narration audio (src aliases the TTS clip below).
    { clips: [{ asset: { type: 'rich-caption', src: 'alias://narration' }, start: 0, length: totalLength }] },
    { clips: textClips },
    // Hook title card: first frame, doubles as the cover thumbnail.
    { clips: [{ asset: { type: 'title', text: script.hook, style: 'blockbuster' }, start: 0, length: TITLE_CARD_SECONDS }] },
  ]
  if (visualClips.length > 0) tracks.push({ clips: visualClips })
  tracks.push({
    clips: [{ asset: { type: 'text-to-speech', text: fullNarration, voice: 'Matthew', language: 'en-US' }, start: 0, length: totalLength, alias: 'narration' }],
  })

  return {
    timeline: { background: '#000000', tracks },
    output: { format: 'mp4', resolution: 'hd', aspectRatio: '9:16' },
  }
}

export interface ShotstackRenderResult {
  ok: boolean
  renderId?: string
  error?: string
}

/** Submits a render job; Shotstack renders asynchronously, so poll with getRenderStatus. */
export async function submitRender(edit: ShotstackEdit): Promise<ShotstackRenderResult> {
  const key = process.env.SHOTSTACK_API_KEY?.trim()
  if (!key) return { ok: false, error: 'SHOTSTACK_API_KEY is not set' }
  try {
    const res = await fetch(`${baseUrl()}/render`, {
      method: 'POST',
      headers: { 'x-api-key': key, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(edit),
      signal: AbortSignal.timeout(30_000),
    })
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) {
      const message = typeof json.message === 'string' ? json.message : `Shotstack returned ${res.status}`
      const detail = typeof json.response === 'object' && json.response ? JSON.stringify(json.response).slice(0, 200) : ''
      return { ok: false, error: detail ? `${message} (${detail})` : message }
    }
    const response = json.response as { id?: string } | undefined
    if (!response?.id) return { ok: false, error: 'Shotstack accepted the request but returned no render id.' }
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
    const response = json.response as { status?: string; url?: string; error?: string } | undefined
    return {
      ok: true,
      status: response?.status as ShotstackStatus['status'],
      url: response?.url || undefined,
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
