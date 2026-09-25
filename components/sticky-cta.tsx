"use client"

import { useEffect, useState } from "react"
import { ExternalLink } from "lucide-react"
import { track } from "@/lib/analytics-client"

interface StickyCtaProps {
  packageName: string
  requestLabel: string
  bookingUrl?: string | null
  bookLabel: string
}

// Phone-only bar pinned to the bottom of a package page. Hides itself while the enquiry form is on
// screen so it never covers the submit button.
export function StickyCta({ packageName, requestLabel, bookingUrl, bookLabel }: StickyCtaProps) {
  const [hidden, setHidden] = useState(false)

  useEffect(() => {
    const form = document.getElementById("enquire")
    if (!form || typeof IntersectionObserver === "undefined") return
    const observer = new IntersectionObserver(([entry]) => setHidden(entry.isIntersecting), { threshold: 0.15 })
    observer.observe(form)
    return () => observer.disconnect()
  }, [])

  return (
    <div
      data-testid="sticky-cta"
      className={`fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 p-3 shadow-[0_-4px_16px_rgba(0,0,0,0.08)] backdrop-blur transition-transform duration-200 lg:hidden ${hidden ? "translate-y-full" : "translate-y-0"}`}
      style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}
    >
      <div className="container mx-auto flex gap-2 px-1">
        <a href="#enquire" className="flex flex-1 items-center justify-center rounded-md bg-primary px-4 py-3 text-sm font-bold uppercase text-primary-foreground">
          {requestLabel}
        </a>
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
