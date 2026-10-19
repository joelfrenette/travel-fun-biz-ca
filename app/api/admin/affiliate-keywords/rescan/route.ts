import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { clearAffiliateRulesCache, KEYWORDS_MIGRATION_MESSAGE } from '@/lib/affiliate-rules'
import { rescanSite } from '@/lib/affiliate-usage'
import { noteUsageScanned } from '@/lib/affiliate-refresh'

// WP22: "Rescan the site". Recomputes the usage report (per phrase: pages, occurrences, example pages) and stores it
// in app_settings. Pages themselves are linked at display time, so this changes no page; it only refreshes the numbers.
// The button always scans at once (the automatic scan after a change is limited to once a minute).
export async function POST(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    clearAffiliateRulesCache()
    const result = await rescanSite(getSupabaseAdmin())
    if (!result.ok) return NextResponse.json({ error: result.migrationMissing ? KEYWORDS_MIGRATION_MESSAGE : result.error }, { status: result.migrationMissing ? 409 : 500 })
    noteUsageScanned()
    return NextResponse.json({ report: result.report })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}
