import type { Metadata } from "next"
import { Suspense } from "react"
import { notFound } from "next/navigation"
import Link from "next/link"
import { generateSlug } from "@/lib/utils"
import { Calendar, Clock, MapPin, Star } from "lucide-react"
import { Header } from "@/components/header"
import { Footer } from "@/components/footer"
import { ContactForm } from "@/components/contact-form"
import { BookNowButton } from "@/components/book-now-button"
import { StickyCta } from "@/components/sticky-cta"
import { PhoneLink } from "@/components/phone-link"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { getPackages, getPublishedPackageBySlug, getNextTripForRecap } from "@/lib/packages"
import { isPastTrip as isPastTripRow, happenedLabel } from "@/lib/past-trip"
import { TripAlertForm } from "@/components/trip-alert-form"
import { getVisitorPreferences } from "@/lib/preferences"
import { getUsdToRate } from "@/lib/fx"
import { displayPackagePrice } from "@/lib/currency"
import { translate } from "@/lib/i18n"
import { SITE_NAME, SITE_LOCALE, DEFAULT_OG_IMAGE, absoluteUrl, formatDateRange, pageAlternates, priceOnRequestLine } from "@/lib/site"
import { tripHeading, tripTitle } from "@/lib/package-seo"
import { ogImageEntry } from "@/lib/og-path"
import { jsonLdHtml, buildBreadcrumbJsonLd, buildRecapQuotesJsonLd } from "@/lib/jsonld"
import { loadRecapBundle } from "@/lib/recap-public"
import { TripRecapExtras } from "@/components/trip-recap-extras"
import { getPublishedTestimonialsForPackage } from "@/lib/testimonials"
import { TripTestimonials } from "@/components/trip-testimonials"
import { listGuidesForPackage, guideKinds, guidePath } from "@/lib/guides"
import { TripGallery } from "@/components/trip-gallery"
import { TripVideo } from "@/components/trip-video"
import { TripJournal } from "@/components/trip-journal"
import { AffiliateParts, AffiliateLinkified, AffiliateAutoDisclosure } from "@/components/affiliate-text"
import { loadAffiliateRules } from "@/lib/affiliate-rules"
import { tripFieldSet, linkPageFields } from "@/lib/affiliate-text-sources"
import { TripExtras } from "@/components/trip-extras"
import { loadTripExtras } from "@/lib/trip-extras"

export const revalidate = 300

type Props = { params: { slug: string } }

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const pkg = await getPublishedPackageBySlug(params.slug)
  if (!pkg) return { title: `Package not found | ${SITE_NAME}`, robots: { index: false } }

  const dates = formatDateRange(pkg.available_from, pkg.available_to)
  // A published Recap Studio recap brings its own search text (checked when it was drafted); it only applies to a past trip.
  const recapBundle = isPastTripRow(pkg) ? await loadRecapBundle(pkg.id) : null
  // "from Canada" is added at render time for Australia and New Zealand trips only (lib/package-seo.ts); stored data is untouched.
  const title = tripTitle(pkg, recapBundle?.metaTitle || pkg.meta_title || `${pkg.name} | ${pkg.destination}${dates ? ` | ${dates}` : ""} | ${SITE_NAME}`, isPastTripRow(pkg))
  const description = recapBundle?.metaDescription || pkg.meta_description || pkg.short_description || `${pkg.name}: ${pkg.duration} in ${pkg.destination}. Request info and join the fun with ${SITE_NAME}.`
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
  // One rule for "past trip" (lib/past-trip.ts): recap_mode auto / recap / live. A past trip is never unpublished.
  const isPastTrip = isPastTripRow(pkg)
  const [allPackages, usdToTargetRate, tripTestimonials, tripGuides, nextTrip, tripExtras, affiliateRules, recapBundle] = await Promise.all([
    getPackages(),
    getUsdToRate(currency),
    getPublishedTestimonialsForPackage(pkg.id),
    listGuidesForPackage({ id: pkg.id, destination: pkg.destination }),
    isPastTrip ? getNextTripForRecap(pkg) : Promise.resolve(null),
    loadTripExtras(isPastTrip),
    // Word links (WP23): ON rules whose link is ON. Fails open (no rules, no links, never an error page).
    loadAffiliateRules(),
    // Recap Studio extras (quick answer, takeaways, approved quotes): only for a past trip, only from a published bundle.
    isPastTrip ? loadRecapBundle(pkg.id) : Promise.resolve(null),
  ])
  const happened = isPastTrip ? happenedLabel(pkg.available_from, pkg.available_to) : null
  // Every linkable text of the page in reading order (lib/affiliate-text-sources.ts): the recap, the journal of a past trip,
  // the description (the full one, else the short one), highlights, itinerary day text, what is included and not, the FAQ
  // answers, and the journal of a trip that has not happened. One shared limit: 3 per phrase and 6 per page.
  const fieldSet = tripFieldSet(pkg)
  const linked = linkPageFields(fieldSet.fields, affiliateRules, "trips")
  const recapText = fieldSet.recap.length > 0
  const recapHighlights = fieldSet.recapHighlights
  const journalBodies = fieldSet.journal.map((f) => linked.parts(f))

  const dates = formatDateRange(pkg.available_from, pkg.available_to)
  const priceDisplay = displayPackagePrice(pkg, currency, usdToTargetRate)
  // Price on request: only when the trip has no price of its own; the number is the site's, never a host's.
  const onRequest = pkg.price_on_request === true && pkg.price_value == null && !(pkg.price_display ?? "").trim()
  const request = priceOnRequestLine()
  const highlights = fieldSet.highlights
  // Itinerary stops stored by the Add details intake: [{day, title, description}]. Anything else is ignored.
  const itinerary = fieldSet.itinerary
  const included = fieldSet.included
  const notIncluded = fieldSet.notIncluded
  const faqs = fieldSet.faqs
  const description = pkg.full_description || pkg.short_description || ""
  // Structured data gets the description without the site-link markdown the heal may add ("[text](/path)" -> "text").
  const plainDescription = description.replace(/\[([^\]\n]+)\]\(\/[^)\s]*\)/g, "$1")
  const pageUrl = absoluteUrl(`/packages/${pkg.slug}`)
  const image = pkg.image_url || DEFAULT_OG_IMAGE

  // Recap pages (a trip that already happened) describe a write-up, not a bookable offer, so they
  // get Article + Review structured data instead of TouristTrip + Offer - same canonical pageUrl
  // either way, just a more accurate schema for content Google shouldn't treat as still for sale.
  const jsonLd: Record<string, unknown>[] = isPastTrip
    ? [
        {
          "@context": "https://schema.org",
          "@type": "Article",
          headline: pkg.name,
          description: pkg.short_description || plainDescription,
          image,
          url: pageUrl,
          mainEntityOfPage: { "@type": "WebPage", "@id": pageUrl },
          ...(pkg.available_to ? { datePublished: pkg.available_to } : {}),
          dateModified: pkg.updated_at,
          author: { "@type": "Organization", name: SITE_NAME },
          publisher: { "@type": "Organization", name: SITE_NAME, logo: { "@type": "ImageObject", url: absoluteUrl("/logo.png") } },
        },
        ...tripTestimonials.map((t) => ({
          "@context": "https://schema.org",
          "@type": "Review",
          itemReviewed: { "@type": "TouristTrip", name: pkg.name },
          reviewRating: { "@type": "Rating", ratingValue: t.rating, bestRating: 5 },
          author: { "@type": "Person", name: t.author },
          reviewBody: t.text,
        })),
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
          itinerary: itinerary.length
            ? { "@type": "ItemList", itemListElement: itinerary.map((d, i) => ({ "@type": "ListItem", position: i + 1, name: d.title, ...(d.description ? { description: d.description } : {}) })) }
            : { "@type": "Place", name: pkg.destination },
          ...(pkg.available_from ? { startDate: pkg.available_from } : {}),
          ...(pkg.available_to ? { endDate: pkg.available_to } : {}),
          provider: { "@type": "TravelAgency", name: SITE_NAME, url: absoluteUrl("/") },
          ...(pkg.price_value
            ? { offers: { "@type": "Offer", price: pkg.price_value, priceCurrency: pkg.currency || "CAD", url: pageUrl, availability: "https://schema.org/InStock" } }
            : {}),
        },
      ]
  // Review markup ONLY for quotes that are approved, carry the permission tick, and are shown on this page (TripRecapExtras).
  if (isPastTrip && recapBundle && recapBundle.quotes.length > 0) jsonLd.push(...buildRecapQuotesJsonLd(pkg.name, recapBundle.quotes))
  if (isPastTrip) {
    jsonLd.push(buildBreadcrumbJsonLd([{ name: "Home", url: absoluteUrl("/") }, { name: "Trips", url: absoluteUrl("/packages") }, { name: pkg.name, url: pageUrl }]))
    const start = pkg.available_from ?? pkg.available_to
    if (start) {
      // The trip happened, so the Event keeps its real past dates; the destination is the only place named.
      jsonLd.push({
        "@context": "https://schema.org",
        "@type": "Event",
        name: pkg.name,
        description: pkg.short_description || description,
        url: pageUrl,
        image,
        startDate: start,
        ...(pkg.available_to ? { endDate: pkg.available_to } : {}),
        eventStatus: "https://schema.org/EventScheduled",
        eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
        location: { "@type": "Place", name: pkg.destination },
        organizer: { "@type": "Organization", name: SITE_NAME, url: absoluteUrl("/") },
        ...(nextTrip ? { about: { "@type": "TouristTrip", name: nextTrip.name, url: absoluteUrl(`/packages/${nextTrip.slug}`) } } : {}),
      })
    }
  }
  if (faqs.length > 0) {
    jsonLd.push({
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: faqs.map((f) => ({ "@type": "Question", name: f.question, acceptedAnswer: { "@type": "Answer", text: f.answer } })),
    })
  }

  return (
    <div className="flex min-h-screen flex-col">
      <Header language={language} currency={currency} />
      <main className="flex-1 pb-20 lg:pb-0">
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdHtml(jsonLd) }} />

        {/* Hero */}
        <section className="relative">
          <div className="relative h-[46vh] min-h-[320px] w-full overflow-hidden bg-muted">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={image} alt={pkg.name} className="h-full w-full object-cover" />
            <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/20 to-transparent" />
          </div>
          <div className="container mx-auto px-4">
            <div className="-mt-24 relative z-10 max-w-4xl rounded-xl border bg-card p-6 shadow-lg sm:p-8">
              <div className="mb-3 flex flex-wrap gap-2">
                <Badge className="bg-primary text-primary-foreground font-bold uppercase">{translate(language, pkg.category)}</Badge>
                {isPastTrip && <Badge variant="outline" className="font-bold uppercase">{translate(language, "Past Trip Recap")}</Badge>}
              </div>
              <h1 className="text-balance text-3xl font-bold uppercase text-foreground sm:text-4xl">{tripHeading(pkg, isPastTrip)}</h1>
              <div className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-sm text-muted-foreground">
                <Link href={`/destinations/${generateSlug(pkg.destination)}`} className="flex items-center gap-1.5 hover:text-foreground hover:underline"><MapPin className="h-4 w-4" />{pkg.destination}</Link>
                {dates && <span className="flex items-center gap-1.5"><Calendar className="h-4 w-4" />{dates}</span>}
                <span className="flex items-center gap-1.5"><Clock className="h-4 w-4" />{pkg.duration}</span>
                {pkg.rating && <span className="flex items-center gap-1.5"><Star className="h-4 w-4 fill-yellow-400 text-yellow-400" />{pkg.rating}/5</span>}
              </div>
              <div className="mt-6 flex flex-wrap items-end justify-between gap-4">
                <div>
                  <p className="text-xs uppercase tracking-wider text-muted-foreground">{pkg.price_value ? translate(language, "From") : translate(language, "Price")}</p>
                  <p className={pkg.price_value ? "text-3xl font-bold text-foreground" : "text-xl font-semibold text-foreground"}>
                    {onRequest ? (
                      request.phone ? (
                        <>
                          {translate(language, "Call or text {phone} for pricing").split("{phone}")[0]}
                          <PhoneLink href={request.telHref} method="package_page_price" className="underline hover:text-primary">{request.phone}</PhoneLink>
                          {translate(language, "Call or text {phone} for pricing").split("{phone}")[1]}
                        </>
                      ) : (
                        translate(language, "Contact us for pricing")
                      )
                    ) : (
                      priceDisplay
                    )}
                    {pkg.price_value != null && <span className="ml-2 text-sm font-normal text-muted-foreground">{currency.toUpperCase()} {translate(language, "per person")}</span>}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {isPastTrip && nextTrip ? (
                    <Button asChild size="lg" className="bg-primary font-bold uppercase text-primary-foreground hover:bg-primary/90">
                      <a href={`/packages/${nextTrip.slug}`}>{translate(language, "Join the Next Trip")}</a>
                    </Button>
                  ) : (
                    <Button asChild size="lg" className="bg-primary font-bold uppercase text-primary-foreground hover:bg-primary/90">
                      <a href="#enquire">{translate(language, isPastTrip ? "Ask About a Similar Trip" : "Request Info")}</a>
                    </Button>
                  )}
                  {!isPastTrip && pkg.booking_url && (
                    <BookNowButton href={pkg.booking_url} label={pkg.call_to_action || translate(language, "Book Now")} packageName={pkg.name} />
                  )}
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Details */}
        <section className="container mx-auto grid gap-10 px-4 py-12 lg:grid-cols-[1fr_340px]">
          <div className="space-y-10">
            {isPastTrip && (happened || recapText || recapHighlights.length > 0) && (
              <div className="space-y-5" data-testid="trip-recap">
                {happened && <p className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground"><Calendar className="h-4 w-4" />{translate(language, "This trip happened")} {happened}</p>}
                {recapText && (
                  <div>
                    <h2 className="mb-3 text-2xl font-bold">{translate(language, "How the trip went")}</h2>
                    <div className="space-y-4 text-pretty leading-relaxed text-muted-foreground">
                      {fieldSet.recap.map((f) => <p key={f.id}><AffiliateParts parts={linked.parts(f)} /></p>)}
                    </div>
                  </div>
                )}
                {recapHighlights.length > 0 && (
                  <div>
                    <h2 className="mb-3 text-xl font-bold">{translate(language, "Recap highlights")}</h2>
                    <ul className="grid gap-2 sm:grid-cols-2">
                      {recapHighlights.map((h) => <li key={h.id} className="flex gap-2 text-muted-foreground"><span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" /><AffiliateParts parts={linked.parts(h)} /></li>)}
                    </ul>
                  </div>
                )}
              </div>
            )}
            {isPastTrip && recapBundle && (
              <TripRecapExtras
                bundle={recapBundle}
                guide={tripGuides[0] ? { href: guidePath(tripGuides[0].kind, tripGuides[0].slug), label: `${tripGuides[0].name} ${guideKinds[tripGuides[0].kind].guideLabel}` } : null}
                nextTrip={nextTrip ? { slug: nextTrip.slug, name: nextTrip.name } : null}
              />
            )}
            {isPastTrip && pkg.gallery_urls?.length > 0 && (
              <div>
                <h2 className="mb-4 text-2xl font-bold">{translate(language, "Trip Photos")}</h2>
                <TripGallery images={pkg.gallery_urls} alt={pkg.name} />
              </div>
            )}
            {isPastTrip && pkg.journal_entries?.length > 0 && <TripJournal entries={pkg.journal_entries} language={language} bodies={journalBodies} />}
            {description && (
              <div>
                <h2 className="mb-3 text-2xl font-bold">{translate(language, "About this trip")}</h2>
                <div className="space-y-4 text-pretty leading-relaxed text-muted-foreground">
                  {fieldSet.description.map((f) => <p key={f.id}><AffiliateLinkified parts={linked.linkified(f)} /></p>)}
                </div>
              </div>
            )}
            {highlights.length > 0 && (
              <div>
                <h2 className="mb-3 text-2xl font-bold">{translate(language, "Highlights")}</h2>
                <ul className="grid gap-2 sm:grid-cols-2">
                  {highlights.map((h) => <li key={h.id} className="flex gap-2 text-muted-foreground"><span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" /><AffiliateParts parts={linked.parts(h)} /></li>)}
                </ul>
              </div>
            )}
            {itinerary.length > 0 && (
              <div>
                <h2 className="mb-3 text-2xl font-bold">{translate(language, "Itinerary")}</h2>
                <ol className="space-y-4">
                  {itinerary.map((d, i) => (
                    <li key={i} className="rounded-lg border p-4">
                      <p className="font-semibold">{d.day != null ? `${translate(language, "Day")} ${d.day}: ` : ""}{d.title}</p>
                      {d.field && <p className="mt-1 text-muted-foreground"><AffiliateParts parts={linked.parts(d.field)} /></p>}
                    </li>
                  ))}
                </ol>
              </div>
            )}
            {(included.length > 0 || notIncluded.length > 0) && (
              <div className="grid gap-8 sm:grid-cols-2">
                {included.length > 0 && (
                  <div>
                    <h2 className="mb-3 text-xl font-bold">{translate(language, "What's included")}</h2>
                    <ul className="space-y-1.5 text-muted-foreground">{included.map((f) => <li key={f.id}>✓ <AffiliateParts parts={linked.parts(f)} /></li>)}</ul>
                  </div>
                )}
                {notIncluded.length > 0 && (
                  <div>
                    <h2 className="mb-3 text-xl font-bold">{translate(language, "Not included")}</h2>
                    <ul className="space-y-1.5 text-muted-foreground">{notIncluded.map((f) => <li key={f.id}>– <AffiliateParts parts={linked.parts(f)} /></li>)}</ul>
                  </div>
                )}
              </div>
            )}
            {faqs.length > 0 && (
              <div>
                <h2 className="mb-3 text-2xl font-bold">{translate(language, "Frequently asked questions")}</h2>
                <div className="divide-y rounded-lg border">
                  {faqs.map((f) => (
                    <details key={f.question} className="group p-4">
                      <summary className="cursor-pointer list-none font-medium">{f.question}</summary>
                      <p className="mt-2 text-muted-foreground"><AffiliateParts parts={linked.parts(f.field)} /></p>
                    </details>
                  ))}
                </div>
              </div>
            )}
            <AffiliateAutoDisclosure count={linked.count} language={language} />
          </div>

          <aside className="space-y-4 lg:sticky lg:top-24 lg:self-start">
            <div className="rounded-xl border bg-card p-5">
              <p className="text-sm font-semibold">{translate(language, "Ready to go?")}</p>
              <p className="mt-1 text-sm text-muted-foreground">{translate(language, "Tell us you're interested and a real travel advisor will call or email you with the details.")}</p>
              <Button asChild className="mt-4 w-full bg-primary font-bold uppercase text-primary-foreground hover:bg-primary/90">
                <a href="#enquire">{translate(language, "Request Info")}</a>
              </Button>
              {pkg.supplier && <p className="mt-4 text-xs text-muted-foreground">{translate(language, "Operated by")} {pkg.supplier}</p>}
            </div>
          </aside>
        </section>

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

        {!isPastTrip && pkg.gallery_urls?.length > 0 && (
          <section className="container mx-auto px-4 pb-12">
            <h2 className="mb-4 text-2xl font-bold">{translate(language, "Trip Photos")}</h2>
            <TripGallery images={pkg.gallery_urls} alt={pkg.name} />
          </section>
        )}

        {!isPastTrip && pkg.journal_entries?.length > 0 && (
          <section className="container mx-auto px-4 pb-12">
            <TripJournal entries={pkg.journal_entries} language={language} bodies={journalBodies} />
          </section>
        )}

        {/* Past trip: "Interested in the next one?" - the alert signup and the link to the next trip. */}
        {isPastTrip && (
          <section id="next-trip-alert" className="container mx-auto px-4 pb-12">
            <div className="mx-auto max-w-3xl rounded-xl border bg-card p-6 text-center shadow-sm sm:p-8">
              <h2 className="text-balance text-2xl font-bold text-foreground">{translate(language, "Interested in the next one?")}</h2>
              <p className="mx-auto mt-2 mb-5 max-w-xl text-pretty text-muted-foreground">{translate(language, "Leave your email and we will let you know when the next trip like this one opens.")}</p>
              <TripAlertForm slug={pkg.slug} language={language} />
              {nextTrip && (
                <div className="mt-6 border-t pt-5">
                  <Button asChild size="lg" variant="outline" className="font-bold uppercase">
                    <a href={`/packages/${nextTrip.slug}`}>{translate(language, "Join the Next Trip")}: {nextTrip.name}</a>
                  </Button>
                </div>
              )}
            </div>
          </section>
        )}

        {/* Lead form */}
        <section id="enquire" className="bg-muted/30 py-16">
          <div className="container mx-auto px-4">
            <div className="mb-8 text-center">
              <h2 className="text-balance text-3xl font-bold text-foreground">
                {isPastTrip ? translate(language, "Interested in a trip like this?") : `${translate(language, "Request info about")} ${pkg.name}`}
              </h2>
              <p className="mx-auto mt-3 max-w-2xl text-pretty text-muted-foreground">{translate(language, "No obligation. We reply within one business day.")}</p>
            </div>
            <Suspense fallback={null}>
              <ContactForm preselectedPackage={pkg.name} packageOptions={Array.from(new Set([pkg.name, ...allPackages.map((p) => p.name)]))} language={language} phone={request.phone} />
            </Suspense>
          </div>
        </section>
      </main>
      <StickyCta packageName={pkg.name} requestLabel={translate(language, "Request Info")} bookingUrl={isPastTrip ? null : pkg.booking_url} bookLabel={pkg.call_to_action || translate(language, "Book Now")} phone={request.phone} callLabel={translate(language, "Call or text now")} />
      <Footer language={language} />
    </div>
  )
}
