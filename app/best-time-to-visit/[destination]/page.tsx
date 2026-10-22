import type { Metadata } from "next"
import { notFound } from "next/navigation"
import Link from "next/link"
import { Calendar, MapPin, Clock } from "lucide-react"
import { Header } from "@/components/header"
import { Footer } from "@/components/footer"
import { PageSignupBox } from "@/components/page-signup-box"
import { getBestTimeToVisitPage } from "@/lib/best-time-to-visit"
import { getVisitorPreferences } from "@/lib/preferences"
import { getUsdToRate } from "@/lib/fx"
import { displayPackagePrice } from "@/lib/currency"
import { SITE_NAME, DEFAULT_OG_IMAGE, absoluteUrl, formatDateRange, priceOnRequestLine } from "@/lib/site"
import { ogImageEntry } from "@/lib/og-path"
import { jsonLdHtml, buildCollectionPageJsonLd, buildFaqPageJsonLd, buildBreadcrumbJsonLd } from "@/lib/jsonld"
import { bestTimePath } from "@/lib/page-copy"
import { getUsablePageCopy } from "@/lib/page-copy-render"
import { copyRobots } from "@/lib/page-copy-index"
import { GuideCta } from "@/components/guide-cta"
import { PageCopyIntro, PageCopyTakeaways, PageCopyFaq } from "@/components/page-copy-parts"
import { AffiliateAutoDisclosure } from "@/components/affiliate-text"
import { loadAffiliateRules } from "@/lib/affiliate-rules"
import { pageCopyFieldSet, linkPageFields } from "@/lib/affiliate-text-sources"

export const revalidate = 300

type Props = { params: { destination: string } }

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const page = await getBestTimeToVisitPage(params.destination)
  if (!page) return { title: `Destination not found | ${SITE_NAME}`, robots: { index: false } }

  // Written copy (when a published row exists) supplies the meta and OG text; otherwise the text below is used as before.
  const copy = await getUsablePageCopy(bestTimePath(params.destination), page.packages.map((p) => p.slug))
  const title = (copy?.meta_title ? `${copy.meta_title} | ${SITE_NAME}` : null) || `Best Time to Visit ${page.destination} | ${SITE_NAME}`
  const description = copy?.meta_description || `The real dates our trips to ${page.destination} run, pulled straight from our current trip calendar, so you can see when a seat is actually available.`
  const ogTitle = copy?.og_title || title
  const ogDescription = copy?.og_description || description
  const url = absoluteUrl(`/best-time-to-visit/${params.destination}`)
  const image = ogImageEntry("best-time-to-visit", params.destination, `Best time to visit ${page.destination}`)

  return {
    title,
    description,
    alternates: { canonical: url },
    // No usable written copy yet: keep the page reachable but out of the index (links still followed).
    ...(copyRobots(!!copy) ? { robots: copyRobots(!!copy) } : {}),
    openGraph: { title: ogTitle, description: ogDescription, url, type: "website", images: [image] },
    twitter: { card: "summary_large_image", title: ogTitle, description: ogDescription, images: [image.url] },
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
  const copy = await getUsablePageCopy(bestTimePath(params.destination), page.packages.map((p) => p.slug), true)
  // Word links (WP23): the copy's intro, takeaways and FAQ answers, in reading order, one shared limit. Fails open (no rules).
  const affiliateRules = await loadAffiliateRules()
  const copySet = pageCopyFieldSet(copy, "best-time")
  const linked = linkPageFields(copySet.fields, affiliateRules, "pages")
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
              <PageCopyIntro copy={copy} html={copySet.intro ? linked.html(copySet.intro) : undefined} />
              <PageCopyTakeaways copy={copy} parts={copySet.takeaways.map((f) => linked.parts(f))} />
            </div>
          )}
          <section>
            <h2 className="mb-4 text-xl font-bold uppercase text-foreground">
              {page.packages.length === 1 ? "Trip dates" : "Trip dates and departures"} for {page.destination}
            </h2>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {page.packages.map((pkg) => {
                const dates = formatDateRange(pkg.available_from, pkg.available_to)
                // Inside a link, so plain text (no nested tel link): price on request shows our number, never a host's.
                const priceDisplay = displayPackagePrice(pkg, currency, usdToTargetRate) || (pkg.price_on_request === true ? priceOnRequestLine().text : "")
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

          {copy && copy.faq.length > 0 && <PageCopyFaq copy={copy} answers={copySet.faq.map((f) => linked.parts(f))} />}
          <AffiliateAutoDisclosure count={linked.count} language={language} />
          <GuideCta name={page.destination} packageName={page.packages[0]?.name} />
          <PageSignupBox path={`/best-time-to-visit/${params.destination}`} language={language} />
        </div>
      </main>
      <Footer language={language} />
    </div>
  )
}
