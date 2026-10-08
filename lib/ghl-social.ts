import type { UploadPostSendResult } from '@/lib/upload-post'

// GoHighLevel Social Planner (v2 API) as a second posting provider. Dormant until
// GOHIGHLEVEL_PRIVATE_TOKEN (a Private Integration Token with the Social Planner scopes),
// GOHIGHLEVEL_LOCATION_ID and GOHIGHLEVEL_USER_ID (the GHL user the posts are created as) are set.
// The site's older GOHIGHLEVEL_API_KEY is the legacy v1 key and cannot reach Social Planner (checked
// 2026-10-08: HTTP 401), which is why a separate token is needed.
//
// ** NOT CONFIRMED BY A REAL POST. ** The accounts list matches a real response seen from GHL. The
// create-post body (accountIds, summary, media[{url,type}], type, userId, status) follows GHL's own
// tool schema, but how "status: published" behaves and how media items must look were not seen from
// a live call. Treat the first post to a chosen account as the test. Posts are not verified after
// creation, so a network rejecting one later is not reported back here.
const BASE = 'https://services.leadconnectorhq.com'
const VERSION = '2021-07-28'

export interface GhlAccount {
  id: string
  platform: string
  name: string
  type?: string
  active: boolean
  expired: boolean
}

// The location id has been saved in Vercel as plain LOCATION_ID as well as GOHIGHLEVEL_LOCATION_ID,
// so either name works.
const locationId = () => (process.env.GOHIGHLEVEL_LOCATION_ID || process.env.LOCATION_ID || '').trim()

export function ghlSocialConfigured(): boolean {
  return !!process.env.GOHIGHLEVEL_PRIVATE_TOKEN?.trim() && !!locationId()
}

export function ghlSocialMissing(): string[] {
  const missing: string[] = []
  if (!process.env.GOHIGHLEVEL_PRIVATE_TOKEN?.trim()) missing.push('GOHIGHLEVEL_PRIVATE_TOKEN')
  if (!locationId()) missing.push('GOHIGHLEVEL_LOCATION_ID (or LOCATION_ID)')
  if (!process.env.GOHIGHLEVEL_USER_ID?.trim()) missing.push('GOHIGHLEVEL_USER_ID')
  return missing
}

const headers = () => ({
  Authorization: `Bearer ${process.env.GOHIGHLEVEL_PRIVATE_TOKEN!.trim()}`,
  Version: VERSION,
  Accept: 'application/json',
  'Content-Type': 'application/json',
})
const loc = () => encodeURIComponent(locationId())

export async function ghlListAccounts(): Promise<{ accounts: GhlAccount[]; error?: string }> {
  if (!ghlSocialConfigured()) return { accounts: [] }
  try {
    const res = await fetch(`${BASE}/social-media-posting/${loc()}/accounts`, { headers: headers(), cache: 'no-store', signal: AbortSignal.timeout(15_000) })
    if (!res.ok) return { accounts: [], error: res.status === 401 ? 'GoHighLevel rejected the token (401) - it needs the Social Planner permission.' : `GoHighLevel returned ${res.status}` }
    const json = (await res.json().catch(() => null)) as { results?: { accounts?: Array<Record<string, unknown>> } } | null
    const list = json?.results?.accounts ?? []
    return {
      accounts: list
        .filter((a) => typeof a.id === 'string' && typeof a.platform === 'string' && a.deleted !== true)
        .map((a) => ({
          id: a.id as string,
          platform: (a.platform as string).toLowerCase(),
          name: typeof a.name === 'string' ? a.name : (a.platform as string),
          type: typeof a.type === 'string' ? a.type : undefined,
          active: a.active !== false,
          expired: a.isExpired === true,
        })),
    }
  } catch {
    return { accounts: [], error: 'Could not reach GoHighLevel.' }
  }
}

/** Creates one post on the given account ids right away. Never retried: a timeout may still have
 * created the post, and a duplicate public post is worse than a missed one. */
export async function ghlCreatePost(input: { accountIds: string[]; text: string; mediaUrls?: string[]; mediaType?: 'image' | 'video'; kind?: 'post' | 'reel' }): Promise<UploadPostSendResult> {
  if (!ghlSocialConfigured()) return { ok: false, dormant: true }
  const userId = process.env.GOHIGHLEVEL_USER_ID?.trim()
  if (!userId) return { ok: false, retryable: false, error: 'GOHIGHLEVEL_USER_ID is not set.' }
  if (!input.accountIds.length) return { ok: false, retryable: false, error: 'No GoHighLevel accounts selected.' }
  const media = (input.mediaUrls ?? []).filter((u) => /^https:\/\//i.test(u)).map((url) => ({ url, type: input.mediaType === 'video' ? 'video/mp4' : 'image/png' }))
  try {
    const res = await fetch(`${BASE}/social-media-posting/${loc()}/posts`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        accountIds: input.accountIds,
        summary: input.text,
        type: input.kind ?? 'post',
        userId,
        status: 'published',
        ...(media.length ? { media } : {}),
      }),
      signal: AbortSignal.timeout(30_000),
    })
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) {
      const message = typeof json.message === 'string' ? json.message : Array.isArray(json.message) ? json.message.join('; ') : `GoHighLevel returned ${res.status}`
      // 4xx will not fix itself on retry; a 5xx might, but a retry could duplicate, so none are retried.
      return { ok: false, retryable: false, error: message }
    }
    return { ok: true }
  } catch {
    return { ok: false, retryable: false, error: 'Could not reach GoHighLevel (the post may or may not have been created).' }
  }
}

/** Hosts a file on GoHighLevel's own media storage and returns the hosted address. TikTok only accepts
 * a video pulled from a domain verified in TikTok's settings ("The media URL isn't from a verified
 * domain", seen on a real post 2026-10-08), and GoHighLevel's own storage is one TikTok accepts, so
 * TikTok videos go through here first. Needs the token to carry the media-library write permission.
 * The request shape (POST /medias/upload-file, hosted + fileUrl) follows GHL's documented API and is
 * not yet confirmed by a live call here. */
export async function ghlHostMedia(sourceUrl: string, name: string): Promise<{ url?: string; error?: string }> {
  if (!ghlSocialConfigured()) return { error: 'GoHighLevel is not configured.' }
  try {
    const form = new FormData()
    form.set('hosted', 'true')
    form.set('fileUrl', sourceUrl)
    form.set('name', name)
    const res = await fetch(`${BASE}/medias/upload-file`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.GOHIGHLEVEL_PRIVATE_TOKEN!.trim()}`, Version: VERSION, Accept: 'application/json' },
      body: form,
      signal: AbortSignal.timeout(60_000),
    })
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) {
      const why = typeof json.message === 'string' ? json.message : `HTTP ${res.status}`
      const hint = res.status === 401 || res.status === 403 ? ' - the GoHighLevel token needs the media library (medias.write) permission' : ''
      return { error: `Could not host the video on GoHighLevel: ${why}${hint}` }
    }
    const url = typeof json.url === 'string' ? json.url : typeof (json.data as { url?: unknown } | undefined)?.url === 'string' ? ((json.data as { url: string }).url) : null
    return url ? { url } : { error: 'GoHighLevel accepted the upload but returned no address for it.' }
  } catch {
    return { error: 'Could not reach GoHighLevel to host the video.' }
  }
}

export interface GhlFailedPost {
  id: string
  platform: string
  accountId: string
  error: string
  at: string
}

/** Posts GoHighLevel accepted and then failed to publish (it says "accepted" at creation, and the
 * network's rejection arrives later - for example TikTok refusing a video). Looks back `days` days. */
export async function ghlListFailedPosts(days = 3): Promise<GhlFailedPost[]> {
  if (!ghlSocialConfigured()) return []
  try {
    const now = new Date()
    const res = await fetch(`${BASE}/social-media-posting/${loc()}/posts/list`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ type: 'failed', skip: '0', limit: '50', includeUsers: 'false', fromDate: new Date(now.getTime() - days * 86_400_000).toISOString(), toDate: new Date(now.getTime() + 86_400_000).toISOString() }),
      cache: 'no-store',
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) return []
    const json = (await res.json().catch(() => null)) as { results?: { posts?: Array<Record<string, unknown>> } } | null
    return (json?.results?.posts ?? [])
      .filter((x) => x.status === 'failed' && x.deleted !== true && typeof x.postId === 'string')
      .map((x) => ({
        id: x.postId as string,
        platform: typeof x.platform === 'string' ? x.platform : 'unknown',
        accountId: typeof x.accountId === 'string' ? x.accountId : '',
        error: typeof x.error === 'string' && x.error ? x.error : 'GoHighLevel reported a failure without a reason.',
        at: typeof x.createdAt === 'string' ? x.createdAt : '',
      }))
  } catch {
    return []
  }
}
