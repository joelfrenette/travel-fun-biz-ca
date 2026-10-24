import type { SupabaseClient } from '@supabase/supabase-js'
import { getSetting, setSetting } from '@/lib/app-settings'
import { DRY_INTENTS_MAX, DRY_DETAIL_MAX, DRY_RUN_KEY, DRY_RUN_SINCE_KEY, DRY_RUN_LOG_KEY, appendDryPass, isDryRunOn, parseDryLog, type DryIntent, type DryPass, type EffectKind } from '@/lib/dry-run-shape'

// DRY RUN: the one gate every outside effect of the autopilot goes through.
//
// How it works. While the switch (app_settings autopilot_dry_run) is on, lib/pipeline.ts runs lib/dry-run-plan.ts inside
// `withDryRun()` instead of the real steps. The plan only READS, and says what each step would do by calling the typed `Effects`
// below. In dry mode every Effects method records an "intent" and returns; the real function behind it is never called.
//
// Defence in depth. The real choke points (send an alert email, post to social, write a post, change a topic, log an automatic
// decision, log a repair, move the publish counter) also call `blockIfDry()`. It only does anything inside `withDryRun()`
// (an AsyncLocalStorage flag), so a normal request, an admin click or the cron running at the same moment is never affected, and
// if some future code path reaches one of them during a dry pass, it records an intent and does nothing.
//
// Not covered by the gate: reads, and the dry run's own bookkeeping (the 5-pass log and the cron heartbeat).

interface DryContext {
  intents: DryIntent[]
  step: string
}

// AsyncLocalStorage is loaded at run time, never imported: several client components reach this file through lib/publish-cadence.ts
// (pure helpers), and webpack cannot bundle node:async_hooks for the browser. In a browser the store is null, every helper is inert,
// and nothing there can ever be a dry run. On the server the real store is used.
interface Store<T> {
  getStore(): T | undefined
  run<R>(store: T, fn: () => R): R
}
function makeStore<T>(): Store<T> | null {
  try {
    const getBuiltin = (process as unknown as { getBuiltinModule?: (id: string) => { AsyncLocalStorage: new () => Store<T> } }).getBuiltinModule
    if (typeof getBuiltin === 'function') return new (getBuiltin('node:async_hooks').AsyncLocalStorage)()
  } catch {
    // fall through to require
  }
  try {
    // eslint-disable-next-line no-eval
    const req = eval('require') as (id: string) => { AsyncLocalStorage: new () => Store<T> }
    return new (req('node:async_hooks').AsyncLocalStorage)()
  } catch {
    return null
  }
}

const storage = makeStore<DryContext>()

/** True only inside `withDryRun`. Outside it every helper here does nothing. */
export function isDryRunActive(): boolean {
  return storage !== null && storage.getStore() !== undefined
}

/** Names the step now running, so intents say which step they belong to. No-op outside a dry run. */
export function setDryStep(step: string): void {
  const ctx = storage?.getStore()
  if (ctx) ctx.step = step
}

function push(ctx: DryContext, kind: EffectKind, detail: string): void {
  if (ctx.intents.length < DRY_INTENTS_MAX) ctx.intents.push({ kind, step: ctx.step, detail: detail.slice(0, DRY_DETAIL_MAX) })
}

/** The gate for a real choke point: inside a dry run, records what would have happened and returns true (the caller must then do nothing
 * and return a harmless result). Outside a dry run returns false and records nothing. */
export function blockIfDry(kind: EffectKind, detail: string): boolean {
  const ctx = storage?.getStore()
  if (!ctx) return false
  push(ctx, kind, detail)
  return true
}

/** Runs `fn` as a dry run and returns its result plus every intent recorded. */
export async function withDryRun<T>(fn: () => Promise<T>): Promise<{ result: T; intents: DryIntent[] }> {
  const ctx: DryContext = { intents: [], step: 'dry run' }
  // No store means a browser bundle, where a dry run can never happen: refuse rather than run un-gated.
  if (!storage) throw new Error('A dry run can only run on the server.')
  const result = await storage.run(ctx, fn)
  return { result, intents: ctx.intents }
}

// ---------------------------------------------------------------------------------------------------
// The typed effects
// ---------------------------------------------------------------------------------------------------

/** Everything the autopilot can do to the outside world, one method each. The rehearsal calls these; in dry mode none reaches the real thing. */
export interface Effects {
  publishPost(i: { slug: string; title: string; as: 'published' | 'draft' }): Promise<void>
  sendSocial(i: { network: string; what: string }): Promise<void>
  sendEmail(i: { subject: string }): Promise<void>
  applyHeal(i: { what: string }): Promise<void>
  applyDecision(i: { policy: string; subject: string }): Promise<void>
  setTopicStatus(i: { id: string; status: string }): Promise<void>
  advanceCounter(i: { key: string }): Promise<void>
  callAi(i: { purpose: string; estUsd?: number }): Promise<void>
}

type Describe = { [K in keyof Effects]: (i: Parameters<Effects[K]>[0]) => { kind: EffectKind; detail: string } }

const DESCRIBE: Describe = {
  publishPost: (i) => ({ kind: 'publish-post', detail: i.as === 'published' ? `Publish "${i.title}" (${i.slug})` : `Save "${i.title}" (${i.slug}) as a draft` }),
  sendSocial: (i) => ({ kind: 'social-post', detail: `Send to ${i.network}: ${i.what}` }),
  sendEmail: (i) => ({ kind: 'email', detail: `Email: ${i.subject}` }),
  applyHeal: (i) => ({ kind: 'heal-write', detail: i.what }),
  applyDecision: (i) => ({ kind: 'apply-decision', detail: `${i.policy}: ${i.subject}` }),
  setTopicStatus: (i) => ({ kind: 'topic-status', detail: `Topic ${i.id} would become ${i.status}` }),
  advanceCounter: (i) => ({ kind: 'counter', detail: `Would move ${i.key}` }),
  callAi: (i) => ({ kind: 'ai-call', detail: `Would call AI: ${i.purpose}` }),
}

/**
 * Wraps real effects in the gate. `dry()` is asked on EVERY call (not once), so flipping the switch mid-pass takes effect at once.
 * Dry: the intent goes to `record` and the real method is never invoked. Not dry: the call goes straight through, unchanged.
 */
export function guardEffects(real: Effects, dry: () => boolean, record: (i: { kind: EffectKind; detail: string }) => void): Effects {
  const wrap = <K extends keyof Effects>(name: K): Effects[K] =>
    (async (input: Parameters<Effects[K]>[0]) => {
      if (dry()) {
        record(DESCRIBE[name](input))
        return
      }
      await (real[name] as (i: Parameters<Effects[K]>[0]) => Promise<void>)(input)
    }) as Effects[K]
  return {
    publishPost: wrap('publishPost'),
    sendSocial: wrap('sendSocial'),
    sendEmail: wrap('sendEmail'),
    applyHeal: wrap('applyHeal'),
    applyDecision: wrap('applyDecision'),
    setTopicStatus: wrap('setTopicStatus'),
    advanceCounter: wrap('advanceCounter'),
    callAi: wrap('callAi'),
  }
}

/** The effects the rehearsal uses. There is no real implementation to call on purpose: the rehearsal never does anything for real. */
export function rehearsalEffects(): Effects {
  const never = async () => {
    throw new Error('A dry run must never reach a real effect.')
  }
  const real: Effects = { publishPost: never, sendSocial: never, sendEmail: never, applyHeal: never, applyDecision: never, setTopicStatus: never, advanceCounter: never, callAi: never }
  return guardEffects(real, () => true, (i) => {
    const ctx = storage?.getStore()
    if (ctx) push(ctx, i.kind, i.detail)
  })
}

// ---------------------------------------------------------------------------------------------------
// The switch and the log
// ---------------------------------------------------------------------------------------------------

/** Reads the switch. Fails SAFE: if it cannot be read, it counts as OFF (the autopilot behaves as it always did). */
export async function isDryRunSwitchOn(admin: SupabaseClient): Promise<boolean> {
  try {
    return isDryRunOn(await getSetting(admin, DRY_RUN_KEY))
  } catch {
    return false
  }
}

export async function readDryRunSince(admin: SupabaseClient): Promise<string | null> {
  try {
    return await getSetting(admin, DRY_RUN_SINCE_KEY)
  } catch {
    return null
  }
}

/** Turns the switch on or off. On records the start time (kept if it was already on); off clears it. */
export async function setDryRun(admin: SupabaseClient, on: boolean, now: Date = new Date()): Promise<{ error?: string }> {
  if (on) {
    const already = await isDryRunSwitchOn(admin)
    const since = already ? await readDryRunSince(admin) : null
    const res = await setSetting(admin, DRY_RUN_SINCE_KEY, since && Number.isFinite(Date.parse(since)) ? since : now.toISOString())
    if (res.error) return res
    return setSetting(admin, DRY_RUN_KEY, 'on')
  }
  const res = await setSetting(admin, DRY_RUN_KEY, 'off')
  if (res.error) return res
  return setSetting(admin, DRY_RUN_SINCE_KEY, '')
}

export async function readDryLog(admin: SupabaseClient): Promise<DryPass[]> {
  try {
    return parseDryLog(await getSetting(admin, DRY_RUN_LOG_KEY))
  } catch {
    return []
  }
}

/** Adds a pass to the log (newest 5 kept). This is the dry run's only write. */
export async function recordDryPass(admin: SupabaseClient, pass: DryPass): Promise<void> {
  const log = await readDryLog(admin)
  await setSetting(admin, DRY_RUN_LOG_KEY, JSON.stringify(appendDryPass(log, pass)))
}
