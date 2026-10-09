import type { SupabaseClient } from '@supabase/supabase-js'
import { getSetting, getSettingStrict, setSetting } from '@/lib/app-settings'
import {
  uploadPostConfigured,
  uploadPostSendText,
  uploadPostSendPhotos,
  uploadPostSendVideo,
  type UploadPostSendResult,
} from '@/lib/upload-post'
import { ghlSocialConfigured, ghlSocialMissing, ghlCreatePost, ghlHostMedia } from '@/lib/ghl-social'

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

/** For anything that SENDS: a failed read must stop the send, never fall back to the other provider
 * (which would post the same networks a second time on the next healthy run). */
async function getProviderStrict(admin: SupabaseClient): Promise<{ provider?: Provider; error?: string }> {
  const r = await getSettingStrict(admin, PROVIDER_KEY)
  if (r.error) return { error: r.error }
  return { provider: r.value === 'ghl' ? 'ghl' : 'upload-post' }
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
// Per-provider exceptions to the lists above. GoHighLevel's TikTok only takes a video ("TikTok needs a
// video to create a post, it doesn't support multi media formats", seen on a real post 2026-10-08),
// while Upload-Post's TikTok takes photo posts.
const PROVIDER_EXCLUDES: Partial<Record<Provider, Partial<Record<PostKind, string[]>>>> = { ghl: { photo: ['tiktok'], text: ['tiktok'] } }
export const platformsFor = (kind: PostKind, platforms: string[], provider?: Provider): string[] =>
  platforms.filter((p) => PLATFORM_ACCEPTS[kind].includes(p) && !(provider && PROVIDER_EXCLUDES[provider]?.[kind]?.includes(p)))

/** Which of `platforms` a send reached: per-network results when the provider gave them, otherwise
 * all of them if the whole send succeeded. */
export function sentPlatformsOf(result: UploadPostSendResult, platforms: string[]): string[] {
  return platforms.filter((p) => (result.results && p in result.results ? result.results[p].ok : result.ok))
}

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
  const { provider, error: providerErr } = await getProviderStrict(admin)
  if (!provider) return { reason: `could not read which posting provider is chosen (${providerErr}); nothing was sent` }

  if (provider === 'ghl') {
    const missing = ghlSocialMissing()
    if (missing.length) return { reason: `GoHighLevel posting needs ${missing.join(', ')} in Vercel` }
    const accounts = await getGhlAccounts(admin)
    if (!accounts.length) return { reason: 'no GoHighLevel accounts selected' }
    const idsFor = (platforms: string[]) => accounts.filter((a) => platforms.includes(a.platform)).map((a) => a.id)
    // One call per network, so one network refusing a post never stops the others, and the result
    // says exactly which networks were reached.
    const perNetwork = async (platforms: string[], send: (ids: string[], platform: string) => Promise<UploadPostSendResult>): Promise<UploadPostSendResult> => {
      const results: NonNullable<UploadPostSendResult['results']> = {}
      const errors: string[] = []
      for (const p of platforms) {
        const ids = idsFor([p])
        if (!ids.length) continue
        const r = await send(ids, p)
        results[p] = { ok: r.ok, error: r.error }
        if (!r.ok) errors.push(`${p}: ${r.error ?? 'failed'}`)
      }
      const reached = Object.values(results)
      return { ok: reached.length > 0 && errors.length === 0, retryable: false, results, error: errors.length ? errors.join('; ') : undefined }
    }
    return {
      target: {
        provider,
        platforms: [...new Set(accounts.map((a) => a.platform))],
        sendText: (p, text) => perNetwork(p, (ids) => ghlCreatePost({ accountIds: ids, text })),
        sendPhotos: (p, text, imageUrls) => perNetwork(p, (ids) => ghlCreatePost({ accountIds: ids, text, mediaUrls: imageUrls, mediaType: 'image' })),
        // TikTok only pulls videos from a domain it has verified, so its copy is hosted on GoHighLevel's
        // own storage first; the other networks take the original address.
        sendVideo: (p, text, videoUrl) =>
          perNetwork(p, async (ids, platform) => {
            let url = videoUrl
            if (platform === 'tiktok') {
              const hosted = await ghlHostMedia(videoUrl, `tiktok-${Date.now()}.mp4`)
              if (!hosted.url) return { ok: false, retryable: false, error: hosted.error }
              url = hosted.url
            }
            return ghlCreatePost({ accountIds: ids, text, mediaUrls: [url], mediaType: 'video', kind: 'reel' })
          }),
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
