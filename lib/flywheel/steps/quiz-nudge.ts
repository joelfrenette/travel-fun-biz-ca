import type { SupabaseClient } from '@supabase/supabase-js'
import { getSettingStrict, setSetting } from '@/lib/app-settings'
import { isTestPerson } from '@/lib/test-data'
import { isPastTrip } from '@/lib/past-trip'
import { isLeadAckOn, sendLeadAck, type LeadAckInput } from '@/lib/lead-ack'
import { itineraryPath, itinerarySecret, signItineraryToken } from '@/lib/itinerary-magnet'
import { nudgeEligible, nudgeKey, nudgeRecorded, NUDGE_AFTER_DAYS, NUDGE_UNTIL_DAYS, quizLeadSlug, type NudgeLead, type TripQuizMode } from '@/lib/trip-quiz'
import { logDecision } from '@/lib/flywheel/ctx'
import type { FlywheelContext, FlywheelResult, FlywheelStep } from '@/lib/flywheel/types'

// The ONE day 3 nudge for a trip quiz lead (policy quiz_nudge). See lib/trip-quiz.ts for the rules and lib/lead-ack-copy.ts for the words.
//
// A lead gets it only when ALL of these hold: the trip quiz switch is on, the instant lead reply switch is on, the lead came from the
// quiz and ticked the consent box, nobody has contacted them (first_contact_at is empty), the lead is not booked or lost, it is not a
// test lead, and it is 3 to 8 days old. The email goes through sendLeadAck, so its own guards apply on top: switch, daily limit, once
// per address per day, sender settings, test rows never.
//
// Idempotent: a record (quiz_nudge:<lead id>) is written BEFORE the send, so a retry, a double pass or a crash can never send twice. The
// record is released only when sendLeadAck proves nothing was sent for a reason that can pass (daily limit, once-a-day rule, sender not set up).
// Never assigns, never edits the lead, never sends anything but this one email. Nothing runs in a dry run (the runner enforces it too).

const POLICY = 'quiz_nudge' as const
/** At most this many nudges go in one pass; the policy cap (a few a day) limits the day. */
const MAX_PER_PASS = 5
const READ_LIMIT = 40

export interface QuizNudgeDeps {
  getMode: (admin: SupabaseClient) => Promise<TripQuizMode>
  ackOn: (admin: SupabaseClient) => Promise<boolean>
  candidates: (admin: SupabaseClient, now: Date) => Promise<NudgeLead[]>
  readRecord: (admin: SupabaseClient, key: string) => Promise<{ value: string | null; error?: string }>
  writeRecord: (admin: SupabaseClient, key: string, value: string) => Promise<{ error?: string }>
  /** True while the trip can still be planned (published and not already run). */
  tripOpen: (slug: string) => Promise<boolean>
  send: (input: LeadAckInput) => Promise<string>
  secret: () => string
  origin: () => Promise<string>
}

async function listCandidates(admin: SupabaseClient, now: Date): Promise<NudgeLead[]> {
  const { data, error } = await admin
    .from('leads')
    .select('id, name, email, message, status, first_contact_at, is_test, created_at')
    .like('message', '%[Trip quiz]%')
    .eq('is_test', false)
    .is('first_contact_at', null)
    .lt('created_at', new Date(now.getTime() - NUDGE_AFTER_DAYS * 86_400_000).toISOString())
    .gt('created_at', new Date(now.getTime() - NUDGE_UNTIL_DAYS * 86_400_000).toISOString())
    .order('created_at', { ascending: true })
    .limit(READ_LIMIT)
  if (error) throw new Error(`could not read the quiz leads (${error.message})`)
  return (Array.isArray(data) ? data : []) as NudgeLead[]
}

const defaultDeps: QuizNudgeDeps = {
  getMode: async (admin) => (await (await import('@/lib/trip-quiz-store')).getTripQuizMode(admin)),
  ackOn: (admin) => isLeadAckOn(admin).catch(() => false),
  candidates: listCandidates,
  readRecord: (admin, key) => getSettingStrict(admin, key),
  writeRecord: (admin, key, value) => setSetting(admin, key, value),
  tripOpen: async (slug) => {
    const { getPublishedPackageBySlug } = await import('@/lib/packages')
    const p = await getPublishedPackageBySlug(slug)
    return !!p && !isPastTrip(p)
  },
  send: (input) => sendLeadAck(input),
  secret: itinerarySecret,
  origin: async () => (await import('@/lib/site')).SITE_URL,
}

/** "Trip: <name> (/packages/<slug>)" is how the lead's message names its trip. */
function tripNameOf(message: string | null | undefined): string {
  const m = /Trip: (.+?) \(\/packages\//.exec(message ?? '')
  return m ? m[1] : 'a trip'
}

export async function runQuizNudge(ctx: FlywheelContext, deps: QuizNudgeDeps = defaultDeps): Promise<FlywheelResult> {
  if (ctx.dryRun) return { ran: false, reason: 'dry run' }
  if ((await deps.getMode(ctx.admin).catch(() => 'off' as const)) !== 'on') return { ran: false, reason: 'the trip quiz is off' }
  if (!(await deps.ackOn(ctx.admin))) return { ran: false, reason: 'the instant lead reply is off, so no nudge is sent' }
  const secret = deps.secret()
  if (!secret) return { ran: false, reason: 'no signing secret is set, so a nudge link cannot be made' }
  if (ctx.room <= 0) return { ran: false, reason: 'the daily limit is used up' }

  const leads = (await deps.candidates(ctx.admin, ctx.now)).filter((l) => nudgeEligible(l, ctx.now))
  if (!leads.length) return { ran: false, reason: 'no quiz lead is due for a nudge' }
  const origin = await deps.origin()
  const limit = Math.min(ctx.room, MAX_PER_PASS)

  let sent = 0
  let held = 0
  let errors = 0
  for (const lead of leads) {
    if (sent >= limit) break
    if (ctx.remainingMs() < 10_000) break
    try {
      const key = nudgeKey(lead.id)
      const existing = await deps.readRecord(ctx.admin, key)
      if (existing.error) continue // cannot prove it was not sent, so do not send
      if (nudgeRecorded(existing.value)) continue
      const slug = quizLeadSlug(lead.message) as string
      if (!(await deps.tripOpen(slug))) continue
      // Claim first: from here on this lead can never be nudged twice.
      const claim = await deps.writeRecord(ctx.admin, key, JSON.stringify({ at: ctx.now.toISOString(), result: 'claimed' }))
      if (claim.error) continue
      const url = `${origin}${itineraryPath(signItineraryToken(lead.id, slug, secret, ctx.now))}`
      const result = await deps.send({ email: lead.email as string, name: lead.name, isTest: isTestPerson({ email: lead.email, name: lead.name }), nudge: { url, tripName: tripNameOf(lead.message) } })
      const passes = result === 'cap' || result === 'rate-limited' || result === 'not-configured' || result === 'off'
      await deps.writeRecord(ctx.admin, key, JSON.stringify({ at: ctx.now.toISOString(), result: passes ? 'released' : result }))
      if (result === 'sent') {
        sent++
        await logDecision(ctx.admin, POLICY, lead.id, 'Sent the day 3 follow-up to a trip quiz lead', 'They asked for an itinerary through the quiz, ticked the consent box and nobody has contacted them yet. It is the only follow-up they get.', null, ctx.now).catch(() => undefined)
      } else if (passes) {
        held++
      }
    } catch {
      errors++ // one lead failing must never stop the next
    }
  }

  if (sent === 0 && errors === 0) return { ran: false, reason: held ? 'the email guards held the nudge back for now (daily limit, once a day per address, or sender not set up)' : 'no nudge was sent' }
  return { ran: true, acted: sent, note: `quiz nudge: ${sent} sent${held ? `, ${held} held back by the email guards` : ''}${errors ? `, ${errors} skipped after an error` : ''}` }
}

export const quizNudgeStep: FlywheelStep = {
  id: 'quiz_nudge',
  policy: 'quiz_nudge',
  label: 'Trip quiz day 3 follow-up email',
  order: 125,
  floorMs: 15_000,
  maxMs: 60_000,
  run: (ctx) => runQuizNudge(ctx),
}
