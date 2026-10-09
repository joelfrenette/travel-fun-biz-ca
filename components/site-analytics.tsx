"use client"

import { Analytics } from "@vercel/analytics/next"
import { isInternalBrowser } from "@/lib/internal-traffic"

// Vercel Web Analytics, with the owner's own browsing (signed-in admin, localhost, /admin pages) dropped
// before it is sent, so test clicks never count.
export function SiteAnalytics() {
  return <Analytics beforeSend={(event) => (isInternalBrowser() ? null : event)} />
}
