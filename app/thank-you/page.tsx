import type { Metadata } from "next"
import Link from "next/link"
import { CheckCircle2, Phone } from "lucide-react"
import { Header } from "@/components/header"
import { Footer } from "@/components/footer"
import { PhoneLink } from "@/components/phone-link"
import { Button } from "@/components/ui/button"
import { TripAlertForm } from "@/components/trip-alert-form"
import { ThankYouTrack } from "@/components/thank-you-track"
import { getVisitorPreferences } from "@/lib/preferences"
import { translate } from "@/lib/i18n"
import { site, SITE_NAME } from "@/lib/site"

// Landing page after a lead form submit. One clean URL for GA4 and ad-platform conversions;
// noindex so it never shows up in search results.
export const metadata: Metadata = {
  title: `Thank you | ${SITE_NAME}`,
  robots: { index: false, follow: false },
}

export default function ThankYouPage({ searchParams }: { searchParams: { package?: string } }) {
  const { language, currency } = getVisitorPreferences()
  const pkg = (searchParams.package || "").trim().slice(0, 120)

  return (
    <div className="flex min-h-screen flex-col">
      <Header language={language} currency={currency} />
      <main className="flex-1">
        <section className="container mx-auto px-4 py-20">
          <div className="mx-auto max-w-xl text-center">
            <CheckCircle2 className="mx-auto mb-6 h-16 w-16 text-green-600" aria-hidden="true" />
            <h1 className="text-balance text-3xl font-bold text-foreground sm:text-4xl">{translate(language, "Thank You!")}</h1>
            <p className="mt-4 text-pretty text-lg text-muted-foreground">{translate(language, "We've received your inquiry and will contact you soon.")}</p>
            {pkg && (
              <p className="mt-2 text-sm text-muted-foreground">
                {translate(language, "Your request")}: <span className="font-medium text-foreground">{pkg}</span>
              </p>
            )}
            {site.phone && (
              <p className="mt-6 flex items-center justify-center gap-2 text-sm text-muted-foreground">
                <Phone className="h-4 w-4" aria-hidden="true" />
                {translate(language, "Prefer to talk? Call or text")} <PhoneLink href={`tel:${site.phone.replace(/[^\d+]/g, "")}`} method="thank_you" className="font-medium text-foreground underline-offset-4 hover:underline">{site.phone}</PhoneLink>
              </p>
            )}
            <div className="mt-10 flex flex-wrap justify-center gap-3">
              <Button asChild size="lg" className="font-bold uppercase">
                <Link href="/">{translate(language, "Browse more trips")}</Link>
              </Button>
            </div>

            {/* Conversion loop: a next step for the visitor. No promise about how fast we reply. */}
            <section aria-labelledby="thank-you-next" className="mt-12 rounded-xl border bg-card p-6 text-left shadow-sm">
              <h2 id="thank-you-next" className="text-lg font-bold text-foreground">What happens next</h2>
              <p className="mt-1 text-sm text-muted-foreground">A travel advisor reads your enquiry and replies by email.</p>
              <p className="mt-4 text-sm font-medium text-foreground">Want to hear about our next trips too?</p>
              <div className="mt-3">
                <TripAlertForm source="/thank-you" language={language} />
              </div>
            </section>
          </div>
          <ThankYouTrack />
        </section>
      </main>
      <Footer language={language} />
    </div>
  )
}
