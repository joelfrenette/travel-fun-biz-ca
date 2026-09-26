import type { SupabaseClient } from '@supabase/supabase-js'
import { getSetting, setSetting } from '@/lib/app-settings'

// Factory Phase 12: the dormant distribution ledger + mode gate. See migration 0011 for why the
// provider-specific columns (video, per-network post ids, captions) are deliberately not here yet
// — this only tracks WHICH published posts are enrolled to go out once a real posting provider is
// wired in, and a manual off/prepare/auto switch, same pattern as autoblog_mode (lib/autoblog-run.ts).
export type DistributionMode = 'off' | 'prepare' | 'auto'
export const DISTRIBUTION_MODE_KEY = 'distribution_mode'
export const DISTRIBUTION_ACCOUNTS_KEY = 'distribution_accounts'

export interface DistributionRow {
  content_type: 'post'
  slug: string
  title: string
  stage: 'queued' | 'held' | 'done' | 'failed'
  attempts: number
  last_error: string | null
  created_at: string
  updated_at: string
}

/** `app_settings.distribution_mode`: off (default — nothing gets enrolled), prepare (enroll but
 * require manual approval before anything could ever post), auto (enroll and — once a real
 * provider exists — post automatically). Off until an admin explicitly changes it. */
export async function getDistributionMode(admin: SupabaseClient): Promise<DistributionMode> {
  const raw = await getSetting(admin, DISTRIBUTION_MODE_KEY)
  return raw === 'prepare' || raw === 'auto' ? raw : 'off'
}

export async function setDistributionMode(admin: SupabaseClient, mode: DistributionMode): Promise<{ error?: string }> {
  return setSetting(admin, DISTRIBUTION_MODE_KEY, mode)
}

/** Free-text, comma-separated account identifiers — kept provider-agnostic on purpose (nobody has
 * picked GHL Social Planner vs Ayrshare vs Upload-Post yet, and each names accounts differently).
 * Empty means nothing is allowed to post regardless of mode, once posting code exists at all. */
export function parseAccountsCsv(raw: string | null): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

export async function getDistributionAccounts(admin: SupabaseClient): Promise<string[]> {
  return parseAccountsCsv(await getSetting(admin, DISTRIBUTION_ACCOUNTS_KEY))
}

export async function setDistributionAccounts(admin: SupabaseClient, accounts: string[]): Promise<{ error?: string }> {
  return setSetting(admin, DISTRIBUTION_ACCOUNTS_KEY, accounts.map((a) => a.trim()).filter(Boolean).join(','))
}

/** Enrolls a published post once distribution is on (prepare or auto) — a no-op when mode is
 * "off" or the post is already enrolled, so it's always safe to call on every publish. `prepare`
 * mode enrolls straight into `held` (needs an admin to release it before anything could ever post
 * once a provider exists); `auto` enrolls into `queued`. Never throws — a distribution-ledger
 * write failure must never block publishing the post itself. */
export async function enrollIfDue(admin: SupabaseClient, slug: string, title: string): Promise<void> {
  try {
    const mode = await getDistributionMode(admin)
    if (mode === 'off') return
    const { data: existing } = await admin.from('post_distribution').select('slug').eq('content_type', 'post').eq('slug', slug).maybeSingle()
    if (existing) return
    await admin.from('post_distribution').insert({ content_type: 'post', slug, title, stage: mode === 'prepare' ? 'held' : 'queued' })
  } catch (err) {
    console.error('[distribution] enroll failed:', err instanceof Error ? err.message : err)
  }
}

export async function listDistributionQueue(admin: SupabaseClient): Promise<DistributionRow[]> {
  const { data, error } = await admin.from('post_distribution').select('*').order('created_at', { ascending: false }).limit(200)
  if (error) throw new Error(error.message)
  return data ?? []
}

/** Moves a held row to queued (admin approval) or a queued row to held (admin pause). Nothing
 * else is legal from the admin UI — done/failed only become reachable once real posting code
 * exists to set them. */
export async function setDistributionStage(admin: SupabaseClient, slug: string, stage: 'queued' | 'held'): Promise<void> {
  const { error } = await admin.from('post_distribution').update({ stage, updated_at: new Date().toISOString() }).eq('content_type', 'post').eq('slug', slug)
  if (error) throw new Error(error.message)
}
