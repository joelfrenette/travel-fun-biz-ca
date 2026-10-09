import type { SupabaseClient } from '@supabase/supabase-js'

// Ported from Nomad Escape Plan's modules/marketing/app-settings.ts (Factory Phase 1: foundation).
// Trimmed to the generic get/set primitives; the mode-specific keys and helpers (autoblog mode,
// distribution mode, and so on) get added in the phases that actually introduce those switches.
/**
 * Operational switches the admin owns, not secrets. Changing one must never require a
 * redeploy, which is why it lives in the database (`app_settings`) instead of a Vercel env var.
 * API keys and tokens stay in env, where they belong. Admin-only by RLS; crons read them with
 * the service-role key, same as every other admin table in this project.
 */
export async function getSetting(supabase: SupabaseClient, key: string): Promise<string | null> {
  const { data } = await supabase.from('app_settings').select('value').eq('key', key).maybeSingle()
  return data?.value ?? null
}

/** Like getSetting, but a failed read is reported instead of looking like "no value". Use it wherever
 * "missing" and "could not read" must lead to different decisions (safety markers, dismissed lists). */
export async function getSettingStrict(supabase: SupabaseClient, key: string): Promise<{ value: string | null; error?: string }> {
  const { data, error } = await supabase.from('app_settings').select('value').eq('key', key).maybeSingle()
  if (error) return { value: null, error: error.message }
  return { value: data?.value ?? null }
}

export async function setSetting(supabase: SupabaseClient, key: string, value: string): Promise<{ error?: string }> {
  const { error } = await supabase
    .from('app_settings')
    .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' })
  return error ? { error: error.message } : {}
}
