import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { newsCard } from '@/lib/news-card'
import { setNewsMode, setNewsPerDay } from '@/lib/news-settings'

// The Travel news section of the Content Autopilot page.
// GET                           the switches, how each source is doing and the last 10 news items
// POST { mode }                 off | draft | publish
// POST { per_day }              0 to 6 news briefs a day (2 is the default)
export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    return NextResponse.json(await newsCard(getSupabaseAdmin()))
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const body = (await request.json().catch(() => ({}))) as { mode?: unknown; per_day?: unknown }
    const admin = getSupabaseAdmin()
    if (body.mode !== undefined) {
      if (body.mode !== 'off' && body.mode !== 'draft' && body.mode !== 'publish') return NextResponse.json({ error: 'mode must be off, draft or publish' }, { status: 400 })
      const { error } = await setNewsMode(admin, body.mode)
      if (error) return NextResponse.json({ error }, { status: 500 })
    }
    if (body.per_day !== undefined) {
      const { error } = await setNewsPerDay(admin, Number(body.per_day))
      if (error) return NextResponse.json({ error }, { status: 400 })
    }
    return NextResponse.json(await newsCard(admin))
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}
