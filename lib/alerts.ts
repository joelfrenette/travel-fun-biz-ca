import type { SupabaseClient } from '@supabase/supabase-js'
import { getSetting, setSetting } from '@/lib/app-settings'

// Failure alerts to the admin's own email, so a hands-off autopilot doesn't fail silently. Sent
// through Resend (https://resend.com) when RESEND_API_KEY is set; dormant otherwise, like every
// other integration here. A free Resend account can send to its own owner's address from
// onboarding@resend.dev without verifying a domain, which is all an alert to ADMIN_EMAIL needs.
const LAST_ALERT_KEY = 'autopilot_last_alert_at'
// One email per window, however many runs fail inside it - an outage must not become an inbox flood.
const THROTTLE_MS = 6 * 60 * 60 * 1000

export function alertsConfigured(): boolean {
  return !!process.env.RESEND_API_KEY?.trim() && !!process.env.ADMIN_EMAIL?.trim()
}

/** Sends one alert email, at most once per throttle window. Never throws. Returns what happened. */
export async function sendThrottledAlert(admin: SupabaseClient, subject: string, lines: string[]): Promise<'sent' | 'throttled' | 'not-configured' | 'failed'> {
  if (!alertsConfigured()) return 'not-configured'
  try {
    const last = Date.parse((await getSetting(admin, LAST_ALERT_KEY)) ?? '')
    if (Number.isFinite(last) && Date.now() - last < THROTTLE_MS) return 'throttled'
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY!.trim()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: process.env.ALERT_FROM_EMAIL?.trim() || 'TravelFunBiz Autopilot <onboarding@resend.dev>',
        to: [process.env.ADMIN_EMAIL!.trim()],
        subject,
        text: lines.join('\n'),
      }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return 'failed'
    await setSetting(admin, LAST_ALERT_KEY, new Date().toISOString())
    return 'sent'
  } catch {
    return 'failed'
  }
}
