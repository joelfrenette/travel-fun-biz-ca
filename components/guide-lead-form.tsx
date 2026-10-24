"use client"

import { useRef, useState, type FormEvent } from "react"
import { useRouter } from "next/navigation"
import { getAttribution } from "@/lib/attribution"
import { trackLeadSubmitted } from "@/lib/ga4-events"
import { trackConversion } from "@/lib/conversion-events"
import {
  buildGuideLeadPayload,
  classifyGuideFormFailure,
  guideFormMessage,
  guideFormMissing,
  type GuideFormFailure,
} from "@/lib/guide-lead-form"

export { buildGuideLeadPayload }

// Inline enquiry form inside the guide page call to action (#guide-cta). Posts to the existing /api/submit-lead with the
// guide's linked trip (else Custom Package) and the visitor's attribution, then goes to /thank-you like the contact form.

const inputClass = "w-full rounded-md border bg-background px-3 py-2 text-sm text-foreground"

export function GuideLeadForm({ packageName, phone, topic }: { packageName?: string | null; phone?: string | null; topic?: string | null }) {
  const router = useRouter()
  const started = useRef(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (busy) return
    const form = new FormData(e.currentTarget)
    const get = (k: string) => String(form.get(k) ?? "")
    if (guideFormMissing({ name: get("name"), email: get("email") }).length > 0) {
      setError(guideFormMessage("invalid", phone))
      return
    }
    const payload = buildGuideLeadPayload({
      name: get("name"),
      email: get("email"),
      phone: get("phone"),
      message: get("message"),
      topic,
      honeypot: get("company_website"),
      packageName,
      attribution: getAttribution(),
      submittedAt: new Date().toISOString(),
    })
    setBusy(true)
    setError(null)
    let failure: GuideFormFailure | null = null
    try {
      const res = await fetch("/api/submit-lead", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
      if (!res.ok) failure = classifyGuideFormFailure(res.status)
    } catch {
      failure = classifyGuideFormFailure(null)
    }
    if (failure) {
      setError(guideFormMessage(failure, phone))
      setBusy(false)
      return
    }
    trackLeadSubmitted({ tripName: payload.package, source: payload.attribution?.utm_source, intent: "info", method: "guide_form" })
    trackConversion("form_submit", { form_id: "guide_form" })
    router.push(`/thank-you?package=${encodeURIComponent(payload.package)}`)
  }

  return (
    <form
      onSubmit={onSubmit}
      onFocusCapture={() => {
        if (started.current) return
        started.current = true
        trackConversion("form_start", { form_id: "guide_form" })
      }}
      className="mx-auto mt-5 max-w-md space-y-3 text-left" aria-label="Send us an enquiry">
      {/* Honeypot: invisible to a real visitor, filled in by form-filling bots. */}
      <div className="absolute left-[-9999px] top-auto h-px w-px overflow-hidden" aria-hidden="true">
        <label htmlFor="guide-company-website">Company Website</label>
        <input id="guide-company-website" name="company_website" tabIndex={-1} autoComplete="off" defaultValue="" />
      </div>
      <div>
        <label htmlFor="guide-lead-name" className="mb-1 block text-sm font-medium text-foreground">Your name</label>
        <input id="guide-lead-name" name="name" required autoComplete="name" className={inputClass} />
      </div>
      <div>
        <label htmlFor="guide-lead-email" className="mb-1 block text-sm font-medium text-foreground">Email address</label>
        <input id="guide-lead-email" name="email" type="email" required autoComplete="email" className={inputClass} />
      </div>
      <div>
        <label htmlFor="guide-lead-phone" className="mb-1 block text-sm font-medium text-foreground">Phone (optional)</label>
        <input id="guide-lead-phone" name="phone" type="tel" autoComplete="tel" className={inputClass} />
      </div>
      <div>
        <label htmlFor="guide-lead-message" className="mb-1 block text-sm font-medium text-foreground">Anything we should know? (optional)</label>
        <input id="guide-lead-message" name="message" maxLength={300} className={inputClass} />
      </div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <button type="submit" disabled={busy} className="w-full rounded-md bg-primary px-6 py-3 text-sm font-bold uppercase text-primary-foreground disabled:opacity-60">
        {busy ? "Sending..." : "Send my enquiry"}
      </button>
      {/* Same sentence the contact form shows under its button. */}
      <p className="text-center text-xs text-muted-foreground">By submitting this form, you agree to our privacy policy and terms of service.</p>
    </form>
  )
}
