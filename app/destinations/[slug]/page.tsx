import type { Metadata } from "next"
import { notFound } from "next/navigation"
import Link from "next/link"
import { MapPin, Calendar } from "lucide-react"
import { Header } from "@/components/header"
import { Footer } from "@/components/footer"
import { PackageCard } from "@/components/package-card"
import { GuideTakeaways, GuideArticle, GuideFaqList, guideJsonLd, guideMetadata } from "@/components/guide-page"
import { getDestinationPage } from "@/lib/destinations"
import { getBestTimeToVisitPage } from "@/lib/best-time-to-visit"
import { getPublicBlurb } from "@/lib/destination-blurbs"
import { getPublishedGuide } from "@/lib/guides"
import { getVisitorPreferences } from "@/lib/preferences"
import { getUsdToRate } from "@/lib/fx"
import { SITE_NAME, DEFAULT_OG_IMAGE, absoluteUrl, formatDateRange } from "@/lib/site"
import { ogImageEntry } from "@/lib/og-path"
import { jsonLdHtml } from "@/lib/jsonld"

export const revalidate = 300

type Props = { params: { slug: string } }

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  // A published guide for this destination supplies the title, description and social text (growth loop
  // WP4). Without one the page is exactly what it was: a trip listing.
  const [page, guide] = await Promise.all([getDestinationPage(params.slug), getPublishedGuide("destinations", params.slug)])
  if (guide) return guideMetadata("destinations", params.slug)
  if (!page) return { title: `Destination not found | ${SITE_NAME}`, robots: { index: false } }

  const title = `${page.destination} Trips | ${SITE_NAME}`
  const description = `Upcoming group trips, cruises and singles getaways to ${page.destination}, plus real recaps from past trips there.`
  const url = absoluteUrl(`/destinations/${params.slug}`)
  const image = ogImageEntry("destinations", params.slug, page.destination)

  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: { title, description, url, type: "website", images: [image] },
    twitter: { card: "summary_large_image", title, description, images: [image.url] },
  }
}

export default async function DestinationPage({ params }: Props) {
  const [page, guide] = await Promise.all([getDestinationPage(params.slug), getPublishedGuide("destinations", params.slug)])
  // A destination with a guide but no published trip yet still has a page (the guide). With neither, it is not found.
  if (!page && !guide) notFound()
  const destination = page?.destination ?? guide!.name
  const upcoming = page?.upcoming ?? []
  const recaps = page?.recaps ?? []

  const { language, currency } = getVisitorPreferences()
  const usdToTargetRate = await getUsdToRate(currency)
  const pageUrl = absoluteUrl(`/destinations/${params.slug}`)
  const blurb = await getPublicBlurb(params.slug)
  // Reuses the same grounding check best-time-to-visit's own page already applies (a real dated
  // published package must exist) rather than re-deriving it from page.upcoming, whose
  // TravelPackage items don't carry available_from/available_to at all.
  const bestTimeToVisit = await getBestTimeToVisitPage(params.slug)

  // A CollectionPage listing the real upcoming trips and past-trip recaps for this destination -
  // the audit script (scripts/audit-live-seo.mjs) flagged every destination page as having no
  // structured data at all. Every item here is a real published/past package, nothing invented.
  // When a guide exists, its TouristDestination, FAQPage and BreadcrumbList are added alongside.
  const allItems = [...upcoming, ...recaps]
  const jsonLd: object[] = []
  if (page) {
    jsonLd.push({
      "@context": "https://schema.org",
      "@type": "CollectionPage",
      name: `${destination} Trips | ${SITE_NAME}`,
      description: `Upcoming group trips, cruises and singles getaways to ${destination}, plus real recaps from past trips there.`,
      url: pageUrl,
      ...(allItems.length > 0
        ? {
            mainEntity: {
              "@type": "ItemList",
              itemListElement: allItems.map((pkg, i) => ({
                "@type": "ListItem",
                position: i + 1,
                url: absoluteUrl(`/packages/${pkg.slug}`),
                name: pkg.name,
              })),
            },
          }
        : {}),
    })
  }
  if (guide) jsonLd.push(...guideJsonLd(guide))

  return (
    <div className="flex min-h-screen flex-col">
      <Header language={language} currency={currency} />
      <main className="flex-1">
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdHtml(jsonLd) }} />
        <div className="border-b bg-muted/30">
          <div className="container mx-auto px-4 py-10">
            <p className="flex items-center gap-1.5 text-sm text-muted-foreground"><MapPin className="h-4 w-4" />Destination</p>
            <h1 className="mt-1 text-balance text-3xl font-bold uppercase text-foreground sm:text-4xl">{page ? `${destination} Trips` : `${destination}: Travel Guide`}</h1>
            {guide ? (
              <p className="mt-3 max-w-3xl text-pretty text-foreground">{guide.summary}</p>
            ) : (
              blurb && <p className="mt-3 max-w-2xl text-pretty text-muted-foreground">{blurb.blurb}</p>
            )}
          </div>
        </div>

        <div className="container mx-auto space-y-12 px-4 py-10">
          {upcoming.length > 0 && (
            <section>
              <h2 className="mb-4 text-xl font-bold uppercase text-foreground">Upcoming trips to {destination}</h2>
              <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
                {upcoming.map((pkg) => (
                  <PackageCard key={pkg.id} package={pkg} language={language} currency={currency} usdToTargetRate={usdToTargetRate} />
                ))}
              </div>
            </section>
          )}

          {guide && (
            <div className="mx-auto max-w-3xl space-y-10">
              {guide.hero_image_url && (
                <figure>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={guide.hero_image_url} alt={guide.hero_alt || guide.name} className="aspect-[16/9] w-full rounded-xl object-cover" />
                  <figcaption className="mt-1.5 text-xs text-muted-foreground">Illustrative stock photo.</figcaption>
                </figure>
              )}
              <GuideTakeaways guide={guide} />
              <GuideArticle guide={guide} />
              <GuideFaqList guide={guide} />
              <div className="rounded-xl border bg-muted/30 p-6 text-center">
                <p className="text-lg font-semibold text-foreground">Thinking about {destination}?</p>
                <p className="mt-1 text-sm text-muted-foreground">Tell us who is travelling and roughly when, and our team will help you work out the right trip.</p>
                <Link href="/#contact" className="mt-4 inline-block rounded-md bg-primary px-6 py-3 text-sm font-bold uppercase text-primary-foreground">Ask us about your trip</Link>
              </div>
            </div>
          )}

          {/* The best-time-to-visit page already links back here ("See all {destination}
              trips") - this completes the reciprocal link. bestTimeToVisit is only non-null when
              a real dated published package exists (upcoming OR past - seasonal timing is still
              meaningful either way), so this never points at a 404. Rendered independently of the
              upcoming/past split above, not nested inside it - a destination whose only dated
              package has since passed (and so sits in "Past trips" instead) still has real
              best-time-to-visit data worth linking to. */}
          {bestTimeToVisit && (
            <p className="text-sm text-muted-foreground">
              <Link href={`/best-time-to-visit/${params.slug}`} className="font-medium text-foreground hover:underline">
                See the best time to visit {destination}
              </Link>
            </p>
          )}

          {recaps.length > 0 && (
            <section>
              <h2 className="mb-4 text-xl font-bold uppercase text-foreground">Past trips to {destination}</h2>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {recaps.map((pkg) => (
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
