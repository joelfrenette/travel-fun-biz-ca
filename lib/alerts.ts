import type { SupabaseClient } from '@supabase/supabase-js'
import { getSetting, setSetting } from '@/lib/app-settings'
import { blockIfDry } from '@/lib/dry-run'

// Failure alerts to the admin's own email, so a hands-off autopilot doesn't fail silently. Sent
// through Resend (https://resend.com) when RESEND_API_KEY is set; dormant otherwise, like every
// other integration here. A free Resend account can send to its own owner's address from
// onboarding@resend.dev without verifying a domain, which is all an alert to ADMIN_EMAIL needs.
export const LAST_ALERT_KEY = 'autopilot_last_alert_at'
/** The last reason an email could not be delivered ('' when the last one went through). Shown in Needs
 * attention, because an email problem cannot be reported by email. */
export const MAIL_ERROR_KEY = 'mail_last_error'

export async function noteMailResult(admin: SupabaseClient, error: string | null): Promise<void> {
  await setSetting(admin, MAIL_ERROR_KEY, error ? error.slice(0, 300) : '').catch(() => undefined)
}

/** Where alerts and the daily brief go: NOTIFY_TO_EMAIL if set, else the admin address. */
export const notifyTo = (fallback?: string) => process.env.NOTIFY_TO_EMAIL?.trim() || fallback || process.env.ADMIN_EMAIL?.trim() || ''
// One email per window, however many runs fail inside it - an outage must not become an inbox flood.
export const THROTTLE_MS = 6 * 60 * 60 * 1000

export function alertsConfigured(): boolean {
  return !!process.env.RESEND_API_KEY?.trim() && !!process.env.ADMIN_EMAIL?.trim()
}

/** Sends one alert email, at most once per throttle window. Never throws. Returns what happened. */
export async function sendThrottledAlert(admin: SupabaseClient, subject: string, lines: string[], html?: string, opts: { ignoreThrottle?: boolean } = {}): Promise<'sent' | 'throttled' | 'not-configured' | 'failed'> {
  // Dry run (lib/dry-run.ts): no email goes out and the throttle does not move.
  if (blockIfDry('email', subject)) return 'throttled'
  if (!alertsConfigured()) return 'not-configured'
  try {
    const last = Date.parse((await getSetting(admin, LAST_ALERT_KEY)) ?? '')
    // ignoreThrottle is only for the admin "send me a test alert" button: a person asked for this one email.
    if (!opts.ignoreThrottle && Number.isFinite(last) && Date.now() - last < THROTTLE_MS) return 'throttled'
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY!.trim()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: process.env.ALERT_FROM_EMAIL?.trim() || 'TravelFunBiz Autopilot <onboarding@resend.dev>',
        to: [notifyTo()],
        subject,
        text: lines.join('\n'),
        // The same look as the daily brief when the caller built one (lib/brief-html.ts alertHtml); the plain
        // text stays as the fallback every mail program can show.
        ...(html ? { html } : {}),
      }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { message?: string }
      await noteMailResult(admin, `Resend said ${res.status}${body.message ? `: ${body.message}` : ''}`)
      return 'failed'
    }
    await noteMailResult(admin, null)
    // A test send does not move the throttle: the next real alert still goes out on its own schedule.
    if (!opts.ignoreThrottle) await setSetting(admin, LAST_ALERT_KEY, new Date().toISOString())
    return 'sent'
  } catch {
    return 'failed'
  }
}

// ---- New lead notice -------------------------------------------------------------------------------
// One short email to the admin the moment a real lead is saved, so follow-up can start fast. It carries
// NO personal data (no name, email or phone), only where the lead came from and a link to /admin/leads.
// It does not use the shared 6 hour throttle: each lead id is claimed once, and at most 20 go out a day.
export const NEW_LEAD_DAILY_CAP = 20
const CLAIM_PREFIX = 'new_lead_notified_'
const DAY_KEY = 'new_lead_notice_day'

export interface NewLeadInfo {
  id: string
  isTest?: boolean
  package?: string | null
  pagePath?: string | null
  utmSource?: string | null
}

export type NewLeadDecision = 'send' | 'test' | 'duplicate' | 'cap'

/** Pure: should this lead get an email? `alreadyClaimed` = this lead id has a claim row; `sentToday` = emails sent today. */
export function decideNewLeadNotice(i: { isTest?: boolean; alreadyClaimed: boolean; sentToday: number }): NewLeadDecision {
  if (i.isTest) return 'test'
  if (i.alreadyClaimed) return 'duplicate'
  if (i.sentToday >= NEW_LEAD_DAILY_CAP) return 'cap'
  return 'send'
}

/** Pure: the day counter stored as "YYYY-MM-DD:count"; a different day (or junk) reads as 0. */
export function parseDayCount(raw: string | null, today: string): number {
  const m = /^(\d{4}-\d{2}-\d{2}):(\d{1,6})$/.exec((raw ?? '').trim())
  return m && m[1] === today ? Number(m[2]) : 0
}

// Free text from the form could hold an address or a phone number; keep the email free of both.
function safeField(v: string | null | undefined): string {
  const s = (v ?? '').replace(/@/g, ' ').replace(/\d{7,}/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120)
  return s || 'not recorded'
}

/** Pure: the subject and plain text body. Never includes a name, email or phone. */
export function buildNewLeadEmail(info: NewLeadInfo, adminUrl: string): { subject: string; text: string } {
  const where = safeField(info.package) !== 'not recorded' ? safeField(info.package) : safeField(info.pagePath)
  return {
    subject: 'New lead',
    text: ['New lead', `Package or page: ${where}`, `Source: ${safeField(info.utmSource)}`, `Open: ${adminUrl}`].join('\n'),
  }
}

export interface NewLeadDeps {
  admin?: SupabaseClient
  fetchImpl?: typeof fetch
  get?: (key: string) => Promise<string | null>
  set?: (key: string, value: string) => Promise<unknown>
  now?: () => Date
}

/** Sends the new lead email. Never throws; returns what happened. No-op when RESEND_API_KEY is unset. */
export async function notifyNewLead(info: NewLeadInfo, deps: NewLeadDeps = {}): Promise<'sent' | NewLeadDecision | 'not-configured' | 'failed'> {
  try {
    const key = process.env.RESEND_API_KEY?.trim()
    const to = notifyTo()
    if (!key || !to || !info.id) return 'not-configured'
    if (info.isTest) return 'test'
    const client = async () => deps.admin ?? (await import('@/lib/supabase-admin')).getSupabaseAdmin()
    const get = deps.get ?? (async (k: string) => getSetting(await client(), k))
    const set = deps.set ?? (async (k: string, v: string) => setSetting(await client(), k, v))
    const today = (deps.now?.() ?? new Date()).toISOString().slice(0, 10)
    const claimKey = `${CLAIM_PREFIX}${info.id}`
    const decision = decideNewLeadNotice({
      alreadyClaimed: !!(await get(claimKey)),
      sentToday: parseDayCount(await get(DAY_KEY), today),
    })
    if (decision !== 'send') return decision
    // Claim first: a retry or a double call for the same lead can never send twice.
    await set(claimKey, today)
    await set(DAY_KEY, `${today}:${parseDayCount(await get(DAY_KEY), today) + 1}`)
    const { SITE_URL } = await import('@/lib/site')
    const mail = buildNewLeadEmail(info, `${SITE_URL}/admin/leads`)
    const res = await (deps.fetchImpl ?? fetch)('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: process.env.ALERT_FROM_EMAIL?.trim() || 'TravelFunBiz Autopilot <onboarding@resend.dev>',
        to: [to],
        subject: mail.subject,
        text: mail.text,
      }),
      signal: AbortSignal.timeout(15_000),
    })
    return res.ok ? 'sent' : 'failed'
  } catch {
    return 'failed'
  }
}
