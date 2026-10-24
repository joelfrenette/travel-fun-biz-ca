import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import type { LeadRow } from '@/lib/leads'
import { isMissingTouchColumn } from '@/lib/lead-touch'
import { setLeadStatus } from '@/lib/lead-desk-store'

export const dynamic = 'force-dynamic'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DESK_COLUMNS = 'hot, intent, status, assigned_agent_id, assigned_at, assigned_by, first_contact_at, desk_note'

export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const admin = getSupabaseAdmin()
    const base = 'id, name, email, phone, package, forwarded_to_ghl, ghl_error, is_test, created_at, page_path, utm_content'
    const read = (cols: string) => admin.from('leads').select(cols).order('created_at', { ascending: false }).limit(100)
    const touch = `${base}, utm_source, utm_medium, utm_campaign, utm_term, referrer, landing_path`
    let deskReady = true
    // Newest first. Migration 0055 adds the lead desk columns and 0051 the source columns; each missing set is dropped, never fatal.
    let { data, error } = await read(`${touch}, ${DESK_COLUMNS}`)
    if (error) {
      deskReady = false
      ;({ data, error } = await read(touch))
    }
    if (error && isMissingTouchColumn(error)) ({ data, error } = await read(`${base}, utm_source, utm_medium, utm_campaign`))
    if (error) throw new Error(error.message)
    const leads = (data ?? []) as unknown as (LeadRow & { assigned_agent_id?: string | null })[]

    // The assigned agents' names (display name only, never their private email or phone).
    const ids = [...new Set(leads.map((l) => l.assigned_agent_id).filter((x): x is string => !!x))]
    const names = new Map<string, string>()
    if (ids.length > 0) {
      const { data: agents } = await admin.from('agents').select('id, display_name').in('id', ids)
      for (const a of (agents ?? []) as { id: string; display_name: string }[]) names.set(a.id, a.display_name)
    }
    return NextResponse.json({
      deskReady,
      leads: leads.map((l) => ({ ...l, assigned_agent_name: l.assigned_agent_id ? names.get(l.assigned_agent_id) ?? 'an agent who is no longer on the roster' : null })),
    })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}

// PATCH {id, status: contacted | booked | lost, note?}  the lead desk buttons on the Leads page.
export async function PATCH(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const body = (await request.json().catch(() => null)) as { id?: unknown; status?: unknown; note?: unknown } | null
    if (!body || typeof body.id !== 'string' || !UUID.test(body.id)) return NextResponse.json({ error: 'Pick a lead.' }, { status: 400 })
    const r = await setLeadStatus(getSupabaseAdmin(), body.id, body.status, body.note)
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status })
    return NextResponse.json({ ok: true, message: r.message })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}
