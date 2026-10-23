"use client"

import { useEffect } from "react"
import { trackConversionWhenReady } from "@/lib/conversion-events"

// Counts one thank_you_view when the thank-you page opens. Consent-gated like every other event: with no analytics
// consent the tag is not loaded and nothing is sent. Draws nothing.
export function ThankYouTrack() {
  useEffect(() => {
    trackConversionWhenReady("thank_you_view")
  }, [])
  return null
}
