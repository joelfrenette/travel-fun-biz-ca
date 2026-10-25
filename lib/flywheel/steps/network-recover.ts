import type { SupabaseClient } from '@supabase/supabase-js'
import { getSetting } from '@/lib/app-settings'
import { isVetoed, logDecision, readJsonSetting, writeJsonSetting } from '@/lib/flywheel/ctx'
import type { FlywheelContext, FlywheelResult, FlywheelStep } from '@/lib/flywheel/types'
import { getDistributionMode } from '@/lib/distribution'
import { resolveIssue } from '@/lib/issues'
import { pausedNow, readPauses, writePauses, NETWORK_PAUSE_HOURS } from '@/lib/network-pause'
import { getGhlAccounts, getProvider, MEDIA_NETWORKS } from '@/lib/social-provider'
import { ghlListAccounts, ghlSocialConfigured, type GhlAccount } from '@/lib/ghl-social'
import { uploadPostConfigured, uploadPostListProfiles, type UploadPostProfile } from '@/lib/upload-post'

// WP7: Network un-pause and reconnect re-probe (policy network_recover).
//
// The funnel watchdog (lib/funnel-watchdog.ts, untouched) pauses a network for 24 hours after repeated failures, and a post that fails with a
// sign-in error is never retried by the retry policy. After Joel reconnects the account nothing noticed. Once per pass this step:
//   1. finds networks that are paused right now (for at least an hour) and networks that have failed posts whose error names them and looks
//      like a sign-in problem (401, 403, expired token, reconnect);
//   2. asks the posting provider whether the account is healthy (one read-only call: GoHighLevel accounts, or Upload-Post profiles);
//   3. for a healthy network, ends its pause (the stored strike count is KEPT, so one more failure pauses it again straight away, and the
//      watchdog stops pausing after its usual two strikes and asks for a person) and puts at most 2 of its failed, never-sent posts back in
//      the posting queue through the existing retry path (resolveIssue 'retry-post').
// It never posts anything itself, never touches a post that already reached a network, and never un-pauses a network the provider does not
// positively report as connected. Each network is recovered at most once per 24 hours and each post is requeued at most once, ever.

export const NETWORK_RECOVER_STATE_KEY = 'network_recover_state'
/** A pause must be this old before it is lifted early (a fresh pause has not had time for a reconnect). */
export const MIN_PAUSE_AGE_MS = 60 * 60_000
/** A failed post must be this old before it is requeued. */
export const MIN_ROW_AGE_MS = 15 * 60_000
/** Failed posts older than this are left alone (a stale post should not wake up). */
export const MAX_ROW_AGE_MS = 3 * 86_400_000
/** One network is recovered at most once in this window. */
export const NETWORK_COOLDOWN_MS = 24 * 3_600_000
/** At most this many posts are requeued per pass. */
export const MAX_REQUEUE_PER_PASS = 2

/** An error that a reconnect can fix (sign-in, expired token), as opposed to a network refusing the content. */
const AUTH_ERROR = /\b(401|403)\b|unauthori[sz]ed|forbidden|token|expired|reconnect|re-?auth|credential|not connected|access denied/i

export type Health = 'healthy' | 'unhealthy' | 'unknown'
export interface ProbeResult {
  /** Health per lowercase network name. A network missing here is unknown. */
  health: Record<string, Health>
  error?: string
}
export type NetworkProbe = (admin: SupabaseClient) => Promise<ProbeResult>

export interface NetworkRecoverDeps {
  probe?: NetworkProbe
  /** Puts one failed post back in the queue; returns an error message or null. */
  retryPost?: (admin: SupabaseClient, slug: string) => Promise<string | null>
  /** The distribution mode ('auto' | 'prepare' | 'off'). Posts are only requeued in 'auto'. */
  getMode?: (admin: SupabaseClient) => Promise<string>
}

interface RecoverState {
  unpaused: Record<string, string>
  requeued: Record<string, string>
}

interface FailedRow {
  slug: string
  stage: string
  last_error: string | null
  sent_platforms: string[] | null
  updated_at: string
}

const alias = (n: string): string[] => (n === 'x' ? ['x', 'twitter'] : n === 'twitter' ? ['twitter', 'x'] : [n])

/** The networks a failed-post error names ("instagram: 401 ..."), the same way the funnel watchdog reads it. Pure. */
export function networksNamedIn(error: string | null | undefined, known: readonly string[] = MEDIA_NETWORKS): string[] {
  if (!error) return []
  return [...new Set(known.filter((n) => new RegExp(`(^|[^a-z])${n}\\s*:`, 'i').test(error)))]
}

/** Health of one network given the probe map (x and twitter are the same network). Pure. */
export function healthOf(health: Record<string, Health>, net: string): Health {
  const seen = alias(net).map((n) => health[n]).filter((h): h is Health => !!h)
  if (seen.includes('unhealthy')) return 'unhealthy'
  if (seen.includes('healthy')) return 'healthy'
  return 'unknown'
}

/** GoHighLevel: a network is healthy when every ticked account of that platform is active and not expired. Pure. */
export function ghlHealth(live: GhlAccount[], chosenIds: string[]): Record<string, Health> {
  const out: Record<string, Health> = {}
  for (const a of live) {
    if (!chosenIds.includes(a.id)) continue
    const ok = a.active && !a.expired
    out[a.platform] = out[a.platform] === 'unhealthy' || !ok ? 'unhealthy' : 'healthy'
  }
  return out
}

/** Upload-Post: a network is healthy only when the chosen profile lists it as connected. Anything else is unhealthy or unknown. Pure. */
export function uploadPostHealth(profiles: UploadPostProfile[], user: string): Record<string, Health> {
  const out: Record<string, Health> = {}
  const p = profiles.find((x) => x.username === user)
  if (!p) return out
  for (const a of p.accounts) {
    const s = (a.status ?? '').toLowerCase()
    out[a.platform.toLowerCase()] = /reconnect|reauth|expired|disconnect|revoked|error|fail|invalid/.test(s) ? 'unhealthy' : /^(connected|active|ok|healthy|valid)$/.test(s) ? 'healthy' : 'unknown'
  }
  return out
}

/** The default provider read: one read-only call to the live provider. Never throws. */
export const defaultProbe: NetworkProbe = async (admin) => {
  try {
    const provider = await getProvider(admin)
    if (provider === 'ghl') {
      if (!ghlSocialConfigured()) return { health: {}, error: 'GoHighLevel posting is not configured' }
      const r = await ghlListAccounts()
      if (r.error) return { health: {}, error: r.error }
      const chosen = (await getGhlAccounts(admin)).map((a) => a.id)
      return { health: ghlHealth(r.accounts, chosen) }
    }
    if (!uploadPostConfigured()) return { health: {}, error: 'Upload-Post is not configured' }
    const user = ((await getSetting(admin, 'distribution_accounts')) ?? '').split(',').map((s) => s.trim()).filter(Boolean)[0]
    if (!user) return { health: {}, error: 'no Upload-Post profile chosen' }
    const r = await uploadPostListProfiles()
    if (r.error || !r.profiles) return { health: {}, error: r.error ?? 'Upload-Post sent no profiles' }
    return { health: uploadPostHealth(r.profiles, user) }
  } catch (e) {
    return { health: {}, error: e instanceof Error ? e.message : 'the account check failed' }
  }
}

const defaultRetryPost = (admin: SupabaseClient, slug: string) => resolveIssue(admin, 'retry-post', slug)

const newest = (m: Record<string, string>, keep: number): Record<string, string> =>
  Object.fromEntries(Object.entries(m).sort((a, b) => Date.parse(b[1]) - Date.parse(a[1])).slice(0, keep))

function parseState(v: Partial<RecoverState> | null): RecoverState {
  const clean = (m: unknown): Record<string, string> =>
    m && typeof m === 'object' && !Array.isArray(m) ? Object.fromEntries(Object.entries(m as Record<string, unknown>).filter(([, t]) => typeof t === 'string' && Number.isFinite(Date.parse(t as string))) as [string, string][]) : {}
  return { unpaused: clean(v?.unpaused), requeued: clean(v?.requeued) }
}

/** Failed, never-sent posts from the last 3 days whose error names a network and looks like a sign-in problem. Pure. */
export function authFailedRows(rows: FailedRow[], now: Date): Array<FailedRow & { nets: string[] }> {
  return rows
    .filter((r) => r.stage === 'failed' && (r.sent_platforms ?? []).length === 0 && !!r.last_error && AUTH_ERROR.test(r.last_error))
    .filter((r) => {
      const age = now.getTime() - Date.parse(r.updated_at)
      return Number.isFinite(age) && age >= MIN_ROW_AGE_MS && age <= MAX_ROW_AGE_MS
    })
    .map((r) => ({ ...r, nets: networksNamedIn(r.last_error) }))
    .filter((r) => r.nets.length > 0)
    .sort((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at))
}

/** The step's work, with its outside calls injectable so it can be checked offline. */
export async function runNetworkRecover(ctx: FlywheelContext, deps: NetworkRecoverDeps = {}): Promise<FlywheelResult> {
  if (ctx.dryRun) return { ran: false, reason: 'dry run' }
  if (ctx.room <= 0) return { ran: false, reason: 'the daily limit for this step is used up' }
  const { admin, now } = ctx
  const probe = deps.probe ?? defaultProbe
  const retryPost = deps.retryPost ?? defaultRetryPost
  const getMode = deps.getMode ?? getDistributionMode

  const pauses = await readPauses(admin)
  const state = parseState(await readJsonSetting<Partial<RecoverState> | null>(admin, NETWORK_RECOVER_STATE_KEY, null))
  const cooled = (net: string) => alias(net).every((n) => !state.unpaused[n] || now.getTime() - Date.parse(state.unpaused[n]) >= NETWORK_COOLDOWN_MS)

  // 1. Candidates: paused for at least an hour, and failed posts that look like a sign-in problem.
  const pausedCandidates = pauses ? pausedNow(pauses, now).filter((n) => now.getTime() - Date.parse(pauses[n].since) >= MIN_PAUSE_AGE_MS && cooled(n)) : []
  let rows: Array<FailedRow & { nets: string[] }> = []
  try {
    const since = new Date(now.getTime() - MAX_ROW_AGE_MS).toISOString()
    const { data, error } = await admin.from('post_distribution').select('slug, stage, last_error, sent_platforms, updated_at').eq('content_type', 'post').eq('stage', 'failed').gte('updated_at', since).order('updated_at', { ascending: true }).limit(50)
    if (!error) rows = authFailedRows((data ?? []) as FailedRow[], now).filter((r) => !state.requeued[r.slug])
  } catch {
    rows = []
  }
  if (!pausedCandidates.length && !rows.length) return { ran: false, reason: 'no paused network and no sign-in failures to re-check' }

  // 2. One read-only account check.
  const probed = await probe(admin)
  if (probed.error) return { ran: false, reason: `could not check the accounts (${probed.error})` }

  let room = ctx.room
  let acted = 0
  const notes: string[] = []

  // 3a. End the pause of a network whose account reports healthy.
  for (const net of pausedCandidates) {
    if (room <= 0) break
    try {
      if (healthOf(probed.health, net) !== 'healthy') continue
      if (await isVetoed(admin, 'network_recover', net)) continue
      const p = pauses![net]
      // Keep the entry (and its strikes) with the pause ended now: the next failure counts at once and pauses it again.
      const next = { ...pauses!, [net]: { ...p, until: now.toISOString() } }
      const w = await writePauses(admin, next)
      if (w.error) continue
      pauses![net] = next[net]
      state.unpaused[net] = now.toISOString()
      await logDecision(admin, 'network_recover', net, `Ended the pause on ${net} early`, `The account reports it is connected again. One test post follows; if it fails the network pauses again straight away (strike ${p.strikes} is kept).`, { kind: 'fw:network_recover', ref: `${net}|${p.until}|${p.since}|${p.strikes}` }, now)
      room--
      acted++
      notes.push(`resumed ${net}`)
    } catch {
      // one network failing must not stop the others
    }
  }

  // 3b. Put at most 2 failed, never-sent posts back in the queue, only when every network the error names is healthy and in auto mode.
  let requeued = 0
  if (room > 0 && rows.length) {
    let mode = ''
    try {
      mode = await getMode(admin)
    } catch {
      mode = ''
    }
    if (mode === 'auto') {
      for (const r of rows) {
        if (room <= 0 || requeued >= MAX_REQUEUE_PER_PASS) break
        try {
          if (!r.nets.every((n) => healthOf(probed.health, n) === 'healthy')) continue
          if (await isVetoed(admin, 'network_recover', r.slug)) continue
          const err = await retryPost(admin, r.slug)
          if (err) continue
          state.requeued[r.slug] = now.toISOString()
          await logDecision(admin, 'network_recover', r.slug, 'Put the failed post back in the posting queue', `It failed with a sign-in error on ${r.nets.join(', ')}, and that account now reports it is connected. Nothing had been posted yet.`, { kind: 'requeue-post', ref: r.slug }, now)
          requeued++
          room--
          acted++
        } catch {
          // carry on with the next post
        }
      }
      if (requeued) notes.push(`requeued ${requeued} post${requeued === 1 ? '' : 's'}`)
    }
  }

  if (acted) {
    await writeJsonSetting(admin, NETWORK_RECOVER_STATE_KEY, { unpaused: newest(state.unpaused, 50), requeued: newest(state.requeued, 200) })
    return { ran: true, note: notes.join(', '), acted }
  }
  return { ran: false, reason: 'no account reports healthy yet' }
}

/** Takes back one early un-pause. ref is "<network>|<old until>|<old since>|<strikes>". */
export async function undoNetworkRecover(admin: SupabaseClient, ref: string): Promise<{ ok: boolean; message: string }> {
  const [net, until, since, strikes] = ref.split('|')
  if (!net || !Number.isFinite(Date.parse(until ?? '')) || !Number.isFinite(Date.parse(since ?? ''))) return { ok: false, message: 'This decision has no pause to restore.' }
  const pauses = await readPauses(admin)
  if (!pauses) return { ok: false, message: 'Could not read the pauses.' }
  const now = new Date()
  if (pauses[net] && Date.parse(pauses[net].until) > now.getTime()) return { ok: true, message: `${net} is paused again already.` }
  const keep = Date.parse(until) > now.getTime()
  pauses[net] = { since, until: keep ? until : new Date(now.getTime() + NETWORK_PAUSE_HOURS * 3_600_000).toISOString(), strikes: Math.max(1, Math.floor(Number(strikes)) || 1) }
  const w = await writePauses(admin, pauses)
  return w.error ? { ok: false, message: w.error } : { ok: true, message: keep ? `${net} is paused again until the original time.` : `${net} is paused again for ${NETWORK_PAUSE_HOURS} hours.` }
}

export function createNetworkRecoverStep(deps: NetworkRecoverDeps = {}): FlywheelStep {
  return {
    id: 'network_recover',
    policy: 'network_recover',
    label: 'Network un-pause and reconnect re-probe',
    order: 70,
    floorMs: 15_000,
    run: (ctx) => runNetworkRecover(ctx, deps),
    undo: undoNetworkRecover,
  }
}

export const networkRecoverStep: FlywheelStep = createNetworkRecoverStep()
