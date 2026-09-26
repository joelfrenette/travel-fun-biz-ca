import type { SupabaseClient } from '@supabase/supabase-js'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { setSetting } from '@/lib/app-settings'

// getSupabaseAdmin() throws when SUPABASE_SERVICE_ROLE_KEY is unset (unlike Nomad's
// createAdminClient(), which returns null) — this project's convention everywhere else. A
// heartbeat write must never itself become the error that breaks a cron, so it's called only
// inside the try/catch below, never by the caller.

// Ported from Nomad Escape Plan (Factory Phase 1: foundation). CRON_NAMES is trimmed to the 11
// crons this program's own spec calls for (GAP-REPORT.md §7) — Nomad's country-fact-checking
// jobs (refresh, import-jobs, check-links, fetch-photos) aren't part of a travel site's engine.
// No route calls this yet: it's the shared plumbing every cron added in a later phase wires up to.
/**
 * CRON HEARTBEATS — proof that a scheduled job actually ran.
 *
 * A cron that never fires (a bad deploy, a missing secret, a schedule dropped from vercel.json)
 * looks exactly like one that ran and had nothing to do. So each cron writes when it last ran
 * into app_settings, as `cron_last_run:<name>` = {"at", "ok", "note"}, and a later phase's
 * engine-health check turns amber when one goes quiet.
 *
 * A heartbeat is a side note: writing one never throws and never fails the cron.
 */
export const CRON_NAMES = [
  'autoblog',
  'distribute',
  'post-health',
  'email-engagement',
  'weekly-digest',
  'social-library',
  'nurture',
  'gsc-snapshot',
  'indexnow',
  'community',
  'shotstack-cleanup',
] as const
export type CronName = (typeof CRON_NAMES)[number]

export interface CronRun {
  at: string
  /** False when the run hit an error it reported, or threw. */
  ok: boolean
  note?: string
}

const PREFIX = 'cron_last_run:'
export const cronRunKey = (name: CronName) => `${PREFIX}${name}`

/** Record that `name` ran just now. */
export async function recordCronRun(name: CronName, run: { ok: boolean; note?: string }): Promise<void> {
  try {
    const value: CronRun = { at: new Date().toISOString(), ok: run.ok, ...(run.note ? { note: run.note.slice(0, 300) } : {}) }
    await setSetting(getSupabaseAdmin(), cronRunKey(name), JSON.stringify(value))
  } catch {
    // A missed heartbeat shows up as a stale light later — never as a failed cron.
  }
}

/**
 * Wrap a cron route's handler so every authorised run leaves a heartbeat. Unauthorised calls
 * (401) and unconfigured servers (503) record nothing, so a stranger hitting the URL can't fake
 * a "ran" signal. A 5xx answer or a throw is recorded as a run that reported a problem (the
 * throw is re-thrown so the platform still sees the failure).
 */
export function withCronHeartbeat(name: CronName, handler: (request: Request) => Promise<Response>): (request: Request) => Promise<Response> {
  return async (request) => {
    let res: Response
    try {
      res = await handler(request)
    } catch (e) {
      await recordCronRun(name, { ok: false, note: e instanceof Error ? e.message : 'unknown error' })
      throw e
    }
    if (res.status !== 401 && res.status !== 503) {
      await recordCronRun(name, { ok: res.status < 500 })
    }
    return res
  }
}

export function parseCronRun(raw: string | null | undefined): CronRun | null {
  try {
    const v = JSON.parse(raw ?? '') as Partial<CronRun> | null
    if (!v || typeof v.at !== 'string' || Number.isNaN(Date.parse(v.at))) return null
    return { at: v.at, ok: v.ok !== false, ...(typeof v.note === 'string' && v.note ? { note: v.note } : {}) }
  } catch {
    return null
  }
}

/** The last run of every cron that has ever written one. A cron missing here has never run since deploy. */
export async function readCronRuns(supabase: SupabaseClient): Promise<Partial<Record<CronName, CronRun>>> {
  const { data } = await supabase.from('app_settings').select('key, value').in('key', CRON_NAMES.map(cronRunKey))
  const out: Partial<Record<CronName, CronRun>> = {}
  for (const row of (data ?? []) as { key: string; value: string | null }[]) {
    const run = parseCronRun(row.value)
    if (run) out[row.key.slice(PREFIX.length) as CronName] = run
  }
  return out
}
