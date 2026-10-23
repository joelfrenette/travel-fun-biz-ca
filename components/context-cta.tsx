"use client"

import { useEffect, useRef } from "react"
import Link from "next/link"
import { Phone } from "lucide-react"
import { telHref } from "@/lib/guide-facts"
import { contextCtaCopy, enquiryHrefWithContext, type CtaBlockId } from "@/lib/conversion"
import { trackConversion } from "@/lib/conversion-events"
import { PhoneLink } from "@/components/phone-link"

// A short, honest call to action that names what the page is about ("Planning Croatia? Talk to a travel advisor.").
// ONE primary action (call or text when the site has a number, otherwise the enquiry) and one quiet text link.
// The subject comes from stored data the page already has (destination, trip, keyword); the number is site.phone,
// passed in by the page. No prices, no counts, no promise about how fast we reply. Place it at most twice a page,
// with a different blockId each time, and not next to the full #guide-cta form.
export function ContextCta({
  blockId,
  subject,
  packageName,
  phone,
}: {
  blockId: CtaBlockId
  subject?: string | null
  packageName?: string | null
  phone?: string | null
}) {
  const ref = useRef<HTMLElement>(null)
  const copy = contextCtaCopy({ subject, phone })
  const tel = telHref(phone)
  const enquiry = enquiryHrefWithContext(packageName, subject)
  const headingId = `context-cta-${blockId}`

  // cta_view: once, when at least half of the block has been on screen.
  useEffect(() => {
    const el = ref.current
    if (!el || typeof IntersectionObserver === "undefined") return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          trackConversion("cta_view", { block_id: blockId })
          observer.disconnect()
        }
      },
      { threshold: 0.5 },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [blockId])

  const click = (kind: string) => () => trackConversion("cta_click", { block_id: blockId, kind })
  const primaryClass = "inline-flex items-center justify-center gap-2 rounded-md bg-primary px-6 py-3 text-sm font-bold text-primary-foreground hover:opacity-90"

  return (
    <section ref={ref} id={blockId === "end_of_page" ? "context-cta-end" : undefined} aria-labelledby={headingId} className="rounded-xl border border-primary/30 bg-primary/10 p-5 sm:p-6">
      <h2 id={headingId} className="text-balance text-lg font-bold text-foreground sm:text-xl">{copy.heading}</h2>
      <p className="mt-1 text-sm text-foreground/80">{copy.body}</p>
      <div className="mt-4 flex flex-col items-start gap-3 sm:flex-row sm:items-center">
        {copy.primary === "call" && tel ? (
          <span onClick={click("call")}>
            <PhoneLink href={tel} method={`context_${blockId}`} className={primaryClass}>
              <Phone className="h-4 w-4" aria-hidden="true" />
              {copy.primaryLabel}
            </PhoneLink>
          </span>
        ) : (
          <Link href={enquiry} onClick={click("enquiry")} className={primaryClass}>{copy.primary === "call" ? "Send an enquiry" : copy.primaryLabel}</Link>
        )}
        {copy.primary === "call" && tel && copy.secondaryLabel && (
          <Link href={enquiry} onClick={click("enquiry")} className="text-sm font-semibold text-primary underline-offset-4 hover:underline">{copy.secondaryLabel}</Link>
        )}
      </div>
      <p className="mt-3 text-xs text-muted-foreground">{copy.nextStep}</p>
    </section>
  )
}
