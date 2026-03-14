import { PackageCard } from "@/components/package-card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import type { TravelPackage } from "@/types/travel"
import type { Currency, Language } from "@/lib/preferences"
import { translate } from "@/lib/i18n"
import { SectionHeading } from "@/components/section-heading"

interface PackagesSectionProps {
  packages: TravelPackage[]
  language: Language
  currency: Currency
}

export function PackagesSection({ packages, language, currency }: PackagesSectionProps) {
  // Get unique categories
  const categories = ["All", ...Array.from(new Set(packages.map((pkg) => pkg.category)))] 

  return (
    <section id="packages" className="py-20 md:py-32">
      <div className="container mx-auto px-4">
        <SectionHeading
          title={translate('Featured Travel Packages', language)}
          subtitle={translate('Discover handpicked destinations and experiences tailored for unforgettable adventures.', language)}
        />

        <Tabs defaultValue="All" className="mt-12">
          <TabsList className="mx-auto flex w-full max-w-2xl flex-wrap justify-center">
            {categories.map((category) => (
              <TabsTrigger key={category} value={category} className="px-6">
                {translate(category, language)}
              </TabsTrigger>
            ))}
          </TabsList>

          {categories.map((category) => (
            <TabsContent key={category} value={category} className="mt-8">
              <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-3">
                {packages
                  .filter((pkg) => category === "All" || pkg.category === category)
                  .map((pkg) => (
                    <PackageCard key={pkg.id} package={pkg} language={language} currency={currency} />
                  ))}
              </div>
            </TabsContent>
          ))}
        </Tabs>

        {packages.length === 0 && (
          <div className="mt-12 text-center">
            <p className="text-muted-foreground">{translate('No packages available at the moment. Check back soon!', language)}</p>
          </div>
        )}
      </div>
    </section>
  )
}