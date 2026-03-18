import { Card, CardContent } from "@/components/ui/card"
import { featureItems } from "@/content/features"
import { SectionHeading } from "@/components/section-heading"
import type { Language } from "@/lib/preferences"
import { translate } from "@/lib/i18n"

interface FeaturesSectionProps {
  language: Language
}

export function FeaturesSection({ language }: FeaturesSectionProps) {
  return (
    <section className="py-20 md:py-32">
      <div className="container mx-auto px-4">
        <SectionHeading
          title={translate(language, 'Why Choose TravelFunBiz.CA')}
          subtitle={translate(
            language,
            "When you work with us, you save time, you save stress, you save money. We take care of all the hard work with a FREE dedicated experience concierge. That's right—you don't pay more! We meet or beat what you can get on your own. We get paid by the suppliers for bringing them millions in business, and we get group rates and exclusive offers that we pass on to YOU.",
          )}
        />

        <div className="mt-16 grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
          {featureItems.map((feature) => (
            <Card key={feature.title} className="border-border/50 transition-shadow hover:shadow-lg">
              <CardContent className="flex flex-col items-center p-6 text-center">
                <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10">
                  <feature.icon className="h-6 w-6 text-primary" />
                </div>
                <h3 className="mb-2 text-lg font-semibold text-foreground">
                  {translate(language, feature.title)}
                </h3>
                <p className="text-sm leading-relaxed text-muted-foreground">
                  {translate(language, feature.description)}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </section>
  )
}