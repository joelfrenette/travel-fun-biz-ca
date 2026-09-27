import type { SupabaseClient } from '@supabase/supabase-js'
import { getSetting, setSetting } from '@/lib/app-settings'

// Autoblog (lib/autoblog-run.ts) and social distribution (lib/distribution.ts) each have their
// own on/off setting, which is right for day-to-day control - but there was no single switch to
// stop BOTH at once. This is that one switch: a global override that both engines check first,
// on top of (never replacing) their own mode. Flipping it back off restores whatever mode each
// engine already had - it never clears autoblog_mode or distribution_mode.
export const AUTOMATION_PAUSED_KEY = 'automation_paused'

export async function isAutomationPaused(admin: SupabaseClient): Promise<boolean> {
  return (await getSetting(admin, AUTOMATION_PAUSED_KEY)) === 'true'
}

export async function setAutomationPaused(admin: SupabaseClient, paused: boolean): Promise<{ error?: string }> {
  return setSetting(admin, AUTOMATION_PAUSED_KEY, paused ? 'true' : 'false')
}
