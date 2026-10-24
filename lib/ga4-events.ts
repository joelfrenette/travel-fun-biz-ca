import { hasAnalyticsConsent } from '@/lib/consent'
import { isInternalBrowser } from '@/lib/internal-traffic'
import { buildGa4Event, leadEventParams } from '@/lib/ga4-lead'

// GA4 key events through the existing gtag tag (components/consent-analytics.tsx). They fire ONLY when the visitor accepted
// analytics AND NEXT_PUBLIC_GA_ID is set AND the tag is loaded; otherwise nothing happens and nothing is queued. Params are
// whitelisted (lib/ga4-lead.ts): trip name, source, intent, page, method, affiliate slug. No names, emails, phone numbers.

type Gtag = (command: 'event', name: string, params?: Record<string, string>) => void

/** Sends one GA4 event, or does nothing. Never throws. */
export function sendGa4Event(name: string, params?: Record<string, unknown>): boolean {
  if (typeof window === 'undefined') return false
  try {
    const gtag = (window as unknown as { gtag?: Gtag }).gtag
    if (typeof gtag !== 'function') return false
    if (isInternalBrowser()) return false
    const event = buildGa4Event(name, params, { consent: hasAnalyticsConsent(), gaId: process.env.NEXT_PUBLIC_GA_ID })
    if (!event) return false
    gtag('event', event.name, event.params)
    return true
  } catch {
    return false // analytics must never break the page
  }
}

/** generate_lead after a successful form submit. Value-less: trip name, source, intent only. */
export function trackLeadSubmitted(input: { tripName?: string | null; source?: string | null; intent?: string | null; method?: string }): void {
  sendGa4Event('generate_lead', leadEventParams({ ...input, pagePath: typeof window === 'undefined' ? null : window.location.pathname }))
}
