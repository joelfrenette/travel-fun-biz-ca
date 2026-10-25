import type { SupabaseClient } from '@supabase/supabase-js'
import { isAutomationPaused } from '@/lib/automation-kill-switch'
import { explainTier, loadConversionSignal, packageTier, type ConversionSignal } from '@/lib/conversion-rank'
import { getDistributionMode } from '@/lib/distribution'
import { logDecision, isVetoed } from '@/lib/flywheel/ctx'
import { packageDistributionSlug } from '@/lib/guide-post-source'
import { enrolPackagePost, orderTripsByConversion, PROMOTION_GAP_DAYS, type PromotionPackage } from '@/lib/promotion'
import { getTripSocialEnabled, TRIP_ENROLMENTS_PER_WEEK, TRIP_HOLD_NOTE, tripBlockers, type TripLedgerRow, type TripSocialPackage } from '@/lib/trip-social'
import type { FlywheelContext, FlywheelResult, FlywheelStep } from '@/lib/flywheel/types'

// WP8: Conversion-weighted promote pick (policy promote_pick, docs/factory/AUTOPILOT-AUDIT.md section 5).
//
// Once a pass, when trip social posts are ALREADY switched on (app_settings.trip_social_posts exactly 'true', never turned on here) and
// the distribution mode is prepare or auto, this picks the next published trip to post with a small lead/order tie-break
// (lib/conversion-rank.ts) and enrols its ONE social post through the same enrolPackagePost the normal rotation and the "Promote this
// package" button use. That function keeps the 30-day rule per trip and the one-enrolment-per-day limit; the row waits the usual
// 24-hour hold in auto mode (or stays held in prepare mode), and the usual captions, checks and send code do the rest.
//
// It only acts when the pick really has conversion evidence (a tier of 1 or more); with no data the normal rotation in
// lib/trip-social.ts keeps choosing, exactly as before. It never turns the setting on, never publishes a trip, never writes a price,
// never messages a person. Each pick is one line in "Autopilot decisions" with an Undo that takes the queued post back out (while it
// has not reached a network), and the Undo adds the trip to the veto list.

export const PROMOTE_PICK_ID = 'promote_pick'

export interface PromotePickDeps {
  loadTrips: (admin: SupabaseClient) => Promise<TripSocialPackage[] | null>
  loadLedger: (admin: SupabaseClient) => Promise<TripLedgerRow[] | null>
  /** Trip posts put into the list in the last 7 days, or null when it could not be counted. */
  countWeek: (admin: SupabaseClient, now: Date) => Promise<number | null>
  loadSignal: (admin: SupabaseClient, now: Date) => Promise<ConversionSignal>
  enrol: typeof enrolPackagePost
}

export const defaultPromotePickDeps: PromotePickDeps = {
  loadTrips: async (admin) => {
    const { data, error } = await admin.from('travel_packages').select('*').eq('status', 'published')
    return error ? null : ((data ?? []) as TripSocialPackage[])
  },
  loadLedger: async (admin) => {
    const { data, error } = await admin.from('post_distribution').select('slug, stage, created_at').like('slug', 'package-%').not('path', 'is', null)
    return error ? null : ((data ?? []) as TripLedgerRow[])
  },
  countWeek: async (admin, now) => {
    const weekAgo = new Date(now.getTime() - 7 * 86_400_000).toISOString()
    const { count, error } = await admin.from('post_distribution').select('slug', { count: 'exact', head: true }).like('slug', 'package-%').not('path', 'is', null).gte('created_at', weekAgo)
    return error || count === null ? null : count
  },
  loadSignal: loadConversionSignal,
  enrol: enrolPackagePost,
}

const skip = (reason: string): FlywheelResult => ({ ran: false, reason })

/** The step's work, with its reads injectable so the offline check can run it against an in-memory fake. Never throws. */
export async function runPromotePick(ctx: FlywheelContext, deps: PromotePickDeps = defaultPromotePickDeps): Promise<FlywheelResult> {
  const { admin, now } = ctx
  if (ctx.dryRun) return skip('dry run: nothing is queued')
  if (ctx.room <= 0) return skip('today\'s limit is used')
  if (!(await getTripSocialEnabled(admin))) return skip('trip social posts is off, so no trip is picked')
  const mode = await getDistributionMode(admin)
  if (mode !== 'prepare' && mode !== 'auto') return skip('social posting is off')
  if (await isAutomationPaused(admin)) return skip('automation is paused')

  const week = await deps.countWeek(admin, now)
  if (week === null || week >= TRIP_ENROLMENTS_PER_WEEK) return skip(week === null ? 'could not count this week\'s trip posts' : 'this week\'s trip post limit is used')
  const [trips, ledger] = await Promise.all([deps.loadTrips(admin), deps.loadLedger(admin)])
  if (!trips || !ledger) return skip('could not read the trips or the post list')

  const bySlug = new Map(ledger.map((r) => [r.slug, r]))
  const today = now.toISOString().slice(0, 10)
  const gapMs = PROMOTION_GAP_DAYS * 86_400_000
  const eligible: TripSocialPackage[] = []
  for (const t of trips) {
    if (tripBlockers(t, today).length) continue
    const row = bySlug.get(packageDistributionSlug(t.slug))
    if (row && !(row.stage === 'done' && now.getTime() - Date.parse(row.created_at) >= gapMs)) continue
    if (await isVetoed(admin, 'promote_pick', t.slug)) continue
    eligible.push(t)
  }
  if (!eligible.length) return skip('no trip is ready for a post')

  const signal = await deps.loadSignal(admin, now)
  const lastPosted = (slug: string) => {
    const row = bySlug.get(packageDistributionSlug(slug))
    return row ? Date.parse(row.created_at) : -1
  }
  const pick = orderTripsByConversion(eligible, lastPosted, signal)[0]
  if (!pick || packageTier(signal, pick.slug) < 1) return skip('no trip has enough lead or order results yet, so the normal rotation chooses')

  const result = await deps.enrol(admin, { slug: pick.slug, name: pick.name, status: pick.status, available_to: pick.available_to ?? null, recap_mode: pick.recap_mode ?? null } as Pick<PromotionPackage, 'slug' | 'name' | 'status' | 'available_to' | 'recap_mode'>, now, TRIP_HOLD_NOTE)
  if (result.state !== 'held' && result.state !== 'queued') return skip(`${pick.slug}: ${result.note}`)

  const renewed = bySlug.has(result.slug)
  const mode2 = result.state === 'held' ? 'held for review' : 'queued'
  await logDecision(admin, 'promote_pick', pick.slug, `Queued the social post for "${pick.name}" (${mode2})`, `Chosen among ${eligible.length} ready trip${eligible.length === 1 ? '' : 's'} because ${explainTier(signal, pick.slug)}. The normal 30-day and one-a-day limits still apply.`, { kind: 'fw:promote_pick', ref: `${result.slug}|${renewed ? 'renewed' : 'new'}` }, now)
  return { ran: true, note: `queued the post for ${pick.slug}`, acted: 1 }
}

/** Takes a pick back: removes the post from the list while it has not reached a network. A row that was an old finished post
 * restarted by this pick goes back to finished instead of being deleted. */
export async function undoPromotePick(admin: SupabaseClient, ref: string): Promise<{ ok: boolean; message: string }> {
  try {
    const [slug, kind] = ref.split('|')
    if (!/^package-[a-z0-9][a-z0-9-]*$/.test(slug ?? '')) return { ok: false, message: 'That post reference is not valid.' }
    const { data, error } = await admin.from('post_distribution').select('stage, sent_platforms').eq('content_type', 'post').eq('slug', slug).maybeSingle()
    if (error) return { ok: false, message: `Could not read the post (${error.message}).` }
    const row = data as { stage: string; sent_platforms: string[] | null } | null
    if (!row) return { ok: false, message: 'That post is no longer in the posting list.' }
    if (row.stage !== 'held' && row.stage !== 'queued') return { ok: false, message: `It is already ${row.stage}, so there is nothing to take back.` }
    if ((row.sent_platforms ?? []).length > 0) return { ok: false, message: 'It has already reached a network, so it was left alone.' }
    if (kind === 'renewed') {
      const { error: e } = await admin.from('post_distribution').update({ stage: 'done', last_error: 'The automatic pick was undone by a person.', updated_at: new Date().toISOString() }).eq('content_type', 'post').eq('slug', slug).in('stage', ['held', 'queued'])
      return e ? { ok: false, message: e.message } : { ok: true, message: 'The post was taken out of the queue. This trip will not be picked automatically again.' }
    }
    const { error: e } = await admin.from('post_distribution').delete().eq('content_type', 'post').eq('slug', slug).in('stage', ['held', 'queued'])
    return e ? { ok: false, message: e.message } : { ok: true, message: 'The post was removed from the queue. This trip will not be picked automatically again.' }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'The undo failed.' }
  }
}

export const promotePickStep: FlywheelStep = {
  id: 'promote_pick',
  policy: 'promote_pick',
  label: 'Conversion-weighted promote pick',
  order: 80,
  floorMs: 10_000,
  run: (ctx) => runPromotePick(ctx),
  undo: undoPromotePick,
}
