"use client"

import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { MapPin, Calendar, Users, Star } from "lucide-react"
import Link from "next/link"
import type { TravelPackage } from "@/types/travel"
import type { Language } from "@/lib/preferences"
import type { Currency } from "@/lib/currency"
import { translate } from "@/lib/i18n"
import { PhoneLink } from "@/components/phone-link"
import { formatPrice, parseUsdPrice } from "@/lib/currency"
import { priceOnRequestLine } from "@/lib/site"

interface PackageCardProps {
  package: TravelPackage
  language: Language
  currency: Currency
  usdToTargetRate: number
  /** Load the photo right away. Only for a card at the very top of a page (a guide header); every other card is lazy so it never competes with the page's main photo. */
  eager?: boolean
}

export function PackageCard({ package: pkg, language, currency, usdToTargetRate, eager = false }: PackageCardProps) {
  const priceValue = pkg.priceValue ?? parseUsdPrice(pkg.price)
  const priceDisplay = priceValue ? formatPrice(priceValue, currency, usdToTargetRate) : pkg.price
  // Price on request: only when the trip has no price of its own. The number is the site's, never a host's.
  const onRequest = !!pkg.priceOnRequest && !priceValue && !pkg.price?.trim()
  const request = priceOnRequestLine()

  return (
    <Card className="group overflow-hidden border-border bg-card transition-all hover:border-primary hover:shadow-xl hover:shadow-primary/20">
      <CardHeader className="p-0">
        <div className="relative h-48 w-full overflow-hidden">
          <img
            src={pkg.image || "/placeholder.svg"}
            alt={pkg.name}
            width={384}
            height={192}
            loading={eager ? "eager" : "lazy"}
            decoding="async"
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-110"
            onError={(e) => { (e.target as HTMLImageElement).src = "/placeholder.svg" }}
          />
          <Badge className="absolute right-3 top-3 bg-primary text-primary-foreground font-bold uppercase">
            {translate(language, pkg.category)}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="p-6">
        <h3 className="mb-2 text-balance text-xl font-bold uppercase text-foreground">
          {translate(language, pkg.name)}
        </h3>
        <div className="mb-4 flex flex-wrap gap-3 text-sm text-muted-foreground">
          <div className="flex items-center gap-1">
            <MapPin className="h-4 w-4" />
            <span>{translate(language, pkg.destination)}</span>
          </div>
          <div className="flex items-center gap-1">
            <Calendar className="h-4 w-4" />
            <span>{translate(language, pkg.duration)}</span>
          </div>
          {pkg.maxPeople && (
            <div className="flex items-center gap-1">
              <Users className="h-4 w-4" />
              <span>{translate(language, pkg.maxPeople)}</span>
            </div>
          )}
        </div>
        <p className="mb-4 line-clamp-2 text-pretty text-sm leading-relaxed text-muted-foreground">
          {translate(language, pkg.description)}
        </p>
        {pkg.rating && (
          <div className="mb-4 flex items-center gap-1 text-foreground">
            <Star className="h-4 w-4 fill-yellow-400 text-yellow-400" />
            <span className="text-sm font-medium">{pkg.rating}</span>
            <span className="text-sm text-muted-foreground">/5</span>
          </div>
        )}
        {onRequest ? (
          <p className="text-base font-semibold text-foreground">
            {request.phone ? (
              <>
                {translate(language, "Call or text {phone} for pricing").split("{phone}")[0]}
                <PhoneLink href={request.telHref} method="package_card" className="underline hover:text-primary">{request.phone}</PhoneLink>
                {translate(language, "Call or text {phone} for pricing").split("{phone}")[1]}
              </>
            ) : (
              translate(language, "Contact us for pricing")
            )}
          </p>
        ) : (
        <div className="flex items-baseline gap-2">
          <span className={priceValue ? "text-2xl font-bold text-foreground" : "text-base font-semibold text-foreground"}>{priceDisplay}</span>
          {!!priceValue && (
            <>
              <span className="text-sm text-muted-foreground uppercase">{currency.toUpperCase()}</span>
              <span className="text-sm text-muted-foreground">{translate(language, 'per person')}</span>
            </>
          )}
        </div>
        )}
      </CardContent>
      <CardFooter className="p-6 pt-0">
        <Button asChild className="w-full bg-primary text-primary-foreground font-bold uppercase hover:bg-primary/90">
          {/* Found 2026-10-03: a query string placed after a hash fragment (/#contact?package=X)
              is parsed as part of the hash, not as a real query param - contact-form.tsx's
              useSearchParams().get("package") would silently read nothing. Correct order is
              path + query + hash. Zero real packages hit this fallback today (all 9 published
              rows have a slug), but it's a landmine for the next one that doesn't. */}
          <Link href={pkg.slug ? `/packages/${pkg.slug}` : `/?package=${encodeURIComponent(pkg.name)}#contact`}>
            {translate(language, 'More Info')}
          </Link>
        </Button>
      </CardFooter>
    </Card>
  )
}