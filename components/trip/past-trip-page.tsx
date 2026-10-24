import type { ReactNode } from "react"
import Link from "next/link"
import { Check, X, Phone, CalendarClock, ArrowRight } from "lucide-react"
import { TripGallery } from "@/components/trip-gallery"
import { TripAlertForm } from "@/components/trip-alert-form"
import { TripRecapExtras } from "@/components/trip-recap-extras"
import { PhoneLink } from "@/components/phone-link"
import { AffiliateParts, AffiliateLinkified } from "@/components/affiliate-text"
import { PastTripHero } from "@/components/trip/past-trip-hero"
import { KeyFactsStrip, RouteTimeline, KitAttribution } from "@/components/trip/trip-kit-body"
import { inclusionBlocks, dateRangeText, type TripKit } from "@/lib/trip-kit-facts"
import { SUPPLIER_STATUS_RE, type PastFaq, type SimilarBasis, type SimilarCandidate } from "@/lib/past-trip-kit"
import type { RecapBundle } from "@/lib/recap-studio"
import type { DbPackage } from "@/lib/packages"
import type { Language } from "@/lib/preferences"
import type { tripFieldSet, linkPageFields } from "@/lib/affiliate-text-sources"

// The Trip Page Kit in PAST TRIP MODE: the same modern blocks as an upcoming trip, written as a recap that earns leads.
// Never drawn here: a price, a booking button, a link to the supplier page, supplier-page words. The caller passes a kit and
// text fields already cleaned by lib/past-trip-kit.ts (cleanKitForPast, pastSafeFieldSet).

export interface PastTripPageProps {
  pkg: DbPackage
  heading: string
  /** The stock hero picture, used when the trip has no real photo. */
  image: string
  kit: TripKit | null
  fieldSet: ReturnType<typeof tripFieldSet>
  linked: ReturnType<typeof linkPageFields>
  language: Language
  phone: string
  telHref: string
  happened: string | null
  /** Real trip photos (Recap Studio) and stock pictures of the places. */
  realPhotos: string[]
  stockPhotos: string[]
  bundle: RecapBundle | null
  faqs: PastFaq[]
  similar: { trips: SimilarCandidate[]; basis: SimilarBasis }
  destinationHref: string
  bestTimeHref: string | null
  guide: { href: string; label: string } | null
  /** The existing ContactForm, rendered by the page (intent callback). */
  contactForm: ReactNode
  /** The page's visible breadcrumb trail. */
  breadcrumbs: ReactNode
}

const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n).replace(/\s+\S*$/, "")}…`)

function PlanCta({ phone, telHref, destination, heading, method }: { phone: string; telHref: string; destination: string; heading: string; method: string }) {
  return (
    <div className="rounded-3xl bg-gradient-to-br from-primary/15 via-card to-card p-6 shadow-sm ring-1 ring-primary/20 sm:p-9" data-testid="past-trip-cta">
      <h2 className="text-balance text-2xl font-bold sm:text-3xl">{heading}</h2>
      <p className="mt-2 max-w-2xl text-muted-foreground">Tell a travel specialist what you loved about this route. We will help you with dates, what is open and the best way to travel to {destination}. No pressure, just a friendly conversation.</p>
      <div className="mt-6 grid gap-3 sm:grid-cols-2">
        {telHref && (
          <PhoneLink href={telHref} method={method} className="flex items-center justify-center gap-2 rounded-xl bg-primary px-5 py-4 text-base font-bold text-primary-foreground shadow hover:bg-primary/90">
            <Phone className="h-5 w-5" aria-hidden="true" />
            Call or text us{phone ? `: ${phone}` : ""}
          </PhoneLink>
        )}
        <a href="#enquire" className="flex items-center justify-center gap-2 rounded-xl border-2 border-primary px-5 py-4 text-base font-bold text-primary hover:bg-primary/5">
          <CalendarClock className="h-5 w-5" aria-hidden="true" />
          Plan a trip like this
        </a>
      </div>
    </div>
  )
}

function Included({ pkg, kit }: { pkg: DbPackage; kit: TripKit | null }) {
  const safe = (v: string | null) => (v ?? "").split("\n").filter((l) => l.trim() && !SUPPLIER_STATUS_RE.test(l)).join("\n")
  const { included, notIncluded } = inclusionBlocks({ price_includes: safe(pkg.price_includes), not_included: safe(pkg.not_included) }, kit)
  if (included.length === 0 && notIncluded.length === 0) return null
  const list = (items: { text: string }[], yes: boolean) => (
    <ul className="space-y-2.5">
      {items.map((f) => (
        <li key={f.text} className="flex gap-2.5 text-muted-foreground">
          {yes ? <Check className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" aria-hidden="true" /> : <X className="mt-0.5 h-5 w-5 shrink-0 text-rose-600" aria-hidden="true" />}
          <span>{f.text}</span>
        </li>
      ))}
    </ul>
  )
  return (
    <section className="container mx-auto px-4 py-10" aria-labelledby="included-heading" data-testid="past-trip-included">
      <h2 id="included-heading" className="text-2xl font-bold sm:text-3xl">What the trip included</h2>
      <div className={`mt-6 grid gap-6 ${included.length > 0 && notIncluded.length > 0 ? "md:grid-cols-2" : ""}`}>
        {included.length > 0 && (
          <div className="rounded-2xl border bg-card p-5">
            <h3 className="mb-3 text-lg font-bold">Included</h3>
            {list(included, true)}
          </div>
        )}
        {notIncluded.length > 0 && (
          <div className="rounded-2xl border bg-card p-5">
            <h3 className="mb-3 text-lg font-bold">Not included</h3>
            {list(notIncluded, false)}
          </div>
        )}
      </div>
    </section>
  )
}

/** "Similar trips coming up": upcoming published trips for this destination or region, else the nearest upcoming ones, else a guide link. */
export function SimilarTripsStrip({ similar, destination, destinationHref }: { similar: { trips: SimilarCandidate[]; basis: SimilarBasis }; destination: string; destinationHref: string }) {
  const heading = similar.basis === "nearest" ? "Other trips coming up" : "Similar trips coming up"
  return (
    <section className="container mx-auto px-4 py-10" aria-labelledby="similar-heading" data-testid="past-trip-similar">
      <h2 id="similar-heading" className="text-2xl font-bold sm:text-3xl">{similar.trips.length > 0 ? heading : `Exploring ${destination}?`}</h2>
      {similar.trips.length > 0 ? (
        <ul className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {similar.trips.map((t) => {
            const dates = dateRangeText(t.available_from, t.available_to)
            return (
              <li key={t.slug} className="rounded-2xl border bg-card p-5">
                <h3 className="text-lg font-bold"><Link href={`/packages/${t.slug}`} className="hover:underline">{t.name}</Link></h3>
                <p className="mt-1 text-sm text-muted-foreground">{t.destination}{dates ? ` · ${dates}` : ""}</p>
                {t.short_description && <p className="mt-2 text-sm text-muted-foreground">{clip(t.short_description.replace(/\s+/g, " ").trim(), 140)}</p>}
                <Link href={`/packages/${t.slug}`} className="mt-3 inline-flex items-center gap-1 text-sm font-semibold text-primary hover:underline">See the trip <ArrowRight className="h-4 w-4" aria-hidden="true" /></Link>
              </li>
            )
          })}
        </ul>
      ) : (
        <p className="mt-3 text-muted-foreground">No new departure is listed for this destination right now. <Link href={destinationHref} className="font-semibold text-primary underline">Read our {destination} guide</Link>, or ask a travel specialist what is coming up.</p>
      )}
    </section>
  )
}

export function PastTripPage({ pkg, heading, image, kit, fieldSet, linked, language, phone, telHref, happened, realPhotos, stockPhotos, bundle, faqs, similar, destinationHref, bestTimeHref, guide, contactForm, breadcrumbs }: PastTripPageProps) {
  const promise = kit?.promise ?? null
  const stopPhoto = kit?.stops.find((s) => s.photo)?.photo
  // Real trip photos come first; a stock picture of a place is the hero only when there is no real one.
  const hero = realPhotos[0]
    ? { src: realPhotos[0], alt: `Photo from the ${pkg.name} trip` }
    : pkg.image_source === "pexels" || !(stopPhoto || stockPhotos[0])
      ? { src: image, alt: pkg.destination }
      : { src: stopPhoto?.url ?? stockPhotos[0], alt: stopPhoto?.alt ?? pkg.destination }
  const mid = <PlanCta phone={phone} telHref={telHref} destination={pkg.destination} heading="Like the look of this route? Plan a trip like this" method="past_trip_mid" />
  const hasRecapBlock = fieldSet.recap.length > 0 || fieldSet.recapHighlights.length > 0 || !!bundle || realPhotos.length > 0
  return (
    <>
      <PastTripHero
        heading={heading}
        category={pkg.category}
        destination={pkg.destination}
        destinationHref={destinationHref}
        image={hero.src}
        imageAlt={hero.alt}
        duration={pkg.duration}
        availableFrom={pkg.available_from}
        availableTo={pkg.available_to}
        happened={happened}
        promise={promise}
        phone={phone}
        telHref={telHref}
        breadcrumbs={breadcrumbs}
      />
      <KeyFactsStrip pkg={pkg} kit={kit} />

      {hasRecapBlock && (
        <section className="container mx-auto px-4 py-10 sm:py-14" aria-labelledby="recap-heading" data-testid="past-trip-recap">
          <div className="space-y-8">
            {fieldSet.recap.length > 0 && (
              <div>
                <h2 id="recap-heading" className="mb-3 text-2xl font-bold sm:text-3xl">How the trip went</h2>
                <div className="space-y-4 text-pretty text-base leading-relaxed text-muted-foreground sm:text-lg">
                  {fieldSet.recap.map((f) => <p key={f.id}><AffiliateParts parts={linked.parts(f)} /></p>)}
                </div>
              </div>
            )}
            {fieldSet.recapHighlights.length > 0 && (
              <ul className="grid gap-2 sm:grid-cols-2">
                {fieldSet.recapHighlights.map((h) => <li key={h.id} className="flex gap-2 text-muted-foreground"><span aria-hidden="true" className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" /><AffiliateParts parts={linked.parts(h)} /></li>)}
              </ul>
            )}
            {bundle && <TripRecapExtras bundle={bundle} guide={null} nextTrip={null} />}
            {realPhotos.length > 0 && (
              <div>
                <h2 className="mb-4 text-2xl font-bold">Photos from the trip</h2>
                <TripGallery images={realPhotos} alt={`Photo from the ${pkg.name} trip`} />
              </div>
            )}
          </div>
        </section>
      )}

      {(fieldSet.description.length > 0 || fieldSet.highlights.length > 0) && (
        <section className="container mx-auto px-4 py-10 sm:py-14" aria-labelledby="about-heading">
          <div className="grid gap-10 lg:grid-cols-[1.4fr_1fr]">
            {fieldSet.description.length > 0 && (
              <div>
                <h2 id="about-heading" className="mb-4 text-2xl font-bold sm:text-3xl">About this trip</h2>
                <div className="space-y-4 text-pretty text-base leading-relaxed text-muted-foreground sm:text-lg">
                  {fieldSet.description.map((f) => <p key={f.id}><AffiliateLinkified parts={linked.linkified(f)} /></p>)}
                </div>
              </div>
            )}
            {fieldSet.highlights.length > 0 && (
              <div className="rounded-2xl border bg-card p-5 sm:p-6">
                <h2 className="mb-3 text-xl font-bold">Highlights</h2>
                <ul className="space-y-2.5">
                  {fieldSet.highlights.map((h) => (
                    <li key={h.id} className="flex gap-2.5 text-muted-foreground"><span aria-hidden="true" className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" /><AffiliateParts parts={linked.parts(h)} /></li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </section>
      )}

      {kit && kit.stops.length > 0 ? (
        <RouteTimeline kit={kit} cta={mid} />
      ) : fieldSet.itinerary.length > 0 ? (
        <section id="route" className="container mx-auto px-4 py-10" aria-labelledby="route-heading">
          <h2 id="route-heading" className="mb-4 text-2xl font-bold sm:text-3xl">Itinerary</h2>
          <ol className="space-y-3">
            {fieldSet.itinerary.map((d, i) => (
              <li key={i} className="rounded-xl border bg-card p-4">
                <p className="font-semibold">{d.day != null ? `Day ${d.day}: ` : ""}{d.title}</p>
                {d.field && <p className="mt-1 text-muted-foreground"><AffiliateParts parts={linked.parts(d.field)} /></p>}
              </li>
            ))}
          </ol>
          <div className="mt-8">{mid}</div>
        </section>
      ) : (
        <section className="container mx-auto px-4 py-6">{mid}</section>
      )}

      <Included pkg={pkg} kit={kit} />

      {realPhotos.length === 0 && stockPhotos.length > 0 && (
        <section className="container mx-auto px-4 py-10 sm:py-14" aria-labelledby="photos-heading">
          <h2 id="photos-heading" className="mb-1 text-2xl font-bold sm:text-3xl">The places on this route</h2>
          <p className="mb-4 text-sm text-muted-foreground">Stock pictures of the places, not photos from the trip.</p>
          <TripGallery images={stockPhotos} alt={`${pkg.destination} stock picture`} />
        </section>
      )}

      {faqs.length > 0 && (
        <section className="container mx-auto px-4 py-10" aria-labelledby="faq-heading" data-testid="past-trip-faq">
          <h2 id="faq-heading" className="mb-4 text-2xl font-bold sm:text-3xl">Frequently asked questions</h2>
          <div className="divide-y rounded-2xl border bg-card">
            {faqs.map((f) => (
              <details key={f.question} className="group p-4 sm:p-5">
                <summary className="cursor-pointer list-none text-base font-semibold sm:text-lg">{f.question}</summary>
                <p className="mt-2 text-muted-foreground">{f.answer}</p>
              </details>
            ))}
          </div>
        </section>
      )}

      <section id="plan" className="container mx-auto scroll-mt-24 px-4 py-10 sm:py-14">
        <PlanCta phone={phone} telHref={telHref} destination={pkg.destination} heading="Plan a trip like this" method="past_trip_end" />
        <div id="enquire" className="mx-auto mt-8 max-w-3xl scroll-mt-24">{contactForm}</div>
      </section>

      <section id="waitlist" className="container mx-auto px-4 pb-10" aria-labelledby="waitlist-heading" data-testid="past-trip-waitlist">
        <div className="mx-auto max-w-3xl rounded-2xl border bg-card p-6 text-center shadow-sm sm:p-8">
          <h2 id="waitlist-heading" className="text-balance text-2xl font-bold">Loved this trip? Join the waitlist for the next one</h2>
          <p className="mx-auto mb-5 mt-2 max-w-xl text-pretty text-muted-foreground">Leave your email and we will tell you when the next trip like this one opens.</p>
          <TripAlertForm slug={pkg.slug} language={language} submitLabel="Tell me when the next one opens" />
        </div>
      </section>

      <SimilarTripsStrip similar={similar} destination={pkg.destination} destinationHref={destinationHref} />

      <section className="container mx-auto px-4 pb-10" aria-label="More about this destination">
        <p className="text-sm text-muted-foreground">
          More about {pkg.destination}: <Link href={destinationHref} className="font-medium text-foreground underline">our {pkg.destination} page</Link>
          {bestTimeHref && <>, <Link href={bestTimeHref} className="font-medium text-foreground underline">the best time to visit</Link></>}
          {guide && <>, <Link href={guide.href} className="font-medium text-foreground underline">{guide.label}</Link></>}.
        </p>
      </section>
      <KitAttribution kit={kit} />
    </>
  )
}
