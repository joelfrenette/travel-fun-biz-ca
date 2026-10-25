import type { SupabaseClient } from '@supabase/supabase-js'
import { readLedger, writeLedger } from '@/lib/learn-loop'

/** Undo for a learned rule: the fingerprint is switched off for good ('disabled'), so it is neither a prompt rule nor re-applied. */
export async function revertLearnedEntry(admin: SupabaseClient, sig: string): Promise<{ ok: boolean; message: string }> {
  const ledger = await readLedger(admin)
  const at = ledger.findIndex((e) => e.sig === sig)
  if (at === -1) return { ok: false, message: 'that failure is no longer in the learning ledger' }
  const next = ledger.map((e, i) => (i === at ? { ...e, status: 'disabled' as const, note: 'switched off by a person' } : e))
  const saved = await writeLedger(admin, next)
  return saved.error ? { ok: false, message: `could not save (${saved.error})` } : { ok: true, message: 'the rule was switched off and will not come back by itself' }
}
