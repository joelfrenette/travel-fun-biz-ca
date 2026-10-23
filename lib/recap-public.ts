import { getSetting } from '@/lib/app-settings'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { parseBundle, recapBundleKey, type RecapBundle } from '@/lib/recap-studio'

// What the PUBLIC trip page may read of the Recap Studio: ONE app_settings row per trip, written only by the Publish button
// (lib/recap-store.ts publishStudio). It holds the quick answer, the takeaways, the approved quotes (each with the permission
// tick) and the search text, and nothing else. Pending and rejected items, answers, links and tokens are never in it. Fails
// to null (the page then shows the plain recap as before).
export async function loadRecapBundle(packageId: string): Promise<RecapBundle | null> {
  try {
    return parseBundle(await getSetting(getSupabaseAdmin(), recapBundleKey(packageId)))
  } catch {
    return null
  }
}
