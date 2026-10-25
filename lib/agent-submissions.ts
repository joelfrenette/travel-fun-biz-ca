import type { SupabaseClient } from '@supabase/supabase-js'
import { getPackageById, updatePackage, deletePackage } from '@/lib/packages'
import { addPromotedSlug } from '@/lib/agents'
import { createDraftPackage } from '@/lib/package-ingest'
import { isPrivateIp } from '@/lib/supplier-photos'
import { publishTrip, publishBlockers } from '@/lib/trip-wizard'
import { missingFacts, type MissingFact } from '@/lib/trip-checklist'
import { completenessScore } from '@/lib/package-completeness'
import {
  isTokenFormat,
  inviteState,
  canWorkOnExisting,
  dailyAllowance,
  limitMessage,
  blockMessage,
  isEditableState,
  isHelperSource,
  decisionAllowed,
  canSend,
  agentFieldViews,
  filledLabels,
  MAX_DRAFTS_PER_DAY,
  MAX_SOURCES_PER_DAY,
  MAX_SOURCES_PER_DRAFT,
  STATE_LABEL,
  DAY_MS,
  type AgentFieldView,
  type DraftEdits,
  type SubmissionState,
} from '@/lib/agent-invites'

// The database side of the agent submission links (growth loop WP13). Every function that takes an `invite` was handed
// one from getInviteByToken, i.e. the token was validated first; every function that takes a `submission` verifies it
// belongs to that invite (getSubmission). The admin-side helpers at the bottom are called only from routes that check
// isAuthorized. Nothing here ever returns another agent's draft, another trip, or any admin data to an agent.

export interface InviteRow {
  id: string
  token: string
  agent_name: string
  agent_email: string | null
  note: string | null
  created_at: string
  expires_at: string
  revoked_at: string | null
  uses: number
  max_uses: number
}

export interface SubmissionRow {
  id: string
  invite_id: string | null
  package_id: string | null
  agent_name: string
  agent_email: string | null
  message: string | null
  trip_name: string | null
  destination: string | null
  dates_note: string | null
  filled_fields: string[]
  submission_state: SubmissionState
  review_note: string | null
  created_at: string
  updated_at: string
  submitted_at: string | null
  decided_at: string | null
}

type Fail = { ok: false; status: number; error: string }
const fail = (status: number, error: string): Fail => ({ ok: false, status, error })

const MIGRATION_HINT = 'The agent links need migration 0036 (supabase/migrations/0036_agent_invites.sql) to be run first.'
const dbMessage = (m: string) => (/agent_invites|package_submissions|does not exist|schema cache/i.test(m) ? MIGRATION_HINT : m)

/** The invite for a token, or null. A badly shaped token never reaches the database. */
export async function getInviteByToken(admin: SupabaseClient, token: unknown): Promise<InviteRow | null> {
  if (!isTokenFormat(token)) return null
  const { data } = await admin.from('agent_invites').select('*').eq('token', token).maybeSingle()
  return (data as InviteRow | null) ?? null
}

/** One of THIS invite's drafts. A submission id from any other link is "not found". */
export async function getSubmission(admin: SupabaseClient, invite: InviteRow, id: string): Promise<SubmissionRow | null> {
  const { data } = await admin.from('package_submissions').select('*').eq('id', id).eq('invite_id', invite.id).maybeSingle()
  const row = data as SubmissionRow | null
  return row && row.package_id ? row : null
}

export async function listSubmissions(admin: SupabaseClient, invite: InviteRow): Promise<SubmissionRow[]> {
  const { data } = await admin.from('package_submissions').select('*').eq('invite_id', invite.id).not('package_id', 'is', null).order('created_at', { ascending: false }).limit(50)
  return (data ?? []) as SubmissionRow[]
}

/** Puts one use back after a start that did not complete (best effort; a lost race only ever makes the limit stricter). */
async function releaseUse(admin: SupabaseClient, inviteId: string): Promise<void> {
  const { data } = await admin.from('agent_invites').select('uses').eq('id', inviteId).maybeSingle()
  const uses = (data as { uses: number } | null)?.uses ?? 0
  if (uses > 0) await admin.from('agent_invites').update({ uses: uses - 1 }).eq('id', inviteId).eq('uses', uses)
}

/**
 * Starts a draft for an agent. Order matters for the limits: (1) the link must be usable; (2) one use is claimed with a
 * compare-and-set so the total cap cannot be passed by parallel requests; (3) a submission row is written BEFORE the
 * rolling-day count, and the count includes it, so two parallel requests can only both be refused, never both pass the
 * daily limit; (4) only then is the draft trip created.
 */
export async function startDraft(
  admin: SupabaseClient,
  invite: InviteRow,
  input: { tripName: string; destination: string; message: string },
  now = new Date(),
): Promise<{ ok: true; submission: SubmissionRow } | Fail> {
  const state = inviteState(invite, now)
  if (!state.ok) return fail(state.reason === 'used-up' ? 429 : 403, blockMessage(state.reason))

  const claim = await admin.from('agent_invites').update({ uses: invite.uses + 1 }).eq('id', invite.id).eq('uses', invite.uses).lt('uses', invite.max_uses).select('id').maybeSingle()
  if (claim.error) return fail(500, dbMessage(claim.error.message))
  if (!claim.data) return fail(409, 'Something else just changed on this link. Please try again.')

  const { data: ins, error: insErr } = await admin
    .from('package_submissions')
    .insert({ invite_id: invite.id, agent_name: invite.agent_name, agent_email: invite.agent_email, trip_name: input.tripName, destination: input.destination || null, message: input.message || null })
    .select('*')
    .single()
  if (insErr || !ins) {
    await releaseUse(admin, invite.id)
    return fail(500, dbMessage(insErr?.message ?? 'Could not start the trip.'))
  }
  const sub = ins as SubmissionRow

  const { data: recent } = await admin.from('package_submissions').select('created_at').eq('invite_id', invite.id).gte('created_at', new Date(now.getTime() - DAY_MS).toISOString())
  const stamps = ((recent ?? []) as { created_at: string }[]).map((r) => r.created_at)
  if (stamps.length > MAX_DRAFTS_PER_DAY) {
    await admin.from('package_submissions').delete().eq('id', sub.id)
    await releaseUse(admin, invite.id)
    const others = stamps.filter((_, i) => i < stamps.length)
    const allow = dailyAllowance(others.filter((s) => s !== sub.created_at), now, MAX_DRAFTS_PER_DAY)
    return fail(429, limitMessage('drafts', allow.nextAt))
  }

  const made = await createDraftPackage({ name: input.tripName, destination: input.destination, supplier: invite.agent_name })
  if (!made.pkg) {
    await admin.from('package_submissions').delete().eq('id', sub.id)
    await releaseUse(admin, invite.id)
    return fail(made.error?.status ?? 500, made.error?.message ?? 'Could not start the trip.')
  }
  const { data: linked, error: linkErr } = await admin.from('package_submissions').update({ package_id: made.pkg.id, updated_at: new Date().toISOString() }).eq('id', sub.id).select('*').single()
  if (linkErr || !linked) {
    // Never leave an orphan draft nobody can see: remove the package and the submission, and give the use back.
    await deletePackage(made.pkg.id).catch(() => false)
    await admin.from('package_submissions').delete().eq('id', sub.id)
    await releaseUse(admin, invite.id)
    return fail(500, dbMessage(linkErr?.message ?? 'Could not start the trip.'))
  }
  return { ok: true, submission: linked as SubmissionRow }
}

/** Sources added by this link in the last 24 hours, across all its drafts. */
export async function sourcesInLastDay(admin: SupabaseClient, invite: InviteRow, now = new Date()): Promise<number> {
  const subs = await listSubmissions(admin, invite)
  const ids = subs.map((s) => s.package_id).filter((x): x is string => !!x)
  if (ids.length === 0) return 0
  // Helper rows the site writes itself (automatic FAQs, own photos, the recap log) are not the agent's sources.
  const { data } = await admin.from('package_sources').select('file_name').in('package_id', ids).gte('created_at', new Date(now.getTime() - DAY_MS).toISOString()).limit(1000)
  return ((data ?? []) as { file_name: string | null }[]).filter((r) => !isHelperSource(r.file_name)).length
}

/** May this draft take one more source right now? (link usable, draft unlocked, 10 a day per link, 8 per draft.) */
export async function mayAddSource(admin: SupabaseClient, invite: InviteRow, sub: SubmissionRow, now = new Date()): Promise<{ ok: true } | Fail> {
  const w = canWorkOnExisting(invite, now)
  if (!w.ok) return fail(403, blockMessage(w.reason))
  if (!isEditableState(sub.submission_state)) return fail(409, 'This trip is with Joel, so it cannot be changed now.')
  if ((await sourcesInLastDay(admin, invite, now)) >= MAX_SOURCES_PER_DAY) return fail(429, limitMessage('sources', null))
  const { data: onDraft } = await admin.from('package_sources').select('file_name').eq('package_id', sub.package_id as string).limit(200)
  const count = ((onDraft ?? []) as { file_name: string | null }[]).filter((r) => !isHelperSource(r.file_name)).length
  if (count >= MAX_SOURCES_PER_DRAFT) return fail(409, `This trip already has ${MAX_SOURCES_PER_DRAFT} things added. That is plenty: review it and send it to Joel.`)
  return { ok: true }
}

/** Why a link an agent typed may not be fetched by the server, or null. https only, no login in it, no address numbers,
 * not a private name, and the name must resolve only to public addresses. (Redirects are followed by the reader; the
 * answer to the agent never contains what was read, which limits what a hidden redirect could leak.) */
export async function publicUrlRejection(url: string, lookup?: (host: string) => Promise<string[]>): Promise<string | null> {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return 'That is not a web address.'
  }
  if (u.protocol !== 'https:') return 'The link must start with https://'
  if (u.username || u.password) return 'The link must not contain a login.'
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (!host.includes('.') || /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':')) return 'Please use the website name, not a number.'
  if (/^(localhost|.*\.local|.*\.internal|.*\.localhost)$/.test(host) || isPrivateIp(host)) return 'That address cannot be used.'
  try {
    const find = lookup ?? (async (h: string) => (await (await import('node:dns/promises')).lookup(h, { all: true })).map((r) => r.address))
    const addrs = await find(host)
    if (addrs.length === 0 || addrs.some(isPrivateIp)) return 'That address cannot be used.'
  } catch {
    return 'That website could not be found.'
  }
  return null
}

// ─── What the agent sees ─────────────────────────────────────────────────────────────

export interface AgentDraftView {
  id: string
  state: SubmissionState
  stateLabel: string
  editable: boolean
  reviewNote: string | null
  tripName: string
  datesNote: string
  fields: AgentFieldView[]
  sources: { id: string; kind: string; label: string; status: string; filled: string[]; failed: boolean }[]
  missing: MissingFact[]
  score: number
  sourcesLeftToday: number
  canSend: boolean
}

/** The agent's page for one draft: its own fields (prices as "found" only), its own sources (what each filled, by name),
 * the Still-missing list and the state. Built from the draft's own row and sources and nothing else. */
export async function agentDraftView(admin: SupabaseClient, invite: InviteRow, sub: SubmissionRow, now = new Date()): Promise<AgentDraftView | null> {
  const pkg = await getPackageById(sub.package_id as string)
  if (!pkg) return null
  const row = pkg as unknown as Record<string, unknown>
  const { data } = await admin.from('package_sources').select('id, kind, file_name, source_url, status, applied_fields, created_at').eq('package_id', pkg.id).order('created_at', { ascending: true })
  const srcs = ((data ?? []) as { id: string; kind: string; file_name: string | null; source_url: string | null; status: string; applied_fields: string[] | null }[]).filter((s) => !isHelperSource(s.file_name))
  const used = await sourcesInLastDay(admin, invite, now)
  const read = srcs.filter((s) => s.status === 'extracted' || s.status === 'applied').length
  return {
    id: sub.id,
    state: sub.submission_state,
    stateLabel: STATE_LABEL[sub.submission_state],
    editable: isEditableState(sub.submission_state),
    reviewNote: sub.review_note,
    tripName: pkg.name,
    datesNote: sub.dates_note ?? '',
    fields: agentFieldViews(row),
    sources: srcs.map((s) => ({
      id: s.id,
      kind: s.kind,
      label: s.kind === 'url' ? (s.source_url ?? 'Link') : s.kind === 'text' ? 'Pasted text' : (s.file_name ?? (s.kind === 'pdf' ? 'PDF' : 'Screenshot')),
      status: s.status,
      filled: filledLabels(s.applied_fields ?? []),
      failed: s.status === 'failed',
    })),
    missing: missingFacts(row),
    score: completenessScore(pkg).score,
    sourcesLeftToday: Math.max(0, MAX_SOURCES_PER_DAY - used),
    canSend: canSend(sub.submission_state, read).ok,
  }
}

/** Saves the agent's own edits to the plain text fields of their draft. Only the whitelisted columns (lib/agent-invites
 * cleanDraftEdits) ever reach here. */
export async function saveAgentEdits(admin: SupabaseClient, sub: SubmissionRow, edits: DraftEdits): Promise<{ ok: true } | Fail> {
  if (!isEditableState(sub.submission_state)) return fail(409, 'This trip is with Joel, so it cannot be changed now.')
  if (Object.keys(edits.columns).length) {
    const updated = await updatePackage(sub.package_id as string, edits.columns)
    if (!updated) return fail(500, 'Your changes could not be saved. Please try again.')
  }
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (edits.datesNote !== undefined) patch.dates_note = edits.datesNote || null
  if (edits.columns.name) patch.trip_name = edits.columns.name
  if (edits.columns.destination !== undefined) patch.destination = edits.columns.destination || null
  await admin.from('package_submissions').update(patch).eq('id', sub.id)
  return { ok: true }
}

/** "Send to Joel for review": locks the draft for the agent and lists it for Joel. */
export async function sendSubmission(admin: SupabaseClient, invite: InviteRow, sub: SubmissionRow, now = new Date()): Promise<{ ok: true } | Fail> {
  const w = canWorkOnExisting(invite, now)
  if (!w.ok) return fail(403, blockMessage(w.reason))
  const { data } = await admin.from('package_sources').select('status').eq('package_id', sub.package_id as string)
  const read = ((data ?? []) as { status: string }[]).filter((s) => s.status === 'extracted' || s.status === 'applied').length
  const can = canSend(sub.submission_state, read)
  if (!can.ok) return fail(409, can.reason)
  const t = now.toISOString()
  const { data: moved } = await admin.from('package_submissions').update({ submission_state: 'submitted', submitted_at: t, updated_at: t }).eq('id', sub.id).in('submission_state', ['in_progress', 'rejected']).select('id').maybeSingle()
  if (!moved) return fail(409, 'This trip was already sent to Joel.')
  return { ok: true }
}

// ─── Admin side (callers check isAuthorized) ────────────────────────────────────────

export async function getSubmissionForPackage(admin: SupabaseClient, packageId: string): Promise<SubmissionRow | null> {
  const { data } = await admin.from('package_submissions').select('*').eq('package_id', packageId).order('created_at', { ascending: false }).limit(1).maybeSingle()
  return (data as SubmissionRow | null) ?? null
}

/**
 * After an approved trip is live, add it to the page of the roster agent the link belongs to (if the link was tied to one).
 * Never throws and never blocks the approval: the trip is already published, and the office can add it by hand if this fails.
 */
async function attachToAgentPage(admin: SupabaseClient, inviteId: string | null, slug: unknown): Promise<void> {
  try {
    if (!inviteId || typeof slug !== 'string' || !slug) return
    const { data: inv } = await admin.from('agent_invites').select('agent_id').eq('id', inviteId).maybeSingle()
    const agentId = (inv as { agent_id?: string | null } | null)?.agent_id
    if (!agentId) return
    const { data: ag } = await admin.from('agents').select('promoted_package_slugs').eq('id', agentId).maybeSingle()
    if (!ag) return
    const next = addPromotedSlug((ag as { promoted_package_slugs?: unknown }).promoted_package_slugs, slug)
    await admin.from('agents').update({ promoted_package_slugs: next }).eq('id', agentId)
  } catch {
    /* best effort */
  }
}

/** Approve = publish (guarded: required fields must be filled). Reject = back to the agent with a note they can read. */
export async function decideSubmission(admin: SupabaseClient, packageId: string, action: 'approve' | 'reject', note?: string): Promise<{ ok: true; state: SubmissionState } | (Fail & { missing?: string[] })> {
  const sub = await getSubmissionForPackage(admin, packageId)
  if (!sub) return fail(404, 'This trip was not sent by an agent.')
  const allowed = decisionAllowed(sub.submission_state, action)
  if (!allowed.ok) return fail(409, allowed.reason)
  const t = new Date().toISOString()
  if (action === 'approve') {
    const pkg = await getPackageById(packageId)
    if (!pkg) return fail(404, 'The trip could not be read.')
    const missing = publishBlockers(pkg as unknown as Record<string, unknown>)
    if (missing.length) return { ...fail(400, `Fill in these first, in the form below: ${missing.join(', ')}.`), missing }
    // Claim the transition FIRST: only the request that moves the row to approved publishes, so a double click cannot
    // publish (and ping search engines) twice. If the publish then fails, the claim is given back.
    const prior = sub.submission_state
    const { data: claimed } = await admin.from('package_submissions').update({ submission_state: 'approved', decided_at: t, updated_at: t }).eq('id', sub.id).in('submission_state', ['in_progress', 'submitted', 'rejected']).select('id').maybeSingle()
    if (!claimed) return fail(409, 'This trip was already decided.')
    const pub = await publishTrip(packageId)
    if (!pub.ok) {
      await admin.from('package_submissions').update({ submission_state: prior, decided_at: null, updated_at: new Date().toISOString() }).eq('id', sub.id).eq('submission_state', 'approved')
      return fail(pub.status, pub.error)
    }
    await attachToAgentPage(admin, sub.invite_id, pkg.slug)
    return { ok: true, state: 'approved' }
  }
  const clean = (note ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, 1000)
  if (!clean) return fail(400, 'Write a short note for the agent so they know what to change.')
  const { data: moved } = await admin.from('package_submissions').update({ submission_state: 'rejected', review_note: clean, decided_at: t, updated_at: t }).eq('id', sub.id).in('submission_state', ['submitted', 'in_progress']).select('id').maybeSingle()
  if (!moved) return fail(409, 'This trip was already decided.')
  return { ok: true, state: 'rejected' }
}
