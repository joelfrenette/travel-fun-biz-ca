import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { readCrawlState } from '@/lib/site-crawl-run'
import { pathOf, summarize } from '@/lib/site-crawl'

// Read only: the stored result of the daily site health crawl, for the System Health card. Nothing here starts a crawl or changes a page.
export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const state = await readCrawlState(getSupabaseAdmin())
  if (!state) return NextResponse.json({ error: 'The site crawl result could not be read.' }, { status: 500 })
  const s = summarize(state)
  return NextResponse.json({
    lastRun: s.lastRun,
    total: s.total,
    checked7d: s.checked7d,
    errors: s.errors,
    warnings: s.warnings,
    infos: s.infos,
    fixed: s.fixed,
    budgetUsed: s.budgetUsed,
    note: state.note,
    top: s.top.map((f) => ({ path: pathOf(f.url), kind: f.kind, severity: f.severity, message: f.message, hint: f.hint, firstSeen: f.firstSeen })),
  })
}
