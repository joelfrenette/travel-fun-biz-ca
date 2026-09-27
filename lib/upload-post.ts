/**
 * Upload-Post (upload-post.com) — ported from Nomad Escape Plan (Factory Phase 6/16.24, tag
 * factory-v9, Joel's pick 2026-09-27 for this project's social auto-distribution provider).
 * Dormant until UPLOAD_POST_API_KEY is set. Kept verbatim on the confirmed API shapes below —
 * the vendor's own docs disagree with what a real call actually returns, so these comments are
 * load-bearing, not decoration.
 */
const BASE = 'https://api.upload-post.com'

export function uploadPostConfigured(): boolean {
  return !!process.env.UPLOAD_POST_API_KEY?.trim()
}

export interface UploadPostProfile {
  username: string
  accounts: { platform: string; username?: string; status?: string }[]
}

/**
 * The profile list as Upload-Post really sends it (confirmed with a live call, Nomad 2026-09-20):
 * {success, profiles: [{username, social_accounts: {tiktok: {...}, instagram: {...}}}], limit,
 * plan}. The vendor's docs say `users` and an array for social_accounts, so both shapes are read.
 * An account needing a fresh login carries reauth_required: true.
 */
export function parseUploadPostProfiles(json: Record<string, unknown>): UploadPostProfile[] {
  const list = Array.isArray(json.profiles) ? json.profiles : Array.isArray(json.users) ? json.users : []
  return (list as Array<Record<string, unknown>>).map((u) => {
    const sa = u.social_accounts
    const entries: Array<[string, Record<string, unknown>]> = Array.isArray(sa)
      ? (sa as Array<Record<string, unknown>>).map((a) => [String(a.platform ?? ''), a])
      : sa && typeof sa === 'object'
        ? Object.entries(sa as Record<string, unknown>).map(([p, a]) => [p, (a && typeof a === 'object' ? a : {}) as Record<string, unknown>])
        : []
    return {
      username: String(u.username ?? ''),
      accounts: entries
        .filter(([p]) => p)
        .map(([platform, a]) => ({
          platform,
          username: typeof a.handle === 'string' ? a.handle : typeof a.username === 'string' ? a.username : undefined,
          status: a.reauth_required === true ? 'needs reconnect' : typeof a.status === 'string' ? a.status : 'connected',
        })),
    }
  })
}

export async function uploadPostListProfiles(): Promise<{
  configured: boolean
  profiles?: UploadPostProfile[]
  error?: string
  shape?: string[]
}> {
  const key = process.env.UPLOAD_POST_API_KEY?.trim()
  if (!key) return { configured: false }
  try {
    const res = await fetch(`${BASE}/api/uploadposts/users`, {
      headers: { Authorization: `Apikey ${key}`, Accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) {
      const hint = res.status === 401 ? ' — check the API key' : ''
      return { configured: true, error: `Upload-Post returned ${res.status}${hint}` }
    }
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null
    if (!json || typeof json !== 'object') return { configured: true, error: 'Upload-Post sent an unreadable answer.' }
    const profiles = parseUploadPostProfiles(json)
    return { configured: true, profiles, shape: Object.keys(json) }
  } catch {
    return { configured: true, error: 'Could not reach Upload-Post.' }
  }
}

export interface UploadPostSendResult {
  ok: boolean
  requestId?: string
  /** Set when the post was scheduled for later (poll it with uploadPostGetStatus). */
  jobId?: string
  status?: string
  /** Per network: did it post, where, and why not. */
  results?: Record<string, { ok: boolean; url?: string; postId?: string; error?: string }>
  /** Uploads used and allowed this period (the free plan allows 10). */
  usage?: { count: number; limit: number }
  error?: string
  dormant?: boolean
}

/**
 * The answer to a text post, as confirmed by a real post (Nomad 2026-09-20): {success, results:
 * {bluesky: {success, post_id, url, status}}, usage: {count, limit}, request_id, status}. Posts
 * complete synchronously. Overall ok needs every requested network to have succeeded.
 */
export function parseUploadPostSend(json: Record<string, unknown>): UploadPostSendResult {
  const raw = json.results && typeof json.results === 'object' ? (json.results as Record<string, Record<string, unknown>>) : {}
  const results: NonNullable<UploadPostSendResult['results']> = {}
  for (const [net, r] of Object.entries(raw)) {
    const rr = r && typeof r === 'object' ? r : {}
    results[net] = {
      ok: rr.success === true,
      url: typeof rr.url === 'string' ? rr.url : undefined,
      postId: typeof rr.post_id === 'string' ? rr.post_id : undefined,
      error: typeof rr.error === 'string' ? rr.error : typeof rr.message === 'string' ? rr.message : undefined,
    }
  }
  const u = json.usage && typeof json.usage === 'object' ? (json.usage as Record<string, unknown>) : null
  const nets = Object.values(results)
  return {
    ok: json.success !== false && nets.length > 0 && nets.every((r) => r.ok),
    requestId: typeof json.request_id === 'string' ? json.request_id : undefined,
    jobId: typeof json.job_id === 'string' ? json.job_id : undefined,
    status: typeof json.status === 'string' ? json.status : undefined,
    results,
    usage: u && typeof u.count === 'number' && typeof u.limit === 'number' ? { count: u.count, limit: u.limit } : undefined,
    error: typeof json.error === 'string' ? json.error : typeof json.message === 'string' ? json.message : undefined,
  }
}

/** A scheduled or async post answers with a job_id / request_id and no per-network results yet: accepted, not failed. */
export function settleUploadPostSend(status: number, ok: boolean, parsed: UploadPostSendResult): UploadPostSendResult {
  if (status === 202 || (ok && (parsed.jobId || parsed.status === 'scheduled' || parsed.status === 'processing' || parsed.status === 'queued'))) return { ...parsed, ok: true }
  if (!ok) return { ...parsed, ok: false, error: parsed.error || `Upload-Post returned ${status}` }
  return parsed
}

/** Schedule or publish a TEXT post: POST /api/upload_text (the docs' other path,
 * /api/uploadposts/upload_text, returns 404). Never retried: a timeout may still have created
 * the post - the distribute cron treats that as a failure needing a human look, not a retry. */
export async function uploadPostSendText(input: {
  user: string
  platforms: string[]
  text: string
  scheduleDate?: string
}): Promise<UploadPostSendResult> {
  const key = process.env.UPLOAD_POST_API_KEY?.trim()
  if (!key) return { ok: false, dormant: true }
  if (!input.user || !input.platforms.length || !input.text.trim()) return { ok: false, error: 'Needs a profile, a network and text.' }
  const form = new FormData()
  form.set('user', input.user)
  for (const p of input.platforms) form.append('platform[]', p)
  form.set('title', input.text)
  if (input.scheduleDate) form.set('scheduled_date', input.scheduleDate)
  try {
    const res = await fetch(`${BASE}/api/upload_text`, {
      method: 'POST',
      headers: { Authorization: `Apikey ${key}` },
      body: form,
      signal: AbortSignal.timeout(30_000),
    })
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
    return settleUploadPostSend(res.status, res.ok, parseUploadPostSend(json))
  } catch {
    return { ok: false, error: 'Could not reach Upload-Post (the post may or may not have been created).' }
  }
}

const PHOTO_MAX_BYTES = 8 * 1024 * 1024
const PHOTO_MAX_COUNT = 10

/** Publish an IMAGE post: POST /api/upload_photos with the images as uploaded files (photos[])
 * and the caption in `title`, confirmed with a real post (Nomad 2026-09-20). Each image URL is
 * downloaded here first (timeout, type and size checked), because URL input is not confirmed.
 * Never retried, like the text send. */
export async function uploadPostSendPhotos(input: {
  user: string
  platforms: string[]
  text: string
  imageUrls: string[]
  scheduleDate?: string
}): Promise<UploadPostSendResult> {
  const key = process.env.UPLOAD_POST_API_KEY?.trim()
  if (!key) return { ok: false, dormant: true }
  if (!input.user || !input.platforms.length) return { ok: false, error: 'Needs a profile and a network.' }
  const urls = input.imageUrls.filter((u) => /^https:\/\//i.test(u)).slice(0, PHOTO_MAX_COUNT)
  if (!urls.length) return { ok: false, error: 'Needs at least one https image URL.' }

  const form = new FormData()
  form.set('user', input.user)
  for (const p of input.platforms) form.append('platform[]', p)
  if (input.text.trim()) form.set('title', input.text)
  if (input.scheduleDate) form.set('scheduled_date', input.scheduleDate)
  let n = 0
  for (const url of urls) {
    try {
      const src = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(20_000) })
      const type = (src.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
      if (!src.ok || !type.startsWith('image/')) return { ok: false, error: `Could not use image ${n + 1} (${src.status}, ${type || 'no type'}).` }
      const buf = await src.arrayBuffer()
      if (buf.byteLength === 0 || buf.byteLength > PHOTO_MAX_BYTES) return { ok: false, error: `Image ${n + 1} is empty or over 8 MB.` }
      n++
      form.append('photos[]', new Blob([buf], { type }), `image-${n}.${type.split('/')[1]?.replace('jpeg', 'jpg') || 'jpg'}`)
    } catch {
      return { ok: false, error: `Could not download image ${n + 1}.` }
    }
  }
  try {
    const res = await fetch(`${BASE}/api/upload_photos`, {
      method: 'POST',
      headers: { Authorization: `Apikey ${key}` },
      body: form,
      signal: AbortSignal.timeout(60_000),
    })
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
    return settleUploadPostSend(res.status, res.ok, parseUploadPostSend(json))
  } catch {
    return { ok: false, error: 'Could not reach Upload-Post (the post may or may not have been created).' }
  }
}

/**
 * A status answer as it really comes (confirmed by live calls, Nomad 2026-09-21): {status,
 * completed, total, results: [{platform, success, platform_post_id, post_url, error_message,
 * upload_timestamp: {$date}, ...}]}. The older guesses (object keyed by network; url / message /
 * post_id) still parse.
 */
export function parseUploadPostStatus(json: Record<string, unknown>): {
  results: NonNullable<UploadPostSendResult['results']>
  counts: { completed?: number; total?: number }
} {
  const src = json.results
  const entries: Array<[string, Record<string, unknown>]> = Array.isArray(src)
    ? (src as Array<Record<string, unknown>>).map((r) => [String(r?.platform ?? ''), r ?? {}])
    : src && typeof src === 'object'
      ? Object.entries(src as Record<string, Record<string, unknown>>)
      : []
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined)
  const results: NonNullable<UploadPostSendResult['results']> = {}
  for (const [net, r] of entries) {
    if (!net) continue
    const ok = r.success === true
    results[net] = {
      ok,
      url: str(r.post_url) ?? str(r.url),
      postId: str(r.platform_post_id) ?? str(r.post_id),
      error: ok ? undefined : (str(r.error_message) ?? str(r.message) ?? str(r.error)),
    }
  }
  const counts: { completed?: number; total?: number } = {}
  if (typeof json.completed === 'number') counts.completed = json.completed
  if (typeof json.total === 'number') counts.total = json.total
  return { results, counts }
}

/** A post's progress: GET /api/uploadposts/status?request_id=… (async) or ?job_id=… (scheduled). */
export async function uploadPostGetStatus(id: { requestId?: string; jobId?: string }): Promise<{
  ok: boolean
  status?: string
  results?: UploadPostSendResult['results']
  completed?: number
  total?: number
  error?: string
  dormant?: boolean
}> {
  const key = process.env.UPLOAD_POST_API_KEY?.trim()
  if (!key) return { ok: false, dormant: true }
  const q = id.requestId ? `request_id=${encodeURIComponent(id.requestId)}` : id.jobId ? `job_id=${encodeURIComponent(id.jobId)}` : ''
  if (!q) return { ok: false, error: 'Needs a request id or a job id.' }
  try {
    const res = await fetch(`${BASE}/api/uploadposts/status?${q}`, {
      headers: { Authorization: `Apikey ${key}`, Accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
    })
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (res.status === 404) return { ok: false, status: 'not_found', error: 'Upload-Post has no post with that id.' }
    if (!res.ok) return { ok: false, error: typeof json.error === 'string' ? json.error : `Upload-Post returned ${res.status}` }
    const { results, counts } = parseUploadPostStatus(json)
    return { ok: true, status: typeof json.status === 'string' ? json.status : undefined, results, ...counts }
  } catch {
    return { ok: false, error: 'Could not reach Upload-Post.' }
  }
}
