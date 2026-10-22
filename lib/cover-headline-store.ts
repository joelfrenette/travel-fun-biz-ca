import type { SupabaseClient } from '@supabase/supabase-js'
import { getSetting, setSetting } from '@/lib/app-settings'
import { coverHeadlineKey, cleanCoverHeadline } from '@/lib/hook-rules'

// The blog title step writes a separate cover_headline. There is no column for it (no migration), so it is kept in
// app_settings under `cover_headline:<slug>`, the same place carousels live (`carousel:<slug>`). Every read and write
// here swallows errors: a missing row, an unreadable table or a bad value just means "use the old cover headline".

/** Saves a cover headline for a post. Never throws; a failure only means the cover keeps its old headline. */
export async function saveCoverHeadline(admin: SupabaseClient, slug: string, headline: string | null | undefined): Promise<boolean> {
  if (!headline || !slug) return false
  try {
    const { error } = await setSetting(admin, coverHeadlineKey(slug), headline)
    return !error
  } catch {
    return false
  }
}

/** The stored cover headline for a post if it still passes the validator against `source` (the post title plus body), else null. Never throws. */
export async function readCoverHeadline(admin: SupabaseClient, slug: string, source: string): Promise<string | null> {
  try {
    const raw = await getSetting(admin, coverHeadlineKey(slug))
    return cleanCoverHeadline(raw, source)
  } catch {
    return null
  }
}
