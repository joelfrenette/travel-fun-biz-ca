import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { isAutomationPaused, setAutomationPaused } from '@/lib/automation-kill-switch'

export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  return NextResponse.json({ paused: await isAutomationPaused(getSupabaseAdmin()) })
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const body = await request.json().catch(() => ({}))
  const { error } = await setAutomationPaused(getSupabaseAdmin(), body.paused === true)
  if (error) return NextResponse.json({ error }, { status: 500 })
  return NextResponse.json({ paused: body.paused === true })
}
