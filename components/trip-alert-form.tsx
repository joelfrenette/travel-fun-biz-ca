"use client"

import { useState } from "react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { useToast } from "@/hooks/use-toast"
import { SITE_NAME, site } from "@/lib/site"
import type { Language } from "@/lib/preferences"
import { translate } from "@/lib/i18n"
import { getAttribution } from "@/lib/attribution"
import { track } from "@/lib/analytics-client"

// "Tell me about the next one" on a past trip's page (WP14): email, an optional name, the CASL consent box (same
// wording as components/newsletter-form.tsx, email only because no phone number is asked for) and the hidden
// honeypot field. Posts to /api/trip-alerts, which reads the trip's tag on the server.
// On a trip page pass `slug`; on a guide, blog, compare or best-time page pass `source` (the page path) instead.
export function TripAlertForm({ slug, source, language, submitLabel }: { slug?: string; source?: string; language: Language; /** Button text; the default is "Tell me about the next one". Consent wording and the sign-up route never change. */ submitLabel?: string }) {
  const { toast } = useToast()
  const [email, setEmail] = useState("")
  const [name, setName] = useState("")
  const [consent, setConsent] = useState(false)
  const [honeypot, setHoneypot] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState("")

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError("")
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) return setError(translate(language, "Enter a valid email"))
    if (!consent) return setError(translate(language, "Please tick the box so we are allowed to email you"))
    setSubmitting(true)
    try {
      const res = await fetch("/api/trip-alerts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, source, email: email.trim(), name: name.trim() || undefined, consent, company_website: honeypot, attribution: getAttribution() }),
      })
      if (res.status === 429) {
        setError(translate(language, "Too many sign-ups from your connection just now. Please wait a few minutes and try again."))
        return
      }
      if (res.status === 400) {
        const body = (await res.json().catch(() => ({}))) as { message?: string }
        setError(body.message || translate(language, "Please check your email address and tick the box."))
        return
      }
      if (!res.ok) throw new Error("failed")
      track("trip_alert_signup", { page_path: window.location.pathname })
      setDone(true)
      toast({ title: translate(language, "You are on the list. We will email you when the next one opens.") })
    } catch {
      setError(translate(language, "Something went wrong. Please try again in a moment."))
    } finally {
      setSubmitting(false)
    }
  }

  if (done) return <p role="status" className="rounded-md border bg-card p-4 text-center font-medium">{translate(language, "You are on the list. We will email you when the next one opens.")}</p>

  return (
    <form onSubmit={onSubmit} className="mx-auto w-full max-w-xl space-y-3 text-left">
      {/* Honeypot: invisible to a real visitor, filled in by form-filling bots (same technique as the newsletter form). */}
      <div className="absolute left-[-9999px] top-auto h-px w-px overflow-hidden" aria-hidden="true">
        <label htmlFor="trip-alert-company_website">Company Website</label>
        <Input id="trip-alert-company_website" tabIndex={-1} autoComplete="off" value={honeypot} onChange={(e) => setHoneypot(e.target.value)} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="trip-alert-email" className="mb-1 block text-sm font-medium">{translate(language, "Enter Your Email *")}</label>
          <Input id="trip-alert-email" type="email" required autoComplete="email" placeholder={translate(language, "Email Address")} value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div>
          <label htmlFor="trip-alert-name" className="mb-1 block text-sm font-medium">{translate(language, "Your name (optional)")}</label>
          <Input id="trip-alert-name" autoComplete="name" placeholder={translate(language, "Full Name")} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
      </div>
      <label htmlFor="trip-alert-consent" className="flex items-start gap-2 text-xs leading-snug text-muted-foreground">
        <input id="trip-alert-consent" type="checkbox" className="mt-0.5 h-4 w-4 shrink-0" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
        <span>
          {translate(language, "Yes, I agree to receive travel deals and updates from")} {SITE_NAME} ({site.addressLines.join(", ")}
          {site.phone ? `, ${site.phone}` : ""}) {translate(language, "by email. I can unsubscribe at any time.")}
        </span>
      </label>
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      <Button type="submit" className="w-full bg-primary font-bold uppercase text-primary-foreground hover:bg-primary/90" disabled={submitting}>
        {submitting ? translate(language, "Submitting...") : (submitLabel ?? translate(language, "Tell me about the next one"))}
      </Button>
    </form>
  )
}
