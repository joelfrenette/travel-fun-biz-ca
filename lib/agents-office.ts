import type { SupabaseClient } from '@supabase/supabase-js'
import { OFFICE_ROLE_LABEL, isOfficeRole, type OfficeRole } from '@/lib/agents'

// Database side of the office team (CEO, CTO, Manager). Server only, admin only: the role is never read by public code.
// The client is passed in so scripts/check-agents.ts can run this against an in-memory fake.
//
// At most one person per role. Moving a role takes it from the old holder first (the database also has a unique index, so
// two holders can never exist), and puts it back if the new write fails.

type Row = Record<string, unknown>

export type SetRoleResult = { ok: true; movedFrom: string[] } | { ok: false; error: string; code: 'taken' | 'db' }

/** Who holds `role` right now, other than `exceptId`. */
export async function otherHolders(admin: SupabaseClient, role: OfficeRole, exceptId: string | null): Promise<{ id: string; display_name: string }[]> {
  const { data, error } = await admin.from('agents').select('id, display_name').eq('office_role', role)
  if (error) throw new Error(error.message)
  return ((data ?? []) as Row[])
    .filter((r) => String(r.id) !== exceptId)
    .map((r) => ({ id: String(r.id), display_name: String(r.display_name ?? '') }))
}

export function takenMessage(role: OfficeRole, holders: { display_name: string }[]): string {
  return `${holders.map((h) => h.display_name).join(' and ')} is already the ${OFFICE_ROLE_LABEL[role]}. Confirm the move to give the role to this person instead.`
}

/** Gives (or clears, when role is null) an office role. A role someone else holds is only moved when `move` is true. */
export async function setOfficeRole(admin: SupabaseClient, agentId: string, role: OfficeRole | null, move: boolean): Promise<SetRoleResult> {
  const now = new Date().toISOString()
  if (role === null) {
    const { error } = await admin.from('agents').update({ office_role: null, updated_at: now }).eq('id', agentId)
    return error ? { ok: false, error: error.message, code: 'db' } : { ok: true, movedFrom: [] }
  }
  if (!isOfficeRole(role)) return { ok: false, error: 'Pick CEO, CTO, Manager or no office role.', code: 'db' }
  let holders: { id: string; display_name: string }[]
  try {
    holders = await otherHolders(admin, role, agentId)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Could not read the office team.', code: 'db' }
  }
  if (holders.length > 0 && !move) return { ok: false, error: takenMessage(role, holders), code: 'taken' }
  for (const h of holders) {
    const { error } = await admin.from('agents').update({ office_role: null, updated_at: now }).eq('id', h.id)
    if (error) return { ok: false, error: error.message, code: 'db' }
  }
  const { error } = await admin.from('agents').update({ office_role: role, updated_at: now }).eq('id', agentId)
  if (error) {
    // Put the role back so the office is never left without its CEO / CTO / Manager because of a failed move.
    for (const h of holders) await admin.from('agents').update({ office_role: role }).eq('id', h.id)
    return { ok: false, error: error.message, code: 'db' }
  }
  return { ok: true, movedFrom: holders.map((h) => h.display_name) }
}
