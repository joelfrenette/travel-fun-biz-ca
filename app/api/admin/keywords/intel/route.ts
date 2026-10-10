import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { buildKeywordIntel } from '@/lib/keyword-intel'

// GET: everything the Keyword Research page shows, in one read: the next blog ideas with their keyword sets,
// the keywords we rank for, the ones we should shoot for, every researched phrase with its verdict, ranking
// progress, the sources that are connected, and the budget line. Works before migration 0032 is applied
// (the verdicts are worked out live; only the engine's saved copy needs the migration).
export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    return NextResponse.json(await buildKeywordIntel(getSupabaseAdmin()))
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}
