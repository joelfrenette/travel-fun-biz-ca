import { NextResponse } from 'next/server'
import { isHoneypotFilled } from '@/lib/abuse-guard'
import { allowSubmit, recapGate } from '@/lib/recap-gate'
import { addSubmission, notifyRecapSubmission } from '@/lib/recap-store'
import { getPackageById } from '@/lib/packages'
import { happenedLabel } from '@/lib/past-trip'
import { displayName, QUESTIONS, validateAnswers, validateQuote } from '@/lib/recap-studio'

export const dynamic = 'force-dynamic'

// PUBLIC route behind a recap link (Recap Studio). No login: the token IS the key, it opens ONE trip, and everything sent through
// it lands as PENDING (nothing is shown on the site until the admin approves it). The token is validated first (lib/recap-gate.ts).
//   GET                         the trip's name and dates, the questions, and how many photos this link has sent
//   POST {action:'answers'}     {answers, yourName}
//   POST {action:'quote'}       {text, firstName, lastName?, consent:true}  (a testimonial link takes only this)
export async function GET(request: Request, { params }: { params: { token: string } }) {
  const g = await recapGate(request, params.token)
  if (!g.ok) return NextResponse.json({ error: g.error }, { status: g.status })
  const pkg = await getPackageById(g.share.package_id)
  if (!pkg) return NextResponse.json({ error: 'This trip could not be found.' }, { status: 404 })
  const { count } = await g.admin.from('recap_submissions').select('id', { count: 'exact', head: true }).eq('share_id', g.share.id).eq('kind', 'photo')
  return NextResponse.json({
    kind: g.share.kind,
    tripName: pkg.name,
    when: happenedLabel(pkg.available_from, pkg.available_to),
    destination: pkg.destination,
    agentName: g.share.agent_name,
    expiresAt: g.share.expires_at,
    questions: QUESTIONS,
    photosSent: count ?? 0,
  })
}

export async function POST(request: Request, { params }: { params: { token: string } }) {
  const g = await recapGate(request, params.token)
  if (!g.ok) return NextResponse.json({ error: g.error }, { status: g.status })
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  if (!body) return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  // A bot that fills the hidden field gets a quiet "ok" and nothing is stored.
  if (isHoneypotFilled(body)) return NextResponse.json({ ok: true })
  if (!(await allowSubmit(params.token))) return NextResponse.json({ error: 'That is a lot of messages in a short time. Please wait a little and try again.' }, { status: 429 })
  const pkg = await getPackageById(g.share.package_id)
  if (!pkg) return NextResponse.json({ error: 'This trip could not be found.' }, { status: 404 })

  let kind: 'answers' | 'quote'
  let payload: Record<string, unknown>
  if (body.action === 'answers' && g.share.kind === 'agent') {
    const v = validateAnswers(body.answers)
    if (!v.ok) return NextResponse.json({ error: v.errors[0], errors: v.errors }, { status: 400 })
    kind = 'answers'
    payload = { answers: v.value, submitterName: displayName(body.yourName, '') }
  } else if (body.action === 'quote') {
    const v = validateQuote({ text: body.text, firstName: body.firstName, lastName: body.lastName, consent: body.consent })
    if (!v.ok) return NextResponse.json({ error: v.errors[0], errors: v.errors }, { status: 400 })
    kind = 'quote'
    payload = { text: v.value.text, name: v.value.name, consent: true, submitterName: g.share.kind === 'agent' ? displayName(body.yourName, '') : null, source: g.share.kind === 'testimonial' ? 'traveller' : 'agent' }
  } else {
    return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
  }
  const r = await addSubmission(g.admin, g.share, kind, payload)
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status })
  // The email carries no names and none of the words. Never blocks the answer.
  await notifyRecapSubmission(g.admin, g.share.id, pkg.id, pkg.name, { answers: kind === 'answers' ? 1 : 0, quotes: kind === 'quote' ? 1 : 0, photos: 0 }).catch(() => null)
  return NextResponse.json({ ok: true })
}
