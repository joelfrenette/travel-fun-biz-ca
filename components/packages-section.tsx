import { PackageCard, type TravelPackage } from "@/components/package-card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

interface PackagesSectionProps {
  packages: TravelPackage[]
}

export function PackagesSection({ packages }: PackagesSectionProps) {
  // Get unique categories
  const categories = ["All", ...Array.from(new Set(packages.map((pkg) => pkg.category)))]

  return (
    <section id="packages" className="py-20 md:py-32">
      <div className="container mx-auto px-4">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-balance text-3xl font-bold tracking-tight text-foreground sm:text-4xl md:text-5xl">
            Featured Travel Packages
          </h2>
          <p className="mt-4 text-pretty text-lg leading-relaxed text-muted-foreground">
            Discover handpicked destinations and experiences tailored for unforgettable adventures.
          </p>
        </div>

        <Tabs defaultValue="All" className="mt-12">
          <TabsList className="mx-auto flex w-full max-w-2xl flex-wrap justify-center">
            {categories.map((category) => (
              <TabsTrigger key={category} value={category} className="px-6">
                {category}
              </TabsTrigger>
            ))}
          </TabsList>

          {categories.map((category) => (
            <TabsContent key={category} value={category} className="mt-8">
              <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-3">
                {packages
                  .filter((pkg) => category === "All" || pkg.category === category)
                  .map((pkg) => (
                    <PackageCard key={pkg.id} package={pkg} />
                  ))}
              </div>
            </TabsContent>
          ))}
        </Tabs>

        {packages.length === 0 && (
          <div className="mt-12 text-center">
            <p className="text-muted-foreground">No packages available at the moment. Check back soon!</p>
          </div>
        )}
      </div>
    </section>
  )
}
