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

export function ghlSocialConfigured(): boolean {
  return !!process.env.GOHIGHLEVEL_PRIVATE_TOKEN?.trim() && !!process.env.GOHIGHLEVEL_LOCATION_ID?.trim()
}

export function ghlSocialMissing(): string[] {
  const missing: string[] = []
  if (!process.env.GOHIGHLEVEL_PRIVATE_TOKEN?.trim()) missing.push('GOHIGHLEVEL_PRIVATE_TOKEN')
  if (!process.env.GOHIGHLEVEL_LOCATION_ID?.trim()) missing.push('GOHIGHLEVEL_LOCATION_ID')
  if (!process.env.GOHIGHLEVEL_USER_ID?.trim()) missing.push('GOHIGHLEVEL_USER_ID')
  return missing
}

const headers = () => ({
  Authorization: `Bearer ${process.env.GOHIGHLEVEL_PRIVATE_TOKEN!.trim()}`,
  Version: VERSION,
  Accept: 'application/json',
  'Content-Type': 'application/json',
})
const loc = () => encodeURIComponent(process.env.GOHIGHLEVEL_LOCATION_ID!.trim())

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
