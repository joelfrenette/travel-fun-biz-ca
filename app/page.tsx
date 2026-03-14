import { Header } from "@/components/header"
import { HeroSection } from "@/components/hero-section"
import { FeaturesSection } from "@/components/features-section"
import { PackagesSection } from "@/components/packages-section"
import { ContactForm } from "@/components/contact-form"
import { Footer } from "@/components/footer"
import { TestimonialsSection } from "@/components/testimonials-section"
import { getPackages } from "@/lib/packages"
import { getVisitorPreferences } from "@/lib/preferences"
import { translate } from "@/lib/i18n"
import { getUsdToCadRate } from "@/lib/fx"

export default async function HomePage() {
  const preferences = getVisitorPreferences()
  const [packages, usdToCadRate] = await Promise.all([getPackages(), getUsdToCadRate()])
  const packageNames = packages.map((pkg) => pkg.name)
  const { language, currency } = preferences

  return (
    <div className="flex min-h-screen flex-col">
      <Header language={language} currency={currency} />
      <main className="flex-1">
        <HeroSection language={language} />
        <PackagesSection
          packages={packages}
          language={language}
          currency={currency}
          usdToCadRate={usdToCadRate}
        />
        <FeaturesSection language={language} />

        <TestimonialsSection language={language} />

        <section id="contact" className="bg-muted/30 py-20">
          <div className="container mx-auto px-4">
            <div className="mb-12 text-center">
              <h2 className="text-balance text-3xl font-bold text-foreground">
                {translate(language, 'Get Your Free Travel Concierge')}
              </h2>
              <p className="mx-auto mt-4 max-w-2xl text-pretty text-muted-foreground">
                {translate(
                  language,
                  'Ready to explore the world? Fill out the form below and let us help you plan your dream vacation.',
                )}
              </p>
            </div>
            <ContactForm packageOptions={packageNames} language={language} />
          </div>
        </section>
      </main>
      <Footer language={language} />
    </div>
  )
}