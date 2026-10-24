import { generateSlug } from "@/lib/utils"
import { TripGallery } from "@/components/trip-gallery"
import { TripAlertForm } from "@/components/trip-alert-form"
import { AffiliateParts, AffiliateLinkified, AffiliateAutoDisclosure } from "@/components/affiliate-text"
import { TripKitHero } from "@/components/trip/trip-kit-hero"
import { KeyFactsStrip, RouteTimeline, InclusionBlock, GoodToKnow, AgentCta, KitAttribution } from "@/components/trip/trip-kit-body"
import type { TripKit, PriceConfirmed } from "@/lib/trip-kit-facts"
import type { DbPackage } from "@/lib/packages"
import type { Language } from "@/lib/preferences"
import type { tripFieldSet, linkPageFields } from "@/lib/affiliate-text-sources"

export interface TripKitPageProps {
  pkg: DbPackage
  heading: string
  image: string
  kit: TripKit | null
  price: PriceConfirmed | null
  fieldSet: ReturnType<typeof tripFieldSet>
  linked: ReturnType<typeof linkPageFields>
  language: Language
  phone: string
  telHref: string
}

const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n).replace(/\s+\S*$/, "")}…`)

/** The Trip Page Kit layout for an upcoming trip: hero, key facts, about, route, included, good to know, photos, FAQ and the
 * conversation block. Replaces the old hero and details sections; everything after it on the page is unchanged. */
export function TripKitPage({ pkg, heading, image, kit, price, fieldSet, linked, language, phone, telHref }: TripKitPageProps) {
  const promise = kit?.promise ?? (pkg.short_description ? clip(pkg.short_description.replace(/\s+/g, " ").trim(), 160) : null)
  // A cover that was uploaded is often the supplier flyer, with prices and personal phone numbers printed in the picture. The kit hero
  // uses it only when it is a stock photo; otherwise the first stock photo of a stop (or the gallery) is the hero.
  const stopPhoto = kit?.stops.find((s) => s.photo)?.photo?.url
  const heroImage = pkg.image_source === "pexels" || !(stopPhoto || pkg.gallery_urls?.[0]) ? image : (stopPhoto ?? pkg.gallery_urls[0])
  const midCta =<AgentCta phone={phone} telHref={telHref} tripName={pkg.name} heading="Like the look of this route? Let us plan it with you" method="trip_kit_mid" />
  return (
    <>
      <TripKitHero
        heading={heading}
        category={pkg.category}
        destination={pkg.destination}
        destinationHref={`/destinations/${generateSlug(pkg.destination)}`}
        image={heroImage}
        imageAlt={heroImage === image ? heading : (kit?.stops.find((s) => s.photo?.url === heroImage)?.photo?.alt ?? pkg.destination)}
        duration={pkg.duration}
        availableFrom={pkg.available_from}
        availableTo={pkg.available_to}
        promise={promise}
        price={price}
        phone={phone}
        telHref={telHref}
      />
      <KeyFactsStrip pkg={pkg} kit={kit} />

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
        <RouteTimeline kit={kit} cta={midCta} />
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
          <div className="mt-8">{midCta}</div>
        </section>
      ) : (
        <section className="container mx-auto px-4 py-6">{midCta}</section>
      )}

      <InclusionBlock pkg={pkg} kit={kit} />
      <GoodToKnow kit={kit} />

      {pkg.gallery_urls?.length > 0 && (
        <section className="container mx-auto px-4 py-10 sm:py-14" aria-labelledby="photos-heading">
          <h2 id="photos-heading" className="mb-4 text-2xl font-bold sm:text-3xl">Trip photos</h2>
          <TripGallery images={pkg.gallery_urls} alt={pkg.name} />
        </section>
      )}

      {fieldSet.faqs.length > 0 && (
        <section className="container mx-auto px-4 py-10" aria-labelledby="faq-heading">
          <h2 id="faq-heading" className="mb-4 text-2xl font-bold sm:text-3xl">Frequently asked questions</h2>
          <div className="divide-y rounded-2xl border bg-card">
            {fieldSet.faqs.map((f) => (
              <details key={f.question} className="group p-4 sm:p-5">
                <summary className="cursor-pointer list-none text-base font-semibold sm:text-lg">{f.question}</summary>
                <p className="mt-2 text-muted-foreground"><AffiliateParts parts={linked.parts(f.field)} /></p>
              </details>
            ))}
          </div>
        </section>
      )}

      <section id="talk" className="container mx-auto scroll-mt-24 px-4 py-10 sm:py-14">
        <AgentCta phone={phone} telHref={telHref} tripName={pkg.name} heading="Let’s talk about your trip" method="trip_kit_end" />
        <div className="mx-auto mt-8 max-w-xl rounded-2xl border bg-card p-5 text-center">
          <h3 className="text-lg font-bold">Not ready to talk yet?</h3>
          <p className="mb-4 mt-1 text-sm text-muted-foreground">Leave your email and we will tell you when something opens up on trips like this one.</p>
          <TripAlertForm slug={pkg.slug} language={language} />
        </div>
      </section>
      <KitAttribution kit={kit} />
      <div className="container mx-auto px-4"><AffiliateAutoDisclosure count={linked.count} language={language} /></div>
    </>
  )
}

