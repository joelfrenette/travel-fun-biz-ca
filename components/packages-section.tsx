import type { TravelPackage } from "@/types/travel"
import { PackageCard } from "@/components/package-card"
import type { Language } from "@/lib/preferences"
import type { Currency } from "@/lib/currency"

interface PackagesSectionProps {
  packages: TravelPackage[]
  language: Language
  currency: Currency
  usdToTargetRate: number
}

export function PackagesSection({ packages, language, currency, usdToTargetRate }: PackagesSectionProps) {
  if (!packages || packages.length === 0) {
    return (
      <section className="py-20">
        <div className="container mx-auto px-4 text-center">
          <p className="text-muted-foreground">No packages available at the moment. Check back soon!</p>
        </div>
      </section>
    )
  }

  return (
    <section className="py-20">
      <div className="container mx-auto px-4">
        <h2 className="mb-6 text-center text-2xl font-bold">Featured Travel Packages</h2>
        <div className="grid gap-6 md:grid-cols-3">
          {packages.map((pkg) => (
            <PackageCard key={pkg.id} package={pkg} language={language} currency={currency} usdToTargetRate={usdToTargetRate} />
          ))}
        </div>
      </div>
    </section>
  )
}