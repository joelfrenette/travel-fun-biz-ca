"use client"

import { useEffect, useState } from "react"

// A plain link to /trip-quiz that carries the visitor's campaign tags (utm_*) along, so the existing source capture
// (lib/attribution.ts, consent gated and first touch) still sees where they came from. Without JavaScript it is an ordinary link.
const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"]

export function TripQuizLink({ className, children }: { className?: string; children: React.ReactNode }) {
  const [href, setHref] = useState("/trip-quiz")
  useEffect(() => {
    try {
      const here = new URLSearchParams(window.location.search)
      const next = new URLSearchParams()
      for (const k of UTM_KEYS) {
        const v = here.get(k)
        if (v) next.set(k, v.slice(0, 200))
      }
      const q = next.toString()
      if (q) setHref(`/trip-quiz?${q}`)
    } catch {
      // keep the plain link
    }
  }, [])
  return (
    <a href={href} className={className}>
      {children}
    </a>
  )
}
