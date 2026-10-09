"use client"

// Visits and clicks from the owner's own browser are testing, not customers, so they must never reach
// analytics. A browser counts as "internal" when it is signed in to the admin (the admin token is kept
// in that browser), is running on localhost, or is on an /admin page. Nothing is sent about it anywhere:
// analytics scripts simply do not run, and campaign attribution is not remembered.
export function isInternalBrowser(): boolean {
  if (typeof window === "undefined") return false
  try {
    if (window.localStorage.getItem("adminToken")) return true
  } catch {
    // blocked storage: cannot tell, treat as a normal visitor
  }
  const host = window.location.hostname
  return host === "localhost" || host === "127.0.0.1" || window.location.pathname.startsWith("/admin")
}
