import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { getSystemCheck } from '@/lib/system-check-run'
import { summarizeCheck } from '@/lib/system-check'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

// GET  the automated system check: every stage in funnel order, each green, amber or red with one plain sentence, what the site
//      fixed by itself and what needs a person. An answer younger than 5 minutes is reused; ?force=1 reads everything again.
//      Read only (apart from saving its own answer in app_settings system_check_state). No AI call.
export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const force = new URL(request.url).searchParams.get('force') === '1'
    const got = await getSystemCheck(getSupabaseAdmin(), { force })
    return NextResponse.json({ ...got.result, summary: summarizeCheck(got.result), cached: got.cached, ...(got.saveWarning ? { warning: `The answer could not be saved (${got.saveWarning}).` } : {}) })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}
