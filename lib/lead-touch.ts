// Lead-source measurement, consent-gated. Pure helpers, no imports, so they can be checked offline.
//
// The consent gate lives in the browser: lib/attribution.ts getAttribution() returns ONLY page_path unless
// the visitor accepted analytics on the cookie banner. So referrer, landing_path and utm_term arrive in the
// payload only after consent, and this module records whatever arrived, trimmed to the least needed:
// the referring host (not the full URL) and the landing path (not the query string). Nothing consented, nothing stored.

export interface TouchFields {
  referrer: string | null
  landing_path: string | null
  utm_term: string | null
}

export const TOUCH_COLUMNS = ['referrer', 'landing_path', 'utm_term'] as const

interface TouchInput {
  referrer?: string
  landing_path?: string
  utm_term?: string
}

/** Referring host only, lower-cased, no www. Junk or empty gives null. */
export function referrerHost(raw: string | undefined | null): string | null {
  const s = (raw ?? '').trim()
  if (!s) return null
  try {
    const host = new URL(s).hostname.toLowerCase().replace(/^www\./, '')
    return host ? host.slice(0, 120) : null
  } catch {
    return null
  }
}

/** Landing path without the query string or hash, kept short. Must start with "/". */
export function landingPathOnly(raw: string | undefined | null): string | null {
  const s = (raw ?? '').trim()
  if (!s.startsWith('/')) return null
  const path = s.split(/[?#]/)[0]
  return path ? path.slice(0, 200) : null
}

/** The consent-gated columns for one lead. All null when the payload carried none (declined, or an old client). */
export function touchFromAttribution(a: TouchInput | undefined | null): TouchFields {
  const term = (a?.utm_term ?? '').trim()
  return {
    referrer: referrerHost(a?.referrer),
    landing_path: landingPathOnly(a?.landing_path),
    utm_term: term ? term.slice(0, 200) : null,
  }
}

/** True when there is anything worth writing. */
export function hasTouch(t: TouchFields): boolean {
  return !!(t.referrer || t.landing_path || t.utm_term)
}

/** Postgres 42703 / PostgREST PGRST204 / "column ... does not exist|schema cache" mentioning one of the new columns. */
export function isMissingTouchColumn(err: { code?: string; message?: string } | null | undefined): boolean {
  if (!err) return false
  const msg = (err.message ?? '').toLowerCase()
  const mentions = TOUCH_COLUMNS.some((c) => msg.includes(c))
  if (err.code === '42703' || err.code === 'PGRST204') return mentions || msg.includes('column')
  return mentions && (msg.includes('does not exist') || msg.includes('schema cache') || msg.includes('could not find'))
}

type InsertResult = { data: unknown; error: { code?: string; message?: string } | null }

/**
 * Inserts a lead row with the touch fields; if the database says those columns do not exist yet (migration not
 * applied), retries once without them so the lead is never lost. `run` performs the insert for a given row.
 */
export async function insertWithTouchFallback(
  base: Record<string, unknown>,
  touch: TouchFields,
  run: (row: Record<string, unknown>) => PromiseLike<InsertResult>,
): Promise<InsertResult> {
  if (!hasTouch(touch)) return run(base)
  const first = await run({ ...base, ...touch })
  if (first.error && isMissingTouchColumn(first.error)) return run(base)
  return first
}
