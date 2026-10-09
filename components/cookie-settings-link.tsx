"use client"

import { resetConsent } from "@/lib/consent"

/** Footer link that reopens the privacy choices so a visitor can change their mind any time. */
export function CookieSettingsLink({ className }: { className?: string }) {
  return (
    <button type="button" onClick={resetConsent} className={className}>
      Cookie settings
    </button>
  )
}
