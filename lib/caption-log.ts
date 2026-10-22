import type { SupabaseClient } from '@supabase/supabase-js'
import { getSetting, setSetting } from '@/lib/app-settings'
import { CAPTION_LOG_KEY, appendCaptionLog, recentCaptions, type CaptionLogEntry, type RecentCaption } from '@/lib/caption-plan'

// Stores the caption text that really went out, per network, with the hook style used, in ONE small app_settings value
// (the last 200, newest first, each text cut at 900 characters), so quality can be audited and the loop can learn from it.
// Only the sending step writes it. Never throws and never blocks a send: a failed read or write is just a missing log line.
// Two sends at the same instant could drop one line (read then write); the log is for review, not for any decision.

export async function recordCaptions(admin: SupabaseClient, entries: ReadonlyArray<Partial<CaptionLogEntry>>): Promise<void> {
  if (!entries.length) return
  try {
    const raw = await getSetting(admin, CAPTION_LOG_KEY)
    const { error } = await setSetting(admin, CAPTION_LOG_KEY, appendCaptionLog(raw, entries.map((e) => ({ at: new Date().toISOString(), ...e }))))
    if (error) console.error('[caption-log] write failed:', error)
  } catch (err) {
    console.error('[caption-log] failed:', err instanceof Error ? err.message : err)
  }
}

/** The last `n` logged captions (default 10) for the admin page; [] when nothing is stored or it cannot be read. */
export async function readRecentCaptions(admin: SupabaseClient, n = 10): Promise<RecentCaption[]> {
  try {
    return recentCaptions(await getSetting(admin, CAPTION_LOG_KEY), n)
  } catch {
    return []
  }
}
