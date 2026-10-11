import type { SupabaseClient } from '@supabase/supabase-js'

// Atomic daily slots (WP13 fix round 1). Same pattern as the repair slots (lib/content-edits.ts): a slot is a row in
// app_settings whose KEY is unique, so two requests can never take the same slot, and the slot is taken BEFORE the paid
// or storage-costly work starts. A request that is later refused or whose result is thrown away still used its slot.

/** UTC calendar day, the same for every caller. */
export function slotDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10)
}

export function slotKey(prefix: string, n: number, now: Date = new Date()): string {
  return `${prefix}:${slotDay(now)}:${n}`
}

/** Takes ONE slot out of `max` for today under this prefix. True when it got one, false when all are taken or the
 * database cannot be written (a failed claim never lets the work through). */
export async function claimSlot(admin: SupabaseClient, prefix: string, max: number, now: Date = new Date()): Promise<boolean> {
  return (await claimSlots(admin, prefix, 1, max, now)) === 1
}

/** Takes up to `want` slots out of `max`. Returns how many it got. */
export async function claimSlots(admin: SupabaseClient, prefix: string, want: number, max: number, now: Date = new Date()): Promise<number> {
  let got = 0
  for (let n = 1; n <= max && got < want; n++) {
    const { error } = await admin.from('app_settings').insert({ key: slotKey(prefix, n, now), value: now.toISOString() })
    if (!error) got++
  }
  return got
}
