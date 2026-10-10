import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { runKeywordEngine } from '@/lib/keyword-intel'

// The engine makes a few vendor calls and one AI call; a run normally takes well under two minutes.
export const maxDuration = 300

// POST: "Run the engine now". Ignores the weekly cadence but never the weekly dollar budget, and runs one
// engine at a time (a lock inside runKeywordEngine). The result is also saved as the last run, so a failure
// shows up in Needs attention.
export async function POST(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const run = await runKeywordEngine(getSupabaseAdmin(), { force: true })
    return NextResponse.json({ run })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}
