"use client"

import { useEffect, useState } from "react"
import { ExternalLink, Phone } from "lucide-react"
import { track } from "@/lib/analytics-client"
import { trackConversion } from "@/lib/conversion-events"
import { telHref } from "@/lib/guide-facts"
import { PhoneLink } from "@/components/phone-link"

interface StickyCtaProps {
  packageName: string
  requestLabel: string
  bookingUrl?: string | null
  bookLabel?: string
  /** Where the request button goes. Defaults to the enquiry form on a package page. */
  requestHref?: string
  /** The number to call or text, as shown on the site (site.phone). No number: no call button. */
  phone?: string | null
  /** Label of the call button, already translated. */
  callLabel?: string
  /** The request button is the "Book a free call" button: its taps also count as the GA4 book_call_click key event. */
  bookCall?: boolean
}

// Ids of the on-page forms. The bar slides away while any of them is on screen so it never covers a submit button.
const FORM_IDS = ["enquire", "contact", "guide-cta", "page-signup"]

// Phone-only bar pinned to the bottom of a page. Hides itself while the enquiry form is on screen.
export function StickyCta({ packageName, requestLabel, bookingUrl, bookLabel, requestHref = "#enquire", phone, callLabel = "Call or text", bookCall = false }: StickyCtaProps) {
  const [hidden, setHidden] = useState(false)
  const tel = telHref(phone)

  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return
    const targets = FORM_IDS.map((id) => document.getElementById(id)).filter((el): el is HTMLElement => !!el)
    if (targets.length === 0) return
    const visible = new Set<Element>()
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) visible.add(entry.target)
          else visible.delete(entry.target)
        }
        setHidden(visible.size > 0)
      },
      { threshold: 0.15 },
    )
    targets.forEach((el) => observer.observe(el))
    return () => observer.disconnect()
  }, [])

  return (
    <div
      data-testid="sticky-cta"
      className={`fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 p-3 shadow-[0_-4px_16px_rgba(0,0,0,0.08)] backdrop-blur transition-transform duration-200 lg:hidden ${hidden ? "translate-y-full" : "translate-y-0"}`}
      style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}
    >
      <div className="container mx-auto flex gap-2 px-1">
        <a href={requestHref} {...(bookCall ? { "data-ga-event": "book_call_click", "data-ga-method": "sticky_bar" } : {})} onClick={() => trackConversion("cta_click", { block_id: "sticky_bar", kind: "enquiry" })} className="flex flex-1 items-center justify-center rounded-md bg-primary px-4 py-3 text-sm font-bold uppercase text-primary-foreground">
          {requestLabel}
        </a>
        {tel && (
          <PhoneLink href={tel} method="sticky_bar" className="flex flex-1 items-center justify-center rounded-md border border-primary px-4 py-3 text-sm font-bold uppercase text-primary">
            <Phone className="mr-1.5 h-4 w-4" aria-hidden="true" />
            {callLabel}
          </PhoneLink>
        )}
        {bookingUrl && (
          <a
            href={bookingUrl}
            target="_blank"
            rel="noopener noreferrer nofollow"
            onClick={() => track("book_now_click", { package_name: packageName, page_path: window.location.pathname, link_url: bookingUrl, method: "sticky_bar" })}
            className="flex flex-1 items-center justify-center rounded-md border border-primary px-4 py-3 text-sm font-bold uppercase text-primary"
          >
            {bookLabel}
            <ExternalLink className="ml-1.5 h-4 w-4" />
          </a>
        )}
      </div>
    </div>
  )
}
