import type { SupabaseClient } from '@supabase/supabase-js'
import { getSetting, getSettingStrict, setSetting } from '@/lib/app-settings'
import { AUTOMATION_PAUSED_KEY } from '@/lib/automation-kill-switch'
import { blockIfDry } from '@/lib/dry-run'
import { revertEdit } from '@/lib/content-edits'
import { readPauses, writePauses } from '@/lib/network-pause'

// The policy engine behind "Autopilot decisions". Four small things the owner approved to happen BY THEMSELVES (retry a failed
// post, approve a safe blog topic, publish a news brief that passed every check, release a held post after 24 hours), plus the
// funnel watchdog's own repairs. Each one is allowed only through the gate below and each one writes a line to an append-only log
// with a plain reason and, when it can be taken back, an Undo.
//
// Rules that apply to every policy:
//  - the master kill switch ("Pause all automation", app_settings.automation_paused) stops all of them; a switch that cannot be
//    read also stops them (fail closed for ACTING);
//  - each policy has its own switch, app_settings.auto_policy_<name>: ON unless it is exactly 'off';
//  - each policy has a per-day cap, counted from the log (UTC day);
//  - anything a person undid, rejected or snoozed is never touched again (the veto list below);
//  - writing the log fails OPEN: a log that cannot be written never blocks or reverts the action's own work, and a log that is
//    corrupt reads as empty.

export type AutopilotPolicyName = 'retry_failed_posts' | 'approve_safe_topics' | 'publish_passing_news' | 'release_held_posts' | 'funnel_watchdog'
/** The SEO engines' two automatic actions (lib/seo-engines-run.ts): suggest topics from Search Console searches, and add internal links
 * between pages that compete or belong together. They have their own switch and cap but are not part of the Autopilot card's list. */
export type SeoPolicyName = 'seo_topics' | 'seo_links'
/** The System check "Auto-heal" AI step (lib/system-check-ai.ts). It only labels log lines (each with an Undo); it has no switch of its own
 * because it only runs when a person clicks Auto-heal, and it is bounded by the kill switch and the heal loop's own daily call cap. */
export type SystemCheckPolicyName = 'system_check_ai'
/** The evergreen re-share (lib/evergreen-reshare-run.ts): one older page a day goes back through social. It has its own switch, DEFAULT OFF
 * (app_settings.evergreen_reshare_enabled), so it is not part of the Autopilot card's list (those default on) and not in ALL_POLICIES. */
export type EvergreenPolicyName = 'evergreen_reshare'
/** The "same meaning" topic check (lib/topic-meaning-run.ts): a topic that says the same thing as an existing post, a queued topic or a recent
 * rejection is skipped and logged with an Undo. Its switch (auto_policy_topic_meaning) defaults to ON; the AI tie-break (topic_meaning_ai) to OFF. */
export type TopicMeaningPolicyName = 'topic_meaning'
export type PolicyName = AutopilotPolicyName | SeoPolicyName | SystemCheckPolicyName | EvergreenPolicyName | TopicMeaningPolicyName

/** The four decisions the owner approved. They default to ON. */
export const APPROVED_POLICIES: readonly PolicyName[] = ['retry_failed_posts', 'approve_safe_topics', 'publish_passing_news', 'release_held_posts']
export const ALL_POLICIES: readonly PolicyName[] = [...APPROVED_POLICIES, 'funnel_watchdog']
export const SEO_POLICIES: readonly SeoPolicyName[] = ['seo_topics', 'seo_links']

export const POLICY_LABELS: Record<PolicyName, string> = {
  topic_meaning: 'Skip blog topics that mean the same as an existing post',
  evergreen_reshare: 'Re-share one older evergreen page on social (off until you switch it on)',
  system_check_ai: 'AI fix started from the System check (Auto-heal)',
  seo_topics: 'Suggest blog topics from Google searches (SEO engines)',
  seo_links: 'Add internal links between competing and related pages (SEO engines)',
  retry_failed_posts: 'Retry failed posts and resume stuck steps',
  approve_safe_topics: 'Approve safe blog topics from Google data',
  publish_passing_news: 'Publish news briefs that passed every check',
  release_held_posts: 'Release held posts after 24 hours',
  funnel_watchdog: 'Funnel watchdog repairs',
}

/** Most automatic actions per policy per UTC day. Counts every logged action of that policy that changed something. */
export const POLICY_CAPS: Record<PolicyName, number> = {
  topic_meaning: 40,
  evergreen_reshare: 1,
  system_check_ai: 12,
  seo_topics: 3,
  seo_links: 3,
  retry_failed_posts: 6,
  approve_safe_topics: 2,
  publish_passing_news: 3,
  release_held_posts: 2,
  funnel_watchdog: 8,
}

export const DECISIONS_KEY = 'auto_decisions'
export const MAX_DECISIONS = 100
export const VETO_KEY = 'auto_vetoes'
const MAX_VETOES = 300

export const policyKey = (p: PolicyName): string => `auto_policy_${p}`

export type UndoKind = 'requeue-post' | 'topic-pending' | 'unpublish-news' | 'rehold-post' | 'unpause-network' | 'topic-withdraw' | 'revert-edit' | 'topic-restore'

export interface AutoDecision {
  /** ISO time the decision was made. */
  at: string
  policy: PolicyName
  /** What it was about: a post slug, a topic keyword, a network, a funnel stage. */
  subject: string
  /** What was done, in plain words. */
  action: string
  /** Why it was allowed (or why it was refused), in plain words. */
  reason: string
  /** How to take it back, or null when it cannot be (or nothing changed). */
  undo: { kind: UndoKind; ref: string } | null
  /** Set when a person used Undo. */
  undone_at?: string
}

const UNDO_KINDS: readonly UndoKind[] = ['requeue-post', 'topic-pending', 'unpublish-news', 'rehold-post', 'unpause-network', 'topic-withdraw', 'revert-edit', 'topic-restore']

// ---------------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------------

/** True unless the switch is exactly 'off'. Unset, empty, 'on', 'OFF' and everything else leave the policy on. Pure. */
export const policyEnabled = (raw: string | null | undefined): boolean => raw !== 'off'

export function isPolicyName(v: unknown): v is PolicyName {
  return typeof v === 'string' && ((ALL_POLICIES as readonly string[]).includes(v) || (SEO_POLICIES as readonly string[]).includes(v) || v === 'system_check_ai' || v === 'evergreen_reshare' || v === 'topic_meaning')
}

/** Reads the stored log. Corrupt or the wrong shape reads as empty; single bad entries are dropped. Pure. */
export function parseDecisions(raw: string | null | undefined): AutoDecision[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw) as unknown
    if (!Array.isArray(v)) return []
    const out: AutoDecision[] = []
    for (const e of v as Partial<AutoDecision>[]) {
      if (!e || typeof e !== 'object') continue
      if (typeof e.at !== 'string' || !Number.isFinite(Date.parse(e.at)) || !isPolicyName(e.policy) || typeof e.subject !== 'string' || typeof e.action !== 'string' || typeof e.reason !== 'string') continue
      const u = e.undo
      const undo = u && typeof u === 'object' && UNDO_KINDS.includes((u as { kind: UndoKind }).kind) && typeof (u as { ref: unknown }).ref === 'string' ? { kind: (u as { kind: UndoKind }).kind, ref: (u as { ref: string }).ref } : null
      out.push({ at: e.at, policy: e.policy, subject: e.subject, action: e.action, reason: e.reason, undo, ...(typeof e.undone_at === 'string' ? { undone_at: e.undone_at } : {}) })
    }
    return out
  } catch {
    return []
  }
}

/** Keeps the newest `max` entries (the log is oldest first). Pure. */
export const boundDecisions = (list: AutoDecision[], max: number = MAX_DECISIONS): AutoDecision[] => (list.length > max ? list.slice(list.length - max) : list)

export const utcDay = (now: Date): string => now.toISOString().slice(0, 10)

/** How many logged actions a policy has taken on the UTC day of `now`. Refusals (undo null and a "refused" action) are not counted. Pure. */
export function actionsToday(log: AutoDecision[], policy: PolicyName, now: Date): number {
  const day = utcDay(now)
  return log.filter((e) => e.policy === policy && e.at.slice(0, 10) === day && !e.action.startsWith('Refused') && !e.action.startsWith('Needs')).length
}

export interface GateInput {
  /** automation_paused: true, false, or null when it could not be read. */
  paused: boolean | null
  /** The raw auto_policy_<name> value, or undefined when it could not be read. */
  toggle: string | null | undefined
  usedToday: number
  cap: number
}

export interface GateResult {
  allowed: boolean
  /** How many more actions are allowed today. */
  room: number
  reason: string
}

/** The one question every policy asks first: may I act right now? Pure. */
export function gateDecision(i: GateInput): GateResult {
  if (i.paused === null) return { allowed: false, room: 0, reason: 'could not read the Pause all automation switch, so nothing was done' }
  if (i.paused) return { allowed: false, room: 0, reason: 'automation is paused (Pause all automation is on)' }
  if (i.toggle === undefined) return { allowed: false, room: 0, reason: 'could not read this policy\'s switch, so nothing was done' }
  if (!policyEnabled(i.toggle)) return { allowed: false, room: 0, reason: 'this automatic decision is switched off' }
  const room = Math.max(0, i.cap - i.usedToday)
  if (room <= 0) return { allowed: false, room: 0, reason: `today's limit of ${i.cap} is used up` }
  return { allowed: true, room, reason: 'allowed' }
}

const vetoKey = (policy: PolicyName, subject: string) => `${policy}|${subject}`

/** Reads the veto list. Corrupt reads as empty. Pure. */
export function parseVetoes(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw) as unknown
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(-MAX_VETOES) : []
  } catch {
    return []
  }
}

export const isVetoedIn = (vetoes: readonly string[], policy: PolicyName, subject: string): boolean => vetoes.includes(vetoKey(policy, subject))

// ---------------------------------------------------------------------------------------------------
// Reading and writing (fail open for the log, fail closed for acting)
// ---------------------------------------------------------------------------------------------------

export async function readDecisions(admin: SupabaseClient): Promise<AutoDecision[]> {
  try {
    return parseDecisions(await getSetting(admin, DECISIONS_KEY))
  } catch {
    return []
  }
}

/** Adds entries to the end of the log, keeping the newest 100. Never throws; a log that cannot be written is only a missing line. */
export async function appendDecisions(admin: SupabaseClient, entries: AutoDecision[]): Promise<void> {
  if (!entries.length) return
  // Dry run (lib/dry-run.ts): a decision is never logged, because none was taken.
  if (blockIfDry('apply-decision', entries.map((e) => `${e.policy}: ${e.subject}`).join('; '))) return
  try {
    const all = boundDecisions([...(await readDecisions(admin)), ...entries])
    await setSetting(admin, DECISIONS_KEY, JSON.stringify(all))
  } catch {
    // the action itself already happened; only its line is missing
  }
}

export async function readVetoes(admin: SupabaseClient): Promise<string[]> {
  try {
    return parseVetoes(await getSetting(admin, VETO_KEY))
  } catch {
    return []
  }
}

export async function addVeto(admin: SupabaseClient, policy: PolicyName, subject: string): Promise<void> {
  try {
    const list = await readVetoes(admin)
    if (list.includes(vetoKey(policy, subject))) return
    await setSetting(admin, VETO_KEY, JSON.stringify([...list, vetoKey(policy, subject)].slice(-MAX_VETOES)))
  } catch {
    // a missing veto only means the policy could look at the subject again
  }
}

/** Reads the kill switch, the policy's own switch and today's count, and answers "may I act, and how many times". Never throws. */
export async function policyGate(admin: SupabaseClient, policy: PolicyName, now: Date = new Date()): Promise<GateResult> {
  try {
    const [paused, toggle, log] = await Promise.all([getSettingStrict(admin, AUTOMATION_PAUSED_KEY), getSettingStrict(admin, policyKey(policy)), readDecisions(admin)])
    return gateDecision({
      paused: paused.error ? null : paused.value === 'true',
      toggle: toggle.error ? undefined : toggle.value,
      usedToday: actionsToday(log, policy, now),
      cap: POLICY_CAPS[policy],
    })
  } catch {
    return { allowed: false, room: 0, reason: 'could not check the switches, so nothing was done' }
  }
}

/** The on/off state of every policy, for the card. A value that cannot be read is reported as on (the default) with ok false. */
export async function readPolicySwitches(admin: SupabaseClient): Promise<{ policy: PolicyName; label: string; on: boolean; readable: boolean }[]> {
  const out: { policy: PolicyName; label: string; on: boolean; readable: boolean }[] = []
  for (const policy of ALL_POLICIES) {
    try {
      const r = await getSettingStrict(admin, policyKey(policy))
      out.push({ policy, label: POLICY_LABELS[policy], on: r.error ? true : policyEnabled(r.value), readable: !r.error })
    } catch {
      out.push({ policy, label: POLICY_LABELS[policy], on: true, readable: false })
    }
  }
  return out
}

export async function setPolicySwitch(admin: SupabaseClient, policy: PolicyName, on: boolean): Promise<{ error?: string }> {
  return setSetting(admin, policyKey(policy), on ? 'on' : 'off')
}

// ---------------------------------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------------------------------

export interface UndoResult {
  ok: boolean
  message: string
}

const MANUAL_HOLD_NOTE = 'Held by a person (an automatic release was undone). It stays held until you approve it.'

/** Takes one automatic decision back. Only reversible entries (undo is not null) can be undone, and only once. The subject is added to
 * the veto list first of all, so the policy never does the same thing to it again. Never throws. */
export async function undoAutoDecision(admin: SupabaseClient, entry: AutoDecision): Promise<UndoResult> {
  try {
    if (!entry.undo) return { ok: false, message: 'This decision cannot be undone.' }
    const log = await readDecisions(admin)
    const stored = log.find((e) => e.at === entry.at && e.policy === entry.policy && e.subject === entry.subject)
    if (!stored) return { ok: false, message: 'That decision is no longer in the log.' }
    if (stored.undone_at) return { ok: false, message: 'That decision was already undone.' }
    const undo = stored.undo
    if (!undo) return { ok: false, message: 'This decision cannot be undone.' }

    const done = await applyUndo(admin, undo)
    if (!done.ok) return done
    await addVeto(admin, stored.policy, stored.subject)
    stored.undone_at = new Date().toISOString()
    try {
      await setSetting(admin, DECISIONS_KEY, JSON.stringify(boundDecisions(log)))
    } catch {
      // the undo itself worked
    }
    return done
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'The undo failed.' }
  }
}

async function applyUndo(admin: SupabaseClient, undo: { kind: UndoKind; ref: string }): Promise<UndoResult> {
  const now = new Date().toISOString()
  if (undo.kind === 'requeue-post') {
    const { data, error } = await admin.from('post_distribution').select('stage, sent_platforms').eq('content_type', 'post').eq('slug', undo.ref).maybeSingle()
    if (error) return { ok: false, message: `Could not read the post (${error.message}).` }
    const row = data as { stage: string; sent_platforms: string[] | null } | null
    if (!row) return { ok: false, message: 'That post is no longer in the posting list.' }
    if (row.stage !== 'queued') return { ok: false, message: `It is already ${row.stage}, so there is nothing to put back.` }
    if ((row.sent_platforms ?? []).length > 0) return { ok: false, message: 'It has already reached a network, so it was left alone.' }
    const { error: e2 } = await admin.from('post_distribution').update({ stage: 'failed', last_error: 'Put back to failed by a person (an automatic retry was undone). It will not be retried again by itself.', updated_at: now }).eq('content_type', 'post').eq('slug', undo.ref).eq('stage', 'queued')
    return e2 ? { ok: false, message: e2.message } : { ok: true, message: 'The post is back to failed and will not be retried by itself again.' }
  }
  if (undo.kind === 'topic-pending') {
    const { data, error } = await admin.from('blog_topic_queue').select('status, used_slug').eq('id', undo.ref).maybeSingle()
    if (error) return { ok: false, message: `Could not read the topic (${error.message}).` }
    const row = data as { status: string; used_slug: string | null } | null
    if (!row) return { ok: false, message: 'That topic no longer exists.' }
    if (row.status !== 'approved' || row.used_slug) return { ok: false, message: row.used_slug ? 'A post was already written from this topic.' : `It is already ${row.status}.` }
    const { error: e2 } = await admin.from('blog_topic_queue').update({ status: 'suggested', scheduled_for: null }).eq('id', undo.ref).eq('status', 'approved')
    return e2 ? { ok: false, message: e2.message } : { ok: true, message: 'The topic is back in the list for you to decide.' }
  }
  if (undo.kind === 'topic-restore') {
    // A topic the same-meaning check skipped: ref is "<queue row id>|<status it had>". The caller adds a veto, so it is not skipped again.
    const [id, back] = undo.ref.split('|')
    const status = back === 'approved' ? 'approved' : 'suggested'
    const { data, error } = await admin.from('blog_topic_queue').select('status, used_slug').eq('id', id).maybeSingle()
    if (error) return { ok: false, message: `Could not read the topic (${error.message}).` }
    const row = data as { status: string; used_slug: string | null } | null
    if (!row) return { ok: false, message: 'That topic no longer exists.' }
    if (row.used_slug || row.status === 'used') return { ok: false, message: 'A post was already written from this topic.' }
    if (row.status !== 'rejected') return { ok: false, message: `It is already ${row.status}.` }
    const { error: e2 } = await admin.from('blog_topic_queue').update({ status, scheduled_for: null }).eq('id', id).eq('status', 'rejected')
    return e2 ? { ok: false, message: e2.message } : { ok: true, message: `The topic is back as ${status} and will not be skipped as a duplicate again.` }
  }
  if (undo.kind === 'topic-withdraw') {
    // A topic the SEO engines suggested: withdrawing it turns it down for good (a rejected keyword is never queued again).
    const { data, error } = await admin.from('blog_topic_queue').select('status, used_slug').eq('id', undo.ref).maybeSingle()
    if (error) return { ok: false, message: `Could not read the topic (${error.message}).` }
    const row = data as { status: string; used_slug: string | null } | null
    if (!row) return { ok: false, message: 'That topic no longer exists.' }
    if (row.used_slug || row.status === 'used') return { ok: false, message: 'A post was already written from this topic.' }
    if (row.status === 'rejected') return { ok: true, message: 'The topic was already turned down.' }
    const { error: e2 } = await admin.from('blog_topic_queue').update({ status: 'rejected', scheduled_for: null }).eq('id', undo.ref).in('status', ['suggested', 'approved'])
    return e2 ? { ok: false, message: e2.message } : { ok: true, message: 'The topic is turned down and will not be suggested again.' }
  }
  if (undo.kind === 'revert-edit') {
    // An internal link the SEO engines added: the audit log (content_edits) puts the page text back as it was.
    const r = await revertEdit(admin, undo.ref)
    return r.ok ? { ok: true, message: 'The link is taken out and the page text is back as it was.' } : { ok: false, message: r.error ?? 'The page text could not be put back.' }
  }
  if (undo.kind === 'unpublish-news') {
    const { data, error } = await admin.from('content_edits').select('id').eq('path', `/blog/${undo.ref}`).eq('field', 'status').eq('after', 'published').is('reverted_at', null).order('created_at', { ascending: false }).limit(1)
    if (error) return { ok: false, message: `Could not find the publish record (${error.message}).` }
    const edit = ((data ?? []) as { id: string }[])[0]
    if (!edit) return { ok: false, message: 'No publish record was found for this brief, so it was not unpublished. Use the Blog page to unpublish it.' }
    const r = await revertEdit(admin, edit.id, { force: true })
    if (!r.ok) return { ok: false, message: r.error ?? 'The brief could not be unpublished.' }
    // The brief must not be published again by the news step: mark its feed item as turned down by a person.
    await admin.from('news_items').update({ status: 'rejected', reject_reason: 'unpublished by a person (an automatic publish was undone)', decided_at: now }).eq('post_slug', undo.ref)
    return { ok: true, message: 'The brief is a draft again and will not be published by itself.' }
  }
  if (undo.kind === 'unpause-network') {
    const pauses = await readPauses(admin)
    if (!pauses) return { ok: false, message: 'Could not read the pauses.' }
    if (!pauses[undo.ref]) return { ok: true, message: 'That network is not paused any more.' }
    delete pauses[undo.ref]
    const w = await writePauses(admin, pauses)
    return w.error ? { ok: false, message: w.error } : { ok: true, message: 'The network is posting again.' }
  }
  // rehold-post
  const { data, error } = await admin.from('post_distribution').select('stage, sent_platforms').eq('content_type', 'post').eq('slug', undo.ref).maybeSingle()
  if (error) return { ok: false, message: `Could not read the post (${error.message}).` }
  const row = data as { stage: string; sent_platforms: string[] | null } | null
  if (!row) return { ok: false, message: 'That post is no longer in the posting list.' }
  if (row.stage !== 'queued') return { ok: false, message: `It is already ${row.stage}, so it cannot be held again.` }
  if ((row.sent_platforms ?? []).length > 0) return { ok: false, message: 'It has already reached a network, so it was left alone.' }
  const { error: e3 } = await admin.from('post_distribution').update({ stage: 'held', last_error: MANUAL_HOLD_NOTE, updated_at: now }).eq('content_type', 'post').eq('slug', undo.ref).eq('stage', 'queued')
  return e3 ? { ok: false, message: e3.message } : { ok: true, message: 'The post is held again and stays held until you approve it.' }
}

/** Builds a log entry. */
export function decision(policy: PolicyName, subject: string, action: string, reason: string, undo: AutoDecision['undo'] = null, now: Date = new Date()): AutoDecision {
  return { at: now.toISOString(), policy, subject, action, reason, undo }
}
