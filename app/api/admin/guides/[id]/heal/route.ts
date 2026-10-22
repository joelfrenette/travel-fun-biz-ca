import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { isAutomationPaused } from '@/lib/automation-kill-switch'
import { editsLoggable } from '@/lib/content-edits'
import { healGuideRow } from '@/lib/heal-drafts'
import { pingIndexNow } from '@/lib/indexnow'

// One heal pass can make several AI calls (suggest, check, judge), so allow the same time as the other heal route.
export const maxDuration = 300

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// POST /api/admin/guides/<id>/heal   "Heal now" for ONE guide, only when an admin clicks it.
// This is the production heal path (healGuideRow), with the once-a-day claim lifted and nothing else: the daily AI-call budget, the
// round limit, the logged-before-applied edits (so Undo works) and the guessed-name rule (such a page is never published) all still apply.
export async function POST(request: Request, { params }: { params: { id: string } }) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!UUID.test(params.id)) return NextResponse.json({ error: 'Not a guide id.' }, { status: 400 })
  try {
    const admin = getSupabaseAdmin()
    if (await isAutomationPaused(admin)) return NextResponse.json({ error: 'Automation is paused (kill switch), so nothing was changed.' }, { status: 409 })
    if (!(await editsLoggable(admin))) return NextResponse.json({ error: 'Edits are logged so you can undo them, and the log is not set up yet (migration 0033). Nothing was changed.' }, { status: 409 })
    const { data, error } = await admin.from('guides').select('*').eq('id', params.id).maybeSingle()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    const result = await healGuideRow(admin, data as Record<string, unknown>, { skipClaim: true, deadlineMs: Date.now() + 270_000 })
    if (result.action === 'published' && !result.ladder.includes('safe-page')) await pingIndexNow([result.path, '/sitemap.xml']).catch(() => undefined)
    if (result.action === 'failed') return NextResponse.json({ error: result.note || 'The heal failed.', result }, { status: 502 })
    return NextResponse.json({ ok: true, note: result.note || `Heal finished: ${result.action}`, result })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Server error' }, { status: 500 })
  }
}
