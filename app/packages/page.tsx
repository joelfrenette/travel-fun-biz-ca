import type { Metadata } from "next"
import { Header } from "@/components/header"
import { Footer } from "@/components/footer"
import { PackageBrowse } from "@/components/package-browse"
import { getPackagesForBrowse } from "@/lib/packages"
import { getVisitorPreferences } from "@/lib/preferences"
import { getUsdToRate } from "@/lib/fx"
import { SITE_NAME, DEFAULT_OG_IMAGE, absoluteUrl } from "@/lib/site"
import { translate } from "@/lib/i18n"

export const revalidate = 300

export async function generateMetadata(): Promise<Metadata> {
  const title = `All Trips | ${SITE_NAME}`
  const description = "Browse every current trip - filter by travel style, length and upcoming departure dates."
  const url = absoluteUrl("/packages")
  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: { title, description, url, type: "website", images: [{ url: DEFAULT_OG_IMAGE, alt: title }] },
    twitter: { card: "summary_large_image", title, description, images: [DEFAULT_OG_IMAGE] },
  }
}

export default async function PackagesIndexPage() {
  const { language, currency } = getVisitorPreferences()
  const [packages, usdToTargetRate] = await Promise.all([getPackagesForBrowse(), getUsdToRate(currency)])

  return (
    <div className="flex min-h-screen flex-col">
      <Header language={language} currency={currency} />
      <main className="flex-1">
        <section className="py-16">
          <div className="container mx-auto px-4">
            <div className="mb-10 text-center">
              <h1 className="text-balance text-3xl font-bold text-foreground">{translate(language, "All Trips")}</h1>
              <p className="mx-auto mt-3 max-w-2xl text-pretty text-muted-foreground">
                {translate(language, "Every trip we currently offer, in one place - filter by style, length or upcoming departure.")}
              </p>
            </div>
            <PackageBrowse packages={packages} language={language} currency={currency} usdToTargetRate={usdToTargetRate} />
          </div>
        </section>
      </main>
      <Footer language={language} />
    </div>
  )
}
