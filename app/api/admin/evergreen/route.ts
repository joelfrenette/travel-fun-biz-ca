import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { previewNextPick, readEvergreenCard } from '@/lib/evergreen-reshare-run'
import { setEvergreenEnabled, EVERGREEN_COOLDOWN_DAYS, EVERGREEN_MIN_AGE_DAYS } from '@/lib/evergreen-reshare'

export const dynamic = 'force-dynamic'

// The Evergreen re-share card on the Content Autopilot page.
// GET                        the switch (default OFF), the last re-shares and when the pass last looked
// POST { action: 'switch', on }  turns the daily re-share on or off. Off means nothing is picked or enrolled; a re-share already waiting is closed unsent.
// POST { action: 'preview' }     READ ONLY: what would be picked next and why. Writes nothing and sends nothing, with the switch on or off.
export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const card = await readEvergreenCard(getSupabaseAdmin())
    return NextResponse.json({ ...card, rules: { minAgeDays: EVERGREEN_MIN_AGE_DAYS, cooldownDays: EVERGREEN_COOLDOWN_DAYS } })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const body = (await request.json().catch(() => ({}))) as { action?: unknown; on?: unknown }
    const admin = getSupabaseAdmin()
    if (body.action === 'switch') {
      if (typeof body.on !== 'boolean') return NextResponse.json({ error: 'on (true or false) is required' }, { status: 400 })
      const { error } = await setEvergreenEnabled(admin, body.on)
      if (error) return NextResponse.json({ error }, { status: 500 })
      return NextResponse.json({ ok: true, on: body.on })
    }
    if (body.action === 'preview') return NextResponse.json({ preview: await previewNextPick(admin) })
    return NextResponse.json({ error: 'Nothing to do - pass {action: "switch", on} or {action: "preview"}.' }, { status: 400 })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}
