"use client"

import { useEffect } from "react"
import { captureAttribution, clearAttribution } from "@/lib/attribution"
import { useConsent } from "@/lib/consent"
import { isInternalBrowser } from "@/lib/internal-traffic"

// Remembering which ad, post or search brought a visitor is optional tracking: it only starts after
// the visitor accepts analytics, and what was remembered is erased if they decline or withdraw.
export function AttributionCapture() {
  const { analytics } = useConsent()
  useEffect(() => {
    // The owner's own browsing is testing, so it never leaves "where I came from" behind either.
    if (analytics && !isInternalBrowser()) captureAttribution()
    else clearAttribution()
  }, [analytics])
  return null
}
