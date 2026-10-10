import type { Metadata } from "next"
import { notFound } from "next/navigation"
import Link from "next/link"
import { Calendar, MapPin, Clock } from "lucide-react"
import { Header } from "@/components/header"
import { Footer } from "@/components/footer"
import { getBestTimeToVisitPage } from "@/lib/best-time-to-visit"
import { getVisitorPreferences } from "@/lib/preferences"
import { getUsdToRate } from "@/lib/fx"
import { displayPackagePrice } from "@/lib/currency"
import { SITE_NAME, DEFAULT_OG_IMAGE, absoluteUrl, formatDateRange } from "@/lib/site"
import { jsonLdHtml, buildCollectionPageJsonLd, buildFaqPageJsonLd, buildBreadcrumbJsonLd } from "@/lib/jsonld"
import { getPublishedPageCopy, bestTimePath } from "@/lib/page-copy"
import { PageCopyIntro, PageCopyTakeaways, PageCopyFaq } from "@/components/page-copy-parts"

export const revalidate = 300

type Props = { params: { destination: string } }

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const page = await getBestTimeToVisitPage(params.destination)
  if (!page) return { title: `Destination not found | ${SITE_NAME}`, robots: { index: false } }

  // Written copy (when a published row exists) supplies the meta and OG text; otherwise the text below is used as before.
  const copy = await getPublishedPageCopy(bestTimePath(params.destination))
  const title = copy?.meta_title || `Best Time to Visit ${page.destination} | ${SITE_NAME}`
  const description = copy?.meta_description || `The real dates our trips to ${page.destination} run, pulled straight from our current trip calendar, so you can see when a seat is actually available.`
  const ogTitle = copy?.og_title || title
  const ogDescription = copy?.og_description || description
  const url = absoluteUrl(`/best-time-to-visit/${params.destination}`)

  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: { title: ogTitle, description: ogDescription, url, type: "website", images: [{ url: DEFAULT_OG_IMAGE, alt: page.destination }] },
    twitter: { card: "summary_large_image", title: ogTitle, description: ogDescription, images: [DEFAULT_OG_IMAGE] },
  }
}

export default async function BestTimeToVisitPage({ params }: Props) {
  const page = await getBestTimeToVisitPage(params.destination)
  if (!page) notFound()

  const { language, currency } = getVisitorPreferences()
  const usdToTargetRate = await getUsdToRate(currency)
  const pageUrl = absoluteUrl(`/best-time-to-visit/${params.destination}`)

  // Every fact here comes straight from the matched travel_packages rows (name, dates, duration,
  // price, highlights) - never invented weather, temperature or crowd-level content. See
  // lib/best-time-to-visit.ts for the grounding rule this page depends on.
  const jsonLd = buildCollectionPageJsonLd(
    `Best Time to Visit ${page.destination} | ${SITE_NAME}`,
    `The real dates our trips to ${page.destination} run.`,
    pageUrl,
    page.packages,
    absoluteUrl,
  )
  // Written copy, when a published row exists. Adds FAQPage and BreadcrumbList next to the CollectionPage above.
  const copy = await getPublishedPageCopy(bestTimePath(params.destination))
  const structuredData: object[] = [...jsonLd]
  if (copy) {
    structuredData.push(buildBreadcrumbJsonLd([
      { name: "Home", url: absoluteUrl("/") },
      { name: "Destinations", url: absoluteUrl("/destinations") },
      { name: page.destination, url: absoluteUrl(`/destinations/${params.destination}`) },
      { name: `Best time to visit ${page.destination}`, url: pageUrl },
    ]))
    if (copy.faq.length > 0) structuredData.push(buildFaqPageJsonLd(copy.faq))
  }

  return (
    <div className="flex min-h-screen flex-col">
      <Header language={language} currency={currency} />
      <main className="flex-1">
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdHtml(copy ? structuredData : jsonLd) }} />
        <div className="border-b bg-muted/30">
          <div className="container mx-auto px-4 py-10">
            <p className="flex items-center gap-1.5 text-sm text-muted-foreground"><MapPin className="h-4 w-4" />Best Time to Visit</p>
            <h1 className="mt-1 text-balance text-3xl font-bold uppercase text-foreground sm:text-4xl">Best Time to Visit {page.destination}</h1>
            <p className="mt-3 max-w-2xl text-pretty text-muted-foreground">
              Here are the actual dates we run trips to {page.destination}, straight from our current trip calendar.
            </p>
          </div>
        </div>

        <div className="container mx-auto space-y-6 px-4 py-10">
          {copy && (
            <div className="space-y-6">
              <PageCopyIntro copy={copy} />
              <PageCopyTakeaways copy={copy} />
            </div>
          )}
          <section>
            <h2 className="mb-4 text-xl font-bold uppercase text-foreground">
              {page.packages.length === 1 ? "Trip dates" : "Trip dates and departures"} for {page.destination}
            </h2>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {page.packages.map((pkg) => {
                const dates = formatDateRange(pkg.available_from, pkg.available_to)
                const priceDisplay = displayPackagePrice(pkg, currency, usdToTargetRate)
                return (
                  <Link key={pkg.id} href={`/packages/${pkg.slug}`} className="group flex flex-col gap-3 rounded-xl border bg-card p-5 transition-shadow hover:shadow-lg">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={pkg.image_url || DEFAULT_OG_IMAGE} alt={pkg.name} className="h-32 w-full rounded object-cover" />
                    <div>
                      <p className="font-medium text-foreground group-hover:underline">{pkg.name}</p>
                      {dates && (
                        <p className="mt-1 flex items-center gap-1 text-sm text-muted-foreground"><Calendar className="h-3.5 w-3.5" />{dates}</p>
                      )}
                      <p className="mt-1 flex items-center gap-1 text-sm text-muted-foreground"><Clock className="h-3.5 w-3.5" />{pkg.duration}</p>
                      {priceDisplay && <p className="mt-2 text-sm font-semibold text-foreground">{priceDisplay}</p>}
                      {pkg.highlights && pkg.highlights.length > 0 && (
                        <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                          {pkg.highlights.slice(0, 3).map((h) => <li key={h}>• {h}</li>)}
                        </ul>
                      )}
                    </div>
                  </Link>
                )
              })}
            </div>
          </section>

          <section>
            <p className="text-sm text-muted-foreground">
              Looking for more options?{" "}
              <Link href={`/destinations/${params.destination}`} className="font-medium text-foreground hover:underline">
                See all {page.destination} trips
              </Link>
              , including past-trip recaps.
            </p>
          </section>

          {copy && copy.faq.length > 0 && <PageCopyFaq copy={copy} />}
        </div>
      </main>
      <Footer language={language} />
    </div>
  )
}
