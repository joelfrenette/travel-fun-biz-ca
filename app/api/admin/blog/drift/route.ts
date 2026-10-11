import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { checkPublishedPostsForDrift, checkPastTripsForRecap } from '@/lib/content-drift'

// Manual trigger for the same check a future cron would run unattended (one shared function,
// lib/content-drift.ts - see its own header comment). Cheap today (a handful of posts/packages),
// bounded by the same deterministic queries getPublishedPosts()/travel_packages already use.
// `recapFindings` (WP14) lists past trips with no recap yet; a past trip is never suggested for unpublishing.
export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const findings = await checkPublishedPostsForDrift()
    const recapFindings = await checkPastTripsForRecap(getSupabaseAdmin()).catch(() => [])
    return NextResponse.json({ findings, recapFindings })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}
