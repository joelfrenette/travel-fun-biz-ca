import type { Metadata } from "next"
import { Suspense } from "react"
import Link from "next/link"
import { notFound } from "next/navigation"
import { Calendar, Clock, MapPin } from "lucide-react"
import { Header } from "@/components/header"
import { Footer } from "@/components/footer"
import { ContactForm } from "@/components/contact-form"
import { PhoneLink } from "@/components/phone-link"
import { getAllPublishedPackages } from "@/lib/package-grouping"
import { listPublishedGuideLinks, pickTopDestinationGuides, guidePath } from "@/lib/guides"
import { getVisitorPreferences } from "@/lib/preferences"
import { generateSlug } from "@/lib/utils"
import { SITE_NAME, absoluteUrl, formatDateRange, pageAlternates, priceOnRequestLine, site } from "@/lib/site"
import { jsonLdHtml, buildBreadcrumbJsonLd, buildFaqPageJsonLd } from "@/lib/jsonld"
import { FROM_CITIES, fromCityBySlug, fromDescription, fromFaq, fromHeading, fromPath, fromTitle, isFromPageIndexable, otherCities, upcomingTrips } from "@/lib/from-cities"

export const revalidate = 300
export const dynamicParams = false

type Props = { params: { city: string } }

export function generateStaticParams() {
  return FROM_CITIES.map((c) => ({ city: c.slug }))
}

async function loadTrips() {
  // Never throws (getAllPublishedPackages logs and returns [] on a read error): a failed read renders the honest no-trips page.
  return upcomingTrips(await getAllPublishedPackages())
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const city = fromCityBySlug(params.city)
  if (!city) return { title: `Page not found | ${SITE_NAME}`, robots: { index: false } }
  const trips = await loadTrips()
  const title = fromTitle(city, SITE_NAME)
  const description = fromDescription(city, trips.length)
  const url = absoluteUrl(fromPath(city))
  return {
    title,
    description,
    alternates: pageAlternates(fromPath(city)),
    ...(isFromPageIndexable(trips.length) ? {} : { robots: { index: false, follow: true } }),
    openGraph: { title, description, url, type: "website", siteName: SITE_NAME },
    twitter: { card: "summary", title, description },
  }
}

export default async function FromCityPage({ params }: Props) {
  const city = fromCityBySlug(params.city)
  if (!city) notFound()

  const { language, currency } = getVisitorPreferences()
  const [trips, links] = await Promise.all([loadTrips(), listPublishedGuideLinks()])
  const heading = fromHeading(city)
  const pageUrl = absoluteUrl(fromPath(city))
  const request = priceOnRequestLine()
  const faq = fromFaq(city, trips, site.phone.trim())
  const destinations = Array.from(new Map(trips.map((t) => [generateSlug(t.destination), t.destination] as const)).entries()).filter(([slug]) => slug)
  const guides = pickTopDestinationGuides(links, 6)

  const jsonLd = [
    { "@context": "https://schema.org", "@type": "WebPage", name: heading, url: pageUrl, description: fromDescription(city, trips.length), isPartOf: { "@type": "WebSite", name: SITE_NAME, url: absoluteUrl("/") } },
    buildBreadcrumbJsonLd([{ name: "Home", url: absoluteUrl("/") }, { name: `From ${city.city}`, url: pageUrl }]),
    buildFaqPageJsonLd(faq),
  ]

  return (
    <div className="flex min-h-screen flex-col">
      <Header language={language} currency={currency} />
      <main className="flex-1">
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdHtml(jsonLd) }} />

        <section className="bg-muted/30 py-12">
          <div className="container mx-auto px-4">
            <nav aria-label="Breadcrumb" className="mb-4 text-sm text-muted-foreground">
              <Link href="/" className="hover:underline">Home</Link> <span aria-hidden="true">/</span> <span>From {city.city}</span>
            </nav>
            <h1 className="text-balance text-3xl font-bold text-foreground sm:text-4xl">{heading}</h1>
            <p className="mt-4 max-w-3xl text-pretty text-muted-foreground">
              {trips.length > 0
                ? `Hosted group trips and cruises you can plan from ${city.city}. Our main airport here is ${city.airportName} (${city.airportCode}). Pick a trip below, then ask us how to get there from ${city.city}.`
                : `We do not have an upcoming trip listed right now. Ask us what is coming next and how you would get there from ${city.city} (${city.airportCode}).`}
            </p>
            <div className="mt-6 flex flex-wrap gap-3">
              <a href="#contact" className="inline-flex items-center rounded-md bg-primary px-5 py-3 text-sm font-bold uppercase text-primary-foreground hover:bg-primary/90">
                Ask us about flights from {city.city}
              </a>
              {request.phone && (
                <PhoneLink href={request.telHref} method="from_city_hero" className="inline-flex items-center rounded-md border px-5 py-3 text-sm font-semibold hover:bg-muted">
                  Call or text {request.phone}
                </PhoneLink>
              )}
            </div>
          </div>
        </section>

        {trips.length > 0 && (
          <section className="container mx-auto px-4 py-12" aria-labelledby="from-trips">
            <h2 id="from-trips" className="mb-6 text-2xl font-bold">Trips you can plan from {city.city}</h2>
            <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {trips.map((t) => {
                const dates = formatDateRange(t.available_from, t.available_to)
                return (
                  <li key={t.slug} className="rounded-lg border bg-card p-5">
                    <h3 className="text-lg font-semibold"><Link href={`/packages/${t.slug}`} className="hover:underline">{t.name}</Link></h3>
                    <div className="mt-3 space-y-1 text-sm text-muted-foreground">
                      <p className="flex items-center gap-1.5"><MapPin className="h-4 w-4" />{t.destination}</p>
                      {dates && <p className="flex items-center gap-1.5"><Calendar className="h-4 w-4" />{dates}</p>}
                      {t.duration && <p className="flex items-center gap-1.5"><Clock className="h-4 w-4" />{t.duration}</p>}
                    </div>
                    <Link href={`/packages/${t.slug}`} className="mt-4 inline-block text-sm font-semibold text-primary hover:underline">See the trip</Link>
                  </li>
                )
              })}
            </ul>
          </section>
        )}

        {(destinations.length > 0 || guides.length > 0) && (
          <section className="container mx-auto px-4 pb-12" aria-labelledby="from-explore">
            <h2 id="from-explore" className="mb-4 text-2xl font-bold">Where to look next</h2>
            <ul className="flex flex-wrap gap-2 text-sm">
              <li><Link href="/packages" className="inline-block rounded-full border px-4 py-2 hover:bg-muted">All trips</Link></li>
              {destinations.map(([slug, name]) => (
                <li key={slug}><Link href={`/destinations/${slug}`} className="inline-block rounded-full border px-4 py-2 hover:bg-muted">{name}</Link></li>
              ))}
              {guides.map((g) => (
                <li key={g.id}><Link href={guidePath(g.kind, g.slug)} className="inline-block rounded-full border px-4 py-2 hover:bg-muted">{g.name}</Link></li>
              ))}
            </ul>
          </section>
        )}

        <section className="container mx-auto px-4 pb-12" aria-labelledby="from-faq">
          <h2 id="from-faq" className="mb-4 text-2xl font-bold">Questions from {city.city}</h2>
          <div className="space-y-4">
            {faq.map((f) => (
              <div key={f.q}>
                <h3 className="font-semibold">{f.q}</h3>
                <p className="mt-1 text-muted-foreground">{f.a}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="container mx-auto px-4 pb-12" aria-label="Other cities">
          <p className="mb-2 text-sm font-semibold uppercase text-muted-foreground">Planning from another city</p>
          <ul className="flex flex-wrap gap-2 text-sm">
            {otherCities(city).map((c) => (
              <li key={c.slug}><Link href={fromPath(c)} className="inline-block rounded-full border px-4 py-2 hover:bg-muted">{c.city}</Link></li>
            ))}
          </ul>
        </section>

        <section id="contact" className="bg-muted/30 py-16">
          <div className="container mx-auto px-4">
            <div className="mb-8 text-center">
              <h2 className="text-balance text-3xl font-bold text-foreground">Ask us about flights from {city.city}</h2>
              <p className="mx-auto mt-3 max-w-2xl text-pretty text-muted-foreground">
                We can help you plan this trip. Send us a note and we can talk through your options.
              </p>
            </div>
            <Suspense fallback={null}>
              <ContactForm packageOptions={trips.map((t) => t.name)} language={language} phone={site.phone} />
            </Suspense>
          </div>
        </section>
      </main>
      <Footer language={language} />
    </div>
  )
}
