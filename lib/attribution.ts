import { z } from 'zod'

// First-touch attribution, captured in the browser on the first page view and sent with every
// lead. Stored in localStorage (per browser), no cookie, no third party.
const STORAGE_KEY = 'tfb_attribution'
const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'] as const

export const attributionSchema = z
  .object({
    utm_source: z.string().max(200).optional(),
    utm_medium: z.string().max(200).optional(),
    utm_campaign: z.string().max(200).optional(),
    utm_term: z.string().max(200).optional(),
    utm_content: z.string().max(200).optional(),
    referrer: z.string().max(500).optional(),
    landing_path: z.string().max(500).optional(),
    page_path: z.string().max(500).optional(),
    first_seen: z.string().max(40).optional(),
  })
  .partial()

export type Attribution = z.infer<typeof attributionSchema>

export function captureAttribution(): void {
  if (typeof window === 'undefined') return
  try {
    const existing = window.localStorage.getItem(STORAGE_KEY)
    const params = new URLSearchParams(window.location.search)
    const hasUtm = UTM_KEYS.some((k) => params.get(k))
    // Keep the first touch unless this visit carries fresh campaign tags.
    if (existing && !hasUtm) return
    const record: Attribution = {
      referrer: document.referrer && !document.referrer.startsWith(window.location.origin) ? document.referrer.slice(0, 500) : undefined,
      landing_path: window.location.pathname + window.location.search,
      first_seen: new Date().toISOString(),
    }
    for (const k of UTM_KEYS) {
      const v = params.get(k)
      if (v) record[k] = v.slice(0, 200)
    }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(record))
  } catch {
    // Private mode or blocked storage: attribution is a nice-to-have, never a blocker.
  }
}

export function getAttribution(): Attribution {
  if (typeof window === 'undefined') return {}
  let stored: Attribution = {}
  try {
    stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '{}')
  } catch {
    stored = {}
  }
  return { ...stored, page_path: window.location.pathname }
}
