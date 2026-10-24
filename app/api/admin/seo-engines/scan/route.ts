import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { readCompetitorList, readCompetitorState, pickDueCompetitor, runCompetitorScan, validateCompetitorUrl } from '@/lib/competitor-scan'
import { loadSeoPages } from '@/lib/seo-pages'

export const dynamic = 'force-dynamic'
// One competitor is up to 40 pages at one page per second, so it is scanned on its own request.
export const maxDuration = 60

// "Scan competitors now": scans ONE competitor from the owner's list (the one named in {url}, else the one that is due, else the first).
// The page asks again for the next one, so five competitors take five short requests. Admin-triggered only.
export async function POST(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const body = await request.json().catch(() => ({}))
    const admin = getSupabaseAdmin()
    const list = await readCompetitorList(admin)
    if (list.length === 0) return NextResponse.json({ error: 'Add a competitor first.' }, { status: 400 })
    let origin: string | null = null
    if (typeof body.url === 'string' && body.url.trim()) {
      const c = validateCompetitorUrl(body.url)
      origin = c.ok ? list.find((o) => o === c.origin) ?? null : null
      if (!origin) return NextResponse.json({ error: 'That competitor is not in your list.' }, { status: 404 })
    } else {
      origin = pickDueCompetitor(list, await readCompetitorState(admin)) ?? list[0]
    }
    const pages = await loadSeoPages(admin)
    if (!pages) return NextResponse.json({ error: 'Could not read our own pages to compare against.' }, { status: 500 })
    const r = await runCompetitorScan(admin, origin, pages, { deadlineMs: Date.now() + 52_000 })
    return NextResponse.json({ ok: !!r.result, note: r.note, origin })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}
