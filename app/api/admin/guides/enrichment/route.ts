import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { ENRICH_MAX_ATTEMPTS, ENRICH_MIN_GAP_DAYS, listSafePages } from '@/lib/safe-enrich'

export const maxDuration = 30

// GET: the live "safe pages" (short pages the heal built only from stored facts, kept out of search) and how many upgrade tries each has had.
// Read only: the upgrade itself runs inside the daily heal step, or by hand with scripts/heal-guides-now.ts --enrich --yes.
export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const { pages, error } = await listSafePages(getSupabaseAdmin())
    return NextResponse.json({ pages, maxAttempts: ENRICH_MAX_ATTEMPTS, gapDays: ENRICH_MIN_GAP_DAYS, ...(error ? { warning: error } : {}) })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}
