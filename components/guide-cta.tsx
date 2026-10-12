import Link from "next/link"
import { site } from "@/lib/site"
import { telHref } from "@/lib/guide-facts"

// The call to action on every guide page (growth loop WP16): the AI agent line and the enquiry form. The number is
// read from site.phone (lib/site.ts), never typed here, so it follows the site profile; with no number set the
// phone line is simply left out and the enquiry form is still offered.

export function GuideCta({ name, compact = false }: { name: string; compact?: boolean }) {
  const phone = site.phone?.trim() || ""
  const tel = telHref(phone)
  if (compact) {
    return (
      <p className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        {phone && (
          <span className="text-muted-foreground">
            Talk to our AI travel agent:{" "}
            {tel ? <a href={tel} className="font-semibold text-foreground hover:underline">{phone}</a> : <span className="font-semibold text-foreground">{phone}</span>}
          </span>
        )}
        <Link href="/#contact" className="font-semibold text-primary hover:underline">Send an enquiry</Link>
      </p>
    )
  }
  return (
    <section aria-labelledby="guide-cta-heading" className="rounded-xl border bg-muted/30 p-6 text-center">
      <h2 id="guide-cta-heading" className="text-lg font-semibold text-foreground">Thinking about {name}?</h2>
      <p className="mt-1 text-sm text-muted-foreground">Tell us who is travelling and roughly when, and our team will help you work out the right trip.</p>
      <div className="mt-4 flex flex-wrap justify-center gap-3">
        {phone && (
          tel ? (
            <a href={tel} className="inline-block rounded-md border border-primary px-6 py-3 text-sm font-bold text-primary hover:bg-primary/10">Call or text our AI agent: {phone}</a>
          ) : (
            <span className="inline-block rounded-md border border-primary px-6 py-3 text-sm font-bold text-primary">Our AI agent line: {phone}</span>
          )
        )}
        <Link href="/#contact" className="inline-block rounded-md bg-primary px-6 py-3 text-sm font-bold uppercase text-primary-foreground">Ask us about your trip</Link>
        <Link href="/packages" className="inline-block rounded-md border px-6 py-3 text-sm font-bold uppercase text-foreground hover:bg-muted">See all trips</Link>
      </div>
    </section>
  )
}
