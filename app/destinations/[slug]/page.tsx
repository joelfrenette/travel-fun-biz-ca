import type { Metadata } from "next"
import { notFound } from "next/navigation"
import Link from "next/link"
import { MapPin, Calendar } from "lucide-react"
import { Header } from "@/components/header"
import { Footer } from "@/components/footer"
import { PackageCard } from "@/components/package-card"
import { getDestinationPage } from "@/lib/destinations"
import { getVisitorPreferences } from "@/lib/preferences"
import { getUsdToRate } from "@/lib/fx"
import { SITE_NAME, DEFAULT_OG_IMAGE, absoluteUrl, formatDateRange } from "@/lib/site"

export const revalidate = 300

type Props = { params: { slug: string } }

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const page = await getDestinationPage(params.slug)
  if (!page) return { title: `Destination not found | ${SITE_NAME}`, robots: { index: false } }

  const title = `${page.destination} Trips | ${SITE_NAME}`
  const description = `Upcoming group trips, cruises and singles getaways to ${page.destination}, plus real recaps from past trips there.`
  const url = absoluteUrl(`/destinations/${params.slug}`)

  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: { title, description, url, type: "website", images: [{ url: DEFAULT_OG_IMAGE, alt: page.destination }] },
    twitter: { card: "summary_large_image", title, description, images: [DEFAULT_OG_IMAGE] },
  }
}

export default async function DestinationPage({ params }: Props) {
  const page = await getDestinationPage(params.slug)
  if (!page) notFound()

  const { language, currency } = getVisitorPreferences()
  const usdToTargetRate = await getUsdToRate(currency)

  return (
    <div className="flex min-h-screen flex-col">
      <Header language={language} currency={currency} />
      <main className="flex-1">
        <div className="border-b bg-muted/30">
          <div className="container mx-auto px-4 py-10">
            <p className="flex items-center gap-1.5 text-sm text-muted-foreground"><MapPin className="h-4 w-4" />Destination</p>
            <h1 className="mt-1 text-balance text-3xl font-bold uppercase text-foreground sm:text-4xl">{page.destination} Trips</h1>
          </div>
        </div>

        <div className="container mx-auto space-y-12 px-4 py-10">
          {page.upcoming.length > 0 && (
            <section>
              <h2 className="mb-4 text-xl font-bold uppercase text-foreground">Upcoming trips to {page.destination}</h2>
              <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
                {page.upcoming.map((pkg) => (
                  <PackageCard key={pkg.id} package={pkg} language={language} currency={currency} usdToTargetRate={usdToTargetRate} />
                ))}
              </div>
            </section>
          )}

          {page.recaps.length > 0 && (
            <section>
              <h2 className="mb-4 text-xl font-bold uppercase text-foreground">Past trips to {page.destination}</h2>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {page.recaps.map((pkg) => (
                  <Link key={pkg.id} href={`/packages/${pkg.slug}`} className="group flex items-center gap-4 rounded-xl border bg-card p-4 transition-shadow hover:shadow-lg">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={pkg.image_url || DEFAULT_OG_IMAGE} alt={pkg.name} className="h-16 w-24 shrink-0 rounded object-cover" />
                    <div className="min-w-0">
                      <p className="truncate font-medium text-foreground group-hover:underline">{pkg.name}</p>
                      {formatDateRange(pkg.available_from, pkg.available_to) && (
                        <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground"><Calendar className="h-3 w-3" />{formatDateRange(pkg.available_from, pkg.available_to)}</p>
                      )}
                    </div>
                  </Link>
                ))}
              </div>
            </section>
          )}
        </div>
      </main>
      <Footer language={language} />
    </div>
  )
}
