import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { getAutoblogPostsPerWeek, setAutoblogPostsPerWeek, getAutoblogMaxPerDay, setAutoblogMaxPerDay } from '@/lib/autoblog-cadence'

export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const admin = getSupabaseAdmin()
  return NextResponse.json({ postsPerWeek: await getAutoblogPostsPerWeek(admin), maxPerDay: await getAutoblogMaxPerDay(admin) })
}

// POST { postsPerWeek } and/or { maxPerDay } (1 to 3, default 1). A value outside its range is refused with 400 and nothing is saved.
export async function POST(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const body = await request.json().catch(() => ({}))
  const admin = getSupabaseAdmin()
  const hasWeek = body.postsPerWeek !== undefined
  const hasDay = body.maxPerDay !== undefined
  if (!hasWeek && !hasDay) return NextResponse.json({ error: 'send postsPerWeek or maxPerDay' }, { status: 400 })
  // Validate everything first so a bad second value cannot leave the first one half saved.
  if (hasDay && (typeof body.maxPerDay !== 'number' || !Number.isInteger(body.maxPerDay) || body.maxPerDay < 1 || body.maxPerDay > 3)) {
    return NextResponse.json({ error: 'posts per day must be a whole number from 1 to 3' }, { status: 400 })
  }
  const out: { postsPerWeek?: number; maxPerDay?: number } = {}
  if (hasWeek) {
    const { error } = await setAutoblogPostsPerWeek(admin, Number(body.postsPerWeek))
    if (error) return NextResponse.json({ error }, { status: 400 })
    out.postsPerWeek = Number(body.postsPerWeek)
  }
  if (hasDay) {
    const { error } = await setAutoblogMaxPerDay(admin, body.maxPerDay)
    if (error) return NextResponse.json({ error }, { status: 400 })
    out.maxPerDay = body.maxPerDay
  }
  return NextResponse.json(out)
}
