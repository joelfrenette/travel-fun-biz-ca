import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { setSetting } from '@/lib/app-settings'
import { getAutoblogMode, AUTOBLOG_MODE_KEY } from '@/lib/autoblog-run'

export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  return NextResponse.json({ mode: await getAutoblogMode() })
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const body = await request.json().catch(() => ({}))
  if (!['off', 'draft', 'publish'].includes(body.mode)) {
    return NextResponse.json({ error: 'mode must be off, draft or publish' }, { status: 400 })
  }
  const { error } = await setSetting(getSupabaseAdmin(), AUTOBLOG_MODE_KEY, body.mode)
  if (error) return NextResponse.json({ error }, { status: 500 })
  return NextResponse.json({ mode: body.mode })
}
