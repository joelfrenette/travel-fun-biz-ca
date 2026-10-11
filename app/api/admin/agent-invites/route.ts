import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { SITE_URL } from '@/lib/site'
import { generateToken, expiryFrom, clampDays, clampMaxUses, cleanText, inviteState, countInWindow } from '@/lib/agent-invites'

// Agent links (WP13), admin only. GET lists them with their drafts; POST creates one. The token is the capability, so
// it is returned here (Joel copies the link) and nowhere else.
const MIGRATION_HINT = 'The agent links need migration 0036 (supabase/migrations/0036_agent_invites.sql) to be run first.'

function linkFor(token: string): string {
  return `${SITE_URL}/submit-trip/${token}`
}

export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const admin = getSupabaseAdmin()
  const { data: invites, error } = await admin.from('agent_invites').select('*').order('created_at', { ascending: false }).limit(100)
  if (error) return NextResponse.json({ error: /does not exist|schema cache/i.test(error.message) ? MIGRATION_HINT : error.message }, { status: 500 })
  const { data: subs } = await admin.from('package_submissions').select('id, invite_id, package_id, trip_name, submission_state, created_at, submitted_at').not('invite_id', 'is', null).order('created_at', { ascending: false }).limit(500)
  const now = new Date()
  type Sub = { id: string; invite_id: string; package_id: string | null; trip_name: string | null; submission_state: string; created_at: string; submitted_at: string | null }
  const list = (invites ?? []) as { id: string; token: string; agent_name: string; agent_email: string | null; note: string | null; created_at: string; expires_at: string; revoked_at: string | null; uses: number; max_uses: number }[]
  return NextResponse.json({
    invites: list.map((i) => {
      const mine = ((subs ?? []) as Sub[]).filter((s) => s.invite_id === i.id)
      const state = inviteState(i, now)
      return { ...i, link: linkFor(i.token), active: state.ok, blocked: state.ok ? null : state.reason, draftsToday: countInWindow(mine.map((s) => s.created_at), now), submissions: mine.map((s) => ({ id: s.id, package_id: s.package_id, trip_name: s.trip_name, state: s.submission_state, created_at: s.created_at, submitted_at: s.submitted_at })) }
    }),
  })
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const body = (await request.json().catch(() => null)) as { agent_name?: unknown; agent_email?: unknown; note?: unknown; expires_days?: unknown; max_uses?: unknown } | null
  if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  const agent_name = cleanText(body.agent_name, 80)
  if (agent_name.length < 2) return NextResponse.json({ error: "Please type the agent's name." }, { status: 400 })
  const email = cleanText(body.agent_email, 160)
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return NextResponse.json({ error: 'That email address does not look right.' }, { status: 400 })
  const row = {
    token: generateToken(),
    agent_name,
    agent_email: email || null,
    note: cleanText(body.note, 300) || null,
    expires_at: expiryFrom(new Date(), clampDays(body.expires_days)).toISOString(),
    max_uses: clampMaxUses(body.max_uses),
  }
  const { data, error } = await getSupabaseAdmin().from('agent_invites').insert(row).select('*').single()
  if (error || !data) return NextResponse.json({ error: /does not exist|schema cache/i.test(error?.message ?? '') ? MIGRATION_HINT : (error?.message ?? 'Could not create the link') }, { status: 500 })
  return NextResponse.json({ invite: { ...data, link: linkFor(row.token) } })
}
