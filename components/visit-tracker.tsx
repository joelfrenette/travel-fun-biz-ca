"use client"

import { useEffect } from "react"
import { usePathname } from "next/navigation"
import { useConsent } from "@/lib/consent"
import { isInternalBrowser } from "@/lib/internal-traffic"

// First-party visit beacon (autoblogging row 11). Sends NOTHING unless ALL of these hold:
//   - the visitor accepted analytics (lib/consent.ts),
//   - Do Not Track and Global Privacy Control are not set,
//   - this is not the owner's browser and not an /admin or /api page.
// It also stays quiet while the server switch (app_settings visit_tracking) is off: the server answers 204, and this
// browser then stops trying until the tab is closed. What is sent: the page path, the referrer HOST only, campaign
// tags, a random visitor id and session id (kept in localStorage, no cookie), and active seconds on the site.
// No fingerprinting, no IP (the server never stores one), nothing sent to any other site.
const VID_KEY = "tfb_vid"
const SID_KEY = "tfb_vsid"
const OFF_KEY = "tfb_vt_off" // sessionStorage: the server said "off", do not ask again in this tab
const ENDPOINT = "/api/track/visit"
const SESSION_IDLE_MS = 30 * 60 * 1000
const HEARTBEAT_MS = 30 * 1000
const MAX_ACTIVE_S = 30 * 60

function optedOut(): boolean {
  const nav = navigator as Navigator & { globalPrivacyControl?: boolean; msDoNotTrack?: string }
  return (
    nav.doNotTrack === "1" ||
    (window as unknown as { doNotTrack?: string }).doNotTrack === "1" ||
    nav.msDoNotTrack === "1" ||
    nav.globalPrivacyControl === true
  )
}

function randomId(): string {
  try {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID()
  } catch {
    // fall through
  }
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
}

function eligiblePath(path: string): boolean {
  return !/^\/(admin|api)(\/|$)/i.test(path)
}

interface Session {
  id: string
  last: number
  active: number
}

function readSession(): Session {
  const now = Date.now()
  try {
    const s = JSON.parse(localStorage.getItem(SID_KEY) || "null") as Session | null
    if (s && typeof s.id === "string" && now - s.last < SESSION_IDLE_MS) return { id: s.id, last: now, active: Number(s.active) || 0 }
  } catch {
    // start a new session
  }
  return { id: randomId(), last: now, active: 0 }
}

function writeSession(s: Session): void {
  try {
    localStorage.setItem(SID_KEY, JSON.stringify(s))
  } catch {
    // blocked storage: the visit simply is not tracked beyond this page
  }
}

function visitorId(): string {
  try {
    const existing = localStorage.getItem(VID_KEY)
    if (existing && /^[a-z0-9-]{16,64}$/.test(existing)) return existing
    const fresh = randomId()
    localStorage.setItem(VID_KEY, fresh)
    return fresh
  } catch {
    return randomId() // blocked storage: a one-page id, never persisted
  }
}

function forgetEverything(): void {
  try {
    localStorage.removeItem(VID_KEY)
    localStorage.removeItem(SID_KEY)
  } catch {
    // nothing stored
  }
}

function send(body: Record<string, unknown>, onStatus?: (status: number) => void): void {
  const json = JSON.stringify(body)
  try {
    fetch(ENDPOINT, { method: "POST", body: json, headers: { "Content-Type": "application/json" }, keepalive: true, credentials: "omit" })
      .then((r) => onStatus?.(r.status))
      .catch(() => {})
  } catch {
    // never an error for the visitor
  }
}

function sendOnExit(body: Record<string, unknown>): void {
  try {
    navigator.sendBeacon(ENDPOINT, new Blob([JSON.stringify(body)], { type: "application/json" }))
  } catch {
    // never an error for the visitor
  }
}

let firstViewOfThisLoad = true

export function VisitTracker() {
  const { analytics } = useConsent()
  const pathname = usePathname()

  // Withdrawn or declined consent: forget the random ids.
  useEffect(() => {
    if (!analytics) forgetEverything()
  }, [analytics])

  // One beacon per page view, plus the optional visibility-based heartbeat.
  useEffect(() => {
    if (!analytics || !pathname || !eligiblePath(pathname)) return
    if (isInternalBrowser() || optedOut()) return
    try {
      if (sessionStorage.getItem(OFF_KEY)) return
    } catch {
      // no sessionStorage: carry on
    }

    const vid = visitorId()
    const session = readSession()
    writeSession(session)
    const params = new URLSearchParams(window.location.search)
    const tag = (k: string) => (params.get(k) || "").slice(0, 100)
    let refHost = ""
    // The outside referrer is only meaningful for the first page of this load (later pages are in-site navigation).
    if (firstViewOfThisLoad && document.referrer) {
      try {
        const h = new URL(document.referrer).hostname.toLowerCase().replace(/^www\./, "")
        if (h !== window.location.hostname.toLowerCase().replace(/^www\./, "")) refHost = h
      } catch {
        refHost = ""
      }
    }
    firstViewOfThisLoad = false
    const clickId = params.has("gclid") || params.has("gbraid") || params.has("wbraid") ? "gclid" : params.has("msclkid") ? "msclkid" : params.has("fbclid") ? "fbclid" : ""
    let stopped = false
    const base = { vid, sid: session.id }

    send(
      {
        ...base,
        t: "pv",
        path: pathname,
        ref_host: refHost,
        utm_source: tag("utm_source"),
        utm_medium: tag("utm_medium"),
        utm_campaign: tag("utm_campaign"),
        utm_content: tag("utm_content"),
        click_id: clickId,
        has_ref: params.has("ref"),
      },
      (status) => {
        if (status === 204) {
          stopped = true
          try {
            sessionStorage.setItem(OFF_KEY, "1")
          } catch {
            // ignore
          }
        }
      },
    )

    // Heartbeat: counts only the seconds the page is actually visible, at most every 30 seconds, up to 30 minutes.
    let visibleSince = document.visibilityState === "visible" ? Date.now() : 0
    const flushVisible = () => {
      if (visibleSince) {
        session.active += Math.round((Date.now() - visibleSince) / 1000)
        visibleSince = document.visibilityState === "visible" ? Date.now() : 0
      }
      session.active = Math.min(session.active, MAX_ACTIVE_S)
      session.last = Date.now()
      writeSession(session)
    }
    const beat = (exit: boolean) => {
      if (stopped) return
      flushVisible()
      if (session.active <= 0 || session.active >= MAX_ACTIVE_S + 1) return
      const body = { ...base, t: "hb", path: pathname, dur: session.active }
      if (exit) sendOnExit(body)
      else send(body)
    }
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible" && session.active < MAX_ACTIVE_S) beat(false)
      else flushVisible()
    }, HEARTBEAT_MS)
    const onVisibility = () => {
      if (document.visibilityState === "hidden") beat(true)
      else visibleSince = Date.now()
    }
    document.addEventListener("visibilitychange", onVisibility)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener("visibilitychange", onVisibility)
      flushVisible()
    }
  }, [analytics, pathname])

  return null
}
