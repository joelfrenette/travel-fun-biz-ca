import Link from "next/link"
import { PackageCard } from "@/components/package-card"
import { heroSrcSet, HERO_SIZES } from "@/lib/guide-images"
import { happenedLabel } from "@/lib/past-trip"
import { DEFAULT_OG_IMAGE } from "@/lib/site"
import type { HeaderFeature, HeaderPastTrip } from "@/lib/guide-header"
import type { TravelPackage } from "@/types/travel"
import type { Language } from "@/lib/preferences"
import type { Currency } from "@/lib/currency"
import type { Part } from "@/lib/affiliate-linker"
import { AffiliateParts } from "@/components/affiliate-text"

// The right-hand card of a guide page header (see lib/guide-header.ts for the rule). A server component: no
// event handlers here. The upcoming case reuses PackageCard as it is, so price, price-on-request line and the
// MORE INFO button are exactly what the rest of the site shows.

export function GuideHeaderFeature({
  feature,
  language,
  currency,
  usdToTargetRate,
  factParts,
}: {
  feature: HeaderFeature<TravelPackage, HeaderPastTrip>
  language: Language
  currency: Currency
  usdToTargetRate: number
  /** The quick facts already processed by the word linker (one entry per fact, same order). Plain text when absent. */
  factParts?: Part[][]
}) {
  if (feature.kind === "none") return null

  if (feature.kind === "upcoming") {
    return (
      <div className="w-full max-w-sm justify-self-center lg:justify-self-end">
        <PackageCard package={feature.trip} language={language} currency={currency} usdToTargetRate={usdToTargetRate} eager />
      </div>
    )
  }

  if (feature.kind === "past") {
    const trip = feature.trip
    const when = happenedLabel(trip.available_from, trip.available_to)
    return (
      <div className="w-full max-w-sm justify-self-center lg:justify-self-end">
        {/* A past trip is a recap, never a booking: no price and no booking button, only a link to the recap. */}
        <Link href={`/packages/${trip.slug}`} className="group block overflow-hidden rounded-xl border bg-card transition-shadow hover:shadow-lg">
          <div className="relative h-48 w-full overflow-hidden">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={trip.image_url || DEFAULT_OG_IMAGE} alt={trip.destination ? `${trip.name}, ${trip.destination}` : trip.name} width={384} height={192} fetchPriority="high" decoding="async" className="h-full w-full object-cover" />
            <span className="absolute right-3 top-3 rounded-md bg-muted px-2 py-1 text-xs font-bold uppercase text-foreground">Past trip</span>
          </div>
          <div className="p-6">
            <h3 className="text-balance text-xl font-bold uppercase text-foreground group-hover:underline">{trip.name}</h3>
            {trip.destination && <p className="mt-2 text-sm text-muted-foreground">{trip.destination}</p>}
            {when && <p className="mt-1 text-sm text-muted-foreground">This trip happened {when}.</p>}
            <p className="mt-4 text-sm font-semibold text-primary">Read the trip recap</p>
          </div>
        </Link>
      </div>
    )
  }

  const srcSet = feature.image ? heroSrcSet(feature.image.url) : null
  return (
    <div className="w-full max-w-sm justify-self-center lg:justify-self-end">
      <div className="overflow-hidden rounded-xl border bg-card">
        {feature.image && (
          <figure>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={feature.image.url}
              srcSet={srcSet ?? undefined}
              sizes={srcSet ? HERO_SIZES.header : undefined}
              alt={feature.image.alt}
              width={704}
              height={528}
              fetchPriority="high"
              decoding="async"
              className="aspect-[4/3] w-full object-cover"
            />
            <figcaption className="px-4 pt-1.5 text-xs text-muted-foreground">Illustrative stock photo.</figcaption>
          </figure>
        )}
        {feature.facts.length > 0 && (
          <aside aria-label="Quick facts" className="p-4">
            <h2 className="text-sm font-bold uppercase text-foreground">Quick facts</h2>
            <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm text-foreground">
              {feature.facts.map((f, i) => (
                <li key={f}>{factParts?.[i] ? <AffiliateParts parts={factParts[i]} /> : f}</li>
              ))}
            </ul>
          </aside>
        )}
      </div>
    </div>
  )
}
