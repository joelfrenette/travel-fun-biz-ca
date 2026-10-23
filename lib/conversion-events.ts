import { track } from '@/lib/analytics-client'
import type { ConversionEvent } from '@/lib/conversion'

// Funnel events. They go through track(), which only does anything once the visitor accepted analytics (the GA4 tag is
// not even loaded before that, components/consent-analytics.tsx). No consent: nothing is sent, nothing is stored.

type Params = Record<string, string | number | boolean | undefined>

export function trackConversion(event: ConversionEvent, params: Params = {}): void {
  if (typeof window === 'undefined') return
  track(event, { page_path: window.location.pathname, ...params })
}

/** Fires once. If the tag is not loaded yet (consent was just given, or the page just opened) it tries again for about 3 seconds, then gives up. */
export function trackConversionWhenReady(event: ConversionEvent, params: Params = {}): void {
  if (typeof window === 'undefined') return
  let tries = 0
  const attempt = () => {
    if (typeof (window as unknown as { gtag?: unknown }).gtag === 'function') return trackConversion(event, params)
    if (++tries < 6) window.setTimeout(attempt, 500)
  }
  attempt()
}
