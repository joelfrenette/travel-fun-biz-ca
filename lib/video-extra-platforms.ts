import type { SupabaseClient } from '@supabase/supabase-js'
import { getSetting, setSetting } from '@/lib/app-settings'
import { fitTikTokTitle } from '@/lib/ghl-social'
import { fitCaption, PLATFORM_CHAR_LIMITS } from '@/lib/social-captions'
import { hashtagCapFor } from '@/lib/hook-styles'

// The same short video also goes to YouTube Shorts and Instagram Reels, each behind its own switch in app_settings.
//   off (default; anything unreadable or unrecognised is off): the network is left out of every video send, nothing is recorded.
//   log: nothing is posted; the video that WOULD have gone is recorded in the log below (visible on the Posting card).
//   on:  the network is included in the video send, with its own title/caption fields.
// Exact match only, like the other mode switches. The video itself is unchanged; only the networks it goes to differ.

export const YOUTUBE_SHORTS_MODE_KEY = 'social_youtube_shorts_mode'
export const INSTAGRAM_REELS_MODE_KEY = 'social_instagram_reels_mode'
export const VIDEO_EXTRA_LOG_KEY = 'social_video_extra_log'
export type VideoExtraMode = 'off' | 'log' | 'on'

export function parseVideoExtraMode(raw: string | null | undefined): VideoExtraMode {
  return raw === 'log' || raw === 'on' ? raw : 'off'
}

/** The network each switch controls. */
export const VIDEO_EXTRA_NETWORKS = ['youtube', 'instagram'] as const
export type VideoExtraNetwork = (typeof VIDEO_EXTRA_NETWORKS)[number]
export type VideoExtraModes = Record<VideoExtraNetwork, VideoExtraMode>

export async function getVideoExtraModes(admin: SupabaseClient): Promise<VideoExtraModes> {
  try {
    const [y, i] = await Promise.all([getSetting(admin, YOUTUBE_SHORTS_MODE_KEY), getSetting(admin, INSTAGRAM_REELS_MODE_KEY)])
    return { youtube: parseVideoExtraMode(y), instagram: parseVideoExtraMode(i) }
  } catch {
    // An unreadable switch is off: a failed read must never turn a new network on.
    return { youtube: 'off', instagram: 'off' }
  }
}

/** Pure: splits the video networks into those that really send (on) and those that only log (log). YouTube and Instagram
 * are dropped unless their switch says so; every other network passes through untouched. */
export function splitVideoPlatforms(platforms: string[], modes: VideoExtraModes): { send: string[]; logOnly: string[] } {
  const send: string[] = []
  const logOnly: string[] = []
  for (const p of platforms) {
    const key = p.toLowerCase()
    if (key !== 'youtube' && key !== 'instagram') {
      send.push(p)
      continue
    }
    const mode = modes[key]
    if (mode === 'on') send.push(p)
    else if (mode === 'log') logOnly.push(p)
  }
  return { send, logOnly }
}

/** YouTube refuses a title over 100 characters. */
export const YOUTUBE_TITLE_MAX = 100
const SHORTS_TAG = '#Shorts'

/** Pure: the Upload-Post fields that are YouTube's own. Field names are from Upload-Post's video upload reference
 * (docs.upload-post.com/api/upload-video): youtube_title, youtube_description, privacyStatus, selfDeclaredMadeForKids. There is no
 * "Shorts" flag: YouTube treats a vertical video of 3 minutes or less as a Short, and #Shorts in the title/description confirms it. */
export function youtubeShortsFields(caption: string): Record<string, string> {
  const room = YOUTUBE_TITLE_MAX - SHORTS_TAG.length - 1
  const title = fitTikTokTitle(caption, room)
  const limit = PLATFORM_CHAR_LIMITS.youtube
  const description = fitCaption(`${caption.trim()}\n\n${SHORTS_TAG}`, limit)
  return {
    youtube_title: title ? `${title} ${SHORTS_TAG}` : SHORTS_TAG,
    youtube_description: description.includes(SHORTS_TAG) ? description : `${fitCaption(caption.trim(), limit - SHORTS_TAG.length - 2)}\n\n${SHORTS_TAG}`,
    privacyStatus: 'public',
    selfDeclaredMadeForKids: 'false',
  }
}

/** Pure: keeps only the first `cap` hashtags of a caption, removing the rest (a hashtag is a #word token). */
export function capHashtags(caption: string, cap: number): string {
  let seen = 0
  return caption
    .replace(/(^|\s)#[\p{L}\p{N}_]+/gu, (m, lead: string) => (++seen <= cap ? m : lead === '\n' ? lead : ''))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()
}

/** Pure: the Upload-Post fields that are Instagram's own: instagram_title is the Reel caption, media_type REELS and share_to_feed
 * are from the same reference. The caption is cut to Instagram's 2,200 characters and its hashtags to the house cap. */
export function instagramReelsFields(caption: string): Record<string, string> {
  const capped = capHashtags(caption, hashtagCapFor('instagram'))
  return {
    instagram_title: fitCaption(capped, PLATFORM_CHAR_LIMITS.instagram),
    media_type: 'REELS',
    share_to_feed: 'true',
  }
}

export interface VideoExtraLogEntry {
  at: string
  slug: string
  networks: string[]
  /** What would have been sent, per network. */
  fields: Record<string, Record<string, string>>
}

/** Pure: what a "log" run records for a video (nothing is sent). */
export function buildLogEntry(slug: string, networks: string[], caption: string, now: Date = new Date()): VideoExtraLogEntry {
  const fields: VideoExtraLogEntry['fields'] = {}
  for (const n of networks) {
    if (n === 'youtube') fields.youtube = youtubeShortsFields(caption)
    else if (n === 'instagram') fields.instagram = instagramReelsFields(caption)
  }
  return { at: now.toISOString(), slug, networks, fields }
}

const LOG_KEEP = 20

export async function readVideoExtraLog(admin: SupabaseClient): Promise<VideoExtraLogEntry[]> {
  try {
    const parsed = JSON.parse((await getSetting(admin, VIDEO_EXTRA_LOG_KEY)) ?? '[]')
    return Array.isArray(parsed) ? (parsed as VideoExtraLogEntry[]).filter((e) => e && typeof e.slug === 'string') : []
  } catch {
    return []
  }
}

/** Records one would-be send, once per video: a slug already in the log is not added again. Never throws. */
export async function recordVideoExtraLog(admin: SupabaseClient, entry: VideoExtraLogEntry): Promise<void> {
  try {
    const log = await readVideoExtraLog(admin)
    if (log.some((e) => e.slug === entry.slug && entry.networks.every((n) => e.networks.includes(n)))) return
    await setSetting(admin, VIDEO_EXTRA_LOG_KEY, JSON.stringify([entry, ...log].slice(0, LOG_KEEP)))
  } catch {
    // A log write failing must never stop the posting pass.
  }
}
