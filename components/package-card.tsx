import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { MapPin, Calendar, Users, Star } from "lucide-react"
import Image from "next/image"
import Link from "next/link"
import type { TravelPackage } from "@/types/travel"
import type { Language } from "@/lib/preferences"
import type { Currency } from "@/lib/currency"
import { translate } from "@/lib/i18n"
import { formatPrice, parseUsdPrice } from "@/lib/currency"

interface PackageCardProps {
  package: TravelPackage
  language: Language
  currency: Currency
  usdToTargetRate: number
}

export function PackageCard({ package: pkg, language, currency, usdToTargetRate }: PackageCardProps) {
  const priceValue = pkg.priceValue ?? parseUsdPrice(pkg.price)
  const priceDisplay = priceValue ? formatPrice(priceValue, currency, usdToTargetRate) : pkg.price

  return (
    <Card className="group overflow-hidden border-border bg-card transition-all hover:border-primary hover:shadow-xl hover:shadow-primary/20">
      <CardHeader className="p-0">
        <div className="relative h-48 w-full overflow-hidden">
          <Image
            src={pkg.image || "/placeholder.svg"}
            alt={pkg.name}
            fill
            className="object-cover transition-transform duration-300 group-hover:scale-110"
            sizes="(max-width: 768px) 100vw, (max-width: 1200px) 50vw, 33vw"
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
        <div className="flex items-baseline gap-2">
          <span className="text-2xl font-bold text-foreground">{priceDisplay}</span>
          <span className="text-sm text-muted-foreground uppercase">{currency.toUpperCase()}</span>
          <span className="text-sm text-muted-foreground">{translate(language, 'per person')}</span>
        </div>
      </CardContent>
      <CardFooter className="p-6 pt-0">
        <Button asChild className="w-full bg-primary text-primary-foreground font-bold uppercase hover:bg-primary/90">
          <Link href={`/#contact?package=${encodeURIComponent(pkg.name)}`}>
            {translate(language, 'More Info')}
          </Link>
        </Button>
      </CardFooter>
    </Card>
  )
}