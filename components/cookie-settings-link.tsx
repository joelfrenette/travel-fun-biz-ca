"use client"

import { resetConsent } from "@/lib/consent"

/** Footer link that reopens the privacy choices so a visitor can change their mind any time. */
export function CookieSettingsLink({ className, label = "Cookie settings" }: { className?: string; label?: string }) {
  return (
    <button type="button" onClick={resetConsent} className={className}>
      {label}
    </button>
  )
}
