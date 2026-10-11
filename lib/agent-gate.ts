import type { SupabaseClient } from '@supabase/supabase-js'
import { allowRequest } from '@/lib/abuse-guard'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { canWorkOnExisting, blockMessage, isUuid } from '@/lib/agent-invites'
import { getInviteByToken, getSubmission, type InviteRow, type SubmissionRow } from '@/lib/agent-submissions'

// The first thing every PUBLIC agent route does (WP13): throttle by IP, validate the token (shape, then database), and
// refuse expired or revoked links. Only after this returns ok does a route touch the service role for anything else.
// Every refusal is plain and says nothing about other links, other agents or other trips.

export type Gate = { ok: true; admin: SupabaseClient; invite: InviteRow } | { ok: false; status: number; error: string }

export async function agentGate(request: Request, token: string): Promise<Gate> {
  if (!(await allowRequest(request, 'agent-trip', 240, 600))) return { ok: false, status: 429, error: 'Too many requests. Please wait a minute and try again.' }
  let admin: SupabaseClient
  try {
    admin = getSupabaseAdmin()
  } catch {
    return { ok: false, status: 503, error: 'This page is not available right now. Please try again later.' }
  }
  let invite: InviteRow | null = null
  try {
    invite = await getInviteByToken(admin, token)
  } catch {
    invite = null
  }
  if (!invite) return { ok: false, status: 404, error: 'This link is not valid. Check that you copied all of it, or ask Joel for a new one.' }
  const w = canWorkOnExisting(invite, new Date())
  if (!w.ok) return { ok: false, status: 403, error: blockMessage(w.reason) }
  return { ok: true, admin, invite }
}

export type DraftGate = (Gate & { ok: false }) | { ok: true; admin: SupabaseClient; invite: InviteRow; sub: SubmissionRow }

/** The gate plus one of THIS link's drafts. Another link's draft id is "not found". */
export async function draftGate(request: Request, token: string, draftId: string): Promise<DraftGate> {
  const g = await agentGate(request, token)
  if (!g.ok) return g
  if (!isUuid(draftId)) return { ok: false, status: 404, error: 'That trip was not found.' }
  const sub = await getSubmission(g.admin, g.invite, draftId)
  if (!sub) return { ok: false, status: 404, error: 'That trip was not found.' }
  return { ok: true, admin: g.admin, invite: g.invite, sub }
}
