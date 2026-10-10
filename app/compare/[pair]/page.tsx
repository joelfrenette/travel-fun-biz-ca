import type { Metadata } from "next"
import { notFound } from "next/navigation"
import Link from "next/link"
import { Calendar, MapPin, Clock } from "lucide-react"
import { Header } from "@/components/header"
import { Footer } from "@/components/footer"
import { getComparePage, type ComparePageSide } from "@/lib/compare-destinations"
import { getVisitorPreferences } from "@/lib/preferences"
import { getUsdToRate } from "@/lib/fx"
import { displayPackagePrice, type Currency } from "@/lib/currency"
import { SITE_NAME, DEFAULT_OG_IMAGE, absoluteUrl, formatDateRange } from "@/lib/site"
import { ogImageEntry } from "@/lib/og-path"
import { jsonLdHtml, buildCollectionPageJsonLd } from "@/lib/jsonld"
import type { DbPackage } from "@/lib/packages"

export const revalidate = 300

type Props = { params: { pair: string } }

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const page = await getComparePage(params.pair)
  if (!page) return { title: `Comparison not found | ${SITE_NAME}`, robots: { index: false } }

  const title = `${page.a.destination} vs ${page.b.destination} Trips | ${SITE_NAME}`
  const description = `See what our real ${page.a.destination} and ${page.b.destination} trips include side by side - duration, price and highlights, straight from our current trip list.`
  const url = absoluteUrl(`/compare/${params.pair}`)
  const image = ogImageEntry("compare", params.pair, `${page.a.destination} vs ${page.b.destination}`)

  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: { title, description, url, type: "website", images: [image] },
    twitter: { card: "summary_large_image", title, description, images: [image.url] },
  }
}

export default async function ComparePage({ params }: Props) {
  const page = await getComparePage(params.pair)
  if (!page) notFound()

  const { language, currency } = getVisitorPreferences()
  const usdToTargetRate = await getUsdToRate(currency)
  const pageUrl = absoluteUrl(`/compare/${params.pair}`)

  // Every fact here comes straight from the two destinations' matched travel_packages rows
  // (name, duration, price, highlights, dates) - never an invented climate, safety or "which is
  // better" claim. See lib/compare-destinations.ts for the grounding rule this page depends on.
  const jsonLd = buildCollectionPageJsonLd(
    `${page.a.destination} vs ${page.b.destination} Trips | ${SITE_NAME}`,
    `Real trip details for ${page.a.destination} and ${page.b.destination}, side by side.`,
    pageUrl,
    [...page.a.packages, ...page.b.packages],
    absoluteUrl,
  )

  return (
    <div className="flex min-h-screen flex-col">
      <Header language={language} currency={currency} />
      <main className="flex-1">
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdHtml(jsonLd) }} />
        <div className="border-b bg-muted/30">
          <div className="container mx-auto px-4 py-10">
            <p className="flex items-center gap-1.5 text-sm text-muted-foreground"><MapPin className="h-4 w-4" />Compare Destinations</p>
            <h1 className="mt-1 text-balance text-3xl font-bold uppercase text-foreground sm:text-4xl">
              {page.a.destination} vs {page.b.destination}
            </h1>
            <p className="mt-3 max-w-2xl text-pretty text-muted-foreground">
              Here&apos;s what each trip includes, straight from our current trip list, so you can compare for yourself.
            </p>
          </div>
        </div>

        <div className="container mx-auto grid gap-8 px-4 py-10 sm:grid-cols-2">
          <DestinationColumn side={page.a} currency={currency} usdToTargetRate={usdToTargetRate} />
          <DestinationColumn side={page.b} currency={currency} usdToTargetRate={usdToTargetRate} />
        </div>
      </main>
      <Footer language={language} />
    </div>
  )
}

function DestinationColumn({
  side,
  currency,
  usdToTargetRate,
}: {
  side: ComparePageSide
  currency: Currency
  usdToTargetRate: number
}) {
  return (
    <section>
      <h2 className="mb-4 text-xl font-bold uppercase text-foreground">{side.destination}</h2>
      <div className="space-y-4">
        {side.packages.map((pkg: DbPackage) => {
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
                {pkg.price_includes && <p className="mt-1 text-xs text-muted-foreground">Includes: {pkg.price_includes}</p>}
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
      <p className="mt-4 text-sm text-muted-foreground">
        <Link href={`/destinations/${side.slug}`} className="font-medium text-foreground hover:underline">
          See all {side.destination} trips
        </Link>
      </p>
    </section>
  )
}
