import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { AUDIT_BUDGET_MS, runSeoPlaybookAudit } from '@/lib/seo-playbook-audit'
import { loadView } from '@/lib/seo-playbook-view'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

// Run the SEO playbook audit now (the same one the daily job runs). Read-only against the live site and Search Console:
// it fetches public pages and stores a short result. No AI call, no credits.
export async function POST(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const admin = getSupabaseAdmin()
    const run = await runSeoPlaybookAudit(admin, { deadlineMs: Date.now() + AUDIT_BUDGET_MS })
    return NextResponse.json({ ok: run.ok, note: run.note, view: await loadView(admin) })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}
