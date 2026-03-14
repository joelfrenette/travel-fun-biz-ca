import { Header } from "@/components/header"
import { HeroSection } from "@/components/hero-section"
import { FeaturesSection } from "@/components/features-section"
import { PackagesSection } from "@/components/packages-section"
import { ContactForm } from "@/components/contact-form"
import { Footer } from "@/components/footer"
import { TestimonialsSection } from "@/components/testimonials-section"
import { getPackages } from "@/lib/packages"
import { SectionHeading } from "@/components/section-heading"

export default async function HomePage() {
  const packages = await getPackages()
  const packageNames = packages.map((pkg) => pkg.name)

  return (
    <div className="flex min-h-screen flex-col">
      <Header />
      <main className="flex-1">
        <HeroSection />
        <PackagesSection packages={packages} />
        <FeaturesSection />

        <TestimonialsSection />

        <section id="contact" className="bg-muted/30 py-20">
          <div className="container mx-auto px-4">
            <SectionHeading
              title="Get Your Free Travel Concierge"
              subtitle="Ready to explore the world? Fill out the form below and let us help you plan your dream vacation."
            />
            <div className="mt-12">
              <ContactForm packageOptions={packageNames} />
            </div>
          </div>
        </section>
      </main>
      <Footer />
    </div>
  )
}