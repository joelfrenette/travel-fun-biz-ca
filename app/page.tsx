import { Suspense } from "react"
import { Header } from "@/components/header"
import { HeroSection } from "@/components/hero-section"
import { FeaturesSection } from "@/components/features-section"
import { PackagesSection } from "@/components/packages-section"
import { ContactForm } from "@/components/contact-form"
import { Footer } from "@/components/footer"
import { TestimonialsSection } from "@/components/testimonials-section"
import { TopDestinations } from "@/components/top-destinations"
import { listTopDestinationGuides } from "@/lib/guides"
import { getPackages } from "@/lib/packages"
import { getPublishedTestimonials } from "@/lib/testimonials"
import { getVisitorPreferences } from "@/lib/preferences"
import { translate } from "@/lib/i18n"
import { getUsdToRate } from "@/lib/fx"
import { officeInfo, socialPromos } from "@/content/footer"
import Link from "next/link"
import type { Metadata } from "next"
import { SITE_NAME, absoluteUrl, site, pageAlternates } from "@/lib/site"
import { FROM_CITIES, fromPath } from "@/lib/from-cities"

// The layout supplies title and description; the home page adds its own canonical and hreflang (en-CA self, x-default).
export const metadata: Metadata = { alternates: pageAlternates("/") }
import { jsonLdHtml } from "@/lib/jsonld"
import { loadAffiliateRules } from "@/lib/affiliate-rules"
import { homeFieldSet, linkPageFields } from "@/lib/affiliate-text-sources"
import { AffiliateParts, AffiliateAutoDisclosure } from "@/components/affiliate-text"

const organizationJsonLd = {
  "@context": "https://schema.org",
  "@type": "TravelAgency",
  name: SITE_NAME,
  url: absoluteUrl("/"),
  logo: absoluteUrl("/logo.png"),
  ...(officeInfo.phone ? { telephone: officeInfo.phone } : {}),
  address: {
    "@type": "PostalAddress",
    ...(officeInfo.addressLines[0] ? { streetAddress: officeInfo.addressLines[0] } : {}),
    addressLocality: site.address.locality,
    addressRegion: site.address.region,
    ...(site.address.postalCode ? { postalCode: site.address.postalCode } : {}),
    addressCountry: site.country,
  },
  sameAs: socialPromos.map((s) => s.href),
}

export default async function HomePage() {
  const preferences = getVisitorPreferences()
  const { language, currency } = preferences
  const [packages, usdToTargetRate, testimonials, topDestinations, affiliateRules] = await Promise.all([getPackages(), getUsdToRate(currency), getPublishedTestimonials(), listTopDestinationGuides(6), loadAffiliateRules()])
  const packageNames = packages.map((pkg) => pkg.name)
  // Word links (WP23): the home page's own sentences (hero, why choose us, the four benefits, the line above the contact
  // form), in reading order, one shared limit. Fails open (no rules, no links).
  const copy = homeFieldSet(language)
  const linked = linkPageFields(copy.fields, affiliateRules, "pages")

  return (
    <div className="flex min-h-screen flex-col">
      <Header language={language} currency={currency} />
      <main className="flex-1">
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdHtml(organizationJsonLd) }} />
        <HeroSection language={language} descriptionParts={linked.parts(copy.hero)} />
        <PackagesSection
          packages={packages}
          language={language}
          currency={currency}
          usdToTargetRate={usdToTargetRate}
        />
        <TopDestinations items={topDestinations} />
        <FeaturesSection language={language} introParts={linked.parts(copy.featuresIntro)} featureParts={copy.features.map((f) => linked.parts(f))} />

        <TestimonialsSection language={language} testimonials={testimonials} />

        <section className="container mx-auto px-4 py-12" aria-labelledby="plan-from-city">
          <h2 id="plan-from-city" className="text-center text-2xl font-bold text-foreground">{translate(language, "Plan from your city")}</h2>
          <ul className="mt-6 flex flex-wrap justify-center gap-2 text-sm">
            {FROM_CITIES.map((c) => (
              <li key={c.slug}>
                <Link href={fromPath(c)} className="inline-block rounded-full border px-4 py-2 hover:bg-muted">
                  {translate(language, "Group trips from")} {c.city}
                </Link>
              </li>
            ))}
          </ul>
        </section>

        <section id="contact" className="bg-muted/30 py-20">
          <div className="container mx-auto px-4">
            <div className="mb-12 text-center">
              <h2 className="text-balance text-3xl font-bold text-foreground">
                {translate(language, 'Get Your Free Travel Concierge')}
              </h2>
              <p className="mx-auto mt-4 max-w-2xl text-pretty text-muted-foreground">
                <AffiliateParts parts={linked.parts(copy.contact)} />
              </p>
            </div>
            <Suspense fallback={null}>
              <ContactForm packageOptions={packageNames} language={language} phone={site.phone} />
            </Suspense>
            <AffiliateAutoDisclosure count={linked.count} language={language} wrapperClassName="mx-auto mt-6 max-w-2xl text-center" />
          </div>
        </section>
      </main>
      <Footer language={language} />
    </div>
  )
}