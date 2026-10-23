import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import type { LeadRow } from '@/lib/leads'
import { isMissingTouchColumn } from '@/lib/lead-touch'

export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const admin = getSupabaseAdmin()
    const base = 'id, name, email, phone, package, forwarded_to_ghl, ghl_error, is_test, created_at, page_path, utm_content'
    const read = (cols: string) => admin.from('leads').select(cols).order('created_at', { ascending: false }).limit(100)
    let { data, error } = await read(`${base}, utm_source, utm_medium, utm_campaign, utm_term, referrer, landing_path`)
    // Migration 0051 not applied yet: show the list without the source columns rather than failing.
    if (error && isMissingTouchColumn(error)) ({ data, error } = await read(`${base}, utm_source, utm_medium, utm_campaign`))
    if (error) throw new Error(error.message)
    return NextResponse.json({ leads: (data ?? []) as unknown as LeadRow[] })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}
