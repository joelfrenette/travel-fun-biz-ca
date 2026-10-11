import type { Metadata } from "next"
import type { ReactNode } from "react"

// The agent submission page (WP13) is private to whoever holds the link: never indexed, never followed, no referrer sent
// (the link itself is the key).
export const metadata: Metadata = {
  title: "Send a trip to Joel",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
}

export default function SubmitTripLayout({ children }: { children: ReactNode }) {
  return <>{children}</>
}
