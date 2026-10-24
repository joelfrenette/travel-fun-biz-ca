import type { SupabaseClient } from '@supabase/supabase-js'
import { getSetting, getSettingStrict, setSetting } from '@/lib/app-settings'
import { readGrowthDigest } from '@/lib/growth-digest-read'
import { readSeoFixCandidates } from '@/lib/seo-playbook-todo'
import { buildLinksView } from '@/lib/links-building-data'
import { levelRank } from '@/lib/link-building'
import { recapsDue } from '@/lib/recap-store'
import { TODAY_LEADS_DONE_KEY, parseIdList } from '@/lib/today-state'
import {
  FOLLOWUPS_DONE_KEY, FOLLOWUPS_LIST_KEY, allCandidates, applyMark, listIsFresh, openCountFrom, parseDone, parseList, selectFollowups, serializeDone, serializeList, siteDay,
  type DoneState, type FollowItem, type FollowSources, type LeadFact, type LinkTaskFact, type Selection, type StoredList,
} from '@/lib/followups'

// Reads what the daily follow-ups are built from, builds today's list, and keeps the ticks. Read only apart from saving its own two
// settings (followups_list, the day's built list, and followups_done, the ticks). Every source is read on its own: one that fails is
// named in `problems` and leaves the rest of the list alone. No AI call and nothing posted.

async function safe<T>(fn: () => Promise<T>, problems: string[], name: string): Promise<T | null> {
  try {
    return await fn()
  } catch (e) {
    problems.push(`${name} could not be read (${e instanceof Error ? e.message : 'unknown error'}).`)
    return null
  }
}

async function readLeads(admin: SupabaseClient, now: Date): Promise<LeadFact[]> {
  const since = new Date(now.getTime() - 16 * 86_400_000).toISOString()
  const { data, error } = await admin.from('leads').select('id, name, email, phone, package, created_at').eq('is_test', false).gte('created_at', since).order('created_at', { ascending: false }).limit(80)
  if (error) throw new Error(error.message)
  return ((data ?? []) as { id: string; name: string | null; email: string | null; phone: string | null; package: string | null; created_at: string }[])
    // Newsletter signups and next-trip alerts are not people waiting for a reply.
    .filter((l) => !/^newsletter signup$/i.test(l.package ?? '') && !/^trip alert:/i.test(l.package ?? ''))
    .map((l) => ({ id: l.id, name: l.name ?? '', email: l.email ?? '', phone: l.phone ?? '', createdAt: l.created_at }))
}

async function readLinkTasks(admin: SupabaseClient): Promise<LinkTaskFact[]> {
  const view = await buildLinksView(admin)
  return view.groups
    .flatMap((g) => g.tasks)
    .filter((t) => t.status === 'todo' && !t.ideaOnly && (!t.askHolds || t.holds === true))
    .sort((a, b) => levelRank(b.value) - levelRank(a.value) || levelRank(a.effort) - levelRank(b.effort) || (a.id < b.id ? -1 : 1))
    .map((t) => ({ id: t.id, title: t.title, how: t.how, effort: t.effort }))
}

/** Reads every source and returns today's candidates (before the cap). Never throws. */
export async function gatherCandidates(admin: SupabaseClient, done: DoneState, now: Date): Promise<{ items: FollowItem[]; problems: string[] }> {
  const problems: string[] = []
  const [digest, seo, leads, replied, linkTasks, recaps] = await Promise.all([
    safe(() => readGrowthDigest(admin, now), problems, 'The growth tips'),
    safe(() => readSeoFixCandidates(admin, 3), problems, 'The SEO fixes'),
    safe(() => readLeads(admin, now), problems, 'The leads'),
    safe(async () => parseIdList(await getSetting(admin, TODAY_LEADS_DONE_KEY)), problems, 'The answered leads'),
    safe(() => readLinkTasks(admin), problems, 'The link building tasks'),
    safe(() => recapsDue(admin, now), problems, 'The past trips'),
  ])
  const sources: FollowSources = {
    now,
    digestActions: digest ? digest.actions : null,
    seoFixes: seo,
    leads,
    // If the answered list could not be read, leads are left out rather than risk chasing someone who was answered.
    repliedLeadIds: replied ?? [],
    linkTasks,
    recaps: recaps ? recaps.map((r) => ({ id: r.id, name: r.name, href: r.href })) : null,
    done,
  }
  const items = allCandidates(sources)
  return { items: replied === null ? items.filter((i) => i.group !== 'lead') : items, problems }
}

export async function readDone(admin: SupabaseClient): Promise<{ done: DoneState; readable: boolean }> {
  const r = await getSettingStrict(admin, FOLLOWUPS_DONE_KEY)
  return r.error ? { done: {}, readable: false } : { done: parseDone(r.value), readable: true }
}

async function readList(admin: SupabaseClient): Promise<StoredList | null> {
  try {
    return parseList(await getSetting(admin, FOLLOWUPS_LIST_KEY))
  } catch {
    return null
  }
}

export interface LoadedFollowups extends Selection {
  generatedAt: string
  problems: string[]
  /** False when the ticks could not be read (every item then shows as open and a tick will not be trusted). */
  ticksReadable: boolean
}

/** Today's list. A list built in the last 10 minutes is reused; `force` builds it again. Never throws. */
export async function loadFollowups(admin: SupabaseClient, opts: { now?: Date; force?: boolean } = {}): Promise<LoadedFollowups> {
  const now = opts.now ?? new Date()
  const { done, readable } = await readDone(admin)
  const stored = await readList(admin)
  let items: FollowItem[]
  let generatedAt: string
  let problems: string[] = []
  if (!opts.force && listIsFresh(stored, now) && stored) {
    items = stored.items
    generatedAt = stored.at
  } else {
    const g = await gatherCandidates(admin, done, now)
    items = g.items
    problems = g.problems
    generatedAt = now.toISOString()
    // Always saved: a tick is only accepted for a task on the saved list. A source that failed is named in `problems`.
    await setSetting(admin, FOLLOWUPS_LIST_KEY, serializeList(siteDay(now), now, items)).catch(() => undefined)
  }
  return { ...selectFollowups(items, done, now), generatedAt, problems, ticksReadable: readable }
}

/** For the menu badge: the open count from the list built today, or null when none has been built yet today. Two settings reads. */
export async function readFollowupsCount(admin: SupabaseClient, now: Date = new Date()): Promise<{ open: number; total: number } | null> {
  try {
    const [{ done }, list] = await Promise.all([readDone(admin), readList(admin)])
    return openCountFrom(list, done, now)
  } catch {
    return null
  }
}

export type TickResult = { ok: true; selection: LoadedFollowups } | { ok: false; status: number; error: string }

/** Applies one tick to an item that is on today's list. An id that is not on the list is refused, so the stored ticks can only hold real tasks. */
export async function tickFollowup(admin: SupabaseClient, id: string, op: 'done' | 'later' | 'reopen', now: Date = new Date()): Promise<TickResult> {
  const { done, readable } = await readDone(admin)
  if (!readable) return { ok: false, status: 503, error: 'The saved ticks could not be read, so nothing was changed. Please try again.' }
  const list = await readList(admin)
  const known = list?.items.find((i) => i.id === id)
  if (!known) return { ok: false, status: 404, error: 'That task is not on today\'s list any more. Reload the list.' }
  const next = applyMark(done, siteDay(now), known, op)
  const saved = await setSetting(admin, FOLLOWUPS_DONE_KEY, serializeDone(next))
  if (saved.error) return { ok: false, status: 500, error: `The tick could not be saved (${saved.error}).` }
  return { ok: true, selection: await loadFollowups(admin, { now }) }
}
