"use client"

import { useSyncExternalStore } from "react"

// Visitor consent for NON-ESSENTIAL tracking (Google Analytics, and remembering which ad, post or search
// brought a visitor). Opt-in: nothing non-essential runs until the visitor says yes, "Essential only" is
// as easy to pick as "Accept", and the choice can be changed any time from the footer. The choice is
// stored in the visitor's own browser (it is an essential preference, not tracking).
// Cookieless Vercel Web Analytics is unaffected: it sets no cookie and keeps no personal data.
export const CONSENT_KEY = "tfb_consent_v1"
const EVENT = "tfb-consent"

export interface Consent {
  /** true once the visitor has chosen either way */
  decided: boolean
  analytics: boolean
}

const UNDECIDED: Consent = { decided: false, analytics: false }
let cached: Consent = UNDECIDED
let cachedRaw: string | null = null

function read(): Consent {
  if (typeof window === "undefined") return UNDECIDED
  let raw: string | null = null
  try {
    raw = window.localStorage.getItem(CONSENT_KEY)
  } catch {
    return UNDECIDED // storage blocked: treat as "no consent", ask again, never track
  }
  if (raw === cachedRaw) return cached
  cachedRaw = raw
  try {
    const parsed = raw ? (JSON.parse(raw) as { analytics?: unknown }) : null
    cached = parsed ? { decided: true, analytics: parsed.analytics === true } : UNDECIDED
  } catch {
    cached = UNDECIDED
  }
  return cached
}

export function setConsent(analytics: boolean): void {
  try {
    window.localStorage.setItem(CONSENT_KEY, JSON.stringify({ analytics, at: new Date().toISOString() }))
  } catch {
    // blocked storage: the banner will simply show again next time
  }
  window.dispatchEvent(new Event(EVENT))
}

/** Forget the choice so the banner asks again (the footer "Cookie settings" link). */
export function resetConsent(): void {
  try {
    window.localStorage.removeItem(CONSENT_KEY)
  } catch {
    // nothing to reset
  }
  window.dispatchEvent(new Event(EVENT))
}

function subscribe(cb: () => void): () => void {
  window.addEventListener(EVENT, cb)
  window.addEventListener("storage", cb)
  return () => {
    window.removeEventListener(EVENT, cb)
    window.removeEventListener("storage", cb)
  }
}

export function useConsent(): Consent {
  return useSyncExternalStore(subscribe, read, () => UNDECIDED)
}

/** Non-hook read for plain functions (for example when a form is submitted). */
export function hasAnalyticsConsent(): boolean {
  return read().analytics
}
