"use client"

import { useEffect } from "react"
import { useConsent } from "@/lib/consent"

declare global {
  interface Window {
    dataLayer?: unknown[]
    gtag?: (...args: unknown[]) => void
  }
}

// Google Analytics loads ONLY after the visitor has said yes. If they later withdraw, GA is switched
// off for this page view (the standard "ga-disable" flag) and its cookies are removed. Before this
// existed GA loaded for every visitor.
export function ConsentAnalytics({ gaId }: { gaId?: string }) {
  const { analytics } = useConsent()

  useEffect(() => {
    if (!gaId) return
    const flag = `ga-disable-${gaId}`
    if (!analytics) {
      ;(window as unknown as Record<string, unknown>)[flag] = true
      document.cookie.split(";").map((c) => c.split("=")[0].trim()).filter((n) => n === "_ga" || n.startsWith("_ga_") || n === "_gid").forEach((n) => {
        document.cookie = `${n}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`
        document.cookie = `${n}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; domain=.${location.hostname.replace(/^www\./, "")}`
      })
      return
    }
    ;(window as unknown as Record<string, unknown>)[flag] = false
    if (document.getElementById("ga4-script")) return
    const s = document.createElement("script")
    s.id = "ga4-script"
    s.async = true
    s.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(gaId)}`
    document.head.appendChild(s)
    window.dataLayer = window.dataLayer || []
    window.gtag = function () {
      // eslint-disable-next-line prefer-rest-params
      window.dataLayer!.push(arguments)
    }
    window.gtag("js", new Date())
    window.gtag("config", gaId)
  }, [gaId, analytics])

  return null
}
