import type { ReactNode } from "react"
import Link from "next/link"
import { Calendar, Clock, MapPin, Phone, History } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { PhoneLink } from "@/components/phone-link"
import { dateRangeText } from "@/lib/trip-kit-facts"

export interface PastTripHeroProps {
  heading: string
  category: string
  destination: string
  destinationHref: string
  image: string
  /** Honest alt text: "Photo from the <trip> trip" for a real trip photo, the place name for a stock photo. */
  imageAlt: string
  duration: string
  availableFrom: string | null
  availableTo: string | null
  /** "May 2026": the line "This trip happened May 2026". Left out when the trip has no usable date. */
  happened: string | null
  promise: string | null
  phone: string
  telHref: string
  /** The visible trail (the page's Breadcrumbs component, which also emits the BreadcrumbList data). */
  breadcrumbs: ReactNode
}

/** Hero of a past trip page: one h1, the line "This trip happened <Month Year>", no price and no booking button, only
 * "Plan a trip like this" and the phone. The visible trail is plain; its BreadcrumbList data is in the page's structured data. */
export function PastTripHero(p: PastTripHeroProps) {
  const dates = dateRangeText(p.availableFrom, p.availableTo)
  return (
    <section className="relative isolate overflow-hidden bg-slate-900 text-white" data-testid="past-trip-hero">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={p.image} alt={p.imageAlt} fetchPriority="high" decoding="async" className="absolute inset-0 -z-10 h-full w-full object-cover opacity-70" />
      <div className="absolute inset-0 -z-10 bg-gradient-to-t from-slate-950/90 via-slate-950/40 to-slate-950/10" />
      <div className="container mx-auto px-4 pb-10 pt-12 sm:pb-14 sm:pt-16 lg:pt-24">
        <div className="max-w-3xl">
          {p.breadcrumbs}
          <div className="mb-4 flex flex-wrap gap-2">
            <Badge className="bg-primary font-bold uppercase text-primary-foreground">{p.category}</Badge>
            <Badge variant="outline" className="border-white/70 font-bold uppercase text-white"><History className="mr-1 h-3.5 w-3.5" aria-hidden="true" />Past trip</Badge>
          </div>
          <h1 className="text-balance text-3xl font-extrabold leading-tight sm:text-5xl">{p.heading}</h1>
          {p.happened && <p className="mt-3 text-lg font-semibold text-white" data-testid="past-trip-happened">This trip happened {p.happened}</p>}
          {p.promise && <p className="mt-3 max-w-2xl text-pretty text-lg text-white/90 sm:text-xl">{p.promise}</p>}
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
          <div className="mt-7 flex flex-col gap-3 sm:flex-row">
            <a href="#plan" className="inline-flex items-center justify-center rounded-md bg-primary px-6 py-3.5 text-base font-bold uppercase text-primary-foreground shadow-lg hover:bg-primary/90">
              Plan a trip like this
            </a>
            {p.telHref && (
              <PhoneLink href={p.telHref} method="past_trip_hero" className="inline-flex items-center justify-center gap-2 rounded-md border border-white/70 px-6 py-3.5 text-base font-bold text-white hover:bg-white/10">
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
