import Link from "next/link"
import { site } from "@/lib/site"
import { telHref, enquiryHref } from "@/lib/guide-facts"
import { PhoneLink } from "@/components/phone-link"
import { GuideLeadForm } from "@/components/guide-lead-form"

export { enquiryHref }

// The call to action on every guide page (growth loop WP16): the phone line of our AI agent and the enquiry form. The number is
// read from site.phone (lib/site.ts), never typed here, so it follows the site profile; with no number set the
// phone line is simply left out and the enquiry form is still offered.
//
// Conversion loop: the form is the one primary action here. The old second enquiry button linked to the SAME
// enquiry on the home page directly under the form, so it is gone; call or text and "See all trips" stay as quiet options.
// `topic` is what the page is about (destination, keyword); it goes into the lead's message so leads arrive with context.

export function GuideCta({ name, compact = false, packageName, topic }: { name: string; compact?: boolean; packageName?: string | null; topic?: string | null }) {
  const enquiry = enquiryHref(packageName)
  const phone = site.phone?.trim() || ""
  const tel = telHref(phone)
  if (compact) {
    return (
      <p className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        {phone && (
          <span className="text-muted-foreground">
            Call or text our AI agent:{" "}
            {tel ? <PhoneLink href={tel} method="guide_cta_compact" className="font-semibold text-foreground hover:underline">{phone}</PhoneLink> : <span className="font-semibold text-foreground">{phone}</span>}
          </span>
        )}
        <Link href={enquiry} className="font-semibold text-primary hover:underline">Send an enquiry</Link>
      </p>
    )
  }
  return (
    <section id="guide-cta" aria-labelledby="guide-cta-heading" className="rounded-xl border bg-muted/30 p-6 text-center">
      <h2 id="guide-cta-heading" className="text-lg font-semibold text-foreground">Thinking about {name}?</h2>
      <p className="mt-1 text-sm text-muted-foreground">Tell us who is travelling and roughly when, and our team will help you work out the right trip.</p>
      <GuideLeadForm packageName={packageName} phone={phone} topic={topic ?? name} />
      <p className="mt-4 text-xs text-muted-foreground">Prefer another way to reach us?</p>
      <div className="mt-2 flex flex-wrap items-center justify-center gap-x-5 gap-y-2">
        {phone && (
          tel ? (
            <PhoneLink href={tel} method="guide_cta" className="inline-block rounded-md border border-primary px-6 py-3 text-sm font-bold text-primary hover:bg-primary/10">Call or text our AI agent: {phone}</PhoneLink>
          ) : (
            <span className="inline-block rounded-md border border-primary px-6 py-3 text-sm font-bold text-primary">Call or text our AI agent: {phone}</span>
          )
        )}
        <Link href={enquiry} className="text-sm font-semibold text-primary underline-offset-4 hover:underline">Use the full enquiry page</Link>
        <Link href="/packages" className="text-sm font-semibold text-foreground underline-offset-4 hover:underline">See all trips</Link>
      </div>
    </section>
  )
}
