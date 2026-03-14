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
import { SectionHeading } from "@/components/section-heading"

export default async function HomePage() {
  const packages = await getPackages()
  const packageNames = packages.map((pkg) => pkg.name)
  const { language, currency } = getVisitorPreferences()

  return (
    <div className="flex min-h-screen flex-col">
      <Header language={language} currency={currency} />
      <main className="flex-1">
        <HeroSection language={language} />
        <PackagesSection packages={packages} language={language} currency={currency} />
        <FeaturesSection language={language} />

        <TestimonialsSection language={language} />

        <section id="contact" className="bg-muted/30 py-20">
          <div className="container mx-auto px-4">
            <SectionHeading
              title={translate('Get Your Free Travel Concierge', language)}
              subtitle={translate(
                'Ready to explore the world? Fill out the form below and let us help you plan your dream vacation.',
                language,
              )}
            />
            <div className="mt-12">
              <ContactForm packageOptions={packageNames} language={language} />
            </div>
          </div>
        </section>
      </main>
      <Footer language={language} />
    </div>
  )
}