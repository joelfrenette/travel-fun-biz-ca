// IndexNow: tell Bing (and Yandex, Naver, Seznam) a URL changed so it is recrawled within minutes.
// Free, one key, no account. Google does not use it. https://www.indexnow.org/documentation
import { SITE_URL, absoluteUrl } from '@/lib/site'

const ENDPOINT = 'https://api.indexnow.org/indexnow'
export const KEY_FILE_PATH = '/indexnow-key.txt'

export function isIndexNowConfigured(): boolean {
  return /^[a-zA-Z0-9-]{8,128}$/.test(process.env.INDEXNOW_KEY || '')
}

export interface IndexNowResult {
  ok: boolean
  skipped?: 'not configured' | 'no urls'
  status?: number
  error?: string
  urls: string[]
}

/** Submit site paths (or absolute URLs on this host). Never throws; the caller's write already succeeded. */
export async function pingIndexNow(paths: string[]): Promise<IndexNowResult> {
  const urls = Array.from(new Set(paths.map(absoluteUrl))).filter((u) => u.startsWith(SITE_URL))
  if (!isIndexNowConfigured()) return { ok: false, skipped: 'not configured', urls }
  if (urls.length === 0) return { ok: false, skipped: 'no urls', urls }
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ host: new URL(SITE_URL).host, key: process.env.INDEXNOW_KEY, keyLocation: absoluteUrl(KEY_FILE_PATH), urlList: urls }),
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    })
    // 200 and 202 both mean accepted. 403 = key file not reachable, 422 = URL/host mismatch, 429 = slow down.
    const ok = res.status === 200 || res.status === 202
    if (!ok) console.warn('[indexnow] rejected', res.status, urls)
    return { ok, status: res.status, urls, ...(ok ? {} : { error: `IndexNow HTTP ${res.status}` }) }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'IndexNow failed'
    console.warn('[indexnow] failed', message)
    return { ok: false, error: message, urls }
  }
}
