import type { SupabaseClient } from '@supabase/supabase-js'
import { getSetting, setSetting } from '@/lib/app-settings'
import { actionsToday, appendDecisions, decision, isVetoedIn, POLICY_CAPS, readDecisions, readVetoes, type AutoDecision, type PolicyName } from '@/lib/auto-decisions'

// Small helpers most flywheel steps need. Every one wraps an existing function (lib/auto-decisions.ts, lib/app-settings.ts);
// none reimplements them.

/** How many logged actions `policy` has taken on the UTC day of `now`. */
export async function todayCount(admin: SupabaseClient, policy: PolicyName, now: Date = new Date()): Promise<number> {
  return actionsToday(await readDecisions(admin), policy, now)
}

/** How many more actions `policy` may take today under its cap (never negative). */
export async function capRoom(admin: SupabaseClient, policy: PolicyName, now: Date = new Date()): Promise<number> {
  return Math.max(0, POLICY_CAPS[policy] - (await todayCount(admin, policy, now)))
}

/** True when a person undid or turned down this subject for this policy (the veto list). */
export async function isVetoed(admin: SupabaseClient, policy: PolicyName, subject: string): Promise<boolean> {
  return isVetoedIn(await readVetoes(admin), policy, subject)
}

/** Writes one line to the "Autopilot decisions" log. `undo` is `{ kind: 'fw:<stepId>', ref }` when the step has an undo handler, or an
 * existing undo kind, or null. Never throws; a dry run logs nothing (appendDecisions blocks it). */
export async function logDecision(admin: SupabaseClient, policy: PolicyName, subject: string, action: string, reason: string, undo: AutoDecision['undo'] = null, now: Date = new Date()): Promise<void> {
  await appendDecisions(admin, [decision(policy, subject, action, reason, undo, now)])
}

/** Reads an app_settings value, or `fallback` when it is unset or cannot be read. */
export async function readSetting(admin: SupabaseClient, key: string, fallback: string): Promise<string> {
  try {
    const v = await getSetting(admin, key)
    return v === null || v === '' ? fallback : v
  } catch {
    return fallback
  }
}

/** Reads a number setting; a missing, non-numeric or negative value gives `fallback`. */
export async function readNumberSetting(admin: SupabaseClient, key: string, fallback: number): Promise<number> {
  const n = Number(await readSetting(admin, key, String(fallback)))
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

/** Reads a JSON setting; anything missing or corrupt gives `fallback`. */
export async function readJsonSetting<T>(admin: SupabaseClient, key: string, fallback: T): Promise<T> {
  try {
    const raw = await getSetting(admin, key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

export async function writeSetting(admin: SupabaseClient, key: string, value: string): Promise<{ error?: string }> {
  try {
    return await setSetting(admin, key, value)
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'could not write the setting' }
  }
}

export async function writeJsonSetting(admin: SupabaseClient, key: string, value: unknown): Promise<{ error?: string }> {
  return writeSetting(admin, key, JSON.stringify(value))
}
