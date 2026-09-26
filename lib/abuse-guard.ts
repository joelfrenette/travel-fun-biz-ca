import { createHash } from 'node:crypto'
import { getSupabaseAdmin } from '@/lib/supabase-admin'

// Ported from Nomad Escape Plan (Factory Phase 1: foundation), adapted to this project's
// getSupabaseAdmin() (which throws when unconfigured, so every call here is wrapped to fail
// open instead — see allowKey). Not wired into any route yet in this phase; the routes that
// should use it (submit-lead, newsletter, upload-image) get it as a small follow-up once this
// lands, not bundled into "foundation, dormant, nothing user-visible changes."
/**
 * Light protection for the public forms — the routes anyone can POST to without
 * signing in (lead capture, newsletter, and later share-to-unlock, click tracking).
 *
 * Two cheap layers:
 *   - a HONEYPOT field real visitors never see; form-filling bots fill every
 *     field, so a filled honeypot gets a quiet "ok" and nothing happens.
 *   - a THROTTLE counted in the database (public.rate_limit_hit), keyed on a
 *     salted hash of the IP or email — the raw value is never stored.
 *
 * Fails open: if the throttle function isn't installed yet, the database is unreachable, or the
 * service role key isn't configured, the request goes through. A spam guard must never be the
 * thing that takes the signup forms down.
 */
export const HONEYPOT_FIELD = 'company_website'

export function isHoneypotFilled(body: unknown): boolean {
  const v = (body as Record<string, unknown> | null)?.[HONEYPOT_FIELD]
  return typeof v === 'string' && v.trim() !== ''
}

/** The IP the server sees for this request, from the trusted proxy headers Vercel sets. */
export function clientIp(request: Request): string {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || request.headers.get('x-real-ip') || 'unknown'
}

/** A salted, truncated hash of a raw value (an IP, an email) — never the value itself. */
export function hashKey(rawKey: string): string {
  const salt = process.env.RATE_LIMIT_SALT || process.env.CRON_SECRET || 'rate-limit'
  return createHash('sha256').update(`${salt}:${rawKey.toLowerCase()}`).digest('hex').slice(0, 32)
}

/** True when this key is still under `limit` hits in the rolling window. */
export async function allowKey(bucket: string, rawKey: string, limit: number, windowSeconds: number): Promise<boolean> {
  const hashed = hashKey(rawKey)
  try {
    const { data, error } = await getSupabaseAdmin().rpc('rate_limit_hit', {
      p_key: `${bucket}:${hashed}`,
      p_limit: limit,
      p_window_seconds: windowSeconds,
    })
    if (error) return true
    return data !== false
  } catch {
    return true
  }
}

/** Per-IP throttle for one route. */
export function allowRequest(request: Request, bucket: string, limit: number, windowSeconds: number): Promise<boolean> {
  return allowKey(bucket, clientIp(request), limit, windowSeconds)
}
