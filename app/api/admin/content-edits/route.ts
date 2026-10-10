import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { listEdits } from '@/lib/content-edits'
import { healCard, runHealContentIfDue } from '@/lib/content-heal-run'
import type { ContentType } from '@/lib/content-repair'

// The heal step makes at most a handful of model calls (one per page, a few pages), plus the scoring pass.
export const maxDuration = 300

const TYPES: ContentType[] = ['post', 'guide', 'page_copy']

// GET                      the automatic edits, newest first (?type=post|guide|page_copy, ?limit, ?offset)
// GET ?card=1              the numbers for the Self-healing card on the Autopilot page
export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const admin = getSupabaseAdmin()
    const url = new URL(request.url)
    if (url.searchParams.get('card') === '1') return NextResponse.json(await healCard(admin))
    const type = url.searchParams.get('type')
    if (type && !TYPES.includes(type as ContentType)) return NextResponse.json({ error: 'type must be post, guide or page_copy' }, { status: 400 })
    const { edits, error } = await listEdits(admin, {
      type: (type as ContentType | null) || null,
      limit: Number(url.searchParams.get('limit')) || 100,
      offset: Number(url.searchParams.get('offset')) || 0,
    })
    if (error) return NextResponse.json({ error, edits: [] }, { status: /relation|does not exist|schema cache/i.test(error) ? 503 : 500 })
    return NextResponse.json({ edits })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}

// POST { action: 'heal-now' }   run the heal step now. It skips the once-a-day claim and nothing else: the
//                               6-pages-a-day repair cap, the per-page call limit and the audit log all still apply.
export async function POST(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const body = await request.json().catch(() => ({}))
    if (body.action !== 'heal-now') return NextResponse.json({ error: 'Nothing to do. Pass {action: "heal-now"}.' }, { status: 400 })
    const result = await runHealContentIfDue(getSupabaseAdmin(), { force: true })
    if (!result) return NextResponse.json({ error: 'Nothing was due.' }, { status: 409 })
    if (!result.ok) return NextResponse.json({ error: result.note }, { status: 502 })
    return NextResponse.json({ note: result.note })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}
