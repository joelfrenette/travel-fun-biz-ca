import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { listPageCopyAdmin, listPageCopyCandidates, pageTypeOfPath } from '@/lib/page-copy'
import { getPageCopyCaps, setPageCopyCaps, readCopyCapUsage, writePageCopy, pickNextPageCopy, getPageCopyPublishMode, setPageCopyPublishMode } from '@/lib/page-copy-run'
import { readCopyFailures } from '@/lib/page-copy-failures'

// Writing page copy is one AI call (about a minute at the outside).
export const maxDuration = 300

// GET: every written page (any status), the pages still missing copy, the caps and how much of them is used.
export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const admin = getSupabaseAdmin()
    const [rows, candidates, caps, usage, failures, publishMode] = await Promise.all([
      listPageCopyAdmin(admin),
      listPageCopyCandidates(admin),
      getPageCopyCaps(admin),
      readCopyCapUsage(admin),
      readCopyFailures(admin),
      getPageCopyPublishMode(admin),
    ])
    const counts = {
      published: rows.filter((r) => r.status === 'published').length,
      draft: rows.filter((r) => r.status === 'draft').length,
      missing: candidates.filter((c) => !c.hasRow).length,
      total: candidates.length,
    }
    const missing = candidates.filter((c) => !c.hasRow)
    const next = (await pickNextPageCopy(admin, candidates)).cand
    return NextResponse.json({ rows, missing, next, caps, usage, counts, failures, publishMode })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}

// POST { action: 'write-next' }                 write the next page in the rotation now (not capped)
// POST { action: 'write', path }                write one page now (the button; ignores the daily and weekly
//                                               caps, still takes the run lock, the attempt limit and the breaker;
//                                               publishes only when the quality gate is clean)
// POST { action: 'caps', perDay, perWeek }      change the pipeline caps
export async function POST(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const body = await request.json().catch(() => ({}))
    const admin = getSupabaseAdmin()

    if (body.action === 'caps') {
      const { error } = await setPageCopyCaps(admin, Number(body.perDay), Number(body.perWeek))
      if (error) return NextResponse.json({ error }, { status: 400 })
      return NextResponse.json({ ok: true })
    }

    if (body.action === 'write-next') {
      const { cand, error } = await pickNextPageCopy(admin, await listPageCopyCandidates(admin))
      if (error) return NextResponse.json({ error }, { status: 503 })
      if (!cand) return NextResponse.json({ error: 'No pages left: everything has copy, or was skipped after repeated failures.' }, { status: 409 })
      const result = await writePageCopy(admin, cand, { source: 'admin' })
      if (!result.ok) return NextResponse.json({ error: result.note }, { status: result.failed ? 502 : 409 })
      return NextResponse.json({ note: result.note, published: result.published, blockers: result.blockers ?? [] })
    }

    if (body.action === 'write') {
      const path = typeof body.path === 'string' ? body.path.trim() : ''
      if (!pageTypeOfPath(path)) return NextResponse.json({ error: 'Pick a compare or best-time page.' }, { status: 400 })
      // Only a page that exists today (a destination with a published package) can get copy: never invent one.
      const cand = (await listPageCopyCandidates(admin)).find((c) => c.path === path)
      if (!cand) return NextResponse.json({ error: 'That page does not exist right now (it needs a published trip).' }, { status: 404 })
      const result = await writePageCopy(admin, cand, { source: 'admin' })
      if (!result.ok) return NextResponse.json({ error: result.note }, { status: result.failed ? 502 : 409 })
      return NextResponse.json({ note: result.note, published: result.published, blockers: result.blockers ?? [] })
    }

    return NextResponse.json({ error: 'Nothing to do. Pass {action: "write"}, {action: "write-next"} or {action: "caps"}.' }, { status: 400 })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}

// PATCH { publishMode: 'draft' | 'publish' }  the one-click switch on the Autopilot page-copy card. Anything else is refused.
export async function PATCH(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const body = await request.json().catch(() => ({}))
    const { error } = await setPageCopyPublishMode(getSupabaseAdmin(), String(body.publishMode ?? ''))
    if (error) return NextResponse.json({ error }, { status: 400 })
    return NextResponse.json({ ok: true, publishMode: body.publishMode })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}
