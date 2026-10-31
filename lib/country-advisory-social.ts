import type { SupabaseClient } from '@supabase/supabase-js'
import { getDistributionMode } from '@/lib/distribution'
import { isAutomationPaused } from '@/lib/automation-kill-switch'
import { getNewsPerDay } from '@/lib/news-settings'
import { SOCIAL_ENROLMENTS_PER_DAY_CEILING, allEnrolmentsSince, utcDayStart } from '@/lib/news-distribution'
import { SOCIAL_MIN_GAP_DAYS, advisoryPath, type AdvisoryMode } from '@/lib/country-advisory'
export { countryOfAdvisoryLedgerSlug, countryOfAdvisoryPath } from '@/lib/country-advisory'

// Social posts for a country advisory page (travel advisories). ONE rule: a post only when a country's government risk LEVEL
// changed, at most one per country per 7 days. It goes through the SAME ledger and posting pass as every other post
// (post_distribution, content_type 'post', slug advisory-<country>-<yyyymmdd>, path /travel-advisories/<country>), so the same
// distribution mode, kill switch, per-network limits and the shared ceiling of 6 enrolments a day apply. This file only decides
// WHETHER to enrol. It never sends anything, and every refusal is a quiet 'skipped', never an error.

export const ADVISORY_LEDGER_PREFIX = 'advisory-'
const DAY_MS = 86_400_000

/** The ledger slug (also the UTM campaign): advisory-<country>-<yyyymmdd>. */
export function advisoryLedgerSlug(countrySlug: string, now: Date): string {
  return `${ADVISORY_LEDGER_PREFIX}${countrySlug}-${now.toISOString().slice(0, 10).replace(/-/g, '')}`
}

export type SocialDecision = { ok: true } | { ok: false; reason: string }

/** Pure. A post is allowed only when: the mode is 'on' (the page exists), the change is a LEVEL change (not a text edit, and
 * never a UK update, which has no level), and the last post for this country was at least 7 days ago. `lastPostedIso` null =
 * never posted. An unreadable last-post time (undefined) refuses. */
export function decideAdvisorySocial(input: { mode: AdvisoryMode; kind: 'level_change' | 'text_update'; source: string; lastPostedIso: string | null | undefined; now: Date }): SocialDecision {
  if (input.mode !== 'on') return { ok: false, reason: 'the advisory pages are not on' }
  if (input.kind !== 'level_change') return { ok: false, reason: 'only a level change is posted' }
  if (input.source !== 'gac-advisories') return { ok: false, reason: 'only the Government of Canada level is posted' }
  if (input.lastPostedIso === undefined) return { ok: false, reason: 'the last post time could not be read' }
  if (input.lastPostedIso !== null) {
    const t = Date.parse(input.lastPostedIso)
    if (!Number.isFinite(t)) return { ok: false, reason: 'the last post time could not be read' }
    if (input.now.getTime() - t < SOCIAL_MIN_GAP_DAYS * DAY_MS) return { ok: false, reason: `this country was posted within the last ${SOCIAL_MIN_GAP_DAYS} days` }
  }
  return { ok: true }
}

/** The newest ledger row for this country's advisory page (created_at), null = none, undefined = could not be read. */
async function lastAdvisoryPostAt(admin: SupabaseClient, countrySlug: string): Promise<string | null | undefined> {
  try {
    const { data, error } = await admin
      .from('post_distribution')
      .select('created_at')
      .eq('content_type', 'post')
      .eq('path', advisoryPath(countrySlug))
      .order('created_at', { ascending: false })
      .limit(1)
    if (error) return undefined
    const row = (data ?? [])[0] as { created_at?: string } | undefined
    return row?.created_at ?? null
  } catch {
    return undefined
  }
}

async function advisoryEnrolmentsSince(admin: SupabaseClient, sinceIso: string): Promise<number | null> {
  try {
    const { count, error } = await admin.from('post_distribution').select('slug', { count: 'exact', head: true }).like('slug', `${ADVISORY_LEDGER_PREFIX}%`).not('path', 'is', null).gte('created_at', sinceIso)
    return error ? null : (count ?? 0)
  } catch {
    return null
  }
}

export interface AdvisoryToEnrol {
  countrySlug: string
  title: string
  source: string
  kind: 'level_change' | 'text_update'
  mode: AdvisoryMode
}

/** Enrols one level change for social posting. A no-op (never an error, never a throw) when the decision refuses, distribution is
 * off, automation is paused, today's advisory number (the news per-day setting) or the shared ceiling of 6 is used, or any count
 * cannot be read. `prepare` mode enrols into `held` (a person approves), `auto` into `queued`, exactly like every other post. */
export async function enrollAdvisoryIfDue(admin: SupabaseClient, input: AdvisoryToEnrol, now: Date = new Date()): Promise<'enrolled' | 'skipped' | 'ceiling'> {
  try {
    if (input.mode !== 'on') return 'skipped'
    const dist = await getDistributionMode(admin)
    if (dist === 'off') return 'skipped'
    if (await isAutomationPaused(admin)) return 'skipped'
    const decision = decideAdvisorySocial({ mode: input.mode, kind: input.kind, source: input.source, lastPostedIso: await lastAdvisoryPostAt(admin, input.countrySlug), now })
    if (!decision.ok) return 'skipped'

    const perDay = await getNewsPerDay(admin)
    const since = utcDayStart(now)
    const mine = await advisoryEnrolmentsSince(admin, since)
    const all = await allEnrolmentsSince(admin, since)
    if (perDay === null || mine === null || all === null || mine >= perDay) return 'skipped'
    if (all >= SOCIAL_ENROLMENTS_PER_DAY_CEILING) return 'ceiling'

    const slug = advisoryLedgerSlug(input.countrySlug, now)
    const { data: existing, error: existingError } = await admin.from('post_distribution').select('slug').eq('content_type', 'post').eq('slug', slug).maybeSingle()
    if (existingError || existing) return 'skipped'
    const { error } = await admin.from('post_distribution').insert({ content_type: 'post', slug, title: input.title, path: advisoryPath(input.countrySlug), stage: dist === 'prepare' ? 'held' : 'queued' })
    if (error) return 'skipped'

    // Two runs at the same instant could both pass the checks. Count again and take this row back out if a limit is now exceeded.
    const mineAfter = await advisoryEnrolmentsSince(admin, since)
    const allAfter = await allEnrolmentsSince(admin, since)
    if (mineAfter === null || allAfter === null || mineAfter > perDay || allAfter > SOCIAL_ENROLMENTS_PER_DAY_CEILING) {
      await admin.from('post_distribution').delete().eq('content_type', 'post').eq('slug', slug).neq('stage', 'done')
      return allAfter !== null && allAfter > SOCIAL_ENROLMENTS_PER_DAY_CEILING ? 'ceiling' : 'skipped'
    }
    return 'enrolled'
  } catch (err) {
    console.error('[country-advisory-social] enrol failed:', err instanceof Error ? err.message : err)
    return 'skipped'
  }
}
