import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { getSetting, setSetting } from '@/lib/app-settings'
import { DESK_EMAILS_KEY } from '@/lib/lead-desk'
import { DESK_NAMES_KEY, buildRecipientRows, serializeRecipients, validateRecipients } from '@/lib/lead-alert-recipients'

export const dynamic = 'force-dynamic'

// GET: who gets the hot lead alert email. POST { recipients: [{ name, email }] }: saves the list.
// The addresses are app_settings.lead_desk_alert_emails (a JSON list, as the lead desk already reads it).
// The names are app_settings.lead_desk_alert_names and are labels for this screen only.
export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const admin = getSupabaseAdmin()
    const [emails, names] = await Promise.all([getSetting(admin, DESK_EMAILS_KEY), getSetting(admin, DESK_NAMES_KEY)])
    return NextResponse.json({ recipients: buildRecipientRows(emails, names) })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const body = (await request.json().catch(() => ({}))) as { recipients?: unknown }
    const checked = validateRecipients(body.recipients)
    if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 400 })
    const { emails, names } = serializeRecipients(checked.rows)
    const admin = getSupabaseAdmin()
    // Names first: if the addresses then fail, the live alert list is untouched.
    const n = await setSetting(admin, DESK_NAMES_KEY, names)
    if (n.error) return NextResponse.json({ error: n.error }, { status: 500 })
    const e = await setSetting(admin, DESK_EMAILS_KEY, emails)
    if (e.error) return NextResponse.json({ error: e.error }, { status: 500 })
    return NextResponse.json({ ok: true, recipients: checked.rows })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}
