import type { SupabaseClient } from '@supabase/supabase-js'
import { allowKey, allowRequest, hashKey } from '@/lib/abuse-guard'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { getShareByToken, MIGRATION_HINT, type ShareRow } from '@/lib/recap-store'
import { isShareTokenFormat, SHARE_LIMITS, SHARE_UNKNOWN_MESSAGE, shareBlockMessage, shareState } from '@/lib/recap-studio'

// The first thing every PUBLIC recap route does: throttle by IP, check the token's shape, throttle by token, look the token up
// BY HASH, and refuse expired or revoked links. Only after this returns ok does a route touch the service role for anything else.
// Every refusal is plain and says nothing about other links, other trips or other people.

export type RecapGate = { ok: true; admin: SupabaseClient; share: ShareRow } | { ok: false; status: number; error: string }

export async function recapGate(request: Request, token: string): Promise<RecapGate> {
  if (!(await allowRequest(request, 'recap-ip', SHARE_LIMITS.perIp.limit, SHARE_LIMITS.perIp.windowSeconds))) return { ok: false, status: 429, error: 'Too many requests. Please wait a few minutes and try again.' }
  if (!isShareTokenFormat(token)) return { ok: false, status: 404, error: SHARE_UNKNOWN_MESSAGE }
  if (!(await allowKey('recap-token', token, SHARE_LIMITS.perToken.limit, SHARE_LIMITS.perToken.windowSeconds))) return { ok: false, status: 429, error: 'This link has been used a lot in a short time. Please try again later.' }
  let admin: SupabaseClient
  try {
    admin = getSupabaseAdmin()
  } catch {
    return { ok: false, status: 503, error: 'This page is not available right now. Please try again later.' }
  }
  let share: ShareRow | null = null
  try {
    share = await getShareByToken(admin, token)
  } catch (e) {
    // Before migration 0053 there is nothing to look up: the link simply is not valid yet.
    return e instanceof Error && e.message === MIGRATION_HINT ? { ok: false, status: 404, error: SHARE_UNKNOWN_MESSAGE } : { ok: false, status: 503, error: 'This page is not available right now. Please try again later.' }
  }
  if (!share) return { ok: false, status: 404, error: SHARE_UNKNOWN_MESSAGE }
  const s = shareState(share, new Date())
  if (!s.ok) return { ok: false, status: 403, error: shareBlockMessage(s.reason) }
  return { ok: true, admin, share }
}

/** A separate, tighter limit for the routes that store something. */
export function allowSubmit(token: string): Promise<boolean> {
  return allowKey('recap-submit', token, SHARE_LIMITS.submitsPerToken.limit, SHARE_LIMITS.submitsPerToken.windowSeconds)
}

export { hashKey }
