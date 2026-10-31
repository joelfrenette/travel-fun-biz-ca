import type { Metadata } from "next"
import { Suspense } from "react"
import { notFound } from "next/navigation"
import Link from "next/link"
import { generateSlug } from "@/lib/utils"
import { Header } from "@/components/header"
import { Footer } from "@/components/footer"
import { ContactForm } from "@/components/contact-form"
import { StickyCta } from "@/components/sticky-cta"
import { getPackages, getPublishedPackageBySlug } from "@/lib/packages"
import { isPastTrip as isPastTripRow, happenedLabel, todayYmd } from "@/lib/past-trip"
import { getVisitorPreferences } from "@/lib/preferences"
import { translate } from "@/lib/i18n"
import { SITE_NAME, SITE_LOCALE, DEFAULT_OG_IMAGE, absoluteUrl, formatDateRange, pageAlternates, priceOnRequestLine } from "@/lib/site"
import { tripHeading, tripTitle } from "@/lib/package-seo"
import { ogImageEntry } from "@/lib/og-path"
import { jsonLdHtml, buildRecapQuotesJsonLd } from "@/lib/jsonld"
import { loadRecapBundle } from "@/lib/recap-public"
import { getPublishedTestimonialsForPackage } from "@/lib/testimonials"
import { TripTestimonials } from "@/components/trip-testimonials"
import { listGuidesForPackage, guideKinds, guidePath } from "@/lib/guides"
import { TripVideo } from "@/components/trip-video"
import { TripJournal } from "@/components/trip-journal"
import { Breadcrumbs } from "@/components/breadcrumbs"
import { AffiliateAutoDisclosure } from "@/components/affiliate-text"
import { loadAffiliateRules } from "@/lib/affiliate-rules"
import { tripFieldSet, linkPageFields } from "@/lib/affiliate-text-sources"
import { TripExtras } from "@/components/trip-extras"
import { loadTripExtras } from "@/lib/trip-extras"
import { loadTripKit } from "@/lib/trip-kit-store"
import { TripKitPage } from "@/components/trip/trip-kit-page"
import { PastTripPage } from "@/components/trip/past-trip-page"
import { getAllPublishedPackages } from "@/lib/package-grouping"
import { getItineraryMagnetMode } from "@/lib/itinerary-magnet-store"
import { ItineraryRequestForm } from "@/components/itinerary-request-form"
import { getBestTimeToVisitPage } from "@/lib/best-time-to-visit"
import { buildPastTripJsonLd, cleanKitForPast, pastSafeFieldSet, pastSafeText, pastTripDescription, pastTripFaqs, pastTripTitle, pickSimilarTrips, splitGallery } from "@/lib/past-trip-kit"

export const revalidate = 300

type Props = { params: { slug: string } }

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const pkg = await getPublishedPackageBySlug(params.slug)
  if (!pkg) return { title: `Package not found | ${SITE_NAME}`, robots: { index: false } }

  const past = isPastTripRow(pkg)
  const dates = formatDateRange(pkg.available_from, pkg.available_to)
  // A published Recap Studio recap brings its own search text (checked when it was drafted); it only applies to a past trip.
  const recapBundle = past ? await loadRecapBundle(pkg.id) : null
  // A past trip is a recap: "<Trip> recap | <Month Year>" (lib/past-trip-kit.ts), never the promotional title or any supplier wording.
  // "from Canada" is added at render time for Australia and New Zealand trips only (lib/package-seo.ts); stored data is untouched.
  const title = past
    ? recapBundle?.metaTitle || pastTripTitle({ name: pkg.name, destination: pkg.destination, from: pkg.available_from, to: pkg.available_to })
    : tripTitle(pkg, pkg.meta_title || `${pkg.name} | ${pkg.destination}${dates ? ` | ${dates}` : ""} | ${SITE_NAME}`, false)
  const description = past
    ? recapBundle?.metaDescription || pastTripDescription({ name: pkg.name, destination: pkg.destination, metaDescription: pkg.meta_description, shortDescription: pkg.short_description, from: pkg.available_from, to: pkg.available_to })
    : pkg.meta_description || pkg.short_description || `${pkg.name}: ${pkg.duration} in ${pkg.destination}. Request info and join the fun with ${SITE_NAME}.`
  const image = ogImageEntry("packages", pkg.slug, pkg.name)
  const url = absoluteUrl(`/packages/${pkg.slug}`)

  return {
    title,
    description,
    alternates: pageAlternates(`/packages/${pkg.slug}`),
    openGraph: { title, description, url, type: "website", locale: SITE_LOCALE, siteName: SITE_NAME, images: [image] },
    twitter: { card: "summary_large_image", title, description, images: [image.url] },
  }
}

export default async function PackagePage({ params }: Props) {
  const pkg = await getPublishedPackageBySlug(params.slug)
  if (!pkg) notFound()

  const { language, currency } = getVisitorPreferences()
  // One rule for "past trip" (lib/past-trip.ts): recap_mode auto / recap / live. A past trip is never unpublished: it becomes a recap.
  const isPastTrip = isPastTripRow(pkg)
  const destSlug = generateSlug(pkg.destination)
  const [allPackages, tripTestimonials, tripGuides, tripExtras, affiliateRules, recapBundle, tripKitRecords, publishedRows, bestTime, itineraryMode] = await Promise.all([
    getPackages(),
    getPublishedTestimonialsForPackage(pkg.id),
    listGuidesForPackage({ id: pkg.id, destination: pkg.destination }),
    loadTripExtras(isPastTrip),
    // Word links (WP23): ON rules whose link is ON. Fails open (no rules, no links, never an error page).
    loadAffiliateRules(),
    // Recap Studio extras (quick answer, takeaways, approved quotes): only for a past trip, only from a published bundle.
    isPastTrip ? loadRecapBundle(pkg.id) : Promise.resolve(null),
    // Trip Page Kit: the stored route/inclusions record and (upcoming trips only) the agent-confirmed price. Fails open.
    loadTripKit(pkg.id),
    // Past trip: the candidates for "Similar trips coming up" and whether a best-time page exists for the destination.
    isPastTrip ? getAllPublishedPackages().catch(() => []) : Promise.resolve([]),
    isPastTrip ? getBestTimeToVisitPage(destSlug).catch(() => null) : Promise.resolve(null),
    // "Send me the itinerary and dates" (lib/itinerary-magnet.ts). Off unless app_settings itinerary_magnet_mode is "on"; fails closed.
    isPastTrip ? Promise.resolve("off" as const) : getItineraryMagnetMode(),
  ])
  const { kit: storedKit, price: confirmedPrice } = tripKitRecords
  // Every linkable text of the page in reading order (lib/affiliate-text-sources.ts). A past trip's text is first cleaned of
  // supplier-page words and money (lib/past-trip-kit.ts), so "Tour Cancelled" can never be a page fact for a tour that ran.
  const rawFieldSet = tripFieldSet(pkg)
  const fieldSet = isPastTrip ? pastSafeFieldSet(rawFieldSet) : rawFieldSet
  const linked = linkPageFields(fieldSet.fields, affiliateRules, "trips")
  const journalBodies = fieldSet.journal.map((f) => linked.parts(f))

  const description = pkg.full_description || pkg.short_description || ""
  // Structured data gets the description without the site-link markdown the heal may add ("[text](/path)" -> "text").
  const plainDescription = description.replace(/\[([^\]\n]+)\]\(\/[^)\s]*\)/g, "$1")
  const pageUrl = absoluteUrl(`/packages/${pkg.slug}`)
  const image = pkg.image_url || DEFAULT_OG_IMAGE
  const request = priceOnRequestLine()
  const heading = tripHeading(pkg, isPastTrip)

  // ─── Past trip: the recap version of the Trip Page Kit ───────────────────────────────
  const pastKit = isPastTrip ? cleanKitForPast(storedKit) : null
  const photos = splitGallery(pkg.gallery_urls, pkg.slug)
  const happened = isPastTrip ? happenedLabel(pkg.available_from, pkg.available_to) : null
  const similar = isPastTrip ? pickSimilarTrips(pkg, publishedRows, todayYmd(), 3) : { trips: [], basis: "none" as const }
  const pastFaqs = isPastTrip ? pastTripFaqs({ name: pkg.name, destination: pkg.destination, stored: fieldSet.faqs.map((f) => ({ question: f.question, answer: f.answer })), from: pkg.available_from, to: pkg.available_to, phone: request.phone }) : []

  const jsonLd: Record<string, unknown>[] = isPastTrip
    ? [
        // TouristTrip with its real dates and NO offer or availability, FAQPage and BreadcrumbList (lib/past-trip-kit.ts).
        ...buildPastTripJsonLd({
          name: pkg.name,
          description: pastSafeText(pkg.short_description || plainDescription) || `${pkg.name} in ${pkg.destination}`,
          url: pageUrl,
          image,
          category: pkg.category,
          destination: pkg.destination,
          startDate: pkg.available_from,
          endDate: pkg.available_to,
          stops: pastKit && pastKit.stops.length > 0 ? pastKit.stops.map((s) => s.name) : fieldSet.itinerary.map((d) => d.title),
          faqs: pastFaqs,
          siteName: SITE_NAME,
          siteUrl: absoluteUrl("/"),
          // The BreadcrumbList is emitted by <Breadcrumbs> next to the visible trail (same list, so they cannot disagree).
          breadcrumbs: [],
        }),
        ...tripTestimonials.map((t) => ({
          "@context": "https://schema.org",
          "@type": "Review",
          itemReviewed: { "@type": "TouristTrip", name: pkg.name },
          reviewRating: { "@type": "Rating", ratingValue: t.rating, bestRating: 5 },
          author: { "@type": "Person", name: t.author },
          reviewBody: t.text,
        })),
        // Review markup ONLY for quotes that are approved, carry the permission tick, and are shown on this page.
        ...(isPastTrip && recapBundle && recapBundle.quotes.length > 0 ? buildRecapQuotesJsonLd(pkg.name, recapBundle.quotes) : []),
      ]
    : [
        {
          "@context": "https://schema.org",
          "@type": "TouristTrip",
          name: pkg.name,
          description: pkg.short_description || plainDescription,
          url: pageUrl,
          image,
          touristType: pkg.category,
          itinerary: fieldSet.itinerary.length
            ? { "@type": "ItemList", itemListElement: fieldSet.itinerary.map((d, i) => ({ "@type": "ListItem", position: i + 1, name: d.title, ...(d.description ? { description: d.description } : {}) })) }
            : { "@type": "Place", name: pkg.destination },
          ...(pkg.available_from ? { startDate: pkg.available_from } : {}),
          ...(pkg.available_to ? { endDate: pkg.available_to } : {}),
          provider: { "@type": "TravelAgency", name: SITE_NAME, url: absoluteUrl("/") },
          // A price is structured data only when an agent confirmed one for this trip.
          ...(pkg.price_value && confirmedPrice
            ? { offers: { "@type": "Offer", price: pkg.price_value, priceCurrency: pkg.currency || "CAD", url: pageUrl, availability: "https://schema.org/InStock" } }
            : {}),
        },
        ...(fieldSet.faqs.length > 0
          ? [{
              "@context": "https://schema.org",
              "@type": "FAQPage",
              mainEntity: fieldSet.faqs.map((f) => ({ "@type": "Question", name: f.question, acceptedAnswer: { "@type": "Answer", text: f.answer } })),
            }]
          : []),
      ]

  const contactForm = (
    <Suspense fallback={null}>
      <ContactForm preselectedPackage={pkg.name} packageOptions={Array.from(new Set([pkg.name, ...allPackages.map((p) => p.name)]))} language={language} phone={request.phone} intent="callback" />
    </Suspense>
  )

  return (
    <div className="flex min-h-screen flex-col">
      <Header language={language} currency={currency} />
      <main className="flex-1 pb-20 lg:pb-0">
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdHtml(jsonLd) }} />

        {isPastTrip ? (
          <PastTripPage
            pkg={pkg}
            heading={heading}
            image={image}
            kit={pastKit}
            fieldSet={fieldSet}
            linked={linked}
            language={language}
            phone={request.phone}
            telHref={request.telHref}
            happened={happened}
            realPhotos={photos.real}
            stockPhotos={photos.stock}
            bundle={recapBundle}
            faqs={pastFaqs}
            similar={similar}
            destinationHref={`/destinations/${destSlug}`}
            bestTimeHref={bestTime ? `/best-time-to-visit/${destSlug}` : null}
            guide={tripGuides[0] ? { href: guidePath(tripGuides[0].kind, tripGuides[0].slug), label: `${tripGuides[0].name} ${guideKinds[tripGuides[0].kind].guideLabel}` } : null}
            contactForm={contactForm}
            breadcrumbs={<Breadcrumbs crumbs={[{ name: translate(language, "Home"), path: "/" }, { name: translate(language, "Trips"), path: "/packages" }, { name: pkg.name }]} currentPath={`/packages/${pkg.slug}`} className="mb-4 text-xs text-white/80" />}
          />
        ) : (
          <>
            <TripKitPage pkg={pkg} heading={heading} image={image} kit={storedKit} price={confirmedPrice} fieldSet={fieldSet} linked={linked} language={language} phone={request.phone} telHref={request.telHref} />
            {itineraryMode === "on" && (
              <section id="itinerary" className="container mx-auto scroll-mt-24 px-4 py-10" aria-labelledby="itinerary-heading">
                <div className="mx-auto max-w-xl rounded-2xl border bg-card p-5 text-center sm:p-6">
                  <h2 id="itinerary-heading" className="text-xl font-bold">{translate(language, "Send me the itinerary and dates")}</h2>
                  <p className="mb-4 mt-1 text-sm text-muted-foreground">{translate(language, "Get a printable page with the day by day plan, what is included and the next confirmed dates. Anything not confirmed yet says so.")}</p>
                  <ItineraryRequestForm slug={pkg.slug} language={language} />
                </div>
              </section>
            )}
            {/* Lead form */}
            <section id="enquire" className="bg-muted/30 py-16">
              <div className="container mx-auto px-4">
                <div className="mb-8 text-center">
                  <h2 className="text-balance text-3xl font-bold text-foreground">{`${translate(language, "Request info about")} ${pkg.name}`}</h2>
                  <p className="mx-auto mt-3 max-w-2xl text-pretty text-muted-foreground">{translate(language, "No obligation. We reply within one business day.")}</p>
                </div>
                {contactForm}
              </div>
            </section>
          </>
        )}
        <AffiliateAutoDisclosure count={linked.count} language={language} />

        {tripTestimonials.length > 0 && (
          <section className="container mx-auto px-4 pb-12">
            <TripTestimonials testimonials={tripTestimonials} language={language} />
          </section>
        )}

        {tripGuides.length > 0 && (
          <section className="container mx-auto px-4 pb-12">
            <aside className="rounded-xl border bg-muted/30 p-5" aria-labelledby="trip-guides-heading">
              <h2 id="trip-guides-heading" className="mb-2 text-lg font-semibold text-foreground">Guides for this trip</h2>
              <ul className="space-y-1.5">
                {tripGuides.map((g) => (
                  <li key={g.id}>
                    <Link href={guidePath(g.kind, g.slug)} className="font-medium text-foreground hover:underline">{g.name}: {guideKinds[g.kind].guideLabel}</Link>
                  </li>
                ))}
              </ul>
            </aside>
          </section>
        )}

        {!isPastTrip && <TripExtras extras={tripExtras} language={language} />}

        {isPastTrip && pkg.video_url && (
          <section className="container mx-auto px-4 pb-12">
            <h2 className="mb-4 text-2xl font-bold">{translate(language, "Trip Video")}</h2>
            <TripVideo url={pkg.video_url} title={pkg.name} />
          </section>
        )}

        {pkg.journal_entries?.length > 0 && (
          <section className="container mx-auto px-4 pb-12">
            <TripJournal entries={pkg.journal_entries} language={language} bodies={journalBodies} />
          </section>
        )}
      </main>
      <StickyCta
        bookCall
        packageName={pkg.name}
        requestLabel={isPastTrip ? "Plan a trip like this" : "Book a free call"}
        bookingUrl={null}
        bookLabel={pkg.call_to_action || translate(language, "Book Now")}
        phone={request.phone}
        callLabel="Call or text"
      />
      <Footer language={language} />
    </div>
  )
}
