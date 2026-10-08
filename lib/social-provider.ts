import type { SupabaseClient } from '@supabase/supabase-js'
import { getSetting, setSetting } from '@/lib/app-settings'
import {
  uploadPostConfigured,
  uploadPostSendText,
  uploadPostSendPhotos,
  uploadPostSendVideo,
  type UploadPostSendResult,
} from '@/lib/upload-post'
import { ghlSocialConfigured, ghlSocialMissing, ghlCreatePost } from '@/lib/ghl-social'

// One place that answers "where does a post go, and how do I send it": Upload-Post or GoHighLevel,
// one active at a time (so the same post can never go out twice). distribution.ts and autopilot.ts
// ask for a PostingTarget and never talk to a provider directly. Settings keys for the Upload-Post
// profile and platform list are read by name here (they are defined in distribution.ts, which
// imports this file).
export type Provider = 'upload-post' | 'ghl'
export const PROVIDER_KEY = 'distribution_provider'
export const GHL_ACCOUNTS_KEY = 'ghl_accounts'

export interface GhlAccountRef {
  id: string
  platform: string
  name: string
}

export async function getProvider(admin: SupabaseClient): Promise<Provider> {
  return (await getSetting(admin, PROVIDER_KEY)) === 'ghl' ? 'ghl' : 'upload-post'
}

export async function setProvider(admin: SupabaseClient, provider: Provider): Promise<{ error?: string }> {
  return setSetting(admin, PROVIDER_KEY, provider)
}

export async function getGhlAccounts(admin: SupabaseClient): Promise<GhlAccountRef[]> {
  try {
    const parsed = JSON.parse((await getSetting(admin, GHL_ACCOUNTS_KEY)) ?? '[]')
    return Array.isArray(parsed)
      ? parsed.filter((a): a is GhlAccountRef => !!a && typeof a.id === 'string' && typeof a.platform === 'string' && typeof a.name === 'string')
      : []
  } catch {
    return []
  }
}

export async function setGhlAccounts(admin: SupabaseClient, accounts: GhlAccountRef[]): Promise<{ error?: string }> {
  return setSetting(admin, GHL_ACCOUNTS_KEY, JSON.stringify(accounts))
}

// Which networks accept which kind of post. A network outside a kind's list is skipped for that
// kind, never sent and failed (YouTube takes video only, so a photo post to it is rejected outright).
// Photo and video lists follow Upload-Post's published support; text is the stricter set because
// Instagram, TikTok, Pinterest and YouTube need media.
export type PostKind = 'text' | 'photo' | 'video'
export const PLATFORM_ACCEPTS: Record<PostKind, string[]> = {
  text: ['x', 'twitter', 'linkedin', 'facebook', 'threads', 'bluesky', 'reddit', 'google'],
  photo: ['instagram', 'tiktok', 'linkedin', 'facebook', 'x', 'twitter', 'threads', 'pinterest', 'bluesky', 'google'],
  video: ['instagram', 'tiktok', 'youtube', 'facebook', 'linkedin', 'x', 'twitter', 'threads', 'pinterest', 'bluesky'],
}
export const platformsFor = (kind: PostKind, platforms: string[]): string[] => platforms.filter((p) => PLATFORM_ACCEPTS[kind].includes(p))

export interface PostingTarget {
  provider: Provider
  /** Lowercase network names this target will post to. */
  platforms: string[]
  sendText(platforms: string[], text: string): Promise<UploadPostSendResult>
  sendPhotos(platforms: string[], text: string, imageUrls: string[]): Promise<UploadPostSendResult>
  sendVideo(platforms: string[], text: string, videoUrl: string): Promise<UploadPostSendResult>
}

const csv = (raw: string | null) => (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean)

/** The active provider's posting target, or why there isn't one yet. */
export async function resolvePostingTarget(admin: SupabaseClient): Promise<{ target?: PostingTarget; reason?: string }> {
  const provider = await getProvider(admin)

  if (provider === 'ghl') {
    const missing = ghlSocialMissing()
    if (missing.length) return { reason: `GoHighLevel posting needs ${missing.join(', ')} in Vercel` }
    const accounts = await getGhlAccounts(admin)
    if (!accounts.length) return { reason: 'no GoHighLevel accounts selected' }
    const idsFor = (platforms: string[]) => accounts.filter((a) => platforms.includes(a.platform)).map((a) => a.id)
    return {
      target: {
        provider,
        platforms: [...new Set(accounts.map((a) => a.platform))],
        sendText: (p, text) => ghlCreatePost({ accountIds: idsFor(p), text }),
        sendPhotos: (p, text, imageUrls) => ghlCreatePost({ accountIds: idsFor(p), text, mediaUrls: imageUrls, mediaType: 'image' }),
        sendVideo: (p, text, videoUrl) => ghlCreatePost({ accountIds: idsFor(p), text, mediaUrls: [videoUrl], mediaType: 'video', kind: 'reel' }),
      },
    }
  }

  if (!uploadPostConfigured()) return { reason: 'UPLOAD_POST_API_KEY is not set' }
  const user = csv(await getSetting(admin, 'distribution_accounts'))[0]
  if (!user) return { reason: 'no Upload-Post profile chosen' }
  const platforms = csv(await getSetting(admin, 'distribution_platforms')).map((p) => p.toLowerCase())
  if (!platforms.length) return { reason: 'no platforms chosen' }
  return {
    target: {
      provider,
      platforms,
      sendText: (p, text) => uploadPostSendText({ user, platforms: p, text }),
      sendPhotos: (p, text, imageUrls) => uploadPostSendPhotos({ user, platforms: p, text, imageUrls }),
      sendVideo: (p, text, videoUrl) => uploadPostSendVideo({ user, platforms: p, text, videoUrl }),
    },
  }
}

export { ghlSocialConfigured }
