import type { SupabaseClient } from '@supabase/supabase-js'
import { getSetting, setSetting } from '@/lib/app-settings'

// Failure alerts to the admin's own email, so a hands-off autopilot doesn't fail silently. Sent
// through Resend (https://resend.com) when RESEND_API_KEY is set; dormant otherwise, like every
// other integration here. A free Resend account can send to its own owner's address from
// onboarding@resend.dev without verifying a domain, which is all an alert to ADMIN_EMAIL needs.
const LAST_ALERT_KEY = 'autopilot_last_alert_at'
/** The last reason an email could not be delivered ('' when the last one went through). Shown in Needs
 * attention, because an email problem cannot be reported by email. */
export const MAIL_ERROR_KEY = 'mail_last_error'

export async function noteMailResult(admin: SupabaseClient, error: string | null): Promise<void> {
  await setSetting(admin, MAIL_ERROR_KEY, error ? error.slice(0, 300) : '').catch(() => undefined)
}

/** Where alerts and the daily brief go: NOTIFY_TO_EMAIL if set, else the admin address. */
export const notifyTo = (fallback?: string) => process.env.NOTIFY_TO_EMAIL?.trim() || fallback || process.env.ADMIN_EMAIL?.trim() || ''
// One email per window, however many runs fail inside it - an outage must not become an inbox flood.
const THROTTLE_MS = 6 * 60 * 60 * 1000

export function alertsConfigured(): boolean {
  return !!process.env.RESEND_API_KEY?.trim() && !!process.env.ADMIN_EMAIL?.trim()
}

/** Sends one alert email, at most once per throttle window. Never throws. Returns what happened. */
export async function sendThrottledAlert(admin: SupabaseClient, subject: string, lines: string[], html?: string): Promise<'sent' | 'throttled' | 'not-configured' | 'failed'> {
  if (!alertsConfigured()) return 'not-configured'
  try {
    const last = Date.parse((await getSetting(admin, LAST_ALERT_KEY)) ?? '')
    if (Number.isFinite(last) && Date.now() - last < THROTTLE_MS) return 'throttled'
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
    await setSetting(admin, LAST_ALERT_KEY, new Date().toISOString())
    return 'sent'
  } catch {
    return 'failed'
  }
}
