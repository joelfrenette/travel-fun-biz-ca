import { Card, CardContent } from "@/components/ui/card"
import { featureItems } from "@/content/features"
import { FEATURES_SUBTITLE } from "@/content/home-copy"
import { SectionHeading } from "@/components/section-heading"
import { AffiliateParts } from "@/components/affiliate-text"
import type { Part } from "@/lib/affiliate-linker"
import type { Language } from "@/lib/preferences"
import { translate } from "@/lib/i18n"
import { SITE_NAME } from "@/lib/site"

interface FeaturesSectionProps {
  language: Language
  /** The paragraph under the title and the four benefit blurbs, already processed by the word linker (WP23). Plain text when absent. */
  introParts?: Part[]
  featureParts?: Part[][]
}

export function FeaturesSection({ language, introParts, featureParts }: FeaturesSectionProps) {
  return (
    <section className="py-20 md:py-32">
      <div className="container mx-auto px-4">
        <SectionHeading
          title={`${translate(language, 'Why Choose')} ${SITE_NAME}`}
          subtitle={introParts ? <AffiliateParts parts={introParts} /> : translate(language, FEATURES_SUBTITLE)}
        />

        <div className="mt-16 grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
          {featureItems.map((feature, i) => (
            <Card key={feature.title} className="border-border/50 transition-shadow hover:shadow-lg">
              <CardContent className="flex flex-col items-center p-6 text-center">
                <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10">
                  <feature.icon className="h-6 w-6 text-primary" />
                </div>
                <h3 className="mb-2 text-lg font-semibold text-foreground">
                  {translate(language, feature.title)}
                </h3>
                <p className="text-sm leading-relaxed text-muted-foreground">
                  {featureParts?.[i] ? <AffiliateParts parts={featureParts[i]} /> : translate(language, feature.description)}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </section>
  )
}
