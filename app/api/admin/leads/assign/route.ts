import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { assignLead, listPickerAgents } from '@/lib/lead-desk-store'
import { orderAgents } from '@/lib/lead-desk'

export const dynamic = 'force-dynamic'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// GET  ?leadId=<uuid>   the agents the office can pick from for this lead: draft, ready and published agents, with the ones whose
//                       specialties match the trip first and tagged "suggested". NOTHING is chosen. Never carries an agent's private email or phone.
// POST {leadId, agentId, assignedBy, reassign?}   the office's choice: saves it on the lead, tags and notes the GoHighLevel contact,
//                       emails the chosen agent at their private roster address, and writes a line to the Today log.

export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const leadId = new URL(request.url).searchParams.get('leadId') ?? ''
    if (!UUID.test(leadId)) return NextResponse.json({ error: 'leadId must be a lead id.' }, { status: 400 })
    const admin = getSupabaseAdmin()
    const { data, error } = await admin.from('leads').select('package, page_path, message').eq('id', leadId).maybeSingle()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    if (!data) return NextResponse.json({ error: 'That lead is gone.' }, { status: 404 })
    const row = data as { package: string | null; page_path: string | null; message: string | null }
    const agents = orderAgents(await listPickerAgents(admin), { package: row.package, pagePath: row.page_path, message: row.message })
    return NextResponse.json({ agents })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const body = (await request.json().catch(() => null)) as { leadId?: unknown; agentId?: unknown; assignedBy?: unknown; reassign?: unknown } | null
    if (!body || typeof body.leadId !== 'string' || !UUID.test(body.leadId) || typeof body.agentId !== 'string' || !UUID.test(body.agentId)) {
      return NextResponse.json({ error: 'Pick a lead and an agent.' }, { status: 400 })
    }
    const result = await assignLead(getSupabaseAdmin(), {
      leadId: body.leadId,
      agentId: body.agentId,
      assignedBy: typeof body.assignedBy === 'string' ? body.assignedBy : '',
      reassign: body.reassign === true,
    })
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
    return NextResponse.json({ ok: true, message: result.message, warnings: result.warnings })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}
