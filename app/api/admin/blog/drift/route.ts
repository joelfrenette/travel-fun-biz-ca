import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { checkPublishedPostsForDrift } from '@/lib/content-drift'

// Manual trigger for the same check a future cron would run unattended (one shared function,
// lib/content-drift.ts - see its own header comment). Cheap today (a handful of posts/packages),
// bounded by the same deterministic queries getPublishedPosts()/travel_packages already use.
export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const findings = await checkPublishedPostsForDrift()
    return NextResponse.json({ findings })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}
