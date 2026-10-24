"use client"

import { useEffect } from "react"
import { sendGa4Event } from "@/lib/ga4-events"
import { classifyLinkClick } from "@/lib/ga4-lead"

// One delegated click listener for the GA4 key events that are about links:
//   tel: link  -> click_to_call      sms: link -> click_to_text      /go/<slug> link -> affiliate_click
//   anything marked data-ga-event="book_call_click" (the "Book a free call" and callback buttons) -> book_call_click
// It covers PhoneLink, the sticky bar and every other tel: link without touching each one. Nothing is sent unless the
// visitor accepted analytics and the GA id is set (lib/ga4-events.ts); the phone number itself is never in the params.
export function Ga4ClickEvents() {
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      try {
        const target = e.target as Element | null
        if (!target || typeof target.closest !== "function") return
        const path = window.location.pathname
        const marked = target.closest("[data-ga-event]")
        if (marked?.getAttribute("data-ga-event") === "book_call_click") {
          sendGa4Event("book_call_click", { page_path: path, method: marked.getAttribute("data-ga-method") || "button" })
          return
        }
        const link = target.closest("a[href]")
        if (!link) return
        const hit = classifyLinkClick(link.getAttribute("href"), path, window.location.host)
        if (hit) sendGa4Event(hit.name, hit.params)
      } catch {
        // analytics must never break the page
      }
    }
    document.addEventListener("click", onClick, true)
    return () => document.removeEventListener("click", onClick, true)
  }, [])
  return null
}
