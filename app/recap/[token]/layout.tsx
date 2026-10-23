import type { Metadata } from "next"
import type { ReactNode } from "react"

// The recap form is private to whoever holds the link: never indexed, never followed, no referrer sent (the link itself is the key).
export const metadata: Metadata = {
  title: "Share your trip memories",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
}

export default function RecapShareLayout({ children }: { children: ReactNode }) {
  return <>{children}</>
}
