import type { SupabaseClient } from '@supabase/supabase-js'
import { getSetting, setSetting } from '@/lib/app-settings'
import { sendThrottledAlert } from '@/lib/alerts'

// AI spend tripwire. ALERT ONLY: it never blocks, slows or stops an AI call. The AI meter
// (lib/ai-meter.ts) writes an ESTIMATED cost per call to api_calls; once a day the existing
// gsc-snapshot cron adds up the last 24 hours and, if the total is above the ceiling, sends ONE
// email and shows a Needs attention item. Every function here fails quiet: a tripwire that throws
// would be worse than no tripwire.

/** app_settings key for the ceiling in US dollars. Blank or junk falls back to the default. */
export const AI_CEILING_KEY = 'ai_daily_ceiling_usd'
export const AI_CEILING_DEFAULT_USD = 5
/** The day (UTC, YYYY-MM-DD) an email already went out, so one noisy day sends one email. */
export const AI_ALERTED_DAY_KEY = 'ai_tripwire_alerted_day'
/** The Needs attention item id. Lives in lib/plain-steps.ts too (a client component imports that file). */
export { AI_SPEND_ISSUE_ID } from '@/lib/plain-steps'

/** Pure: the ceiling from the stored text. A positive number, else the default. */
export function parseCeiling(raw: string | null | undefined): number {
  const n = Number((raw ?? '').trim())
  return Number.isFinite(n) && n > 0 ? n : AI_CEILING_DEFAULT_USD
}

/** Pure: true only when spend is strictly above the ceiling. */
export function overCeiling(spendUsd: number, ceilingUsd: number): boolean {
  return Number.isFinite(spendUsd) && spendUsd > ceilingUsd
}

export const usd = (n: number) => `$${n.toFixed(2)}`

export interface SpendRead {
  /** Estimated dollars over the last 24 hours, or null when it could not be read (never shown as 0). */
  spend: number | null
  ceiling: number
}

/** Adds up the estimated cost of the last 24 hours. Never throws. */
export async function readAiSpend(admin: SupabaseClient, now: number = Date.now()): Promise<SpendRead> {
  let ceiling = AI_CEILING_DEFAULT_USD
  try {
    ceiling = parseCeiling(await getSetting(admin, AI_CEILING_KEY))
  } catch {
    // the default stands
  }
  try {
    const since = new Date(now - 24 * 3600_000).toISOString()
    let total = 0
    for (let from = 0; from < 20_000; from += 1000) {
      const { data, error } = await admin.from('api_calls').select('est_cost_usd').gte('ts', since).range(from, from + 999)
      if (error) return { spend: null, ceiling }
      const rows = (data ?? []) as { est_cost_usd: number | string | null }[]
      for (const r of rows) {
        const v = Number(r.est_cost_usd)
        if (Number.isFinite(v) && v > 0) total += v
      }
      if (rows.length < 1000) break
    }
    return { spend: Math.round(total * 100) / 100, ceiling }
  } catch {
    return { spend: null, ceiling }
  }
}

/** Pure: the alert wording. Plain words, no em dashes. */
export function buildAiAlert(spend: number, ceiling: number): { subject: string; lines: string[] } {
  return {
    subject: 'AI spending is above your daily limit',
    lines: [
      `The site used about ${usd(spend)} of AI in the last 24 hours. Your daily limit is ${usd(ceiling)}. This is an estimate, not the bill.`,
      'Nothing was stopped. This is only a heads up.',
      '',
      '1) Open the Anthropic console and click Usage. Look at the last day.',
      '2) Open the Value page in the admin and check which job used the most.',
      '3) If it looks wrong, set Autopilot to off for now, then tell Claude.',
      '4) If it looks fine, raise the limit: in Supabase open the app_settings table and set the row ai_daily_ceiling_usd to a bigger number.',
    ],
  }
}

/** Daily check, called from the gsc-snapshot cron. Emails once per day at most. Never throws. */
export async function runAiTripwire(admin: SupabaseClient, now: number = Date.now()): Promise<string> {
  try {
    const { spend, ceiling } = await readAiSpend(admin, now)
    if (spend === null || !overCeiling(spend, ceiling)) return ''
    const day = new Date(now).toISOString().slice(0, 10)
    if ((await getSetting(admin, AI_ALERTED_DAY_KEY)) === day) return `ai tripwire: ${usd(spend)} over ${usd(ceiling)}, already emailed today`
    const mail = buildAiAlert(spend, ceiling)
    const sent = await sendThrottledAlert(admin, mail.subject, mail.lines)
    if (sent === 'sent') await setSetting(admin, AI_ALERTED_DAY_KEY, day)
    return `ai tripwire: ${usd(spend)} over ${usd(ceiling)}, alert ${sent}`
  } catch (e) {
    console.error('[cron:gsc-snapshot] ai tripwire failed:', e)
    return ''
  }
}
