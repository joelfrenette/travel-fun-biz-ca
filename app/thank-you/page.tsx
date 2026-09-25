import type { Metadata } from "next"
import Link from "next/link"
import { CheckCircle2, Phone } from "lucide-react"
import { Header } from "@/components/header"
import { Footer } from "@/components/footer"
import { Button } from "@/components/ui/button"
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
                {translate(language, "Prefer to talk? Call or text")} <a href={`tel:${site.phone.replace(/[^\d+]/g, "")}`} className="font-medium text-foreground underline-offset-4 hover:underline">{site.phone}</a>
              </p>
            )}
            <div className="mt-10 flex flex-wrap justify-center gap-3">
              <Button asChild size="lg" className="font-bold uppercase">
                <Link href="/">{translate(language, "Browse more trips")}</Link>
              </Button>
            </div>
          </div>
        </section>
      </main>
      <Footer language={language} />
    </div>
  )
}
