import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { getAdvisoryMode, setAdvisoryMode } from '@/lib/country-advisory-store'
import { parseAdvisoryMode, type AdvisoryMode } from '@/lib/country-advisory'

export const dynamic = 'force-dynamic'

// GET: the travel advisories switch (off, log or on) and how many country pages exist. POST { mode }: sets it.
// The switch is app_settings.country_advisories_mode. Off is the default and what any unreadable value means.
export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const admin = getSupabaseAdmin()
    const mode = await getAdvisoryMode(admin)
    const total = await admin.from('country_advisories').select('slug', { count: 'exact', head: true })
    const published = await admin.from('country_advisories').select('slug', { count: 'exact', head: true }).eq('status', 'published')
    // A count that cannot be read (for example migration 0062 not applied yet) is null, never a made-up zero.
    return NextResponse.json({ mode, countries: total.error ? null : total.count ?? 0, published: published.error ? null : published.count ?? 0, tablesReady: !total.error })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const body = (await request.json().catch(() => ({}))) as { mode?: unknown }
    const raw = typeof body.mode === 'string' ? body.mode : ''
    // Only the three exact values are accepted; anything else is a 400 (the page never guesses a mode).
    if (raw !== 'off' && raw !== 'log' && raw !== 'on') return NextResponse.json({ error: 'The mode must be off, log or on.' }, { status: 400 })
    const mode: AdvisoryMode = parseAdvisoryMode(raw)
    const { error } = await setAdvisoryMode(getSupabaseAdmin(), mode)
    if (error) return NextResponse.json({ error }, { status: 500 })
    return NextResponse.json({ ok: true, mode })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}
