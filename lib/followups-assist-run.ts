import type { SupabaseClient } from '@supabase/supabase-js'
import { getSetting, setSetting } from '@/lib/app-settings'
import { anthropicText, callAnthropic, isAiConfigured } from '@/lib/ai-verify'
import { buildLinksView } from '@/lib/links-building-data'
import { loadView } from '@/lib/seo-playbook-view'
import { runSeoPlaybookAudit } from '@/lib/seo-playbook-audit'
import { site } from '@/lib/site'
import { siteDay, slug, type FollowItem } from '@/lib/followups'
import {
  ASSIST_KEY, ASSIST_REGISTRY, NO_DASH, aiRoomLeft, assistKindFor, digestPostPrompt, digestPostTemplate, leadReplyPrompt, leadReplyTemplate, parseStore, recapAskPrompt, recapAskTemplate, serializeStore,
  type AssistKind, type AssistResult, type AssistStore,
} from '@/lib/followups-actions'

// Runs the safe "Do this for me" action for one follow-up task. Admin-triggered only (the route checks isAuthorized first). Drafts
// text into a box and re-reads the SEO audit; it NEVER sends or posts anything. The answer is cached for the day per task (so a
// second press costs nothing), and the AI is called at most AI_CALLS_PER_DAY times a day. When the AI is off, capped or fails, a
// fixed template is used and the result says so. Never throws.

export type AssistOutcome = { ok: true; result: AssistResult; cached: boolean } | { ok: false; status: number; error: string }

export interface AssistDeps {
  now?: Date
  /** Test seam: replaces the AI call (returns the text, or null when it failed). */
  ai?: (prompt: string) => Promise<string | null>
  aiConfigured?: boolean
}

async function realAi(prompt: string): Promise<string | null> {
  try {
    const r = await callAnthropic({ max_tokens: 700, messages: [{ role: 'user', content: prompt }] }, { feature: 'followup-assist', timeoutMs: 25_000 })
    if (!r || !r.res.ok) return null
    const text = anthropicText(await r.res.json())
    return text || null
  } catch {
    return null
  }
}

async function readStore(admin: SupabaseClient, day: string): Promise<AssistStore> {
  try {
    return parseStore(await getSetting(admin, ASSIST_KEY), day)
  } catch {
    return parseStore(null, day)
  }
}

const agency = { name: site.name, phone: site.phone }

/** Asks the AI when there is room, else falls back to the template. Returns the text, where it came from, and why a template was used. */
async function draft(store: AssistStore, prompt: string, template: string, deps: AssistDeps): Promise<{ text: string; source: 'ai' | 'template'; note?: string }> {
  const configured = deps.aiConfigured ?? isAiConfigured()
  if (!configured) return { text: template, source: 'template', note: 'The AI is not connected, so this is a fixed template.' }
  if (aiRoomLeft(store) <= 0) return { text: template, source: 'template', note: 'Today\'s AI limit for drafts is used, so this is a fixed template.' }
  store.aiCalls++
  const text = await (deps.ai ?? realAi)(prompt)
  if (!text) return { text: template, source: 'template', note: 'The AI did not answer, so this is a fixed template.' }
  return { text: NO_DASH(text), source: 'ai' }
}

async function leadRow(admin: SupabaseClient, id: string) {
  const { data, error } = await admin.from('leads').select('name, package, message, travel_date, travelers').eq('id', id).maybeSingle()
  if (error || !data) return null
  const r = data as { name: string | null; package: string | null; message: string | null; travel_date: string | null; travelers: string | null }
  return { name: r.name ?? '', package: r.package, message: r.message, travelDate: r.travel_date, travelers: r.travelers }
}

async function perform(admin: SupabaseClient, item: FollowItem, kind: AssistKind, store: AssistStore, deps: AssistDeps, now: Date): Promise<Omit<AssistResult, 'at' | 'kind' | 'title'> | { error: string; status: number }> {
  if (kind === 'lead-reply') {
    const m = /^lead:([0-9a-f-]{8,40}):/i.exec(item.id)
    const lead = m ? await leadRow(admin, m[1]) : null
    if (!lead) return { error: 'That lead could not be read, so nothing was drafted.', status: 404 }
    const d = await draft(store, leadReplyPrompt(lead, agency), leadReplyTemplate(lead, agency), deps)
    return { blocks: [{ label: 'Reply', text: d.text }], source: d.source, ...(d.note ? { note: d.note } : {}) }
  }
  if (kind === 'recap-ask') {
    const name = item.title.replace(/^Write the recap for\s+/i, '').trim() || 'your trip'
    const d = await draft(store, recapAskPrompt(name, agency), recapAskTemplate(name, agency), deps)
    return { blocks: [{ label: 'Message', text: d.text }], source: d.source, ...(d.note ? { note: d.note } : {}) }
  }
  if (kind === 'digest-post') {
    const d = await draft(store, digestPostPrompt(item.title, agency), digestPostTemplate(item.title, agency), deps)
    return { blocks: [{ label: 'Post', text: d.text }], source: d.source, ...(d.note ? { note: d.note } : {}) }
  }
  if (kind === 'link-draft') {
    const key = item.id.replace(/^links:/, '')
    const view = await buildLinksView(admin)
    const task = view.groups.flatMap((g) => g.tasks).find((t) => slug(t.id) === key)
    if (!task) return { error: 'That link building task is not on the list any more.', status: 404 }
    const blocks = task.drafts.map((x) => ({ label: x.label, text: x.text }))
    if (!blocks.length) return { blocks: [{ label: 'How to do it', text: task.how }], source: 'template', note: 'This task has no ready draft, so here is how to do it.' }
    return { blocks: blocks.slice(0, 5), source: 'template', note: 'Filled in from our name, address and phone. Nothing was sent.' }
  }
  // seo-recheck: run the audit again (read only), then read the item's status.
  const key = item.id.replace(/^seo:/, '')
  const sanitize = (id: string) => id.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 100)
  const run = await runSeoPlaybookAudit(admin, { now, deadlineMs: Date.now() + 20_000 })
  const view = await loadView(admin)
  const found = view.items.find((i) => sanitize(i.id) === key)
  if (!found) return { error: 'That SEO item is not in the checklist any more.', status: 404 }
  const status = found.status === 'pass' ? 'now passes' : found.status === 'fail' ? 'still fails' : found.status === 'warn' ? 'now only warns' : `is ${found.status}`
  const lines = [`${found.title} ${status}.`, found.evidence ? `What the audit saw: ${found.evidence}` : '', found.status === 'pass' ? '' : found.fixHint ? `How to fix it: ${found.fixHint}` : found.how[0] ? `How to fix it: ${found.how[0]}` : '', run.ok ? '' : `The audit note: ${run.note}`].filter(Boolean)
  return { blocks: [{ label: 'Result', text: lines.join('\n') }], source: 'audit', note: found.status === 'pass' ? 'Tick Done: it is fixed.' : 'The site was not changed. Use Open to go to the fix.' }
}

/** Runs the action for a task. `item` must come from today's saved list (the route checks). `force` skips the day's cached answer. */
export async function runAssist(admin: SupabaseClient, item: FollowItem, opts: { force?: boolean } = {}, deps: AssistDeps = {}): Promise<AssistOutcome> {
  const now = deps.now ?? new Date()
  try {
    const kind = assistKindFor(item)
    if (!kind) return { ok: false, status: 400, error: 'There is no safe action for this task. Use Copy for Claude.' }
    const day = siteDay(now)
    const store = await readStore(admin, day)
    const hit = store.items[item.id]
    if (hit && !opts.force) return { ok: true, result: hit, cached: true }
    const out = await perform(admin, item, kind, store, deps, now)
    if ('error' in out) return { ok: false, status: out.status, error: out.error }
    const result: AssistResult = { kind, title: ASSIST_REGISTRY[kind].resultTitle, at: now.toISOString(), ...out }
    store.items[item.id] = result
    await setSetting(admin, ASSIST_KEY, serializeStore(store)).catch(() => undefined)
    return { ok: true, result, cached: false }
  } catch (e) {
    return { ok: false, status: 500, error: e instanceof Error ? e.message : 'That did not work.' }
  }
}
