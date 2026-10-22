import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { isLeadAckOn, setLeadAckOn } from '@/lib/lead-ack'

export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const configured = !!process.env.RESEND_API_KEY?.trim() && !!process.env.LEAD_ACK_FROM_EMAIL?.trim()
  return NextResponse.json({ on: await isLeadAckOn(getSupabaseAdmin()), configured })
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const body = await request.json().catch(() => ({}))
  const on = body.on === true
  const { error } = await setLeadAckOn(getSupabaseAdmin(), on)
  if (error) return NextResponse.json({ error }, { status: 500 })
  return NextResponse.json({ on })
}
