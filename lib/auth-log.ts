import { clientIp, hashKey } from '@/lib/abuse-guard'
import { getSupabaseAdmin } from '@/lib/supabase-admin'

// Admin sign-in log (table auth_events, migration 0045). Only the kind of event, a salted hash of
// the IP (the same RATE_LIMIT_SALT / CRON_SECRET salt the spam guard uses, never the raw IP) and a
// short browser label. No email, no password, no token. Writing a row never throws.

export type AuthEventKind = 'login_ok' | 'login_fail' | 'logout'

export interface AuthEventWriter {
  from: (table: string) => { insert: (row: unknown) => PromiseLike<{ error: { message: string } | null }> }
}

/** "Chrome on Windows" style label, at most 40 characters. The full user agent is never stored. Pure. */
export function shortUserAgent(ua: string | null | undefined): string {
  if (!ua) return 'unknown'
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Other browser'
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad|iOS/.test(ua) ? 'iOS' : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'other OS'
  return `${browser} on ${os}`.slice(0, 40)
}

/** Build the row to store. Pure, so the check can prove no raw IP or user agent leaks into it. */
export function buildAuthEvent(kind: AuthEventKind, ip: string, ua: string | null | undefined, now: Date = new Date()) {
  return { ts: now.toISOString(), kind, ip_hash: hashKey(`auth:${ip}`), ua_short: shortUserAgent(ua) }
}

/** Record one admin sign-in event. Never throws. `writer` is for tests. */
export async function recordAuthEvent(kind: AuthEventKind, request: Request, writer?: AuthEventWriter): Promise<void> {
  try {
    const row = buildAuthEvent(kind, clientIp(request), request.headers.get('user-agent'))
    const db = writer ?? (getSupabaseAdmin() as unknown as AuthEventWriter)
    await db.from('auth_events').insert(row)
  } catch {
    // The log is a side note: it must never block a sign-in or a sign-out.
  }
}
