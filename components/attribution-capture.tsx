"use client"

import { useEffect } from "react"
import { captureAttribution, clearAttribution } from "@/lib/attribution"
import { useConsent } from "@/lib/consent"

// Remembering which ad, post or search brought a visitor is optional tracking: it only starts after
// the visitor accepts analytics, and what was remembered is erased if they decline or withdraw.
export function AttributionCapture() {
  const { analytics } = useConsent()
  useEffect(() => {
    if (analytics) captureAttribution()
    else clearAttribution()
  }, [analytics])
  return null
}
