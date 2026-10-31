"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { SITE_NAME, site } from "@/lib/site"
import type { Language } from "@/lib/preferences"
import { translate } from "@/lib/i18n"
import { getAttribution } from "@/lib/attribution"
import { track } from "@/lib/analytics-client"
import { itineraryFormProblem } from "@/lib/itinerary-form"

// "Send me the itinerary and dates" on an upcoming trip's page (lib/itinerary-magnet.ts). Only drawn when app_settings
// itinerary_magnet_mode is "on". Name, email, optional phone, the UNTICKED CASL consent box (same wording as
// components/trip-alert-form.tsx) and the hidden honeypot. Posts to /api/itinerary-request, then opens the private itinerary page.
// The trip quiz (components/trip-quiz-result.tsx, lib/trip-quiz.ts) reuses this form as is: it passes `quiz` (the four answers and the
// matched trip slugs, the first being `slug`) and its own button words, and the request goes through the same route and lead path.
export function ItineraryRequestForm({ slug, language, quiz, submitLabel }: { slug: string; language: Language; quiz?: { who: string; style: string; when: string; length: string; slugs: string[] }; submitLabel?: string }) {
  const router = useRouter()
  const [email, setEmail] = useState("")
  const [name, setName] = useState("")
  const [phone, setPhone] = useState("")
  const [consent, setConsent] = useState(false)
  const [honeypot, setHoneypot] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState("")

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError("")
    // The consent box must be ticked by the visitor: unticked, nothing is sent.
    const problem = itineraryFormProblem({ name, email, consent })
    if (problem) return setError(translate(language, problem))
    setSubmitting(true)
    try {
      const res = await fetch("/api/itinerary-request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, name: name.trim(), email: email.trim(), phone: phone.trim() || undefined, consent, company_website: honeypot, attribution: getAttribution(), ...(quiz ? { quiz } : {}) }),
      })
      if (res.status === 429) return setError(translate(language, "Too many requests from your connection just now. Please wait a few minutes and try again."))
      if (res.status === 400) {
        const body = (await res.json().catch(() => ({}))) as { message?: string }
        return setError(body.message || translate(language, "Please check your details and tick the box."))
      }
      const body = (await res.json().catch(() => ({}))) as { url?: string; error?: string }
      if (!res.ok || !body.url) return setError(body.error || translate(language, "Something went wrong. Please try again in a moment."))
      track("itinerary_request", { page_path: window.location.pathname })
      router.push(body.url)
    } catch {
      setError(translate(language, "Something went wrong. Please try again in a moment."))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={onSubmit} className="mx-auto w-full max-w-xl space-y-3 text-left">
      {/* Honeypot: invisible to a real visitor, filled in by form-filling bots (same technique as the trip alert form). */}
      <div className="absolute left-[-9999px] top-auto h-px w-px overflow-hidden" aria-hidden="true">
        <label htmlFor="itinerary-company_website">Company Website</label>
        <Input id="itinerary-company_website" tabIndex={-1} autoComplete="off" value={honeypot} onChange={(e) => setHoneypot(e.target.value)} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="itinerary-name" className="mb-1 block text-sm font-medium">{translate(language, "Full Name")} *</label>
          <Input id="itinerary-name" required autoComplete="name" placeholder={translate(language, "Full Name")} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <label htmlFor="itinerary-email" className="mb-1 block text-sm font-medium">{translate(language, "Enter Your Email *")}</label>
          <Input id="itinerary-email" type="email" required autoComplete="email" placeholder={translate(language, "Email Address")} value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
      </div>
      <div>
        <label htmlFor="itinerary-phone" className="mb-1 block text-sm font-medium">{translate(language, "Phone Number")} ({translate(language, "optional")})</label>
        <Input id="itinerary-phone" type="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
      </div>
      <label htmlFor="itinerary-consent" className="flex items-start gap-2 text-xs leading-snug text-muted-foreground">
        <input id="itinerary-consent" type="checkbox" className="mt-0.5 h-4 w-4 shrink-0" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
        <span>
          {translate(language, "Yes, I agree to receive travel deals and updates from")} {SITE_NAME} ({site.addressLines.join(", ")}
          {site.phone ? `, ${site.phone}` : ""}) {translate(language, "by email. I can unsubscribe at any time.")}
        </span>
      </label>
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      <Button type="submit" className="w-full bg-primary font-bold uppercase text-primary-foreground hover:bg-primary/90" disabled={submitting}>
        {submitting ? translate(language, "Submitting...") : translate(language, submitLabel ?? "Send me the itinerary and dates")}
      </Button>
    </form>
  )
}
