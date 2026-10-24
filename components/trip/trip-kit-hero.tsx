import Link from "next/link"
import { Calendar, Clock, MapPin, Phone } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { PhoneLink } from "@/components/phone-link"
import { priceConfirmedLine, dateRangeText, type PriceConfirmed } from "@/lib/trip-kit-facts"

export interface TripKitHeroProps {
  heading: string
  category: string
  destination: string
  destinationHref: string
  image: string
  /** Honest alt text: the place name when the picture is a stock photo of a place, else the trip name. */
  imageAlt: string
  duration: string
  availableFrom: string | null
  availableTo: string | null
  /** One line promise from the kit, else the stored short description (clipped). */
  promise: string | null
  /** Only set when an agent confirmed a price. Nothing else on the page ever shows a price. */
  price: PriceConfirmed | null
  phone: string
  telHref: string
}

/** Hero of the Trip Page Kit: the photo, one h1, one line promise, the facts that are stored, and the conversation buttons. */
export function TripKitHero(p: TripKitHeroProps) {
  const dates = dateRangeText(p.availableFrom, p.availableTo)
  const priceLine = p.price ? priceConfirmedLine(p.price) : null
  return (
    <section className="relative isolate overflow-hidden bg-slate-900 text-white" data-testid="trip-kit-hero">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={p.image} alt={p.imageAlt} fetchPriority="high" decoding="async" className="absolute inset-0 -z-10 h-full w-full object-cover opacity-70" />
      <div className="absolute inset-0 -z-10 bg-gradient-to-t from-slate-950/90 via-slate-950/40 to-slate-950/10" />
      <div className="container mx-auto px-4 pb-10 pt-14 sm:pb-14 sm:pt-20 lg:pt-28">
        <div className="max-w-3xl">
          <Badge className="mb-4 bg-primary font-bold uppercase text-primary-foreground">{p.category}</Badge>
          <h1 className="text-balance text-3xl font-extrabold leading-tight sm:text-5xl">{p.heading}</h1>
          {p.promise && <p className="mt-4 max-w-2xl text-pretty text-lg text-white/90 sm:text-xl">{p.promise}</p>}
          <ul className="mt-5 flex flex-wrap gap-x-5 gap-y-2 text-sm text-white/85">
            <li className="flex items-center gap-1.5">
              <MapPin className="h-4 w-4" aria-hidden="true" />
              <Link href={p.destinationHref} className="hover:underline">{p.destination}</Link>
            </li>
            {dates && (
              <li className="flex items-center gap-1.5">
                <Calendar className="h-4 w-4" aria-hidden="true" />
                {dates}
              </li>
            )}
            {p.duration && (
              <li className="flex items-center gap-1.5">
                <Clock className="h-4 w-4" aria-hidden="true" />
                {p.duration}
              </li>
            )}
          </ul>
          {priceLine && (
            <div className="mt-6 inline-block rounded-xl bg-white/95 px-5 py-3 text-slate-900 shadow-lg" data-testid="trip-kit-price">
              <p className="text-2xl font-extrabold">{priceLine.headline}</p>
              <p className="text-xs text-slate-600">{priceLine.note}</p>
            </div>
          )}
          <div className="mt-7 flex flex-col gap-3 sm:flex-row">
            <a href="#talk" className="inline-flex items-center justify-center rounded-md bg-primary px-6 py-3.5 text-base font-bold uppercase text-primary-foreground shadow-lg hover:bg-primary/90">
              {priceLine ? "Talk to an agent about this trip" : "Talk to an agent about today’s price and what is open"}
            </a>
            {p.telHref && (
              <PhoneLink href={p.telHref} method="trip_kit_hero" className="inline-flex items-center justify-center gap-2 rounded-md border border-white/70 px-6 py-3.5 text-base font-bold text-white hover:bg-white/10">
                <Phone className="h-4 w-4" aria-hidden="true" />
                Call or text {p.phone}
              </PhoneLink>
            )}
          </div>
        </div>
      </div>
    </section>
  )
}
