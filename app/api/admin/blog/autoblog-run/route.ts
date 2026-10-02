import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { runAutoblog } from '@/lib/autoblog-run'

// blog-composer.ts's own per-step timeouts allow up to ~290s of sequential Anthropic calls
// (40s + 40s + 170s + 40s) plus the cover-image fetch/upload on top - give it headroom, matching
// the pattern already used by extract-draft/generate-field/destinations-generate routes.
export const maxDuration = 300

// Admin-triggered "run now" - bypasses the cron's one-post-per-day cap (an admin clicking this
// button clearly wants a post right now), but still respects autoblog_mode: if it's 'off', this
// still returns { ran: false } rather than forcing a write nobody asked to enable.
export async function POST(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const result = await runAutoblog({ scheduled: false })
    return NextResponse.json(result)
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}
